/**
 * The second attack on Sheaf's launch check, on devnet: the basket's own
 * creator opens a pool on rogue terms.
 *
 * The squat test (meteora-squat-test.mjs) proved a stranger cannot pass the
 * creator check. This one plays a creator who skips the UI and scripts
 * `createConfigAndPool` at a free derived slot of their own basket. Everything
 * matches the current preset (same curve, fees, treasury as fee claimer and
 * leftover receiver, DAMM v2 graduation) except one term: half the graduated
 * liquidity goes to the creator unlocked, withdrawable after graduation, where
 * the preset locks all of it. web/lib/dbc.ts `checkLaunch` must report it as
 * unofficial on the terms, not on who opened it.
 *
 * The creator here is the house key, the creator of PROXY, so the creator
 * check passes. It uses PROXY's slot 2: slot 0 holds the squat, slot 1 the real
 * launch. The receipt is added to web/lib/meteora-squat.json.
 *
 *   BASKET=FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8 SLOT=2 node scripts/meteora-rogue-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import {
  NATIVE_SOL,
  ROOT,
  TREASURY,
  connection,
  dbc,
  houseKey,
  launchInfo,
  launchKey,
  launchTerms,
  send,
  web3,
} from "./meteora-lib.mjs";

const { PublicKey } = web3;
const BASKET = process.env.BASKET;
const SLOT = Number(process.env.SLOT ?? 2);
if (!BASKET || SLOT < 1) throw new Error("Set BASKET, and a SLOT of 1 or more that is still free.");
const OUT = path.join(ROOT, "web", "lib", "meteora-squat.json");
const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "lib", "meteora-preset.json"), "utf8"));

const creator = houseKey();
const info = launchInfo(BASKET, SLOT);
const taken = await connection.getMultipleAccountsInfo([info.pool, info.config, info.mint]);
if (taken.some(Boolean)) throw new Error(`Slot ${SLOT} is not free.`);

// The same price points as the basket's real v2 launch (slot 1), so only the terms differ.
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const real = await client.state.getPoolConfig(launchInfo(BASKET, 1).config);
const sqrtPrices = [real.sqrtStartPrice, ...real.curve.slice(0, preset.curve.liquidityWeights.length).map((p) => p.sqrtPrice)];

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
  // The one rogue term: the creator's half of the graduated liquidity is not locked.
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 50,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 50,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: dbc.ActivationType.Timestamp,
  sqrtPrices,
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
    name: "Rogue terms test",
    symbol: "ROGUE",
    uri: `https://sheaf-index.vercel.app/api/launch/${BASKET}`,
    poolCreator: creator.publicKey,
    baseMint: info.mint,
  },
});
tx.feePayer = creator.publicKey;
const signature = await send(tx, [creator, launchKey(BASKET, "config", SLOT), launchKey(BASKET, "mint", SLOT)], "rogue terms");
const after = await connection.getBalance(creator.publicKey);

const [pool, config] = await connection.getMultipleAccountsInfo([info.pool, info.config]);
const poolCreator = new PublicKey(pool.data.subarray(104, 136)).toBase58();
const verdict = launchTerms(config.data);
console.log(`pool ${info.pool.toBase58()} creator ${poolCreator} (basket creator: ${creator.publicKey.toBase58()})`);
console.log(`terms check: ${verdict.reason ?? `passes as ${verdict.preset}`}`);
console.log(`cost ${(before - after) / 1e9} SOL`);
if (!verdict.reason) throw new Error("The rogue pool passed the terms check. checkLaunch is broken.");

const receipts = JSON.parse(fs.readFileSync(OUT, "utf8"));
receipts.rogueTerms = {
  slot: SLOT,
  creator: creator.publicKey.toBase58(),
  pool: info.pool.toBase58(),
  signature,
  costSol: (before - after) / 1e9,
  rogueTerm: "creator_liquidity_percentage = 50 (unlocked), creator_permanent_locked_liquidity_percentage = 0",
  reason: verdict.reason,
  note: "Opened by the basket's own creator (the house key) on the v2 curve and fees, with one rogue term: half the graduated LP withdrawable. The creator check passes; checkLaunch rejects it on its terms.",
  at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(receipts, null, 2) + "\n");
