import "server-only";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import { WRITE_RPC } from "./config";
import { faucetKeypair } from "./faucet-server";
import { fetchBaskets, tokenAccount, TOKEN_2022_PROGRAM_ID, type Basket } from "./sheaf";
import { fetchOrders, fetchPlans, fillOrderIx, runPlanIx, requiredShares, grossSharesForNet, freshNonce, type Order } from "./desk";
import { fetchMarket } from "./market";
import { stockForWriteMint, symbolForWriteMint } from "./mirror";
import { BY_SYMBOL_PRESTOCKS } from "./prestocks";
import { CASH_MINT } from "./cash.generated";

/**
 * The house keeper. Two jobs, both of which anyone could do:
 *
 *   1. Run every monthly plan that is due. run_plan is permissionless; the
 *      keeper pays the order's rent and gets it back when the order fills.
 *   2. Fill cash orders as the house filler, once the auction has fallen to a
 *      share count the dollars actually pay for at mainnet prices. On devnet the
 *      filler mints the mirror stocks it delivers; on mainnet a filler would buy
 *      them. Other fillers are free to beat it to any order.
 */

const ONE_SHARE = 1_000_000n;

type Report = { plansRun: string[]; ordersFilled: { order: string; shares: string; cash: string }[]; skipped: string[]; errors: string[] };

function priceShareUsd(basket: Basket, market: Awaited<ReturnType<typeof fetchMarket>>): number | null {
  const bySymbol = new Map(market.quotes.map((q) => [q.symbol, q]));
  let nav = 0;
  for (const c of basket.components) {
    const stock = stockForWriteMint(c.mint);
    const q = stock ? bySymbol.get(stock.symbol) : undefined;
    if (!q) return null;
    nav += (Number(c.unitsPerShare) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
  }
  return nav;
}

async function send(connection: Connection, ixs: TransactionInstruction[]) {
  const keeper = faucetKeypair()!;
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  return sendAndConfirmTransaction(connection, tx, [keeper], { commitment: "confirmed" });
}

async function fill(connection: Connection, order: Order, basket: Basket, gross: bigint) {
  const keeper = faucetKeypair()!;
  const componentProgram = new PublicKey(basket.tokenProgram);
  const prep: TransactionInstruction[] = [];
  for (const c of basket.components) {
    const mint = new PublicKey(c.mint);
    const ata = tokenAccount(mint, keeper.publicKey, componentProgram);
    let need = (c.unitsPerShare * gross + ONE_SHARE - 1n) / ONE_SHARE;
    // PreStocks carry a transfer fee; deliver enough that the vault still gets the recipe.
    const fee = BY_SYMBOL_PRESTOCKS[symbolForWriteMint(c.mint) ?? ""]?.transferFeeBps ?? 0;
    if (fee > 0) need = (need * 10_000n + BigInt(10_000 - fee) - 1n) / BigInt(10_000 - fee) + 1n;
    prep.push(
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, keeper.publicKey, mint, componentProgram),
      createMintToInstruction(mint, ata, keeper.publicKey, need, [], componentProgram),
    );
  }
  const cashMint = new PublicKey(order.cashMint);
  const cashProgram = new PublicKey(order.cashTokenProgram);
  const shareMint = new PublicKey(basket.shareMint);
  prep.push(
    createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(cashMint, keeper.publicKey, cashProgram), keeper.publicKey, cashMint, cashProgram),
    createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(shareMint, new PublicKey(order.buyer), TOKEN_2022_PROGRAM_ID), new PublicKey(order.buyer), shareMint, TOKEN_2022_PROGRAM_ID),
  );
  if (basket.creatorFeeBps > 0) {
    prep.push(
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(shareMint, new PublicKey(basket.creator), TOKEN_2022_PROGRAM_ID), new PublicKey(basket.creator), shareMint, TOKEN_2022_PROGRAM_ID),
    );
  }
  // Inventory first, then the fill on its own, so the fill transaction stays small.
  await send(connection, prep);
  return send(connection, [fillOrderIx({ filler: keeper.publicKey, order, basket })]);
}

export async function runKeeper(opts: { maxActions?: number } = {}): Promise<Report> {
  const report: Report = { plansRun: [], ordersFilled: [], skipped: [], errors: [] };
  const keeper = faucetKeypair();
  if (!keeper) {
    report.errors.push("No keeper key on this deployment.");
    return report;
  }
  const connection = new Connection(WRITE_RPC, "confirmed");
  const now = Math.floor(Date.now() / 1000);
  let budget = opts.maxActions ?? 4;

  // 1. Plans that are due.
  const plans = await fetchPlans(connection);
  for (const plan of plans) {
    if (budget <= 0) break;
    if (plan.runsLeft <= 0 || now < plan.nextRunTs) continue;
    try {
      const { ix } = runPlanIx({ cranker: keeper.publicKey, plan, nonce: freshNonce() });
      await send(connection, [ix]);
      report.plansRun.push(plan.address);
      budget--;
    } catch (err) {
      report.errors.push(`plan ${plan.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  // 2. Orders worth filling.
  const orders = (await fetchOrders(connection)).filter((o) => o.cashMint === CASH_MINT && o.endTs >= now + 2);
  if (!orders.length) return report;
  const [baskets, market] = await Promise.all([fetchBaskets(connection), fetchMarket()]);
  const byAddress = new Map(baskets.map((b) => [b.address, b]));
  for (const order of orders) {
    if (budget <= 0) break;
    const basket = byAddress.get(order.basket);
    const nav = basket ? priceShareUsd(basket, market) : null;
    if (!basket || nav == null || nav <= 0) {
      report.skipped.push(`${order.address.slice(0, 6)}: no price`);
      continue;
    }
    // Fill a few seconds ahead, so the auction is no worse when the transaction lands.
    const shares = requiredShares(order, now + 4);
    const gross = grossSharesForNet(shares, basket.creatorFeeBps);
    const cost = (Number(gross) / Number(ONE_SHARE)) * nav;
    const cash = Number(order.cashAmount) / 1e6;
    if (cash + 1e-9 < cost) {
      report.skipped.push(`${order.address.slice(0, 6)}: auction still above fair (${(cost / cash).toFixed(3)}x)`);
      continue;
    }
    try {
      await fill(connection, order, basket, gross);
      report.ordersFilled.push({ order: order.address, shares: (Number(shares) / 1e6).toFixed(6), cash: cash.toFixed(2) });
      budget--;
    } catch (err) {
      report.errors.push(`order ${order.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  return report;
}
