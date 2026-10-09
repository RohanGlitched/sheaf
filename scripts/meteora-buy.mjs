/**
 * One small curve buy on devnet from a lifecycle wallet, printing the fee the
 * pool charged, to check a launch's fee schedule against its preset.
 *
 *   BASKET=<address> SLOT=1 SOL=0.01 WALLET=1 node scripts/meteora-buy.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { BN, ROOT, connection, dbc, launchInfo, send, web3 } from "./meteora-lib.mjs";

const { Keypair } = web3;
const BASKET = process.env.BASKET;
if (!BASKET) throw new Error("Set BASKET.");
const info = launchInfo(BASKET, Number(process.env.SLOT ?? 0));
const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "lifecycle-wallets.json"), "utf8"));
const wallet = Keypair.fromSecretKey(Uint8Array.from(wallets[Number(process.env.WALLET ?? 1)]));
const lamports = BigInt(Math.round(Number(process.env.SOL ?? 0.01) * 1e9));

const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const virtualPool = await client.state.getPool(info.pool);
const config = await client.state.getPoolConfig(info.config);
const currentPoint = await dbc.getCurrentPoint(connection, config.activationType);
const amountIn = new BN(lamports.toString());
const quote = client.pool.swapQuote2({
  virtualPool,
  config,
  swapBaseForQuote: false,
  swapMode: dbc.SwapMode.ExactIn,
  amountIn,
  slippageBps: 300,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint,
});
const fee = Number(quote.tradingFee ?? 0) + Number(quote.protocolFee ?? 0);
const elapsed = Number(currentPoint.toString()) - Number(virtualPool.poolState.activationPoint.toString());
console.log(`activation ${config.activationType === 1 ? "timestamp" : "slot"}, ${elapsed} ${config.activationType === 1 ? "s" : "slots"} since open, fee on this buy ${((fee / Number(lamports)) * 100).toFixed(2)}%`);
const tx = await client.pool.swap2({
  owner: wallet.publicKey,
  pool: info.pool,
  swapMode: dbc.SwapMode.ExactIn,
  amountIn,
  minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
  swapBaseForQuote: false,
  referralTokenAccount: null,
});
tx.feePayer = wallet.publicKey;
await send(tx, [wallet], "buy");
