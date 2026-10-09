import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import {
  DynamicBondingCurveClient,
  SwapMode as CurveSwapMode,
  getCurrentPoint,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  CpAmm,
  SwapMode as PoolSwapMode,
  getTokenProgram,
  getUnClaimLpFee,
} from "@meteora-ag/cp-amm-sdk";
import { CURVE_FULL, NATIVE_SOL, dammV2PoolAddress, type DbcPoolInfo } from "./dbc";

export type Side = "buy" | "sell";

/**
 * What the quote behind a trade said, for the receipt: the input it spends
 * (a partial-fill buy at the end of a curve can spend less than asked), what
 * comes out, and the fee, all in raw units (lamports for SOL). Both markets
 * collect fees in SOL, so `feeLamports` is the whole fee, Meteora's share
 * included.
 */
export type TradeQuote = { spent: bigint; out: bigint; feeLamports: bigint };

const big = (value: { toString(): string } | null | undefined): bigint => BigInt(value?.toString() ?? "0");

/** One percent of slippage, in basis points, for both markets. */
const SLIPPAGE_BPS = 100;

/**
 * A buy or a sell of a launch token, on whichever market it trades on now: the
 * bonding curve before graduation, the DAMM v2 pool after. Buys spend
 * `amount` lamports of SOL; sells spend `amount` raw units of the token. Load
 * this module on the click, so neither SDK sits on a page load.
 */
export async function buildTrade(params: {
  connection: Connection;
  owner: PublicKey;
  info: DbcPoolInfo;
  side: Side;
  amount: bigint;
  graduated: boolean;
}): Promise<{ transaction: Transaction; quote: TradeQuote }> {
  return params.graduated ? buildPoolTrade(params) : buildCurveTrade(params);
}

async function buildCurveTrade({
  connection,
  owner,
  info,
  side,
  amount,
}: {
  connection: Connection;
  owner: PublicKey;
  info: DbcPoolInfo;
  side: Side;
  amount: bigint;
}): Promise<{ transaction: Transaction; quote: TradeQuote }> {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const pool = new PublicKey(info.pool);
  const [virtualPool, config] = await Promise.all([
    client.state.getPool(pool),
    client.state.getPoolConfig(info.config),
  ]);
  if (!virtualPool || !config) throw new Error("The pool could not be read.");
  // A full curve takes no more trades either way until it graduates; say so
  // rather than sending a swap the program will reject.
  if (virtualPool.poolState.quoteReserve.gte(config.migrationQuoteThreshold)) {
    throw new Error(CURVE_FULL);
  }

  // A buy bigger than what is left on the curve takes the rest and refunds the
  // difference rather than failing at the last step; a sell is exact.
  const swapMode = side === "buy" ? CurveSwapMode.PartialFill : CurveSwapMode.ExactIn;
  const swapBaseForQuote = side === "sell";
  const amountIn = new BN(amount.toString());
  const quote = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote,
    swapMode,
    amountIn,
    slippageBps: SLIPPAGE_BPS,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await getCurrentPoint(connection, config.activationType),
  });
  const transaction = await client.pool.swap2({
    owner,
    pool,
    swapMode,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
    swapBaseForQuote,
    referralTokenAccount: null,
  });
  return {
    transaction,
    quote: {
      spent: big(quote.includedFeeInputAmount) > 0n ? big(quote.includedFeeInputAmount) : amount,
      out: big(quote.outputAmount),
      feeLamports: big(quote.tradingFee) + big(quote.protocolFee) + big(quote.referralFee),
    },
  };
}

async function buildPoolTrade({
  connection,
  owner,
  info,
  side,
  amount,
}: {
  connection: Connection;
  owner: PublicKey;
  info: DbcPoolInfo;
  side: Side;
  amount: bigint;
}): Promise<{ transaction: Transaction; quote: TradeQuote }> {
  const amm = new CpAmm(connection);
  const pool = new PublicKey(dammV2PoolAddress(info.baseMint));
  const poolState = await amm.fetchPoolState(pool);
  const base = new PublicKey(info.baseMint);
  const [inputTokenMint, outputTokenMint] = side === "buy" ? [NATIVE_SOL, base] : [base, NATIVE_SOL];
  const decimals = (mint: PublicKey) => (mint.equals(NATIVE_SOL) ? 9 : info.baseDecimals);

  // The pool counts time in slots or seconds, whichever it was activated by.
  const currentPoint =
    poolState.activationType === 0
      ? new BN(await connection.getSlot())
      : new BN(Math.floor(Date.now() / 1000));
  const amountIn = new BN(amount.toString());
  const quote = amm.getQuote2({
    inputTokenMint,
    slippage: SLIPPAGE_BPS / 100,
    currentPoint,
    poolState,
    tokenADecimal: decimals(poolState.tokenAMint),
    tokenBDecimal: decimals(poolState.tokenBMint),
    hasReferral: false,
    swapMode: PoolSwapMode.ExactIn,
    amountIn,
  });
  const transaction = await amm.swap2({
    payer: owner,
    pool,
    inputTokenMint,
    outputTokenMint,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
    poolState,
    swapMode: PoolSwapMode.ExactIn,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
  });
  return {
    transaction,
    quote: {
      spent: amount,
      out: big(quote.outputAmount),
      feeLamports: big(quote.claimingFee) + big(quote.protocolFee) + big(quote.compoundingFee) + big(quote.referralFee),
    },
  };
}

/**
 * The locked DAMM v2 position a graduated launch gave this wallet, if any, and
 * the fees it has earned since its last claim. Graduation locks half the
 * liquidity for the creator and half for the partner, and both keep earning
 * the pool's trading fees for good.
 */
export async function readPoolPosition(params: {
  connection: Connection;
  owner: PublicKey;
  info: DbcPoolInfo;
}): Promise<{ feeSol: number; feeToken: number } | null> {
  const { connection, owner, info } = params;
  const amm = new CpAmm(connection);
  const pool = new PublicKey(dammV2PoolAddress(info.baseMint));
  const [positions, poolState] = await Promise.all([
    amm.getUserPositionByPool(pool, owner),
    amm.fetchPoolState(pool),
  ]);
  if (positions.length === 0) return null;
  const baseIsA = poolState.tokenAMint.toBase58() === info.baseMint;
  let feeSol = 0;
  let feeToken = 0;
  for (const { positionState } of positions) {
    const { feeTokenA, feeTokenB } = getUnClaimLpFee(poolState, positionState);
    const [sol, token] = baseIsA ? [feeTokenB, feeTokenA] : [feeTokenA, feeTokenB];
    feeSol += Number(sol.toString()) / 1e9;
    feeToken += Number(token.toString()) / 10 ** info.baseDecimals;
  }
  return { feeSol, feeToken };
}

/** Claims the fees on every DAMM v2 position this wallet holds in a launch's pool. */
export async function buildPoolFeeClaim(params: {
  connection: Connection;
  owner: PublicKey;
  info: DbcPoolInfo;
}): Promise<Transaction> {
  const { connection, owner, info } = params;
  const amm = new CpAmm(connection);
  const pool = new PublicKey(dammV2PoolAddress(info.baseMint));
  const [positions, poolState] = await Promise.all([
    amm.getUserPositionByPool(pool, owner),
    amm.fetchPoolState(pool),
  ]);
  if (positions.length === 0) throw new Error("This wallet holds no position in the pool.");
  const transaction = new Transaction();
  for (const { position, positionNftAccount } of positions) {
    const claim = await amm.claimPositionFee({
      owner,
      position,
      pool,
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    });
    transaction.add(...claim.instructions);
  }
  return transaction;
}
