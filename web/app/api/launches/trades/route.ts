import { Connection, PublicKey } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { DBC_PROGRAM } from "@/lib/dbc";
import { TRADE_WINDOW, readTrades } from "../read-trades";

export const dynamic = "force-dynamic";

/**
 * GET /api/launches/trades?pool=<DBC pool>
 *
 * The recent swaps on one launch, on its curve and (once graduated) its DAMM v2
 * pool, newest first. Sheaf's own wallets carry `team` ("house", "test
 * wallet", ...): those trades are ours and never count as traction; `traders`
 * counts only wallets outside the team.
 */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("pool") ?? "";
  let pool: PublicKey;
  try {
    pool = new PublicKey(address);
  } catch {
    return Response.json({ error: "Pass ?pool=<a Meteora DBC pool address>." }, { status: 400 });
  }
  const connection = new Connection(WRITE_RPC, "confirmed");
  const account = await connection.getAccountInfo(pool);
  if (!account || !account.owner.equals(DBC_PROGRAM) || account.data.length < 376) {
    return Response.json({ error: "No Meteora DBC pool at that address." }, { status: 404 });
  }
  const baseMint = new PublicKey(account.data.subarray(136, 168)).toBase58();
  const migrated = account.data[305] === 1;
  const result = await readTrades(connection, { pool: pool.toBase58(), baseMint, migrated });
  return Response.json(
    { pool: pool.toBase58(), baseMint, graduated: migrated, window: TRADE_WINDOW, ...result },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
