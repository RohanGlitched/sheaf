import "server-only";
import { MAINNET_RPC } from "./config";

/**
 * Every mainnet read Sheaf makes goes through here.
 *
 * Solami's RPC answers when SOLAMI_API_KEY is set. The free tier allows five
 * requests a second per key, and a burst past that answers 429 with
 * `Retry-After: 1`, so this module paces every call it sends (one slot every
 * 240 ms per server instance, about 4.2 a second) and leaves the remainder of
 * the budget as headroom for a second warm instance. A 429 waits out its
 * Retry-After once and tries again; a second failure puts Solami on a short
 * cool-down and the call is answered by the public RPC instead, and the caller
 * is told so. Nothing here ever reports "solami" for an answer Solami did not give.
 *
 * The key travels in the query string because that is how Solami's RPC takes it.
 * It stays on the server, and no error message built here includes the URL.
 */

export type Via = "solami" | "public";

const SOLAMI_BASE = "https://rpc.solami.dev/solana";
const SPACING_MS = 240;
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
  nextSlot[via] = at + SPACING_MS;
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

async function send<T>(via: Via, method: string, params: unknown[], timeoutMs: number): Promise<{ result: T; ms: number }> {
  await pace(via);
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
    throw new RpcError(`${method}: ${(err as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
  }
  const ms = Math.round(performance.now() - started);
  const retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000;
  let body: { result?: T; error?: { code?: number; message?: string } } | null = null;
  try {
    body = await res.json();
  } catch {}
  const limited = res.status === 429 || body?.error?.code === -32005 || body?.error?.code === 429;
  if (limited) throw new RpcError(`${method}: rate limited`, true, retryAfterMs || 1000);
  if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`);
  if (!body) throw new RpcError(`${method}: unreadable answer`);
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
  if (keyed && opts.prefer !== "public" && !cooling) {
    try {
      const out = await send<T>("solami", method, params, timeoutMs);
      return { ...out, via: "solami", fallback: null };
    } catch (err) {
      const e = err as RpcError;
      // Solami answered, and the answer is about this request: asking the
      // public RPC the same thing would get the same error.
      if (e.answered) throw e;
      if (e.rateLimited) {
        await sleep(Math.min(2_000, e.retryAfterMs));
        try {
          const out = await send<T>("solami", method, params, timeoutMs);
          return { ...out, via: "solami", fallback: null };
        } catch (again) {
          if ((again as RpcError).answered) throw again;
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

/** Time one getSlot against a single upstream, for the side-by-side on the tape. */
export async function timeSlot(via: Via): Promise<{ slot: number; ms: number } | null> {
  if (via === "solami" && !solamiKey()) return null;
  try {
    const { result, ms } = await send<number>(via, "getSlot", [{ commitment: "confirmed" }], 5_000);
    return { slot: result, ms };
  } catch {
    return null;
  }
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
