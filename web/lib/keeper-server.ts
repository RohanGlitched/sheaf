import "server-only";
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import { WRITE_RPC } from "./config";
import { faucetKeypair } from "./faucet-server";
import { fetchBaskets, tokenAccount, TOKEN_2022_PROGRAM_ID, type Basket } from "./sheaf";
import { fetchOrders, fetchPlans, fillOrderIx, runPlanIx, cancelOrderIx, requiredShares, grossSharesForNet, freshNonce, type Order } from "./desk";
import { fetchMarket } from "./market";
import { stockForWriteMint, symbolForWriteMint } from "./mirror";
import { BY_SYMBOL_PRESTOCKS } from "./prestocks";
import { CASH_MINT } from "./cash.generated";

/**
 * The house keeper. Three jobs, all of which anyone could do, in this order:
 *
 *   1. Fill cash orders as the house filler, once the auction has fallen to a
 *      share count the dollars actually pay for at mainnet prices. On devnet the
 *      filler mints the mirror stocks it delivers; on mainnet a filler would buy
 *      them. Other fillers are free to beat it to any order.
 *   2. Return the dollars of orders whose auction ended unfilled.
 *   3. Run every monthly plan that is due. run_plan is permissionless; the
 *      keeper pays the order's rent and gets it back when the order fills.
 */

const ONE_SHARE = 1_000_000n;

type Report = { plansRun: string[]; ordersFilled: { order: string; shares: string; cash: string }[]; refunded: string[]; skipped: string[]; errors: string[] };

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
  );
  // The buyer's share account must already exist: the order form creates it, so the
  // house never pays rent for a stranger's account.
  const buyerShares = await connection.getAccountInfo(tokenAccount(shareMint, new PublicKey(order.buyer), TOKEN_2022_PROGRAM_ID));
  if (!buyerShares) throw new Error("buyer has no share account yet");
  if (basket.creatorFeeBps > 0) {
    prep.push(
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(shareMint, new PublicKey(basket.creator), TOKEN_2022_PROGRAM_ID), new PublicKey(basket.creator), shareMint, TOKEN_2022_PROGRAM_ID),
    );
  }
  // Inventory first, then the fill on its own, so the fill transaction stays small.
  await send(connection, prep);
  return send(connection, [fillOrderIx({ filler: keeper.publicKey, order, basket })]);
}

/** House-paid plan orders open at once, across every plan. Each one locks a little rent. */
const MAX_HOUSE_PLAN_ORDERS = 12;
/** Refunds get their own small budget so a pile of expired orders never crowds out fills. */
const REFUND_BUDGET = 3;
/** A buyer's own expired order is theirs to return; the house steps in after this. */
const REFUND_GRACE_SECS = 10 * 60;

