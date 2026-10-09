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
import { WRITE_RPC, WRITE_CLUSTER } from "@/lib/config";
import { COMPOSABLE, FAUCET_TOKENS_PER_CLAIM, writeMint } from "@/lib/mirror";
import { CASH_MINT, CASH_DECIMALS } from "@/lib/cash.generated";

/** Test dollars per claim: enough for a few cash orders and a plan. */
const CASH_PER_CLAIM = 1_000;

/**
 * Test shares, on request.
 *
 * Nobody should have to go looking for tokens to try a product. The mirror mints
 * on the write cluster keep their authority with this faucet, so a visitor can
 * ask for a handful of every ticker and go straight to composing.
 *
 * The faucet key is read from the server environment and never leaves it. It has
 * authority over nothing but these stand-in mints on a test cluster.
 */

const COOLDOWN_MS = 60_000;
const MAX_TICKERS_PER_REQUEST = 8;

const DECIMALS_BY_SYMBOL = new Map(COMPOSABLE.map((s) => [s.symbol, s.decimals]));

/** Last claim per address. Per-instance and deliberately simple. */
const lastClaim = new Map<string, number>();

/** Fresh addresses cost the faucet account rent, so cap claims per IP as well. */
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX_CLAIMS = 6;
const claimsByIp = new Map<string, number[]>();

/**
 * The faucet key is also the keeper's, which stops spending rent at 0.5 SOL. New
 * token accounts are only opened while the key holds well above that, so a run of
 * fresh wallets can never starve the keeper.
 */
const ATA_FLOOR_LAMPORTS = 1.5e9;


function recentClaims(ip: string): number[] {
  const now = Date.now();
  const recent = (claimsByIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  claimsByIp.set(ip, recent);
  return recent;
}


export async function POST(request: Request) {
  const keypair = faucetKeypair();
  if (!keypair) {
    return Response.json(
      {
        error:
          "The faucet is not configured on this deployment. Set FAUCET_SECRET_KEY to the mirror mint authority.",
      },
      { status: 503 },
    );
  }

  let body: { owner?: string; symbols?: string[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(body.owner ?? "");
  } catch {
    return Response.json(
      { error: "That does not look like a Solana address." },
      { status: 400 },
    );
  }

  const previous = lastClaim.get(owner.toBase58());
  if (previous && Date.now() - previous < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - previous)) / 1000);
    return Response.json(
      { error: `Already claimed. Try again in ${wait}s.` },
      { status: 429 },
    );
  }

  const ip = clientIp(request);
  const fromIp = recentClaims(ip);
  if (fromIp.length >= IP_MAX_CLAIMS) {
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

  // Claim the slot before the first network call, so parallel requests cannot all
  // pass the checks above; give it back if nothing is sent.
  const wallet = owner.toBase58();
  const claimedAt = Date.now();
  lastClaim.set(wallet, claimedAt);
  fromIp.push(claimedAt);
  const release = () => {
    if (lastClaim.get(wallet) === claimedAt) {
      if (previous) lastClaim.set(wallet, previous);
      else lastClaim.delete(wallet);
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
      connection.getBalance(keypair.publicKey),
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
  const canOpenAccounts = houseLamports >= ATA_FLOOR_LAMPORTS;
  const claimable = entries
    .map((entry, n) => ({ entry, ata: atas[n], exists: existing[n] }))
    .filter((x) => x.exists || canOpenAccounts);
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
  const skipped = entries.filter((_, n) => !existing[n] && !canOpenAccounts).map((e) => e.symbol);

  const tx = new Transaction();
  for (const { entry, ata, exists } of claimable) {
    const mint = new PublicKey(entry.mint);
    const amount =
      (entry.symbol === "USDC" ? BigInt(CASH_PER_CLAIM) : BigInt(FAUCET_TOKENS_PER_CLAIM)) * 10n ** BigInt(entry.decimals);
    if (!exists) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
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
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
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
    return Response.json({ error: message }, { status: 502 });
  }
}
