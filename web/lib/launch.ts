import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  LAUNCH_DECIMALS,
  LAUNCH_SUPPLY,
  NATIVE_SOL,
  TREASURY,
  findLaunch,
  launchKeys,
  launchName,
  launchSymbol,
} from "./dbc";
import { SITE_URL } from "./config";
import preset from "./meteora-preset.json";

/**
 * Sheaf's "NAV shelf" curve, the preset every new launch is opened with. The
 * numbers live in `meteora-preset.json` so anyone can reuse them (see
 * docs/meteora.md); this module turns them into a DBC config.
 *
 * The curve opens at half the basket's NAV and graduates at five times it.
 * Four segments, as market-cap breakpoints relative to the open
 * (1 → 1.5 → 2.5 → 5 → 10) with liquidity weights 3 : 3 : 3 : 4. On those
 * numbers (from the SDK's own curve builder):
 *   - about 74% of supply is sold on the curve and about 25% goes into the
 *     graduated DAMM v2 pool, so the locked pool is a real market, not 6% of
 *     the cap (the first preset gave the pool 6%);
 *   - the first fifth of the SOL raised buys about 34% of supply (the first
 *     preset: 44%), so a single early wallet cannot take half the token;
 *   - half the raise is in by about 2.5 × NAV.
 * Launches opened before this preset keep their own curve (0.5× → 20× NAV);
 * every figure on the site is read from each pool's own config, so both draw
 * correctly.
 */
export const OPEN_MULTIPLE = preset.openMultipleOfNav;
export const GRADUATION_MULTIPLE = preset.graduationMultipleOfNav;
/** Share of curve trading fees that goes to the basket's creator; the rest to Sheaf. */
export const CREATOR_FEE_SHARE = preset.fees.creatorTradingFeePercentage;
export const LAUNCH_SHAPE = { caps: preset.curve.capMultiplesOfOpen, weights: preset.curve.liquidityWeights };
/** The anti-snipe opening fee, in seconds: it starts high and decays to the base fee. */
export const LAUNCH_FEE = preset.fees.antiSnipe;

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
 * mint keys of the first free slot; the creator's wallet pays and signs last.
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
    DammV2BaseFeeMode,
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");

  // A basket has one launch. If a squatter took an earlier derived slot, the
  // launch goes into the next free one; readers check every slot and only
  // count a pool its basket's creator opened.
  const found = await findLaunch(connection, { ...basket, creator: creator.toBase58() });
  if (found.launch) throw new Error("This basket's launch market is already open.");
  if (!found.free) throw new Error("Every launch address for this basket is taken. Nothing was sent.");
  const slot = found.free.slot ?? 0;

  const openCap = navSol * OPEN_MULTIPLE;
  const curve = buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      // No upgrade path for the token, the same reason a share mint has no freeze authority.
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: LAUNCH_SUPPLY,
      leftover: LAUNCH_SUPPLY * (preset.leftoverPercentOfSupply / 100),
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        // Anti-snipe, counted in seconds (ActivationType.Timestamp below): 25%
        // in the first ten seconds, decaying every ten seconds to 1% at ten
        // minutes. A bot buying in the opening block pays a quarter of its
        // order to the creator and the treasury; a person who comes at minute
        // ten pays the base fee.
        feeSchedulerParam: {
          startingFeeBps: LAUNCH_FEE.startingFeeBps,
          endingFeeBps: LAUNCH_FEE.endingFeeBps,
          numberOfPeriod: LAUNCH_FEE.numberOfPeriod,
          totalDuration: LAUNCH_FEE.totalDurationSeconds,
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
      migrationFee: { feePercentage: preset.migration.migrationFeePercentage, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: 0,
        poolFeeBps: preset.migration.dammV2.startingFeeBps,
        // A graduation cushion: the DAMM v2 pool opens at 2% and its fee only
        // falls, to 1%, as the market cap doubles from graduation. Selling into
        // a falling pool right after graduation pays the higher fee to the
        // locked LP; a token that holds its price trades at 1%.
        baseFeeMode: DammV2BaseFeeMode.FeeMarketCapSchedulerExponential,
        marketCapFeeSchedulerParams: {
          endingBaseFeeBps: preset.migration.dammV2.endingFeeBps,
          numberOfPeriod: preset.migration.dammV2.numberOfPeriod,
          priceMultiple: preset.migration.dammV2.priceMultiple,
          schedulerExpirationDuration: preset.migration.dammV2.schedulerExpirationSeconds,
        },
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
    // Seconds, not slots: the fee schedule above means ten real minutes.
    activationType: ActivationType.Timestamp,
    sqrtPrices: LAUNCH_SHAPE.caps.map((c) =>
      getSqrtPriceFromMarketCap(openCap * c, LAUNCH_SUPPLY, LAUNCH_DECIMALS, 9),
    ),
    liquidityWeights: LAUNCH_SHAPE.weights,
  });

  const { config, mint } = await launchKeys(basket.address, slot);
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
