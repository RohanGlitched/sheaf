/**
 * The third attack on Sheaf's launch check, on devnet: the basket's own
 * creator opens a pool on the exact published terms, but anchored at the
 * wrong price.
 *
 * Everything matches the v2 preset (curve shape, weights, fees, locked LP,
 * immutable token, treasury as fee claimer and leftover receiver), so the
 * creator and terms checks both pass. Only the anchor is off: the curve opens
 * at 1x the basket's NAV instead of 0.5x, so every price on it is 2x. The
 * server's anchor check (web/app/api/launch/anchor.ts) must call it a
 * mismatch, list it as unofficial, and keep the basket's real launch (slot 0).
 *
 * The creator is the house key, IDX's creator; the pool goes in IDX's free
 * slot 1. The receipt is added to web/lib/meteora-squat.json as `rogueAnchor`.
 *
 *   BASKET=EjoW8Gy9tJTctrtWcUJtkUiee5t9RFeCB3nbamutvghE SLOT=1 SITE=http://localhost:3900 node scripts/meteora-anchor-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { NATIVE_SOL, ROOT, TREASURY, connection, dbc, houseKey, launchInfo, launchKey, launchTerms, send } from "./meteora-lib.mjs";

const BASKET = process.env.BASKET;
const SLOT = Number(process.env.SLOT ?? 1);
const SITE = (process.env.SITE ?? "https://sheaf-index.vercel.app").replace(/\/$/, "");
if (!BASKET || SLOT < 1) throw new Error("Set BASKET, and a SLOT of 1 or more that is still free.");
const OUT = path.join(ROOT, "web", "lib", "meteora-squat.json");
const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "lib", "meteora-preset.json"), "utf8"));
const MULTIPLE = 2;

const creator = houseKey();
const info = launchInfo(BASKET, SLOT);
const taken = await connection.getMultipleAccountsInfo([info.pool, info.config, info.mint]);
if (taken.some(Boolean)) throw new Error(`Slot ${SLOT} is not free.`);

// The real launch's opening market cap (slot 0), which is 0.5x NAV; the rogue opens at twice it.
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const real = await client.state.getPoolConfig(launchInfo(BASKET, 0).config);
const openCap = (Number(real.sqrtStartPrice.toString()) / 2 ** 64) ** 2 * 10 ** (6 - 9) * 1_000_000_000;
const rogueOpen = openCap * MULTIPLE;

const fee = preset.fees.antiSnipe;
const curve = dbc.buildCurveWithCustomSqrtPrices({
  token: {
    tokenType: dbc.TokenType.Token2022,
    tokenBaseDecimal: dbc.TokenDecimal.SIX,
    tokenQuoteDecimal: dbc.TokenDecimal.NINE,
    tokenAuthorityOption: dbc.TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 1_000_000_000 * (preset.leftoverPercentOfSupply / 100),
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: dbc.BaseFeeMode.FeeSchedulerExponential,
      feeSchedulerParam: {
        startingFeeBps: fee.startingFeeBps,
        endingFeeBps: fee.endingFeeBps,
        numberOfPeriod: fee.numberOfPeriod,
        totalDuration: fee.totalDurationSeconds,
      },
    },
    dynamicFeeEnabled: true,
    collectFeeMode: dbc.CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: preset.fees.creatorTradingFeePercentage,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: dbc.MigrationOption.MET_DAMM_V2,
    migrationFeeOption: dbc.MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: preset.migration.migrationFeePercentage, creatorFeePercentage: 0 },
    migratedPoolFee: {
      collectFeeMode: dbc.MigratedCollectFeeMode.QuoteToken,
      dynamicFee: 0,
      poolFeeBps: preset.migration.dammV2.startingFeeBps,
      baseFeeMode: dbc.DammV2BaseFeeMode.FeeMarketCapSchedulerExponential,
      marketCapFeeSchedulerParams: {
        endingBaseFeeBps: preset.migration.dammV2.endingFeeBps,
        numberOfPeriod: preset.migration.dammV2.numberOfPeriod,
        priceMultiple: preset.migration.dammV2.priceMultiple,
        schedulerExpirationDuration: preset.migration.dammV2.schedulerExpirationSeconds,
      },
    },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 50,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: dbc.ActivationType.Timestamp,
  // The one wrong thing: every price is MULTIPLE times the preset's.
  sqrtPrices: preset.curve.capMultiplesOfOpen.map((c) => dbc.getSqrtPriceFromMarketCap(rogueOpen * c, 1_000_000_000, 6, 9)),
  liquidityWeights: preset.curve.liquidityWeights,
});

const before = await connection.getBalance(creator.publicKey);
const tx = await client.partner.createConfigAndPool({
  ...curve,
  payer: creator.publicKey,
  config: info.config,
  feeClaimer: TREASURY,
  leftoverReceiver: TREASURY,
  quoteMint: NATIVE_SOL,
  preCreatePoolParam: {
    name: "Rogue anchor test",
    symbol: "ROGUEA",
    uri: `https://sheaf-index.vercel.app/api/launch/${BASKET}`,
    poolCreator: creator.publicKey,
    baseMint: info.mint,
  },
});
tx.feePayer = creator.publicKey;
const signature = await send(tx, [creator, launchKey(BASKET, "config", SLOT), launchKey(BASKET, "mint", SLOT)], "rogue anchor");
const after = await connection.getBalance(creator.publicKey);

const config = await connection.getAccountInfo(info.config);
const terms = launchTerms(config.data);
console.log(`terms check: ${terms.reason ?? `passes as ${terms.preset}`} (expected: passes as v2)`);
if (terms.reason) throw new Error("The rogue-anchor pool should pass the terms check; only its anchor is wrong.");

// The server decides the anchor; read its verdict for this pool.
const body = await fetch(`${SITE}/api/launch/${BASKET}`).then((r) => r.json());
const refused = body?.provenance?.rejected?.find((r) => r.pool === info.pool.toBase58());
console.log(`anchor: ${refused ? `rejected, ${refused.reason} (deviation ${refused.anchor?.deviationPct}%)` : "NOT rejected"}`);
console.log(`the basket's launch is still slot ${body?.provenance?.slot}, anchor ${body?.provenance?.anchor?.status}`);
console.log(`cost ${(before - after) / 1e9} SOL`);
if (!refused) throw new Error("The anchor check did not refuse the rogue-anchor pool.");

const receipts = JSON.parse(fs.readFileSync(OUT, "utf8"));
receipts.rogueAnchor = {
  slot: SLOT,
  basket: BASKET,
  creator: creator.publicKey.toBase58(),
  pool: info.pool.toBase58(),
  signature,
  costSol: (before - after) / 1e9,
  rogueTerm: `opening market cap ${rogueOpen.toFixed(6)} SOL: ${MULTIPLE}x the real launch's, so the curve opens at 1x NAV, not 0.5x`,
  reason: refused.reason,
  deviationPct: refused.anchor?.deviationPct ?? null,
  note: "Opened by the basket's own creator (the house key) on the exact v2 terms with every price doubled. The creator and terms checks pass; the anchor check rejects it, and the basket's real launch stays slot 0.",
  at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(receipts, null, 2) + "\n");
