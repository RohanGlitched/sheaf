import "server-only";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import { WRITE_RPC } from "./config";
import { faucetKeypair } from "./faucet-server";
import { fetchBaskets, tokenAccount, TOKEN_2022_PROGRAM_ID, type Basket } from "./sheaf";
import {
  fetchOrders,
  fetchPlans,
  fillOrderIx,
  runPlanIx,
  cancelOrderIx,
  requiredShares,
  grossSharesForNet,
  planBounds,
  freshNonce,
  type Order,
  type Plan,
} from "./desk";
import { fetchMarket } from "./market";
import { stockForWriteMint, symbolForWriteMint } from "./mirror";
import { BY_SYMBOL_PRESTOCKS } from "./prestocks";
import { CASH_MINT } from "./cash.generated";
import { ALT_MIN_COMPONENTS, ensureAlt } from "./alt";

/**
 * The house keeper. Three jobs, all of which anyone could do, in this order:
 *
 *   1. Fill cash orders as the house filler, once the auction has fallen to a
 *      share count the dollars pay for at mainnet prices, plus the filler's
 *      margin. On devnet the filler mints the mirror stocks it delivers; on
 *      mainnet a filler would buy them. Other fillers are free to beat it to any
 *      order.
 *   2. Return the dollars of orders whose auction ended unfilled.
 *   3. Run every monthly plan that is due. run_plan is permissionless; the
 *      keeper pays the order's rent and gets it back when the order fills.
 *
 * Every price check is closed form (the auction is a straight line), so a flood
 * of orders that will never be fair costs one multiplication each, not a scan.
 */

const ONE_SHARE = 1_000_000n;

/**
 * The house filler's business: it fills once the auction gives it at least this
 * much over fair value, a few seconds after the break-even point. 15 bps sits
 * well inside a plan's ±2% band, so every plan run still fills, and it is what a
 * market maker would charge to buy the stocks and deliver them.
 */
export const FILL_MARGIN_BPS = 15;
/** One minimum for the house, for dollar orders and plan runs alike. */
export const HOUSE_MIN_CASH = 5_000_000n;
/** House-paid plan orders open at once, across every plan. Each one locks a little rent. */
const MAX_HOUSE_PLAN_ORDERS = 12;
/** Slots of that cap a plan that has never filled may take; the rest are kept for plans that do. */
const MAX_UNPROVEN_PLAN_ORDERS = 8;
/** Plan orders that expire unfilled in a row before the house stops running the plan. */
const MAX_PLAN_STRIKES = 2;
/** Refund attempts per run, successful or not, so unrefundable orders never crowd out the rest. */
const REFUND_ATTEMPTS = 6;
/** A buyer's own expired order is theirs to return; the house steps in after this. */
const REFUND_GRACE_SECS = 10 * 60;
/** Someone else's expired order under this is left to its buyer. */
const MIN_REFUND_CASH = 1_000_000n;
/** A sanity cap on orders priced per run; pricing is closed form, so it is generous. */
const MAX_PRICED = 2_000;
/** Fills attempted per run, soonest first, and per buyer, so no one wallet takes the run. */
const MAX_JOBS = 20;
const MAX_JOBS_PER_BUYER = 3;
/** An order further than this from the house's price is left for the next run. */
const MAX_WAIT_SECS = 30;

type Fill = { order: string; shares: string; cash: string; marginBps: number };
export type Report = {
  plansRun: string[];
  ordersFilled: Fill[];
  refunded: string[];
  skipped: string[];
  errors: string[];
  /** The house filler's margin over fair, summed over this run's fills, in dollars. */
  marginUsd: number;
};

type Market = Awaited<ReturnType<typeof fetchMarket>>;

