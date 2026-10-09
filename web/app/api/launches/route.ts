import { Connection } from "@solana/web3.js";
import { WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { DBC_PROGRAM, PRESET_NAMES, TREASURY, findLaunch, launchFor, readDbcState } from "@/lib/dbc";
import { isTestBasket } from "@/lib/hidden";
import { fetchBaskets } from "@/lib/sheaf";
import { teamTag } from "@/lib/team-wallets";
import preset from "@/lib/meteora-preset.json";
import { TRADE_WINDOW, readTrades } from "./read-trades";

/**
 * Every basket's launch market, read straight from the pool and config
 * accounts, for terminals and anyone else who wants the curves without the
 * site. No indexer: each basket's launch addresses are derived from the basket,
 * and every pool found there is checked against its own account data before it
 * counts (fee claimer and leftover receiver are Sheaf's treasury, quoted in
 * SOL, graduates into DAMM v2, opened by the basket's creator, and on the
 * published terms: locked LP, immutable token, fee split, migration fee and
 * one of the published curve presets). A pool that fails is listed under
 * `unofficial` with the reason, and never as the launch. A basket with no open
 * launch is listed with where its launch will be.
 *
 * Launches our own QA runs opened (a test basket, or a basket a team test
 * wallet created) carry `test: true` and are left out unless `?tests=1`.
 * `outsideLaunches` counts launches opened by anyone outside the Sheaf team;
 * `traders` counts distinct wallets outside the team that traded a launch.
 * House buys are ours and never count.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const withTests = new URL(req.url).searchParams.get("tests") === "1";
  const connection = new Connection(WRITE_RPC, "confirmed");
  const baskets = await fetchBaskets(connection);
  const outsideWallets = new Set<string>();
  const all = await Promise.all(
    baskets.map(async (basket) => {
      const { launch, unofficial, free } = await findLaunch(connection, basket);
      const info = launch?.info ?? free ?? (await launchFor(basket));
      const state = launch ? await readDbcState(connection, launch.info, basket.creator) : null;
      const creatorTeam = teamTag(basket.creator);
      const test = isTestBasket(basket) || creatorTeam === "test wallet";
      const trades = state
        ? await readTrades(connection, { pool: info.pool, baseMint: info.baseMint, migrated: state.migrated }).catch(
            () => null,
          )
        : null;
      if (trades && !test) for (const t of trades.trades) if (t.team == null) outsideWallets.add(t.wallet);
      return {
        basket: {
          address: basket.address,
          name: basket.name,
          symbol: basket.symbol,
          creator: basket.creator,
          // "house" for baskets Sheaf seeded, "test wallet" for our QA runs, null for anyone else.
          creatorTeam,
        },
        test,
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
          preset: state.preset,
          presetId: state.preset ? PRESET_NAMES[state.preset] : null,
          raisedSol: state.raised,
          thresholdSol: state.threshold,
          marketCapSol: state.cap,
          openCapSol: state.openCap,
          graduationCapSol: state.graduationCap,
          graduated: state.migrated,
          creatorFeesSol: state.creatorFees,
          partnerFeesSol: state.partnerFees,
          meteoraFeesSol: state.protocolFees,
          totalFeesSol: state.totalFees,
          feeSchedulerCounts: state.activation === "timestamp" ? "seconds" : "slots",
          shape: state.shape,
        }),
        ...(trades && {
          // Distinct wallets outside the Sheaf team; house, treasury and test wallets never count.
          traders: trades.traders,
          outsideTrades: trades.outsideTrades,
          teamTrades: trades.teamTrades,
        }),
        ...(unofficial.length > 0 && {
          unofficial: unofficial.map((u) => ({ pool: u.info.pool, slot: u.info.slot ?? 0, reason: u.check.reason })),
        }),
      };
    }),
  );
  const real = all.filter((l) => !l.test);
  const opened = real.filter((l) => l.open && l.official);
  return Response.json(
    {
      cluster: WRITE_CLUSTER,
      program: DBC_PROGRAM.toBase58(),
      treasury: TREASURY.toBase58(),
      readAt: new Date().toISOString(),
      feeSplit: {
        note: "Percent of every fee a trader pays. The DBC and DAMM v2 programs take Meteora's protocol share before the creator and treasury split the rest.",
        curve: {
          meteora: preset.feeSplit.meteoraProtocolPercent,
          creator: preset.feeSplit.creatorPercentOfEveryCurveFee,
          treasury: preset.feeSplit.treasuryPercentOfEveryCurveFee,
        },
        graduatedPool: {
          meteora: preset.feeSplit.meteoraProtocolPercent,
          creator: preset.feeSplit.creatorPercentOfEveryGraduatedPoolFee,
          treasury: preset.feeSplit.treasuryPercentOfEveryGraduatedPoolFee,
        },
        migrationFeePercentOfRaiseToTreasury: preset.migration.migrationFeePercentage,
      },
      openLaunches: opened.length,
      // Launches whose basket creator is outside the Sheaf team. House and QA launches never count.
      outsideLaunches: opened.filter((l) => l.basket.creatorTeam == null).length,
      // Distinct wallets outside the team that swapped on any launch, over each market's last `tradeWindow` signatures.
      traders: outsideWallets.size,
      tradeWindow: TRADE_WINDOW,
      testLaunchesHidden: withTests ? 0 : all.filter((l) => l.test && l.open).length,
      launches: withTests ? all : real,
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
