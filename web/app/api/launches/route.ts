import { Connection } from "@solana/web3.js";
import { WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { DBC_PROGRAM, PRESET_NAMES, TREASURY, launchFor, preIpoCompanies } from "@/lib/dbc";
import { isTestBasket } from "@/lib/hidden";
import { fetchBaskets } from "@/lib/sheaf";
import { teamTag } from "@/lib/team-wallets";
import preset from "@/lib/meteora-preset.json";
import { resolveLaunch } from "../launch/anchor";

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
 * wallet created) carry `test: true` and are left out unless `?tests=1`. The
 * team's wallets are listed in lib/team-wallets.ts for that filter only; the
 * feed does not tag wallets.
 *
 * Each open launch also carries `anchor`: whether the curve really opened at
 * half the basket's NAV, checked against SOL's price in that hour and the
 * basket's NAV at the last close (see app/api/launch/anchor.ts). A launch whose
 * anchor is off by more than 10% is not official, and neither is one on a
 * listed basket whose opening price could not be checked yet ("checking the
 * opening price").
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const withTests = url.searchParams.get("tests") === "1";
  const connection = new Connection(WRITE_RPC, "confirmed");
  const baskets = await fetchBaskets(connection);
  const all = await Promise.all(
    baskets.map(async (basket) => {
      // Every pool on the published terms is anchor-checked in slot order; the first that passes is the launch.
      const { launch, unofficial, free, state, anchor, anchors, checking } = await resolveLaunch(connection, url.origin, basket);
      const info = launch?.info ?? free ?? (await launchFor(basket));
      const official = !!state?.official && anchor?.status !== "mismatch" && !checking;
      const preIpo = preIpoCompanies(basket);
      const test = isTestBasket(basket) || teamTag(basket.creator) === "test wallet";
      return {
        basket: {
          address: basket.address,
          name: basket.name,
          symbol: basket.symbol,
          creator: basket.creator,
        },
        test,
        // Pre-IPO SPV tokens in the basket: the launch is kept off featured surfaces and carries a warning.
        ...(preIpo.length > 0 && { preIpo }),
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
          official,
          ...(!official && {
            unofficialReason: state.unofficialReason ?? (checking ? "checking the opening price" : (anchor?.reason ?? null)),
          }),
          preset: state.preset,
          presetId: state.preset ? PRESET_NAMES[state.preset] : null,
          raisedSol: state.raised,
          thresholdSol: state.threshold,
          marketCapSol: state.cap,
          openCapSol: state.openCap,
          graduationCapSol: state.graduationCap,
          graduated: state.migrated,
          // Every curve fee ever charged, and how it split: Meteora 20%, then 40% each.
          totalFeesSol: state.totalFees,
          meteoraFeesSol: state.protocolFees,
          creatorFeesEarnedSol: (state.totalFees - state.protocolFees) / 2,
          partnerFeesEarnedSol: (state.totalFees - state.protocolFees) / 2,
          // What each side has not claimed yet. They differ once one side claims; the split does not.
          creatorFeesUnclaimedSol: state.creatorFees,
          partnerFeesUnclaimedSol: state.partnerFees,
          feeSchedulerCounts: state.activation === "timestamp" ? "seconds" : "slots",
          shape: state.shape,
          anchor,
        }),
        ...(unofficial.length > 0 && {
          unofficial: unofficial.map((u) => ({
            pool: u.info.pool,
            slot: u.info.slot ?? 0,
            reason: u.check.reason,
            ...(anchors.has(u.info.pool) && { anchor: anchors.get(u.info.pool) }),
          })),
        }),
      };
    }),
  );
  const real = all.filter((l) => !l.test);
  const opened = real.filter((l) => l.open && "official" in l && l.official);
  const graduated = opened.filter((l) => "graduated" in l && l.graduated);
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
      // Official launches opened, of which still on their curve and graduated into DAMM v2.
      launchesOpened: opened.length,
      onCurve: opened.length - graduated.length,
      // Kept for older readers: launches still open on their curve (graduated ones are counted in `graduated`).
      openLaunches: opened.length - graduated.length,
      graduated: graduated.length,
      // SOL raised on every curve ever, split into what sits on open curves now and what graduated launches moved into DAMM v2.
      solRaisedOnCurves: opened.reduce((n, l) => n + (("raisedSol" in l && (l.graduated ? l.thresholdSol : l.raisedSol)) || 0), 0),
      solOnCurvesNow: opened.reduce((n, l) => n + (("raisedSol" in l && !l.graduated && l.raisedSol) || 0), 0),
      solRaisedByGraduated: opened.reduce((n, l) => n + (("thresholdSol" in l && l.graduated && l.thresholdSol) || 0), 0),
      testLaunchesHidden: withTests ? 0 : all.filter((l) => l.test && l.open).length,
      launches: withTests ? all : real,
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