function priceShareUsd(basket: Basket, market: Market): number | null {
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

/** What delivering `net` shares costs the filler at `nav`, creator fee included. */
const costOf = (net: bigint, basket: Basket, nav: number) => (Number(grossSharesForNet(net, basket.creatorFeeBps, basket.protocolFeeBps)) / Number(ONE_SHARE)) * nav;

/** The filler's margin over fair, in basis points, when `net` shares are bought for `cash` dollars. */
const marginBps = (cash: number, net: bigint, basket: Basket, nav: number) => {
  const cost = costOf(net, basket, nav);
  return cost > 0 ? (cash / cost - 1) * 10_000 : 0;
};

/**
 * The most shares the house will deliver for `cash` dollars: the dollars must
 * cover them at `nav` plus the filler's margin. Found from the gross bound and
 * nudged by the exact fee rounding, never by a search over time.
 */
function maxShares(cash: number, basket: Basket, nav: number): bigint {
  const grossCap = BigInt(Math.floor((cash / (nav * (1 + FILL_MARGIN_BPS / 10_000))) * Number(ONE_SHARE)));
  if (grossCap <= 0n) return 0n;
  const fee = BigInt(basket.creatorFeeBps + basket.protocolFeeBps);
  let net = (grossCap * (10_000n - fee)) / 10_000n;
  for (let i = 0; i < 4 && net > 0n && grossSharesForNet(net, basket.creatorFeeBps, basket.protocolFeeBps) > grossCap; i++) net--;
  for (let i = 0; i < 4 && grossSharesForNet(net + 1n, basket.creatorFeeBps, basket.protocolFeeBps) <= grossCap; i++) net++;
  return net;
}

/**
 * The first second at which the auction owes at most `target` shares, from the
 * line itself: required(t) = start − ⌊(start − end)·(t − startTs) / span⌋.
 * Null when even the auction's end asks for more.
 */
function firstSecondAtOrBelow(order: Order, target: bigint): number | null {
  if (order.startShares <= target) return order.startTs;
  if (order.endShares > target) return null;
  const drop = order.startShares - order.endShares;
  const span = BigInt(order.endTs - order.startTs);
  if (drop <= 0n || span <= 0n) return order.endTs;
  const need = order.startShares - target;
  let t = order.startTs + Number((need * span + drop - 1n) / drop);
  for (let i = 0; i < 3 && t < order.endTs && requiredShares(order, t) > target; i++) t++;
  return Math.min(t, order.endTs);
}

/** A plan run's auction, as run_plan computes it: the band around the reference, floored at min_ref. */
function planAuction(plan: Plan): { start: bigint; end: bigint } {
  const { start, end } = planBounds(plan.cashPerRun, plan.refSharesPerCashE9, plan.bandBps);
  const floor = plan.minRef != null ? (plan.cashPerRun * plan.minRef) / 1_000_000_000n : 0n;
  const e = end > floor ? end : floor;
  return { start: start > e ? start : e, end: e };
}

/** Plan orders that expired unfilled in a row, per plan, until the plan fills or is re-centred. */
const strikes = new Map<string, { count: number; fills: number; ref: bigint }>();
function strikesFor(plan: Plan): number {
  const s = strikes.get(plan.address);
  if (!s) return 0;
  if (s.fills !== plan.fills || s.ref !== plan.refSharesPerCashE9) {
    strikes.delete(plan.address);
    return 0;
  }
  return s.count;
}

/** The cluster's own clock, which is what the program prices against. */
async function chainClock(connection: Connection): Promise<() => number> {
  const wall = () => Math.floor(Date.now() / 1000);
  try {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    if (t == null) return wall;
    const offset = t - wall();
    return () => wall() + offset;
  } catch {
    return wall;
  }
}

async function send(connection: Connection, ixs: TransactionInstruction[], table?: AddressLookupTableAccount | null) {
  const keeper = faucetKeypair()!;
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  if (!table) {
    const tx = new Transaction().add(budget, ...ixs);
    return sendAndConfirmTransaction(connection, tx, [keeper], { commitment: "confirmed" });
  }
  // Seven or eight components: a v0 transaction that names the shared accounts through the basket's table.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: blockhash, instructions: [budget, ...ixs] }).compileToV0Message([table]);
  const tx = new VersionedTransaction(message);
  tx.sign([keeper]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

async function fill(connection: Connection, order: Order, basket: Basket, gross: bigint) {
  const keeper = faucetKeypair()!;
  const componentProgram = new PublicKey(basket.tokenProgram);
  // The buyer's share account must already exist: the order form creates it, so the
  // house never pays rent for a stranger's account.
  const shareMint = new PublicKey(basket.shareMint);
  const buyerShares = await connection.getAccountInfo(tokenAccount(shareMint, new PublicKey(order.buyer), TOKEN_2022_PROGRAM_ID));
  if (!buyerShares) throw new Error("buyer has no share account yet");
  const table = basket.components.length >= ALT_MIN_COMPONENTS ? await ensureAlt(connection, keeper, basket) : null;

  const inventory: TransactionInstruction[][] = [];
  for (const c of basket.components) {
    const mint = new PublicKey(c.mint);
    const ata = tokenAccount(mint, keeper.publicKey, componentProgram);
    let need = (c.unitsPerShare * gross + ONE_SHARE - 1n) / ONE_SHARE;
    // PreStocks carry a transfer fee; deliver enough that the vault still gets the recipe.
    const fee = BY_SYMBOL_PRESTOCKS[symbolForWriteMint(c.mint) ?? ""]?.transferFeeBps ?? 0;
    if (fee > 0) need = (need * 10_000n + BigInt(10_000 - fee) - 1n) / BigInt(10_000 - fee) + 1n;
    inventory.push([
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, keeper.publicKey, mint, componentProgram),
      createMintToInstruction(mint, ata, keeper.publicKey, need, [], componentProgram),
    ]);
  }
  const cashMint = new PublicKey(order.cashMint);
  const cashProgram = new PublicKey(order.cashTokenProgram);
  const accounts: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(cashMint, keeper.publicKey, cashProgram), keeper.publicKey, cashMint, cashProgram),
  ];
  if (basket.creatorFeeBps > 0) {
    accounts.push(
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, tokenAccount(shareMint, new PublicKey(basket.creator), TOKEN_2022_PROGRAM_ID), new PublicKey(basket.creator), shareMint, TOKEN_2022_PROGRAM_ID),
    );
  }
  // Inventory first, four components to a transaction, then the fill on its own.
  for (let i = 0; i < inventory.length; i += 4) {
    const batch = inventory.slice(i, i + 4).flat();
    await send(connection, i === 0 ? [...batch, ...accounts] : batch, table);
  }
  return send(connection, [fillOrderIx({ filler: keeper.publicKey, order, basket })], table);
}

