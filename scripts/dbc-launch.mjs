/**
 * Open a Meteora Dynamic Bonding Curve pool for one Sheaf basket.
 *
 * A brand-new basket has zero shares and zero liquidity, and nobody wants to be
 * the first person to assemble eight components to find out if anyone else wants
 * in. A DBC pool gives it a primary market before it needs one: a fresh token
 * whose curve is shaped around the basket's own live NAV, rather than around
 * "unknown, discover it" the way a memecoin curve is.
 *
 * Three choices are specific to composing a basket rather than launching a coin:
 *
 *   initialMarketCap       set at half the basket's own stated NAV per share,
 *                          in SOL at today's price — the curve opens near a
 *                          number Sheaf already computes, instead of at an
 *                          arbitrary round one.
 *   migrationMarketCap     20x the same NAV, so graduation triggers at a
 *                          multiple of something real.
 *   tokenAuthorityOption: Immutable
 *                          the base mint gets no upgrade path, same reason a
 *                          Sheaf share mint has no freeze authority: nothing
 *                          here should be editable after the fact.
 *
 *   node scripts/dbc-launch.mjs --url devnet --basket <address> --nav 500
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

const NATIVE_SOL = "So11111111111111111111111111111111111111112";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URLS = {
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};
const clusterArg = arg("url", "devnet");
const rpc = URLS[clusterArg] ?? clusterArg;
const basketAddress = arg("basket", "5Z8XUzGVJjcYPxPZ6Hfxx8uJRNKibFcmZd7yStuSPr1p");
const navUsd = Number(arg("nav", "500"));

const keypairPath = arg(
  "keypair",
  path.join(os.homedir(), ".config", "solana", "id.json"),
);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
);

const connection = new Connection(rpc, "confirmed");
const client = new DynamicBondingCurveClient(connection, "confirmed");

console.log(`cluster   ${clusterArg} (${rpc})`);
console.log(`payer     ${payer.publicKey.toBase58()}`);
console.log(`basket    ${basketAddress}`);

const solPrice = await fetch(`https://lite-api.jup.ag/price/v3?ids=${NATIVE_SOL}`)
  .then((r) => r.json())
  .then((body) => body[NATIVE_SOL]?.usdPrice);
if (!solPrice) throw new Error("could not read a live SOL price from Jupiter");
console.log(`SOL/USD   $${solPrice.toFixed(2)}`);

const navSol = navUsd / solPrice;
console.log(`basket NAV  $${navUsd} = ${navSol.toFixed(6)} SOL, at today's price`);

const TOTAL_SUPPLY = 1_000_000_000;

const curve = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.Token2022,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: TOTAL_SUPPLY,
    leftover: TOTAL_SUPPLY * 0.01,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
      // Anti-snipe decay: 4% at the open, down to 1% within the hour. A
      // component basket's own last-mile round trip runs ~0.17-0.26%, so even
      // the settled 1% is the price of not having to assemble eight tokens.
      feeSchedulerParam: {
        startingFeeBps: 400,
        endingFeeBps: 100,
        numberOfPeriod: 60,
        totalDuration: 3600,
      },
    },
    dynamicFeeEnabled: true,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 20,
    poolCreationFee: 0.002, // SOL; just above the SDK's own floor of 0.001
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.Customizable,
    migrationFee: { feePercentage: 1, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: CollectFeeMode.QuoteToken, dynamicFee: 0, poolFeeBps: 100 },
  },
  liquidityDistribution: {
    // All of it locked, permanently, split evenly. Nobody here can pull
    // migrated liquidity later, by construction, the same reason a Sheaf
    // vault has no withdrawal instruction a creator can call.
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
  activationType: ActivationType.Slot,
  initialMarketCap: navSol * 0.5,
  migrationMarketCap: navSol * 20,
  percentageSupplyOnMigration: 20,
});

const configKeypair = Keypair.generate();
const baseMintKeypair = Keypair.generate();

const tx = await client.partner.createConfigAndPool({
  ...curve,
  payer: payer.publicKey,
  config: configKeypair.publicKey,
  feeClaimer: payer.publicKey,
  leftoverReceiver: payer.publicKey,
  quoteMint: new PublicKey(NATIVE_SOL),
  preCreatePoolParam: {
    name: "Frontier Labs, early access",
    symbol: "FRNTRA",
    uri: "https://www.sheaf.vercel.app/basket/5Z8XUzGVJjcYPxPZ6Hfxx8uJRNKibFcmZd7yStuSPr1p",
    poolCreator: payer.publicKey,
    baseMint: baseMintKeypair.publicKey,
  },
});

tx.feePayer = payer.publicKey;
const { blockhash } = await connection.getLatestBlockhash();
tx.recentBlockhash = blockhash;

const signature = await sendAndConfirmTransaction(
  connection,
  tx,
  [payer, configKeypair, baseMintKeypair],
  { commitment: "confirmed" },
);

console.log(`\nconfig     ${configKeypair.publicKey.toBase58()}`);
console.log(`base mint  ${baseMintKeypair.publicKey.toBase58()}`);
console.log(`tx         ${signature}`);
