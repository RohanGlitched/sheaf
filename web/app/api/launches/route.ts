import { Connection } from "@solana/web3.js";
import { WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { DBC_PROGRAM, TREASURY, findLaunch, launchFor, readDbcState } from "@/lib/dbc";
import { fetchBaskets } from "@/lib/sheaf";

/**
 * Every basket's launch market, read straight from the pool and config
 * accounts, for terminals and anyone else who wants the curves without the
 * site. No indexer: each basket's launch addresses are derived from the basket,
 * and every pool found there is checked against its own account data before it
 * counts (fee claimer and leftover receiver are Sheaf's treasury, quoted in
 * SOL, graduates into DAMM v2, and opened by the basket's creator). A pool that
 * fails is listed under `unofficial` with the reason, and never as the launch.
 * A basket with no open launch is listed with where its launch will be.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const connection = new Connection(WRITE_RPC, "confirmed");
  const baskets = await fetchBaskets(connection);
  const launches = await Promise.all(
    baskets.map(async (basket) => {
      const { launch, unofficial, free } = await findLaunch(connection, basket);
      const info = launch?.info ?? free ?? (await launchFor(basket));
      const state = launch ? await readDbcState(connection, launch.info, basket.creator) : null;
      return {
        basket: { address: basket.address, name: basket.name, symbol: basket.symbol, creator: basket.creator },
        launch: {
          pool: info.pool,
          config: info.config,
          mint: info.baseMint,
          symbol: info.baseSymbol,
          name: info.baseName,
          slot: info.slot ?? 0,
        },
        open: state != null,
        ...(state && {
          official: state.official,
          raisedSol: state.raised,
          thresholdSol: state.threshold,
          marketCapSol: state.cap,
          openCapSol: state.openCap,
          graduationCapSol: state.graduationCap,
          graduated: state.migrated,
          creatorFeesSol: state.creatorFees,
          partnerFeesSol: state.partnerFees,
          totalFeesSol: state.totalFees,
          feeSchedulerCounts: state.activation === "timestamp" ? "seconds" : "slots",
          shape: state.shape,
        }),
        ...(unofficial.length > 0 && {
          unofficial: unofficial.map((u) => ({ pool: u.info.pool, slot: u.info.slot ?? 0, reason: u.check.reason })),
        }),
      };
    }),
  );
  return Response.json(
    {
      cluster: WRITE_CLUSTER,
      program: DBC_PROGRAM.toBase58(),
      treasury: TREASURY.toBase58(),
      readAt: new Date().toISOString(),
      launches,
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
