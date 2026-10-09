import { Connection, PublicKey } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, serverRpcUrl } from "@/lib/config";
import { clientIp, faucetKeypair } from "@/lib/faucet-server";
import { rememberOidc } from "@/lib/gcs-store";
import { ledgerStats, type Ledger, type LedgerStats } from "@/lib/ledger";
import { decodeBasket } from "@/lib/sheaf";
import { historyEntries, syncLedgerHistory } from "@/lib/server-ledger-history";
import { isTeamWallet } from "@/lib/team-wallets";
import { filler2Address } from "@/lib/server-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/ledger[?basket=<address>][&limit=n] → { entries, done, total, truncated, complete, stats, asOf }
 *
 * The program's whole history, decoded on the server once for every visitor and
 * kept in the project's bucket (lib/server-ledger-history.ts), so nothing falls
 * out of view as the house's demo plan adds transactions. A basket's history is
 * the same events filtered to that basket, so no address but the program's is
 * ever scanned, and only real Sheaf baskets are accepted.
 *
 *  - entries: the newest `limit` events (default 600, at most 5,000), newest first.
 *  - done / total: transactions decoded so far, of every successful one the
 *    program has had; complete: whether paging back has reached the first one.
 *  - stats: over the whole history (or the basket's), not just `entries`.
 */

const TTL_MS = 30_000;
const DEFAULT_LIMIT = 600;
const MAX_LIMIT = 5_000;

type Answer = Ledger & { complete: boolean; stats: LedgerStats; asOf: number };

/** Answers per basket, least recently used out first. */
const LRU_SIZE = 64;
const answers = new Map<string, Answer>();
function remember(key: string, a: Answer) {
  answers.delete(key);
  answers.set(key, a);
  while (answers.size > LRU_SIZE) answers.delete(answers.keys().next().value!);
}

/** Known baskets, so a repeat check costs nothing; anything else is read once and refused for a while. */
const baskets = new Set<string>();
const notBaskets = new Map<string, number>();

const PER_MINUTE = 30;
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_MINUTE;
}

async function isBasket(connection: Connection, key: PublicKey): Promise<boolean> {
  const k = key.toBase58();
  if (baskets.has(k)) return true;
  if ((notBaskets.get(k) ?? 0) > Date.now()) return false;
  const info = await connection.getAccountInfo(key);
  const ok = !!info && info.owner.toBase58() === SHEAF_PROGRAM_ID && decodeBasket(key, new Uint8Array(info.data)) != null;
  if (ok) baskets.add(k);
  else {
    notBaskets.set(k, Date.now() + 10 * 60_000);
    if (notBaskets.size > 2000) notBaskets.clear();
  }
  return ok;
}

let synced = 0;

export async function GET(request: Request) {
  rememberOidc(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("basket");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const connection = new Connection(serverRpcUrl(), "confirmed");

  let basket: string | undefined;
  if (raw) {
    if (limited(clientIp(request))) return Response.json({ error: "Too many requests." }, { status: 429, headers: { "retry-after": "20" } });
    let key: PublicKey;
    try {
      key = new PublicKey(raw);
    } catch {
      return Response.json({ error: "basket must be a basket address." }, { status: 400 });
    }
    if (!(await isBasket(connection, key).catch(() => false))) {
      return Response.json({ error: "No Sheaf basket at that address." }, { status: 404 });
    }
    basket = key.toBase58();
  }
  const cacheKey = `${basket ?? "*"}:${limit}`;
  const headers = { "cache-control": "public, s-maxage=30, stale-while-revalidate=300" };
  const cached = answers.get(cacheKey);
  if (cached && Date.now() - cached.asOf < TTL_MS) return Response.json(cached, { headers });

  try {
    // One sync of the program's history serves every key for the next 30 seconds.
    const fresh = Date.now() - synced < TTL_MS;
    const history = await syncLedgerHistory(connection, fresh ? 0 : 40_000);
    if (!fresh) synced = Date.now();
    const view = historyEntries(history, basket);
    const answer: Answer = {
      entries: view.entries.slice(0, limit),
      done: view.decoded,
      total: view.total,
      truncated: view.entries.length > limit,
      complete: view.complete,
      stats: ledgerStats(view.entries, isTeamWallet, {
        house: faucetKeypair()?.publicKey.toBase58(),
        second: filler2Address() ?? undefined,
      }),
      asOf: Date.now(),
    };
    remember(cacheKey, answer);
    return Response.json(answer, { headers });
  } catch (err) {
    // An older answer beats none; the rows in it are still true.
    if (cached) return Response.json(cached, { headers: { "cache-control": "no-store" } });
    return Response.json({ error: ((err as Error).message ?? "ledger read failed").split("\n")[0].slice(0, 200) }, { status: 502 });
  }
}
