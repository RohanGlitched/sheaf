import { Connection } from "@solana/web3.js";
import { WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { launchFor, openLaunches, readDbcState } from "@/lib/dbc";
import { fetchBaskets } from "@/lib/sheaf";

/**
 * Every basket's launch market, read straight from the pool and config
 * accounts, for terminals and anyone else who wants the curves without the
 * site. A basket with no open launch is listed with where its launch will be.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const connection = new Connection(WRITE_RPC, "confirmed");
  const baskets = await fetchBaskets(connection);
  const open = await openLaunches(connection, baskets);
  const launches = await Promise.all(
    baskets.map(async (basket) => {
      const info = await launchFor(basket);
      const state = open.has(basket.address) ? await readDbcState(connection, info) : null;
      return {
        basket: { address: basket.address, name: basket.name, symbol: basket.symbol, creator: basket.creator },
        launch: { pool: info.pool, config: info.config, mint: info.baseMint, symbol: info.baseSymbol, name: info.baseName },
        open: state != null,
        ...(state && {
          raisedSol: state.raised,
          thresholdSol: state.threshold,
          marketCapSol: state.cap,
          openCapSol: state.openCap,
          graduationCapSol: state.graduationCap,
          graduated: state.migrated,
          creatorFeesSol: state.creatorFees,
          totalFeesSol: state.totalFees,
          shape: state.shape,
        }),
      };
    }),
  );
  return Response.json(
    { cluster: WRITE_CLUSTER, program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", readAt: new Date().toISOString(), launches },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
