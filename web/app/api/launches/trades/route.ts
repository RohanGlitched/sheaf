import { Connection, PublicKey } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { clientIp, rateLimiter } from "@/lib/evm-server";
import { fetchBaskets } from "@/lib/sheaf";
import { isSiteOrigin } from "@/lib/server-origin";
import { TRADE_WINDOW, readTrades } from "../read-trades";
import { resolveLaunch } from "../../launch/anchor";

export const dynamic = "force-dynamic";

/** 20 lookups a minute per IP; each one reads up to 100 transactions per market. */
const perIp = rateLimiter(60_000, 20);

/** The official launch pools, refreshed once a minute: the only pools this route will read. */
let official: { at: number; pools: Map<string, string> } | null = null;
async function officialPools(connection: Connection, origin: string): Promise<Map<string, string>> {
  if (official && Date.now() - official.at < 60_000) return official.pools;
  // The same choice as the card and the feed: creator, terms, mint authority and the price check.
  const pools = new Map<string, string>();
  for (const basket of await fetchBaskets(connection)) {
    const { launch } = await resolveLaunch(connection, origin, basket);
    if (launch) pools.set(launch.info.pool, launch.info.baseMint);
  }
  official = { at: Date.now(), pools };
  return pools;
}

/**
 * GET /api/launches/trades?pool=<DBC pool>
 *
 * The recent swaps on one official launch, on its curve and (once graduated)
 * its DAMM v2 pool, newest first. Sheaf's own wallets carry `team` ("house",
 * "test wallet", ...): those trades are ours and never count as traction;
 * `traders` counts only wallets outside the team.
 *
 * Only the pools of official launches are read, so the work behind this route
 * is bounded by the number of launches, whatever address is asked for. Calls
 * from another site's pages are refused, and each IP gets 20 a minute.
 */
export async function GET(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !isSiteOrigin(origin)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const ip = clientIp(req);
  const limit = perIp.check(ip);
  if (!limit.ok) {
    return Response.json({ error: "Too many requests." }, { status: 429, headers: { "retry-after": String(limit.retryInSec) } });
  }
  perIp.hit(ip);

  const address = new URL(req.url).searchParams.get("pool") ?? "";
  let pool: string;
  try {
    pool = new PublicKey(address).toBase58();
  } catch {
    return Response.json({ error: "Pass ?pool=<an official launch's pool address>." }, { status: 400 });
  }
  const connection = new Connection(WRITE_RPC, "confirmed");
  const baseMint = (await officialPools(connection, new URL(req.url).origin)).get(pool);
  if (!baseMint) return Response.json({ error: "Not an official Sheaf launch pool." }, { status: 404 });
  const account = await connection.getAccountInfo(new PublicKey(pool));
  const migrated = account?.data[305] === 1;
  const result = await readTrades(connection, { pool, baseMint, migrated });
  return Response.json(
    { pool, baseMint, graduated: migrated, window: TRADE_WINDOW, ...result },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
