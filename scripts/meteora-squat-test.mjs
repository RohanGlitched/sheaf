/**
 * Attack Sheaf's own launch addresses on devnet, to prove the read-side check.
 *
 * A basket's launch keys are derived from its address, so their secrets are
 * public. This script plays the squatter: it recomputes the slot-0 config and
 * mint secrets for a basket the house has not launched yet and opens a pool
 * there from a throwaway wallet. To make it as convincing as it can be, the
 * squat copies everything a reader might check except the one thing it cannot
 * fake: fees and leftover go to Sheaf's treasury, it graduates into DAMM v2,
 * but the pool creator is the squatter, because DBC makes the pool creator
 * sign. web/lib/dbc.ts `checkLaunch` must then report it as unofficial, and
 * the basket's real launch must open in slot 1.
 *
 *   BASKET=<address> node scripts/meteora-squat-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, TREASURY, NATIVE_SOL, connection, dbc, launchInfo, launchKey, send, web3 } from "./meteora-lib.mjs";

const { Keypair, PublicKey } = web3;
const BASKET = process.env.BASKET;
if (!BASKET) throw new Error("Set BASKET to the basket address to squat.");
const OUT = path.join(ROOT, "web", "lib", "meteora-squat.json");

// The squatter: the first lifecycle wallet, which has devnet SOL left over.
const squatter = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "lifecycle-wallets.json"), "utf8"))[0]),
);
const info = launchInfo(BASKET, 0);
if (await connection.getAccountInfo(info.pool)) throw new Error("Slot 0 already has a pool.");

const curve = dbc.buildCurveWithMarketCap({
  token: {
    tokenType: dbc.TokenType.Token2022,
    tokenBaseDecimal: dbc.TokenDecimal.SIX,
    tokenQuoteDecimal: dbc.TokenDecimal.NINE,
    tokenAuthorityOption: dbc.TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 10_000_000,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: dbc.BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: dbc.CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 100,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: dbc.MigrationOption.MET_DAMM_V2,
    migrationFeeOption: dbc.MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 0,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityPercentage: 90,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: dbc.ActivationType.Slot,
  initialMarketCap: 5,
  migrationMarketCap: 50,
});

const tx = await new dbc.DynamicBondingCurveClient(connection, "confirmed").partner.createConfigAndPool({
  ...curve,
  payer: squatter.publicKey,
  config: info.config,
  feeClaimer: TREASURY,
  leftoverReceiver: TREASURY,
  quoteMint: NATIVE_SOL,
  preCreatePoolParam: {
    name: "Squatted launch",
    symbol: "SQUAT",
    uri: "https://example.com/squat.json",
    poolCreator: squatter.publicKey,
    baseMint: info.mint,
  },
});
tx.feePayer = squatter.publicKey;
const signature = await send(tx, [squatter, launchKey(BASKET, "config", 0), launchKey(BASKET, "mint", 0)], "squat");
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      cluster: "devnet",
      basket: BASKET,
      squatter: squatter.publicKey.toBase58(),
      pool: info.pool.toBase58(),
      signature,
      note: "A deliberate squat of slot 0 with the public derived keys: fees to the treasury, but the pool creator is not the basket's creator, so checkLaunch rejects it.",
      at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`squatted ${new PublicKey(info.pool).toBase58()}`);