export async function runKeeper(opts: { maxActions?: number } = {}): Promise<Report> {
  const started = Date.now();
  const report: Report = { plansRun: [], ordersFilled: [], refunded: [], skipped: [], errors: [], marginUsd: 0 };
  const keeper = faucetKeypair();
  if (!keeper) {
    report.errors.push("No keeper key on this deployment.");
    return report;
  }
  const keeperKey = keeper.publicKey.toBase58();
  const connection = new Connection(WRITE_RPC, "confirmed");
  let budget = opts.maxActions ?? 6;
  // Fixed slices of the route's 60 s: fills, then refunds, then plans, which always get their turn.
  const fillDeadline = started + 35_000;
  const refundDeadline = started + 40_000;
  const hardDeadline = started + 52_000;

  // The keeper spends the house key's SOL on rent it gets back later. Below this
  // floor it only refunds, so nobody can drain it by flooding the program.
  const [balance, clock] = await Promise.all([connection.getBalance(keeper.publicKey), chainClock(connection)]);
  const now = clock();
  const lowOnSol = balance < 0.5e9;
  if (lowOnSol) report.skipped.push(`house key low on SOL (${(balance / 1e9).toFixed(3)}); refunds only`);
  const [baskets, everyOrder] = await Promise.all([fetchBaskets(connection), fetchOrders(connection)]);
  const known = new Set(baskets.map((b) => b.address));
  const byAddress = new Map(baskets.map((b) => [b.address, b]));
  const openOrders = new Set(everyOrder.map((o) => o.address));
  const all = everyOrder.filter((o) => o.cashMint === CASH_MINT);

  let market: Market | null = null;
  const navOf = async (basket: Basket) => {
    market ??= await fetchMarket();
    const nav = priceShareUsd(basket, market);
    return nav != null && nav > 0 ? nav : null;
  };
  /** When the house would fill this order, by the cluster's clock, or null if never at today's prices. */
  const houseFillAt = (order: Order, basket: Basket, nav: number) =>
    firstSecondAtOrBelow(order, maxShares(Number(order.cashAmount) / 1e6, basket, nav));

  // 1. Live orders worth filling, first, since they are what a buyer is waiting on.
  // Pricing is a few multiplications an order, so every live order is priced (up
  // to a sanity cap); only then are the ones the house would fill within the next
  // half minute kept, soonest first and a few per buyer, so a stream of fresh
  // orders that will never be fair cannot push a real one out of the queue.
  // Dollar orders under $5 are left to other fillers: a fill costs the house rent
  // for the creator's share account at most, never the buyer's.
  const live = lowOnSol
    ? []
    : all
        .filter((o) => o.endTs >= now + 2 && o.cashAmount >= HOUSE_MIN_CASH && known.has(o.basket))
        .sort((x, y) => y.createdAt - x.createdAt)
        .slice(0, MAX_PRICED);
  let neverFair = 0;
  let later = 0;
  const priced: { order: Order; basket: Basket; nav: number; cash: number; at: number }[] = [];
  for (const order of live) {
    const basket = byAddress.get(order.basket)!;
    const nav = await navOf(basket);
    if (nav == null) continue;
    const at = houseFillAt(order, basket, nav);
    if (at == null) neverFair++;
    else if (at - now > MAX_WAIT_SECS) later++;
    else priced.push({ order, basket, nav, cash: Number(order.cashAmount) / 1e6, at });
  }
  if (neverFair) report.skipped.push(`${neverFair} open orders never fair at today's prices`);
  if (later) report.skipped.push(`${later} open orders reach the house's price more than ${MAX_WAIT_SECS}s from now`);
  priced.sort((x, y) => x.at - y.at);
  const perBuyer = new Map<string, number>();
  const jobs = priced
    .filter((j) => {
      const n = perBuyer.get(j.order.buyer) ?? 0;
      perBuyer.set(j.order.buyer, n + 1);
      return n < MAX_JOBS_PER_BUYER;
    })
    .slice(0, MAX_JOBS);
  for (const job of jobs) {
    if (budget <= 0) break;
    const wait = (job.at - clock()) * 1000;
    if (wait > 0 && Date.now() + wait > fillDeadline) {
      report.skipped.push(`${job.order.address.slice(0, 6)}: house price in ${Math.round(wait / 1000)}s`);
      continue;
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // The auction only decays, so the count owed at the cluster's clock now is an
    // upper bound on what the fill will need when it lands.
    const shares = requiredShares(job.order, clock());
    const gross = grossSharesForNet(shares, job.basket.creatorFeeBps, job.basket.protocolFeeBps);
    const margin = marginBps(job.cash, shares, job.basket, job.nav);
    if (margin < FILL_MARGIN_BPS - 0.01) {
      report.skipped.push(`${job.order.address.slice(0, 6)}: margin ${margin.toFixed(1)} bps, under ${FILL_MARGIN_BPS}`);
      continue;
    }
    try {
      await fill(connection, job.order, job.basket, gross);
      report.ordersFilled.push({ order: job.order.address, shares: (Number(shares) / 1e6).toFixed(6), cash: job.cash.toFixed(2), marginBps: Math.round(margin * 10) / 10 });
      report.marginUsd += job.cash - costOf(shares, job.basket, job.nav);
      openOrders.delete(job.order.address);
      budget--;
    } catch (err) {
      report.errors.push(`order ${job.order.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  report.marginUsd = Math.round(report.marginUsd * 100) / 100;

  // 2. Orders whose auction has ended unfilled: return the dollars. Anyone may do
  // this once the auction is over; the buyer gets the cash, the payer the rent.
  // The house refunds its own plan orders at once; a buyer's own order is left to
  // their Return button for ten minutes before the house does it for them, and
  // one under $1 is left to them for good. A plan order that expires unfilled is
  // a strike against its plan, refunded or not.
  //
  // The program refunds a third party's call only into the buyer's canonical
  // dollar account, so an order whose buyer has none can only be cancelled by the
  // buyer. Those are found in one read and never attempted. Attempts, not
  // successes, are capped, and refunds stop in time to leave the plans their slice.
  const plans = lowOnSol ? [] : await fetchPlans(connection);
  const planByAddress = new Map(plans.map((p) => [p.address, p]));
  const strike = (order: Order) => {
    const plan = order.plan ? planByAddress.get(order.plan) : undefined;
    if (plan) strikes.set(plan.address, { count: strikesFor(plan) + 1, fills: plan.fills, ref: plan.refSharesPerCashE9 });
  };
  const expiredAll = all
    .filter((o) => o.endTs < now && (o.rentPayer === keeperKey || (o.endTs < now - REFUND_GRACE_SECS && o.cashAmount >= MIN_REFUND_CASH)))
    .sort((x, y) => Number(y.rentPayer === keeperKey) - Number(x.rentPayer === keeperKey) || x.endTs - y.endTs)
    .slice(0, 100);
  const cashAtas = expiredAll.map((o) => tokenAccount(new PublicKey(o.cashMint), new PublicKey(o.buyer), new PublicKey(o.cashTokenProgram)));
  const cashInfos = cashAtas.length ? await connection.getMultipleAccountsInfo(cashAtas).catch(() => cashAtas.map(() => null)) : [];
  const expired = expiredAll.filter((o, i) => {
    if (cashInfos[i]) return true;
    strike(o);
    return false;
  });
  if (expiredAll.length > expired.length) {
    report.skipped.push(`${expiredAll.length - expired.length} expired orders whose buyer has no dollar account; only the buyer can cancel them`);
  }
  let attempts = 0;
  for (const order of expired) {
    if (attempts >= REFUND_ATTEMPTS || Date.now() > refundDeadline) break;
    attempts++;
    try {
      await send(connection, [cancelOrderIx({ caller: keeper.publicKey, order })]);
      report.refunded.push(order.address);
      openOrders.delete(order.address);
    } catch (err) {
      report.errors.push(`refund ${order.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
    strike(order);
  }

  // 3. Plans that are due. Only plans the house would sensibly run: Sheaf's test
  // dollar, a real basket, at least a minute between runs, an auction no longer
  // than two hours, at least $5 a run, and an auction that reaches the house's
  // price at today's quotes. One open order per plan (its last order must be filled
  // or refunded first), one plan per owner per call, none after two runs in a row
  // expired unfilled (until the owner re-centres it), and a cap on house-paid plan
  // orders open at once, with some of it kept for plans that have filled before.
  // The owner must hold the basket's share account (or the fill could never land)
  // and the plan must draw from the owner's canonical dollar account (or a refund
  // could never land), both checked in one read before the run.
  // Anyone else's plan can still be run by anyone; the house just won't pay for it.
  // An expired order is waiting for its refund, not using the cap.
  const houseOpen = everyOrder.filter((o) => o.plan != null && o.rentPayer === keeperKey && openOrders.has(o.address) && o.endTs >= now);
  let housePlanOrders = 0;
  let unproven = 0;
  for (const o of houseOpen) {
    const basket = byAddress.get(o.basket);
    const nav = basket ? await navOf(basket) : null;
    // An order that can never reach fair holds no slot: no new run of its plan will start.
    if (basket && nav != null && houseFillAt(o, basket, nav) == null) continue;
    housePlanOrders++;
    if ((planByAddress.get(o.plan!)?.fills ?? 0) === 0) unproven++;
  }
  const owners = new Set<string>();
  for (const plan of plans) {
    if (budget <= 0 || Date.now() > hardDeadline) break;
    if (plan.legacy || plan.runsLeft <= 0 || now < plan.nextRunTs) continue;
    if (plan.cashMint !== CASH_MINT || !known.has(plan.basket) || plan.periodSecs < 60 || plan.auctionSecs > 7200 || plan.cashPerRun < HOUSE_MIN_CASH) continue;
    if (plan.lastOrder && openOrders.has(plan.lastOrder)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: last order still open`);
      continue;
    }
    if (owners.has(plan.owner)) continue;
    if (strikesFor(plan) >= MAX_PLAN_STRIKES) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: last ${MAX_PLAN_STRIKES} runs expired unfilled; waiting for a re-centre`);
      continue;
    }
    const basket = byAddress.get(plan.basket)!;
    const owner = new PublicKey(plan.owner);
    const cashAta = tokenAccount(new PublicKey(plan.cashMint), owner, new PublicKey(plan.cashTokenProgram));
    if (plan.cashAccount !== cashAta.toBase58()) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: draws from a dollar account that is not the owner's own, so a refund could never land`);
      continue;
    }
    const [shareInfo] = await connection.getMultipleAccountsInfo([tokenAccount(new PublicKey(basket.shareMint), owner, TOKEN_2022_PROGRAM_ID)]).catch(() => [null]);
    if (!shareInfo) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: the owner has no ${basket.symbol} share account for the fill to land in`);
      continue;
    }
    const nav = await navOf(basket);
    const auction = planAuction(plan);
    if (nav == null || auction.end <= 0n || auction.end > maxShares(Number(plan.cashPerRun) / 1e6, basket, nav)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: its auction never reaches today's price`);
      continue;
    }
    if (housePlanOrders >= MAX_HOUSE_PLAN_ORDERS || (plan.fills === 0 && unproven >= MAX_UNPROVEN_PLAN_ORDERS)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: ${housePlanOrders} house-paid plan orders already open`);
      continue;
    }
    try {
      const { ix } = runPlanIx({ cranker: keeper.publicKey, plan, nonce: freshNonce() });
      await send(connection, [ix]);
      report.plansRun.push(plan.address);
      owners.add(plan.owner);
      housePlanOrders++;
      if (plan.fills === 0) unproven++;
      budget--;
    } catch (err) {
      report.errors.push(`plan ${plan.address.slice(0, 6)}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  return report;
}
