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

  const requested = (body.symbols ?? []).slice(0, MAX_TICKERS_PER_REQUEST);
  const entries: { symbol: string; mint: string; decimals: number }[] = requested
    .map((symbol) => {
      const mint = writeMint(symbol);
      const decimals = DECIMALS_BY_SYMBOL.get(symbol);
      return mint && decimals != null ? { symbol, mint, decimals } : null;
    })
    .filter((e): e is { symbol: string; mint: string; decimals: number } => e != null);
  // Test dollars for cash orders and monthly plans ride the same claim.
  if (requested.includes("USDC")) entries.push({ symbol: "USDC", mint: CASH_MINT, decimals: CASH_DECIMALS });

  if (!entries.length) {
    return Response.json(
      { error: "Name at least one ticker that has a mirror on this cluster." },
      { status: 400 },
    );
  }

  const connection = new Connection(WRITE_RPC, "confirmed");

  const tx = new Transaction();
  for (const entry of entries) {
    const mint = new PublicKey(entry.mint);
    const amount =
      (entry.symbol === "USDC" ? BigInt(CASH_PER_CLAIM) : BigInt(FAUCET_TOKENS_PER_CLAIM)) * 10n ** BigInt(entry.decimals);
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        ata,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
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
    lastClaim.set(owner.toBase58(), Date.now());
    fromIp.push(Date.now());
    return Response.json({
      signature,
      cluster: WRITE_CLUSTER,
      tokensEach: FAUCET_TOKENS_PER_CLAIM,
      symbols: entries.map((e) => e.symbol),
    });
  } catch (err) {
    // Never echo the error verbatim: a failed send can quote instruction data.
    const message =
      err instanceof Error && /insufficient|0x1\b/.test(err.message)
        ? "The faucet is out of SOL on this cluster."
        : "The faucet transaction failed. Try again in a moment.";
    return Response.json({ error: message }, { status: 502 });
  }
}
