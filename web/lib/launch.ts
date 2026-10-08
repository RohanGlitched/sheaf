import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  LAUNCH_DECIMALS,
  LAUNCH_SUPPLY,
  NATIVE_SOL,
  TREASURY,
  launchKeys,
  launchName,
  launchSymbol,
} from "./dbc";
import { SITE_URL } from "./config";

/** The curve opens at half the basket's NAV and graduates at twenty times it. */
export const OPEN_MULTIPLE = 0.5;
export const GRADUATION_MULTIPLE = 20;
/** Share of curve trading fees that goes to the basket's creator; the rest to Sheaf. */
export const CREATOR_FEE_SHARE = 50;

/**
 * The curve's shape: four segments, as price breakpoints relative to the
 * opening market cap and the liquidity weight of each. Heavy early segments
 * make an opening shelf: the first fifth of the SOL raised moves the price
 * less than a quarter above the open, and half the raise is in before the
 * price reaches a sixth of graduation. Early buyers of a basket are not
 * punished for being early, and late buyers pay for the climb. Four segments
 * because the config has to fit in one transaction with the pool.
 */
export const LAUNCH_SHAPE = { caps: [1, 1.26, 2, 6.3, 40], weights: [16, 6, 2, 1] };

export async function solUsd(): Promise<number> {
  const body = await fetch(`https://lite-api.jup.ag/price/v3?ids=${NATIVE_SOL.toBase58()}`, {
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json());
  const price = body?.[NATIVE_SOL.toBase58()]?.usdPrice;
  if (!price) throw new Error("Could not read a live SOL price.");
  return price;
}

/**
 * The one transaction that opens a basket's launch: a DBC config sized off the
 * basket's NAV and the pool on it. Partially signed by the derived config and
 * mint keys; the creator's wallet pays and signs last.
 */
export async function buildLaunch(params: {
  connection: Connection;
  creator: PublicKey;
  basket: { address: string; name: string; symbol: string };
  navSol: number;
}): Promise<Transaction> {
  const { connection, creator, basket, navSol } = params;
  const {
    DynamicBondingCurveClient,
    buildCurveWithCustomSqrtPrices,
    getSqrtPriceFromMarketCap,
    TokenType,
    TokenDecimal,
    TokenAuthorityOption,
    ActivationType,
    CollectFeeMode,
    BaseFeeMode,
    MigrationOption,
    MigrationFeeOption,
    MigratedCollectFeeMode,
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");

  const openCap = navSol * OPEN_MULTIPLE;
  const curve = buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      // No upgrade path for the token, the same reason a share mint has no freeze authority.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: LAUNCH_SUPPLY,
      leftover: LAUNCH_SUPPLY * 0.01,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        // Anti-snipe: 4% at the open, decaying to 1% within the hour.
        feeSchedulerParam: {
          startingFeeBps: 400,
          endingFeeBps: 100,
          numberOfPeriod: 60,
          totalDuration: 3600,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: CREATOR_FEE_SHARE,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 1, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: 0,
        poolFeeBps: 100,
      },
    },
    // Every migrated LP position is locked for good: nobody can pull the
    // graduated pool's liquidity, the same way nobody can drain a basket vault.
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
    activationType: ActivationType.Slot,
    sqrtPrices: LAUNCH_SHAPE.caps.map((c) =>
      getSqrtPriceFromMarketCap(openCap * c, LAUNCH_SUPPLY, LAUNCH_DECIMALS, 9),
    ),
    liquidityWeights: LAUNCH_SHAPE.weights,
  });

  const { config, mint } = await launchKeys(basket.address);
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const transaction = await client.partner.createConfigAndPool({
    ...curve,
    payer: creator,
    config: config.publicKey,
    feeClaimer: TREASURY,
    leftoverReceiver: TREASURY,
    quoteMint: NATIVE_SOL,
    preCreatePoolParam: {
      name: launchName(basket.name),
      symbol: launchSymbol(basket.symbol),
      uri: `${SITE_URL}/api/launch/${basket.address}`,
      poolCreator: creator,
      baseMint: mint.publicKey,
    },
  });
  transaction.feePayer = creator;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.partialSign(config, mint);
  return transaction;
}

