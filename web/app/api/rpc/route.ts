import { serverRpcUrl, SHEAF_PROGRAM_ID } from "@/lib/config";
import { clientIp } from "@/lib/faucet-server";

/**
 * POST /api/rpc: the browser's devnet RPC.
 *
 * Forwards JSON-RPC to the server's endpoint (Helius when a key is set) so the
 * key stays here. Only the read and send methods the app uses are allowed, and a
 * batch is capped, so the proxy cannot be turned into a general-purpose RPC.
 */

const ALLOWED = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getParsedAccountInfo",
  "getProgramAccounts",
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
const seen = new Map<string, number[]>();
function overLimit(ip: string, n: number): boolean {
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < 60_000);
  for (let i = 0; i < n; i++) recent.push(now);
  seen.set(ip, recent);
  if (seen.size > 5000) seen.clear();
  return recent.length > PER_MINUTE;
}

/** Only this site's pages (and server-side callers, which send no Origin) may use the proxy. */
function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return o.host === host || o.hostname === "localhost" || o.hostname.endsWith(".vercel.app") && o.hostname.startsWith("sheaf");
  } catch {
    return false;
  }
}

type Call = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Call | Call[] | null;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > MAX_BATCH) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
  }
  if (!originAllowed(req.headers.get("origin"), req.headers.get("host"))) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "This endpoint serves this site only" } }, { status: 403 });
  }
  if (overLimit(clientIp(req), calls.length)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }, { status: 429, headers: { "retry-after": "20" } });
  }
  // Program scans are the expensive call: only Sheaf's own program may be scanned.
  const scan = calls.find((c) => c.method === "getProgramAccounts" && (c.params as unknown[] | undefined)?.[0] !== SHEAF_PROGRAM_ID);
  if (scan) {
    return Response.json({ jsonrpc: "2.0", id: scan.id ?? null, error: { code: -32602, message: "Only the Sheaf program can be scanned here" } }, { status: 403 });
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
