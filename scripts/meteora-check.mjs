/**
 * Devnet assertion that the hand-rolled offsets in web/lib/dbc.ts still match
 * the DBC program's layouts, by decoding the same accounts with the SDK and
 * comparing field by field, and that the official-launch terms check gives the
 * expected verdict on every known pool: the real launches pass on their
 * preset, the squat and the rogue-terms pool fail. Exits non-zero on any
 * mismatch, so a layout upgrade or a broken check fails loudly here instead of
 * silently in the UI.
 *
 *   node scripts/meteora-check.mjs
 */
import { BASKETS, DBC_PROGRAM, TREASURY, connection, dbc, launchInfo, launchTerms, web3 } from "./meteora-lib.mjs";

const { PublicKey } = web3;
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const u64 = (d, at) => d.readBigUInt64LE(at);
const u128 = (d, at) => u64(d, at) | (u64(d, at + 8) << 64n);
const key = (d, at) => new PublicKey(d.subarray(at, at + 32)).toBase58();

// The offsets web/lib/dbc.ts reads. Keep the two in step.
const POOL = { config: 72, creator: 104, baseMint: 136, quoteReserve: 240, sqrtPrice: 280, activationPoint: 296, isMigrated: 305, protocolQuoteFee: 320, totalFees: 336, creatorQuoteFee: 360, partnerQuoteFee: 272 };
const CONFIG = {
  quoteMint: 8, feeClaimer: 40, leftoverReceiver: 72,
  baseFeeCliff: 104, baseFeeSecond: 112, baseFeeThird: 120, baseFeeFirst: 128, baseFeeMode: 130,
  dynamicFeeOn: 136, maxVolatility: 144, variableFeeControl: 148,
  partnerVestingPercent: 185, creatorVestingPercent: 201,
  collectFeeMode: 232, migrationOption: 233, activationType: 234, tokenType: 237,
  partnerLockedLp: 239, partnerLp: 240, creatorLockedLp: 241, creatorLp: 242, migrationFeeOption: 243,
  creatorTradingFee: 245, tokenUpdateAuthority: 246, migrationFee: 247, creatorMigrationFee: 248,
  threshold: 264, migrationSqrtPrice: 280, vestingPerPeriod: 296, vestingCliffUnlock: 328,
  migratedPoolFeeBps: 362, migratedPoolFeeMode: 364, sqrtStartPrice: 392, curve: 408,
};

