import {
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { clientIp, faucetKeypair } from "@/lib/faucet-server";
import { faucetHasOwnKey, faucetPayerKeypair, filler2Keypair } from "@/lib/server-keys";
import { WRITE_RPC, WRITE_CLUSTER } from "@/lib/config";
import { COMPOSABLE, FAUCET_TOKENS_PER_CLAIM, writeMint } from "@/lib/mirror";
import { CASH_MINT, CASH_DECIMALS } from "@/lib/cash.generated";
import { rememberOidc } from "@/lib/gcs-store";
import { LIMITS, budgetRefusal, faucetInvite, reserve as reserveBudget } from "@/lib/server-faucet-budget";
import { originAllowed } from "@/lib/server-origin";
import { fetchBasketAt } from "@/lib/sheaf";

/** Test dollars per claim: enough for a few cash orders and a plan. */
const CASH_PER_CLAIM = 1_000;

/**
 * Test shares, on request.
 *
 * Nobody should have to go looking for tokens to try a product. The mirror mints
 * on the write cluster keep their authority with the house key, so a visitor can
 * ask for a handful of every ticker and go straight to composing.
 *
 * Both keys are read from the server environment and never leave it. The house
 * key (FAUCET_SECRET_KEY) signs the mints; it is also the keeper, the house filler
 * and a devnet stand-in issuer, on a test cluster only. The faucet's own key
 * (FAUCET_KEY, see lib/server-keys.ts) pays the fee and the rent for new token
 * accounts, so handing out tokens never spends the keeper's SOL.
 */

const COOLDOWN_MS = 60_000;
const MAX_TICKERS_PER_REQUEST = 8;

const DECIMALS_BY_SYMBOL = new Map(COMPOSABLE.map((s) => [s.symbol, s.decimals]));

/**
 * Last claim per address and set of tickers asked for, so test dollars and a
 * basket's stocks a minute apart are two claims. Per-instance and deliberately simple.
 */
const lastClaim = new Map<string, number>();

/**
 * Fresh addresses cost the faucet account rent, so this instance caps claims per
 * network too, loosely enough for a room of testers on one Wi-Fi; the durable
 * daily budgets (lib/server-faucet-budget.ts) are the real limit.
 */
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX_CLAIMS = 30;
/** Without a basket in view, the most new stock accounts one claim opens (test dollars aside). */
const NEW_ACCOUNTS_WITHOUT_BASKET = 3;
const claimsByIp = new Map<string, number[]>();

/**
 * The house key holds the stand-in mints' authority, so it signs every mint. The
 * rent for a visitor's new token accounts and the fee are paid by the faucet's own
 * key (FAUCET_KEY) when it has one, so a run of fresh wallets spends the faucet's
 * SOL, never the keeper's. New accounts stop below this floor on the paying key:
 * 1.5 SOL when that is still the house (the keeper stops at 0.5), 0.2 otherwise.
 */
const ATA_FLOOR_HOUSE = 1.5e9;
const ATA_FLOOR_OWN_KEY = 0.2e9;


function recentClaims(ip: string): number[] {
  const now = Date.now();
  const recent = (claimsByIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  claimsByIp.set(ip, recent);
  return recent;
}


export async function POST(request: Request) {
  const keypair = faucetKeypair();
  const payer = faucetPayerKeypair();
  if (!keypair || !payer) {
    return Response.json(
      {
        error:
          "The faucet is not configured on this deployment. Set FAUCET_SECRET_KEY to the mirror mint authority.",
      },
      { status: 503 },
    );
  }

  rememberOidc(request);
  // `basket`: the basket the visitor is looking at; new accounts open only for its stocks.
  // `ref` (or the x-sheaf-ref header): an invite code. Only a founder-issued one
  // (lib/server-faucet-budget.ts faucetInvite) raises the network's cap; any other is ignored here.
  let body: { owner?: string; symbols?: string[]; basket?: string; ref?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const invite = faucetInvite(body.ref, request.headers.get("x-sheaf-ref"));

  let owner: PublicKey;
  try {
    owner = new PublicKey(body.owner ?? "");
  } catch {
    return Response.json(
      { error: "That does not look like a Solana address." },
      { status: 400 },
    );
  }

  // Only this site's pages may claim; a browser always sends Origin on a POST. The
  // site's own second filler tops up from the server, with no Origin, for its own key only.
  const ownFiller = !request.headers.get("origin") && filler2Keypair()?.publicKey.equals(owner);
  if (!ownFiller && !originAllowed(request)) {
    return Response.json({ error: "This faucet serves this site's pages only." }, { status: 403 });
  }

  const ip = clientIp(request);
  const fromIp = recentClaims(ip);
  if (fromIp.length >= IP_MAX_CLAIMS * (invite ? LIMITS.inviteNetFactor : 1)) {
    const wait = Math.ceil((IP_WINDOW_MS - (Date.now() - fromIp[0])) / 60_000);
    return Response.json(
      { error: `Too many claims from this network. Try again in ${wait} min.` },
      { status: 429 },
    );
  }

  // One entry per distinct mint asked for, so a claim never opens more accounts than that.
  const asked = [...new Set(Array.isArray(body.symbols) ? body.symbols.filter((s) => typeof s === "string") : [])];
  const requested = asked.filter((s) => s !== "USDC").slice(0, MAX_TICKERS_PER_REQUEST);
  const entries: { symbol: string; mint: string; decimals: number }[] = requested
    .map((symbol) => {
      const mint = writeMint(symbol);
      const decimals = DECIMALS_BY_SYMBOL.get(symbol);
      return mint && decimals != null ? { symbol, mint, decimals } : null;
    })
    .filter((e): e is { symbol: string; mint: string; decimals: number } => e != null);
  // Test dollars for cash orders and monthly plans ride the same claim.
  if (asked.includes("USDC")) entries.push({ symbol: "USDC", mint: CASH_MINT, decimals: CASH_DECIMALS });

  if (!entries.length) {
    return Response.json(
      { error: "Name at least one ticker that has a mirror on this cluster." },
      { status: 400 },
    );
  }

  // The cooldown is per wallet and per set of tickers: test dollars just claimed
  // never block a basket's stocks. `retryAfter` lets the page count down.
  const wallet = owner.toBase58();
  const claimKey = `${wallet}:${entries.map((e) => e.symbol).sort().join(",")}`;
  const previous = lastClaim.get(claimKey);
  if (previous && Date.now() - previous < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - previous)) / 1000);
    return Response.json(
      { error: `Already sent these a moment ago. Try again in ${wait}s.`, retryAfter: wait },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }

  // Claim the slot before the first network call, so parallel requests cannot all
  // pass the checks above; give it back if nothing is sent.
  const claimedAt = Date.now();
  if (lastClaim.size > 5_000) lastClaim.clear();
  lastClaim.set(claimKey, claimedAt);
  fromIp.push(claimedAt);
  const release = () => {
    if (lastClaim.get(claimKey) === claimedAt) {
      if (previous) lastClaim.set(claimKey, previous);
      else lastClaim.delete(claimKey);
    }
    const list = claimsByIp.get(ip) ?? [];
    const at = list.lastIndexOf(claimedAt);
    if (at >= 0) list.splice(at, 1);
  };

  const connection = new Connection(WRITE_RPC, "confirmed");

  // Only accounts that do not exist yet cost the house rent, and only those are
  // created. When the house is low, it still tops up accounts that already exist.
  const atas = entries.map((e) =>
    getAssociatedTokenAddressSync(new PublicKey(e.mint), owner, true, TOKEN_2022_PROGRAM_ID),
  );
  let existing: boolean[];
  let houseLamports: number;
  try {
    const [infos, lamports] = await Promise.all([
      connection.getMultipleAccountsInfo(atas),
      connection.getBalance(payer.publicKey),
    ]);
    existing = infos.map((info) => info != null);
    houseLamports = lamports;
  } catch {
    release();
    return Response.json(
      { error: "The faucet could not reach the cluster. Try again in a moment." },
      { status: 502 },
    );
  }
  const canOpenAccounts = houseLamports >= (faucetHasOwnKey() ? ATA_FLOOR_OWN_KEY : ATA_FLOOR_HOUSE);
  // New accounts (rent the visitor could close and keep) open only for test dollars
  // and the stocks of the basket in view; without one, for at most a few stocks.
  // Accounts that already exist are always topped up.
  const inView = body.basket ? await fetchBasketAt(body.basket) : null;
  const inViewMints = inView ? new Set(inView.components.map((c) => c.mint)) : null;
  let newStocks = 0;
  const mayOpen = (entry: { symbol: string; mint: string }) => {
    if (!canOpenAccounts) return false;
    if (entry.symbol === "USDC") return true;
    if (inViewMints) return inViewMints.has(entry.mint);
    return newStocks++ < NEW_ACCOUNTS_WITHOUT_BASKET;
  };
  const claimable = entries
    .map((entry, n) => ({ entry, ata: atas[n], exists: existing[n] }))
    .filter((x) => x.exists || mayOpen(x.entry));
  if (!claimable.length) {
    release();
    return Response.json(
      {
        error:
          "The faucet is low on SOL and cannot open new token accounts right now. Try again later.",
      },
      { status: 503 },
    );
  }
  const skipped = entries.filter((e) => !claimable.some((x) => x.entry === e)).map((e) => e.symbol);
  // The durable budget, shared by every instance: reserved now, given back if the send fails.
  const budget = await reserveBudget({ kind: "token", net: ip, invite, accounts: claimable.filter((x) => !x.exists).length });
  if (!budget.ok) {
    release();
    return budgetRefusal(budget.refused);
  }

  const tx = new Transaction({ feePayer: payer.publicKey });
  for (const { entry, ata, exists } of claimable) {
    const mint = new PublicKey(entry.mint);
    const amount =
      (entry.symbol === "USDC" ? BigInt(CASH_PER_CLAIM) : BigInt(FAUCET_TOKENS_PER_CLAIM)) * 10n ** BigInt(entry.decimals);
    if (!exists) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata,
          owner,
          mint,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
    }
    tx.add(
      createMintToInstruction(
        mint,
        ata,
        keypair.publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  try {
    const signers = payer.publicKey.equals(keypair.publicKey) ? [keypair] : [payer, keypair];
    const signature = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
    });
    return Response.json({
      signature,
      cluster: WRITE_CLUSTER,
      tokensEach: FAUCET_TOKENS_PER_CLAIM,
      symbols: claimable.map((x) => x.entry.symbol),
      ...(skipped.length ? { skipped } : {}),
    });
  } catch (err) {
    // Never echo the error verbatim: a failed send can quote instruction data.
    const message =
      err instanceof Error && /insufficient|0x1\b/.test(err.message)
        ? "The faucet is out of SOL on this cluster."
        : "The faucet transaction failed. Try again in a moment.";
    release();
    await budget.release();
    return Response.json({ error: message }, { status: 502 });
  }
}
