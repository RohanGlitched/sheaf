/**
 * Devnet assertion that the hand-rolled offsets in web/lib/dbc.ts still match
 * the DBC program's layouts, by decoding the same accounts with the SDK and
 * comparing field by field. Exits non-zero on any mismatch, so a program
 * layout upgrade fails loudly here instead of silently in the UI.
 *
 *   node scripts/meteora-check.mjs
 */
import { BASKETS, DBC_PROGRAM, TREASURY, connection, dbc, launchInfo, web3 } from "./meteora-lib.mjs";

const { PublicKey } = web3;
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const u64 = (d, at) => d.readBigUInt64LE(at);
const u128 = (d, at) => u64(d, at) | (u64(d, at + 8) << 64n);
const key = (d, at) => new PublicKey(d.subarray(at, at + 32)).toBase58();

// The offsets web/lib/dbc.ts reads. Keep the two in step.
const POOL = { config: 72, creator: 104, baseMint: 136, quoteReserve: 240, sqrtPrice: 280, isMigrated: 305, totalFees: 336, creatorQuoteFee: 360, partnerQuoteFee: 272 };
const CONFIG = { quoteMint: 8, feeClaimer: 40, leftoverReceiver: 72, migrationOption: 233, activationType: 234, threshold: 264, migrationSqrtPrice: 280, sqrtStartPrice: 392, curve: 408 };

let failures = 0;
function check(label, hand, sdk) {
  const ok = String(hand) === String(sdk);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${hand}${ok ? "" : ` (sdk ${sdk})`}`);
}

// One launch on each preset: BIG5A and FRNTRA on v1 (slot activation), PROXYA
// on v2 (timestamp activation, slot 1 because slot 0 was deliberately squatted).
const LAUNCHES = [
  ["BIG5", BASKETS.BIG5, 0],
  ["FRNTR", BASKETS.FRNTR, 0],
  ["PROXY", "FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8", 1],
];
for (const [name, basket, slot] of LAUNCHES) {
  const info = launchInfo(basket, slot);
  const [poolAcc, configAcc] = await connection.getMultipleAccountsInfo([info.pool, info.config]);
  if (!poolAcc || !configAcc) {
    console.log(`${name}: no launch at slot ${slot}`);
    continue;
  }
  console.log(`${name}A  pool ${info.pool.toBase58()}`);
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
  check("pool.isMigrated", p[POOL.isMigrated], pool.isMigrated);
  check("pool.metrics.totalTradingQuoteFee", u64(p, POOL.totalFees), pool.metrics.totalTradingQuoteFee.toString());
  check("pool.creatorQuoteFee", u64(p, POOL.creatorQuoteFee), pool.creatorQuoteFee.toString());
  check("config.quoteMint", key(c, CONFIG.quoteMint), config.quoteMint.toBase58());
  check("config.feeClaimer", key(c, CONFIG.feeClaimer), config.feeClaimer.toBase58());
  check("config.leftoverReceiver", key(c, CONFIG.leftoverReceiver), config.leftoverReceiver.toBase58());
  check("config.migrationOption", c[CONFIG.migrationOption], config.migrationOption);
  check("config.activationType", c[CONFIG.activationType], config.activationType);
  check("config.migrationQuoteThreshold", u64(c, CONFIG.threshold), config.migrationQuoteThreshold.toString());
  check("config.migrationSqrtPrice", u128(c, CONFIG.migrationSqrtPrice), config.migrationSqrtPrice.toString());
  check("config.sqrtStartPrice", u128(c, CONFIG.sqrtStartPrice), config.sqrtStartPrice.toString());
  check("config.curve[0].sqrtPrice", u128(c, CONFIG.curve), config.curve[0].sqrtPrice.toString());
  check("config.curve[0].liquidity", u128(c, CONFIG.curve + 16), config.curve[0].liquidity.toString());
  check("official: fee claimer is the treasury", key(c, CONFIG.feeClaimer), TREASURY.toBase58());
  const fees = config.poolFees.baseFee;
  console.log(
    `  info: threshold ${Number(config.migrationQuoteThreshold) / 1e9} SOL, raised ${Number(pool.quoteReserve) / 1e9} SOL, activation ${config.activationType === 0 ? "slot" : "timestamp"}, ` +
      `fee cliff ${fees.cliffFeeNumerator.toString()} periods ${fees.firstFactor} period ${fees.secondFactor.toString()} reduction ${fees.thirdFactor.toString()}`,
  );
}

if (failures) {
  console.error(`${failures} mismatch(es): web/lib/dbc.ts offsets are out of date.`);
  process.exit(1);
}
console.log("Decoder offsets match the SDK.");
