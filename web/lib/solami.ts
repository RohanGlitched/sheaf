import "server-only";
import { MAINNET_RPC } from "./config";

/**
 * Every mainnet read Sheaf makes goes through here.
 *
 * Solami's RPC answers when SOLAMI_API_KEY is set. The free tier allows five
 * requests a second per key, and a burst past that answers 429 with
 * `Retry-After: 1`, so this module paces every call it sends: one slot every
 * 500 ms per server instance, two a second, so two warm instances together
 * still fit under the key's five (Vercel keeps more than one warm, and at
 * 240 ms three of them together drew 429s). A 429 waits out its
 * Retry-After once and tries again; a second failure puts Solami on a short
 * cool-down and the call is answered by the public RPC instead, and the caller
 * is told so. Nothing here ever reports "solami" for an answer Solami did not give.
 *
 * raceSlot and raceTransaction put the same call to Solami and the public RPC
 * at the same instant, over warm sockets, for the comparison the tape shows;
 * upstreamStats counts every call and every 429 per upstream.
 *
 * The key travels in the query string because that is how Solami's RPC takes it.
 * It stays on the server, and no error message built here includes the URL.
 */

export type Via = "solami" | "public";

const SOLAMI_BASE = "https://rpc.solami.dev/solana";
/** Gap between calls to one upstream from one instance. */
const SPACING_MS: Record<Via, number> = { solami: 500, public: 240 };
const COOL_DOWN_MS = 8_000;

export function solamiKey(): string | null {
  return process.env.SOLAMI_API_KEY?.trim() || null;
}

function urlFor(via: Via): string {
  const key = solamiKey();
  return via === "solami" && key ? `${SOLAMI_BASE}?api-key=${encodeURIComponent(key)}` : MAINNET_RPC;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One queue per upstream: a poll never puts more than one request on the wire
// every SPACING_MS, however many callers want one.
const nextSlot: Record<Via, number> = { solami: 0, public: 0 };
async function pace(via: Via) {
  const now = Date.now();
  const at = Math.max(now, nextSlot[via]);
  nextSlot[via] = at + SPACING_MS[via];
  if (at > now) await sleep(at - now);
}

let coolUntil = 0;
let lastFailure: string | null = null;

/** Why the last Solami call fell back, while the cool-down lasts. */
export function solamiCooling(): string | null {
  return Date.now() < coolUntil ? lastFailure : null;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly rateLimited = false,
    readonly retryAfterMs = 0,
    /** A JSON-RPC error about this request (bad params, unsupported version): the node is fine. */
    readonly answered = false,
  ) {
    super(message);
  }
}

/**
 * Every request this instance sent to an upstream for the tape and the market
 * reads, and how it ended. The comparison's own calls are kept out of it (they
 * are reported inside the comparison), so race traffic never reads as the tape
 * being throttled.
 */
export type UpstreamStats = { calls: number; ok: number; rateLimited: number; failed: number };
export type ReadStats = {
  /** Reads that went to Solami first. */
  wanted: number;
  /** Of those, how many Solami answered (after its one patient retry on a 429). */
  solami: number;
};
const stats: Record<Via, UpstreamStats> = {
  solami: { calls: 0, ok: 0, rateLimited: 0, failed: 0 },
  public: { calls: 0, ok: 0, rateLimited: 0, failed: 0 },
};
const reads: ReadStats = { wanted: 0, solami: 0 };
export function upstreamStats(): Record<Via, UpstreamStats> & { reads: ReadStats } {
  return { solami: { ...stats.solami }, public: { ...stats.public }, reads: { ...reads } };
}