export async function runKeeper(opts: { maxActions?: number } = {}): Promise<Report> {
  const started = Date.now();
  const report: Report = { plansRun: [], ordersFilled: [], refunded: [], skipped: [], errors: [] };
  const keeper = faucetKeypair();
  if (!keeper) {
    report.errors.push("No keeper key on this deployment.");
    return report;
  }
  const keeperKey = keeper.publicKey.toBase58();
  const connection = new Connection(WRITE_RPC, "confirmed");
  const now = Math.floor(Date.now() / 1000);
  let budget = opts.maxActions ?? 6;
  let refundBudget = REFUND_BUDGET;
  // Leave room inside the route's 60s for the refunds and plans after the fills.
  const fillDeadline = started + 35_000;
  const hardDeadline = started + 50_000;

  // The keeper spends the house key's SOL on rent it gets back later. Below this
  // floor it only refunds, so nobody can drain it by flooding the program.
  const balance = await connection.getBalance(keeper.publicKey);
  const lowOnSol = balance < 0.5e9;
  if (lowOnSol) report.skipped.push(`house key low on SOL (${(balance / 1e9).toFixed(3)}); refunds only`);
  const [baskets, everyOrder] = await Promise.all([fetchBaskets(connection), fetchOrders(connection)]);
  const known = new Set(baskets.map((b) => b.address));
  const byAddress = new Map(baskets.map((b) => [b.address, b]));
  const openOrders = new Set(everyOrder.map((o) => o.address));
  const all = everyOrder.filter((o) => o.cashMint === CASH_MINT);

  // 1. Live orders worth filling, first, since they are what a buyer is waiting on.
  // An order still above fair is waited for, inside this call, when its auction
  // reaches fair within the next ~30 seconds; later ones are left for the next run
  // (plans keep a half-hour auction so the schedule catches them). Dollar orders
  // under $5 are left to other fillers: a fill costs the house rent for the
  // creator's share account at most, never the buyer's.
  const orders = lowOnSol ? [] : all.filter((o) => o.endTs >= now + 2 && o.cashAmount >= 5_000_000n && known.has(o.basket));
  if (orders.length) {
    const market = await fetchMarket();
    const jobs = orders
      .map((order) => {
        const basket = byAddress.get(order.basket);
        const nav = basket ? priceShareUsd(basket, market) : null;
        if (!basket || nav == null || nav <= 0) return null;
        const cash = Number(order.cashAmount) / 1e6;
        // The first second at which the dollars cover the shares owed (with the creator fee).
        const costAt = (t: number) => (Number(grossSharesForNet(requiredShares(order, t), basket.creatorFeeBps)) / Number(ONE_SHARE)) * nav;
        let fairAt: number | null = null;
        for (let t = Math.max(now, order.startTs); t <= order.endTs; t++) {
          if (costAt(t + 4) <= cash + 1e-9) {
            fairAt = t;
            break;
          }
        }
        return { order, basket, nav, cash, fairAt };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((x, y) => (x.fairAt ?? Infinity) - (y.fairAt ?? Infinity));
    for (const job of jobs) {
      if (budget <= 0) break;
      if (job.fairAt == null) {
        report.skipped.push(`${job.order.address.slice(0, 6)}: never fair at today's prices`);
        continue;
      }
      const wait = job.fairAt * 1000 - Date.now();
      if (wait > 0 && Date.now() + wait > fillDeadline) {
        report.skipped.push(`${job.order.address.slice(0, 6)}: fair in ${Math.round(wait / 1000)}s`);
        continue;
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const t = Math.floor(Date.now() / 1000);
      const shares = requiredShares(job.order, t + 4);
      const gross = grossSharesForNet(shares, job.basket.creatorFeeBps);
      try {
        await fill(connection, job.order, job.basket, gross);
        report.ordersFilled.push({ order: job.order.address, shares: (Number(shares) / 1e6).toFixed(6), cash: job.cash.toFixed(2) });
        openOrders.delete(job.order.address);
        budget--;
      } catch (err) {
        report.errors.push(`order ${job.order.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }

  // 2. Orders whose auction has ended unfilled: return the dollars. Anyone may do
  // this once the auction is over; the buyer gets the cash, the payer the rent.
  // The house refunds its own plan orders at once; a buyer's own order is left to
  // their Return button for ten minutes before the house does it for them.
  const expired = all
    .filter((o) => o.endTs < now && (o.rentPayer === keeperKey || o.endTs < now - REFUND_GRACE_SECS))
    .sort((x, y) => Number(y.rentPayer === keeperKey) - Number(x.rentPayer === keeperKey) || x.endTs - y.endTs);
  for (const order of expired) {
    if (refundBudget <= 0 || Date.now() > hardDeadline) break;
    try {
      await send(connection, [cancelOrderIx({ caller: keeper.publicKey, order })]);
      report.refunded.push(order.address);
      openOrders.delete(order.address);
      refundBudget--;
    } catch (err) {
      report.errors.push(`refund ${order.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  // 3. Plans that are due. Only plans the house would sensibly run: Sheaf's test
  // dollar, a real basket, at least a minute between runs, an auction no longer
  // than two hours and at least a dollar a run. One open order per plan (its last
  // order must be filled or refunded first), one plan per owner per call, and a cap
  // on house-paid plan orders open at once, so the rent the house locks is bounded.
  // Anyone else's plan can still be run by anyone; the house just won't pay for it.
  let housePlanOrders = everyOrder.filter((o) => o.plan != null && o.rentPayer === keeperKey && openOrders.has(o.address)).length;
  const owners = new Set<string>();
  const plans = lowOnSol ? [] : await fetchPlans(connection);
  for (const plan of plans) {
    if (budget <= 0 || Date.now() > hardDeadline) break;
    if (plan.legacy || plan.runsLeft <= 0 || now < plan.nextRunTs) continue;
    if (plan.cashMint !== CASH_MINT || !known.has(plan.basket) || plan.periodSecs < 60 || plan.auctionSecs > 7200 || plan.cashPerRun < 1_000_000n) continue;
    if (plan.lastOrder && openOrders.has(plan.lastOrder)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: last order still open`);
      continue;
    }
    if (owners.has(plan.owner)) continue;
    if (housePlanOrders >= MAX_HOUSE_PLAN_ORDERS) {
      report.skipped.push(`plans: ${housePlanOrders} house-paid plan orders already open`);
      break;
    }
    try {
      const { ix } = runPlanIx({ cranker: keeper.publicKey, plan, nonce: freshNonce() });
      await send(connection, [ix]);
      report.plansRun.push(plan.address);
      owners.add(plan.owner);
      housePlanOrders++;
      budget--;
    } catch (err) {
      report.errors.push(`plan ${plan.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  return report;
}
