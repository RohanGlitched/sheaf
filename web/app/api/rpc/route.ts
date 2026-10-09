import { serverRpcUrl, SHEAF_PROGRAM_ID } from "@/lib/config";
import { clientIp } from "@/lib/faucet-server";
import { originAllowed } from "@/lib/server-origin";

/**
 * POST /api/rpc: the browser's devnet RPC.
 *
 * Forwards JSON-RPC to the server's endpoint (Helius when a key is set) so the
 * key stays here. Only the read and send methods the app uses are allowed, and a
 * batch is capped, so the proxy cannot be turned into a general-purpose RPC.
 */

/**
 * JSON-RPC method names, not Connection method names: getMultipleAccountsInfo
 * sends getMultipleAccounts, getParsedAccountInfo sends getAccountInfo, and
 * getParsedTokenAccountsByOwner sends getTokenAccountsByOwner. The list covers
 * every read the app, @solana/spl-token and the Meteora DBC and DAMM v2 SDKs make
 * from the browser (the curve's swap reads the clock with getSlot + getBlockTime).
 */
const ALLOWED = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getBlockTime",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);
const MAX_BATCH = 25;

/** A page polls a few calls every few seconds; this is generous for a person and tight for a script. */
const PER_MINUTE = 240;
const seen = new Map<string, { t: number; w: number }[]>();
function overLimit(ip: string, weight: number): boolean {
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((h) => now - h.t < 60_000);
  recent.push({ t: now, w: weight });
  seen.set(ip, recent);
  if (seen.size > 5000) seen.clear();
  return recent.reduce((a, h) => a + h.w, 0) > PER_MINUTE;
}
/** A page decoding history reads many transactions; each counts a quarter of a call. */
const weightOf = (calls: Call[]) => calls.reduce((a, c) => a + (c.method === "getTransaction" ? 0.25 : 1), 0);
/** Signature lists are capped: the app asks for at most a hundred, a scan for a thousand is a script. */
const MAX_SIGNATURES = 100;

type Call = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Call | Call[] | null;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > MAX_BATCH) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
  }
  // Only this site's pages may use the proxy; a browser always sends Origin on a POST.
  if (!originAllowed(req)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "This endpoint serves this site only" } }, { status: 403 });
  }
  if (overLimit(clientIp(req), weightOf(calls))) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }, { status: 429, headers: { "retry-after": "20" } });
  }
  // Program scans are the expensive call: only Sheaf's own program may be scanned.
  const scan = calls.find((c) => c.method === "getProgramAccounts" && (c.params as unknown[] | undefined)?.[0] !== SHEAF_PROGRAM_ID);
  if (scan) {
    return Response.json({ jsonrpc: "2.0", id: scan.id ?? null, error: { code: -32602, message: "Only the Sheaf program can be scanned here" } }, { status: 403 });
  }
  const long = calls.find((c) => {
    if (c.method !== "getSignaturesForAddress") return false;
    const limit = ((c.params as unknown[] | undefined)?.[1] as { limit?: unknown } | undefined)?.limit;
    return typeof limit !== "number" || limit > MAX_SIGNATURES;
  });
  if (long) {
    return Response.json(
      { jsonrpc: "2.0", id: long.id ?? null, error: { code: -32602, message: `getSignaturesForAddress needs a limit of at most ${MAX_SIGNATURES}` } },
      { status: 403 },
    );
  }
  const bad = calls.find((c) => !c.method || !ALLOWED.has(c.method));
  if (bad) {
    return Response.json(
      { jsonrpc: "2.0", id: bad.id ?? null, error: { code: -32601, message: `Method not allowed: ${bad.method}` } },
      { status: 403 },
    );
  }
  const res = await fetch(serverRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);
  if (!res) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Upstream RPC unreachable" } }, { status: 502 });
  }
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
