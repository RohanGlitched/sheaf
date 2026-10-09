/**
 * One small curve buy on devnet, printing the fee the pool charged, to check a
 * launch's fee schedule against its preset.
 *
 *   BASKET=<address> SLOT=1 SOL=0.01 WALLET=1 node scripts/meteora-buy.mjs
 *
 * WALLET is an index into .keys/lifecycle-wallets.json, or `house` for the
 * house key. A house buy is Sheaf buying its own launch: it is appended to
 * web/lib/meteora-house-buys.json, the site tags it "house buy" wherever trades
 * are listed, and it never counts as traction.
 */
import fs from "node:fs";
import path from "node:path";
import { BN, ROOT, connection, dbc, houseKey, launchInfo, send, web3 } from "./meteora-lib.mjs";

const { Keypair } = web3;
const BASKET = process.env.BASKET;
if (!BASKET) throw new Error("Set BASKET.");
const SLOT = Number(process.env.SLOT ?? 0);
const info = launchInfo(BASKET, SLOT);
const house = process.env.WALLET === "house";
const wallet = house
  ? houseKey()
  : Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "lifecycle-wallets.json"), "utf8"))[Number(process.env.WALLET ?? 1)],
      ),
    );
const solIn = Number(process.env.SOL ?? 0.01);
if (!(solIn > 0 && solIn <= 0.05)) throw new Error("SOL must be between 0 and 0.05: this script makes small test buys only.");
const lamports = BigInt(Math.round(solIn * 1e9));

const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const virtualPool = await client.state.getPool(info.pool);
const config = await client.state.getPoolConfig(info.config);
if (!virtualPool || !config) throw new Error("No pool at that basket and slot.");
if (virtualPool.poolState.quoteReserve.add(new BN(lamports.toString())).gte(config.migrationQuoteThreshold)) {
  throw new Error("This buy would fill the curve. These test buys must never graduate a launch.");
}
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
const signature = await send(tx, [wallet], house ? "house buy" : "buy");

if (house) {
  const file = path.join(ROOT, "web", "lib", "meteora-house-buys.json");
  const log = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {
        note: "Sheaf's own buys on its launch curves, from the house key, so the curves show trades. Ours, labelled 'house buy' wherever trades are listed, and never counted as traction.",
        wallet: wallet.publicKey.toBase58(),
        buys: [],
      };
  log.buys.push({
    label: "house buy",
    basket: BASKET,
    slot: SLOT,
    pool: info.pool.toBase58(),
    sol: solIn,
    feePercent: Number(((fee / Number(lamports)) * 100).toFixed(2)),
    signature,
    at: new Date().toISOString(),
  });
  fs.writeFileSync(file, JSON.stringify(log, null, 2) + "\n");
}