async function send<T>(
  via: Via,
  method: string,
  params: unknown[],
  timeoutMs: number,
  /** Counted in upstreamStats (the comparison's own calls are not). */
  counted = true,
  /** False when the caller has already waited its turn in the queue. */
  paced = true,
): Promise<{ result: T; ms: number }> {
  if (paced) await pace(via);
  const tally = counted ? stats[via] : { calls: 0, ok: 0, rateLimited: 0, failed: 0 };
  tally.calls++;
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(urlFor(via), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    tally.failed++;
    throw new RpcError(`${method}: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  const ms = Math.round(performance.now() - started);
  const retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
  let body: { result?: T; error?: { code?: number; message?: string } } | null = null;
  try {
    body = await res.json();
  } catch {}
  const limited = res.status === 429 || body?.error?.code === -32005 || body?.error?.code === 429;
  if (limited) {
    tally.rateLimited++;
    throw new RpcError(`${method}: rate limited`, true, retryAfterMs || 1000);
  }
  if (!res.ok || !body) {
    tally.failed++;
    throw new RpcError(`${method}: ${!res.ok ? `HTTP ${res.status}` : "unreadable answer"}`);
  }
  // A JSON-RPC error about the request still means the node answered.
  tally.ok++;
  if (body.error) throw new RpcError(`${method}: ${body.error.message ?? "error"}`, false, 0, true);
  return { result: body.result as T, ms };
}

export type MainnetAnswer<T> = { result: T; ms: number; via: Via; fallback: string | null };

/**
 * One JSON-RPC call to mainnet: Solami first, one patient retry on a 429, then
 * the public endpoint. `fallback` carries the reason whenever the public RPC
 * answered although a Solami key is configured.
 */
export async function mainnetCall<T>(
  method: string,
  params: unknown[],
  opts: { timeoutMs?: number; prefer?: Via } = {},
): Promise<MainnetAnswer<T>> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const keyed = solamiKey() != null;
  const cooling = solamiCooling();
  if (keyed && opts.prefer !== "public") reads.wanted++;
  if (keyed && opts.prefer !== "public" && !cooling) {
    try {
      const out = await send<T>("solami", method, params, timeoutMs);
      reads.solami++;
      return { ...out, via: "solami", fallback: null };
    } catch (err) {
      const e = err as RpcError;
      // Solami answered, and the answer is about this request: asking the
      // public RPC the same thing would get the same error.
      if (e.answered) {
        reads.solami++;
        throw e;
      }
      if (e.rateLimited) {
        await sleep(Math.min(2_000, e.retryAfterMs));
        try {
          const out = await send<T>("solami", method, params, timeoutMs);
          reads.solami++;
          return { ...out, via: "solami", fallback: null };
        } catch (again) {
          if ((again as RpcError).answered) {
            reads.solami++;
            throw again;
          }
          lastFailure = (again as Error).message;
        }
      } else {
        lastFailure = e.message;
      }
      coolUntil = Date.now() + COOL_DOWN_MS;
    }
  }
  const out = await send<T>("public", method, params, timeoutMs);
  return {
    ...out,
    via: "public",
    fallback: keyed ? `Solami did not answer (${cooling ?? lastFailure ?? "unknown"}), so the public RPC did` : null,
  };
}

type Outcome<T> = { ok: true; result: T; ms: number } | { ok: false; limited: boolean };
async function attempt<T>(via: Via, method: string, params: unknown[]): Promise<Outcome<T>> {
  try {
    return { ok: true, ...(await send<T>(via, method, params, 5_000, false, false)) };
  } catch (err) {
    return { ok: false, limited: err instanceof RpcError && err.rateLimited };
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export type RaceSide = {
  /** Median round trip over the samples this upstream answered. */
  medianMs: number | null;
  /** Highest slot it reported across the samples. */
  slot: number | null;
  answered: number;
  rateLimited: number;
};

export type SlotRace = {
  method: "getSlot";
  commitment: "confirmed";
  /** Paired samples, after one warm-up pair that is thrown away. */
  samples: number;
  solami: RaceSide;
  public: RaceSide;
  /**
   * Median of (Solami's slot minus the public RPC's) over pairs sent at the
   * same instant: positive means Solami was ahead of the chain tip.
   */
  slotLead: number | null;
  at: number;
};

/**
 * The same call, getSlot at "confirmed", sent to both upstreams at the same
 * instant, `samples` times over warm connections (one pair first, discarded,
 * opens the keep-alive sockets). Each pair goes out together, so neither side
 * gains from going second and the two slots describe the same moment. Each
 * pair first waits for a turn in both paced queues, then fires both at once.
 * These calls are kept out of upstreamStats.
 */
export async function raceSlot(samples = 3): Promise<SlotRace | null> {
  if (!solamiKey()) return null;
  const params = [{ commitment: "confirmed" }];
  const pair = async () => {
    await Promise.all([pace("solami"), pace("public")]);
    return Promise.all([attempt<number>("solami", "getSlot", params), attempt<number>("public", "getSlot", params)]);
  };
  await pair();
  const rows: Awaited<ReturnType<typeof pair>>[] = [];
  for (let i = 0; i < samples; i++) rows.push(await pair());
  const side = (i: 0 | 1): RaceSide => {
    const ok = rows.map((r) => r[i]).filter((o): o is Extract<Outcome<number>, { ok: true }> => o.ok);
    return {
      medianMs: median(ok.map((o) => o.ms)),
      slot: ok.length ? Math.max(...ok.map((o) => o.result)) : null,
      answered: ok.length,
      rateLimited: rows.filter((r) => !r[i].ok && (r[i] as { limited: boolean }).limited).length,
    };
  };
  const leads = rows.flatMap(([a, b]) => (a.ok && b.ok ? [a.result - b.result] : []));
  return {
    method: "getSlot",
    commitment: "confirmed",
    samples,
    solami: side(0),
    public: side(1),
    slotLead: median(leads),
    at: Date.now(),
  };
}

export type TxCheck = {
  /** True when the upstream returned the transaction, false when it answered null, null when it failed or 429ed. */
  solami: boolean | null;
  public: boolean | null;
};

/**
 * Ask both upstreams, at the same instant, for one transaction that landed
 * seconds ago. An RPC that answers null has not caught up with it yet.
 */
export async function raceTransaction(signature: string): Promise<TxCheck | null> {
  if (!solamiKey()) return null;
  const params = [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }];
  await Promise.all([pace("solami"), pace("public")]);
  const [a, b] = await Promise.all([attempt<unknown>("solami", "getTransaction", params), attempt<unknown>("public", "getTransaction", params)]);
  return { solami: a.ok ? a.result != null : null, public: b.ok ? b.result != null : null };
}

/**
 * A fetch for @solana/web3.js's Connection that waits its turn in the same queue,
 * so reads made through a Connection share the per-key budget with the tape.
 */
export function pacedFetch(via: Via): typeof fetch {
  return async (input, init) => {
    await pace(via);
    return fetch(input, init);
  };
}

export function rpcUrl(via: Via): string {
  return urlFor(via);
}
