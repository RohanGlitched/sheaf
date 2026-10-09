/**
 * The squat that isolates the creator check, on devnet. A stranger's key (our
 * own Meteora lifecycle wallet 1, playing a stranger) opens a pool at one of
 * IDX's derived slots with everything else exactly right: the v2 preset, the
 * real launch's own prices (so the curve opens at half of NAV), locked LP,
 * fees and leftover to the treasury, DAMM v2 graduation, and even the
 * per-slot metadata URL. Only the pool creator differs, and DBC makes the pool
 * creator sign, so a stranger cannot fake it. web/lib/dbc.ts `checkLaunch` must
 * refuse it with "It was not opened by the basket's creator." and nothing else.
 *
 * The first squat (PROXY slot 0, meteora-squat-test.mjs) also broke the terms;
 * this one does not. The receipt is added to web/lib/meteora-squat.json as
 * `squatExact`.
 *
 *   BASKET=EjoW8Gy9tJTctrtWcUJtkUiee5t9RFeCB3nbamutvghE SLOT=2 SITE=http://localhost:3900 node scripts/meteora-squat-exact.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { NATIVE_SOL, ROOT, TREASURY, connection, dbc, launchInfo, launchKey, launchTerms, send, web3 } from "./meteora-lib.mjs";

const { Keypair, PublicKey } = web3;
const BASKET = process.env.BASKET;
const SLOT = Number(process.env.SLOT ?? 2);
const SITE = (process.env.SITE ?? "https://sheaf-index.vercel.app").replace(/\/$/, "");
if (!BASKET || SLOT < 1) throw new Error("Set BASKET, and a SLOT of 1 or more that is still free.");
const OUT = path.join(ROOT, "web", "lib", "meteora-squat.json");
const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "lib", "meteora-preset.json"), "utf8"));

// The squatter: lifecycle wallet 1, a key that is not the basket's creator.
const squatter = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "lifecycle-wallets.json"), "utf8"))[0]),
);
const info = launchInfo(BASKET, SLOT);
const taken = await connection.getMultipleAccountsInfo([info.pool, info.config, info.mint]);
if (taken.some(Boolean)) throw new Error(`Slot ${SLOT} is not free.`);

// The real launch's own price points (slot 0), so the curve is anchored exactly right.
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const real = await client.state.getPoolConfig(launchInfo(BASKET, 0).config);
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
  sqrtPrices,
  liquidityWeights: preset.curve.liquidityWeights,
});

const before = await connection.getBalance(squatter.publicKey);
const tx = await client.partner.createConfigAndPool({
  ...curve,
  payer: squatter.publicKey,
  config: info.config,
  feeClaimer: TREASURY,
  leftoverReceiver: TREASURY,
  quoteMint: NATIVE_SOL,
  preCreatePoolParam: {
    name: "Squat, exact terms",
    symbol: "SQUATX",
    uri: `https://sheaf-index.vercel.app/api/launch/${BASKET}/${SLOT}`,
    poolCreator: squatter.publicKey,
    baseMint: info.mint,
  },
});
tx.feePayer = squatter.publicKey;
const signature = await send(tx, [squatter, launchKey(BASKET, "config", SLOT), launchKey(BASKET, "mint", SLOT)], "exact squat");
const after = await connection.getBalance(squatter.publicKey);

const config = await connection.getAccountInfo(info.config);
const terms = launchTerms(config.data);
console.log(`terms check: ${terms.reason ?? `passes as ${terms.preset}`} (expected: passes as v2)`);
if (terms.reason) throw new Error("The exact squat should pass the terms check; only its creator differs.");

// What the site says about this slot: its per-slot metadata URL must answer "not official", for the creator.
const body = await fetch(`${SITE}/api/launch/${BASKET}/${SLOT}`).then((r) => r.json());
console.log(`metadata for slot ${SLOT}: ${body?.name}; ${body?.provenance?.reason}`);
console.log(`cost ${(before - after) / 1e9} SOL`);
if (body?.provenance?.reason !== "It was not opened by the basket's creator.") throw new Error("The creator check did not refuse the exact squat.");

const receipts = JSON.parse(fs.readFileSync(OUT, "utf8"));
receipts.squatExact = {
  slot: SLOT,
  basket: BASKET,
  squatter: squatter.publicKey.toBase58(),
  pool: info.pool.toBase58(),
  signature,
  costSol: (before - after) / 1e9,
  reason: body.provenance.reason,
  note: "Opened by a key that is not the basket's creator (our own lifecycle wallet 1, playing a stranger) on the exact v2 terms at the real launch's prices, with the per-slot metadata URL. The terms pass; the creator check alone refuses it.",
  at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(receipts, null, 2) + "\n");