let failures = 0;
function check(label, hand, sdk) {
  const ok = String(hand) === String(sdk);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${hand}${ok ? "" : ` (sdk ${sdk})`}`);
}

const PROXY = "FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8";
// [name, basket, slot, the terms verdict the check must give]. BIG5A and
// FRNTRA are v1 (slot activation); PROXYA is v2 (timestamp activation, slot 1
// because slot 0 was squatted on purpose). The squat in PROXY's slot 0 and the
// creator-signed rogue pool in its slot 2 must both fail the terms check.
const LAUNCHES = [
  ["BIG5A", BASKETS.BIG5, 0, "v1"],
  ["FRNTRA", BASKETS.FRNTR, 0, "v1"],
  ["PROXYA", PROXY, 1, "v2"],
  ["IDXA", "EjoW8Gy9tJTctrtWcUJtkUiee5t9RFeCB3nbamutvghE", 0, "v2"],
  ["squat", PROXY, 0, "rejected"],
  ["rogue terms", PROXY, 2, "rejected"],
];
for (const [name, basket, slot, expected] of LAUNCHES) {
  const info = launchInfo(basket, slot);
  const [poolAcc, configAcc] = await connection.getMultipleAccountsInfo([info.pool, info.config]);
  if (!poolAcc || !configAcc) {
    console.log(`${name}: no pool at slot ${slot}`);
    continue;
  }
  console.log(`${name}  pool ${info.pool.toBase58()}`);
  check("pool owner is DBC", poolAcc.owner.equals(DBC_PROGRAM), true);
  check("config owner is DBC", configAcc.owner.equals(DBC_PROGRAM), true);
  const pool = (await client.state.getPool(info.pool)).poolState;
  const config = await client.state.getPoolConfig(info.config);
  const p = poolAcc.data;
  const c = configAcc.data;
  check("pool.config", key(p, POOL.config), pool.config.toBase58());
  check("pool.creator", key(p, POOL.creator), pool.creator.toBase58());
  check("pool.baseMint", key(p, POOL.baseMint), pool.baseMint.toBase58());
  check("pool.quoteReserve", u64(p, POOL.quoteReserve), pool.quoteReserve.toString());
  check("pool.partnerQuoteFee", u64(p, POOL.partnerQuoteFee), pool.partnerQuoteFee.toString());
  check("pool.sqrtPrice", u128(p, POOL.sqrtPrice), pool.sqrtPrice.toString());
  check("pool.activationPoint", u64(p, POOL.activationPoint), pool.activationPoint.toString());
  check("pool.isMigrated", p[POOL.isMigrated], pool.isMigrated);
  check("pool.metrics.totalProtocolQuoteFee", u64(p, POOL.protocolQuoteFee), pool.metrics.totalProtocolQuoteFee.toString());
  check("pool.metrics.totalTradingQuoteFee", u64(p, POOL.totalFees), pool.metrics.totalTradingQuoteFee.toString());
  check("pool.creatorQuoteFee", u64(p, POOL.creatorQuoteFee), pool.creatorQuoteFee.toString());
  check("config.quoteMint", key(c, CONFIG.quoteMint), config.quoteMint.toBase58());
  check("config.feeClaimer", key(c, CONFIG.feeClaimer), config.feeClaimer.toBase58());
  check("config.leftoverReceiver", key(c, CONFIG.leftoverReceiver), config.leftoverReceiver.toBase58());
  const base = config.poolFees.baseFee;
  check("config.baseFee.cliffFeeNumerator", u64(c, CONFIG.baseFeeCliff), base.cliffFeeNumerator.toString());
  check("config.baseFee.secondFactor", u64(c, CONFIG.baseFeeSecond), base.secondFactor.toString());
  check("config.baseFee.thirdFactor", u64(c, CONFIG.baseFeeThird), base.thirdFactor.toString());
  check("config.baseFee.firstFactor", c.readUInt16LE(CONFIG.baseFeeFirst), base.firstFactor);
  check("config.baseFee.baseFeeMode", c[CONFIG.baseFeeMode], base.baseFeeMode);
  const dyn = config.poolFees.dynamicFee;
  check("config.dynamicFee.initialized", c[CONFIG.dynamicFeeOn], dyn.initialized);
  check("config.dynamicFee.maxVolatilityAccumulator", c.readUInt32LE(CONFIG.maxVolatility), dyn.maxVolatilityAccumulator);
  check("config.dynamicFee.variableFeeControl", c.readUInt32LE(CONFIG.variableFeeControl), dyn.variableFeeControl);
  check("config.partnerLiquidityVestingInfo.vestingPercentage", c[CONFIG.partnerVestingPercent], config.partnerLiquidityVestingInfo.vestingPercentage);
  check("config.creatorLiquidityVestingInfo.vestingPercentage", c[CONFIG.creatorVestingPercent], config.creatorLiquidityVestingInfo.vestingPercentage);
  check("config.collectFeeMode", c[CONFIG.collectFeeMode], config.collectFeeMode);
  check("config.migrationOption", c[CONFIG.migrationOption], config.migrationOption);
  check("config.activationType", c[CONFIG.activationType], config.activationType);
  check("config.tokenType", c[CONFIG.tokenType], config.tokenType);
  check("config.partnerPermanentLockedLiquidityPercentage", c[CONFIG.partnerLockedLp], config.partnerPermanentLockedLiquidityPercentage);
  check("config.partnerLiquidityPercentage", c[CONFIG.partnerLp], config.partnerLiquidityPercentage);
  check("config.creatorPermanentLockedLiquidityPercentage", c[CONFIG.creatorLockedLp], config.creatorPermanentLockedLiquidityPercentage);
  check("config.creatorLiquidityPercentage", c[CONFIG.creatorLp], config.creatorLiquidityPercentage);
  check("config.migrationFeeOption", c[CONFIG.migrationFeeOption], config.migrationFeeOption);
  check("config.creatorTradingFeePercentage", c[CONFIG.creatorTradingFee], config.creatorTradingFeePercentage);
  check("config.tokenUpdateAuthority", c[CONFIG.tokenUpdateAuthority], config.tokenUpdateAuthority);
  check("config.migrationFeePercentage", c[CONFIG.migrationFee], config.migrationFeePercentage);
  check("config.creatorMigrationFeePercentage", c[CONFIG.creatorMigrationFee], config.creatorMigrationFeePercentage);
  check("config.migrationQuoteThreshold", u64(c, CONFIG.threshold), config.migrationQuoteThreshold.toString());
  check("config.migrationSqrtPrice", u128(c, CONFIG.migrationSqrtPrice), config.migrationSqrtPrice.toString());
  check("config.lockedVestingConfig.amountPerPeriod", u64(c, CONFIG.vestingPerPeriod), config.lockedVestingConfig.amountPerPeriod.toString());
  check("config.lockedVestingConfig.cliffUnlockAmount", u64(c, CONFIG.vestingCliffUnlock), config.lockedVestingConfig.cliffUnlockAmount.toString());
  check("config.migratedPoolFeeBps", c.readUInt16LE(CONFIG.migratedPoolFeeBps), config.migratedPoolFeeBps);
  check("config.migratedPoolBaseFeeMode", c[CONFIG.migratedPoolFeeMode], config.migratedPoolBaseFeeMode);
  check("config.sqrtStartPrice", u128(c, CONFIG.sqrtStartPrice), config.sqrtStartPrice.toString());
  check("config.curve[0].sqrtPrice", u128(c, CONFIG.curve), config.curve[0].sqrtPrice.toString());
  check("config.curve[0].liquidity", u128(c, CONFIG.curve + 16), config.curve[0].liquidity.toString());
  check("fee claimer is the treasury", key(c, CONFIG.feeClaimer), TREASURY.toBase58());
  const verdict = launchTerms(c);
  check("terms check", verdict.preset ?? "rejected", expected);
  if (verdict.reason) console.log(`  reason: ${verdict.reason}`);
  console.log(
    `  info: threshold ${Number(config.migrationQuoteThreshold) / 1e9} SOL, raised ${Number(pool.quoteReserve) / 1e9} SOL, activation ${config.activationType === 0 ? "slot" : "timestamp"}, ` +
      `fee cliff ${base.cliffFeeNumerator.toString()} periods ${base.firstFactor} period ${base.secondFactor.toString()} reduction ${base.thirdFactor.toString()}`,
  );
}

if (failures) {
  console.error(`${failures} mismatch(es): web/lib/dbc.ts offsets or the terms check are out of date.`);
  process.exit(1);
}
console.log("Decoder offsets match the SDK, and the terms check gives every expected verdict.");
