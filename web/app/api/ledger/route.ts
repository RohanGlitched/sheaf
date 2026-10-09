import { Connection, PublicKey } from "@solana/web3.js";
import { serverRpcUrl } from "@/lib/config";
import { ledgerStats, readLedgerBatched, type Known, type Ledger, type LedgerStats } from "@/lib/ledger";
import { isTeamWallet } from "@/lib/team-wallets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/ledger[?basket=<address>] → { entries, done, total, truncated, stats, asOf }
 *
 * The ledger, decoded here once for every visitor: the program's (or one
 * basket's) last 300 transactions, read in JSON-RPC batches through the server's
 * endpoint, with each decoded transaction kept for the life of the instance. A
 * page makes one request instead of one per transaction. Answers are cached for
 * 30 seconds here and at the edge.
 *
 * `stats` are the numbers behind it: actions, wallets, wallets that aren't ours,
 * plans, fills, dollars filled, median time to fill and fill rate.
 */

const TTL_MS = 30_000;
const LIMIT = 300;

type Answer = Ledger & { stats: LedgerStats; asOf: number };

/** Decoded transactions never change, so one store serves every key. */
const store: Known = {};
const answers = new Map<string, Answer>();
const inFlight = new Map<string, Promise<Answer>>();

async function build(basket?: string): Promise<Answer> {
  const connection = new Connection(serverRpcUrl(), "confirmed");
  const ledger = await readLedgerBatched(connection, { basket, limit: LIMIT, store });
  return { ...ledger, stats: ledgerStats(ledger.entries, isTeamWallet), asOf: Date.now() };
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("basket");
  let basket: string | undefined;
  if (raw) {
    try {
      basket = new PublicKey(raw).toBase58();
    } catch {
      return Response.json({ error: "basket must be a basket address." }, { status: 400 });
    }
  }
  const key = basket ?? "*";
  const headers = { "cache-control": "public, s-maxage=30, stale-while-revalidate=300" };

  const cached = answers.get(key);
  if (cached && Date.now() - cached.asOf < TTL_MS) return Response.json(cached, { headers });

  let job = inFlight.get(key);
  if (!job) {
    job = build(basket).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  try {
    const answer = await job;
    answers.set(key, answer);
    if (answers.size > 500) answers.clear();
    return Response.json(answer, { headers });
  } catch (err) {
    // An older answer beats none; the rows in it are still true.
    if (cached) return Response.json(cached, { headers: { "cache-control": "no-store" } });
    return Response.json({ error: ((err as Error).message ?? "ledger read failed").split("\n")[0].slice(0, 200) }, { status: 502 });
  }
}
