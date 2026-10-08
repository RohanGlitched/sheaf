import { serverRpcUrl } from "@/lib/config";

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

type Call = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Call | Call[] | null;
  const calls = Array.isArray(body) ? body : body ? [body] : [];
  if (!calls.length || calls.length > MAX_BATCH) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
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
