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
import { fetchBaskets, redeemSharesInstruction, tokenAccount, TOKEN_2022_PROGRAM_ID, type Basket } from "./sheaf";
import {
  fetchOrders,
  fetchSellOrders,
  fillSellOrderIx,
  cancelSellOrderIx,
  requiredCash,
  type SellOrder,
  fetchPlans,
  fillOrderIx,
  runPlanIx,
  cancelOrderIx,
  requiredShares,
  grossSharesForNet,
  planBounds,
  freshNonce,
  MEMO_PROGRAM_ID,
  type Order,
  type Plan,
} from "./desk";
import { fetchMarket } from "./market";
import { stockForWriteMint, symbolForWriteMint } from "./mirror";
import { BY_SYMBOL_PRESTOCKS } from "./prestocks";
import { CASH_MINT } from "./cash.generated";
import { ALT_MIN_COMPONENTS, ensureAlt } from "./alt";
import { gcsConfigured, getJson, putJson } from "./gcs-store";
import { recordFills, type FillLogEntry } from "./server-fill-log";

/**
 * The house keeper. Three jobs, all of which anyone could do, in this order:
 *
 *   1. Fill cash orders as the house filler, once the auction has fallen to a
 *      share count the dollars pay for at mainnet prices, plus the filler's
 *      margin. On devnet the filler mints the mirror stocks it delivers; on
 *      mainnet a filler would buy them. Other fillers are free to beat it to any
 *      order.
 *      It buys on the dollar exit too: a holder's sell order is filled once the
 *      cash it asks has decayed to the shares' fair value less the same margin,
 *      and the shares are redeemed in kind in the same transaction, so the house
 *      ends up holding the stocks, never the shares.
 *   2. Return the dollars of orders whose auction ended unfilled, and the shares
 *      of sell orders that found no buyer.
 *   3. Run every monthly plan that is due. run_plan is permissionless; the
 *      keeper pays the order's rent and gets it back when the order fills.
 *
 * Every price check is closed form (the auction is a straight line), so a flood
 * of orders that will never be fair costs one multiplication each, not a scan.
 * Everything that would fail is found before it is tried: the accounts a fill,
 * refund or plan run needs are read in batches (missing, frozen, or requiring a
 * memo on incoming transfers), and whatever fails anyway backs off (5 min, 20 min,
 * 1 h, 6 h) in a failure memory kept in the project's bucket, so it never takes
 * the place of an order that would go through.
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
/** A fill is only started with at least this long left in the auction, so it lands before the end. */
const MIN_SECS_LEFT = 5;
/** Extra margin the house asks when any component is priced from a fallback source. */
const FALLBACK_EXTRA_BPS = 50;
/** Fill and plan attempts that may fail in one run before the rest wait for the next. */
const FAILED_ATTEMPTS = 6;
/** Plan runs attempted per run, proven plans first. */
const MAX_PLAN_ATTEMPTS = 8;

type Fill = { order: string; shares: string; cash: string; marginBps: number; navUsd: number; costUsd: number; fallback: boolean };
/** A sell order the house bought: shares taken, dollars paid, and the discount to fair it got. */
type SellFill = { order: string; shares: string; cash: string; discountBps: number; navUsd: number; valueUsd: number; fallback: boolean };
export type Report = {
  plansRun: string[];
  ordersFilled: Fill[];
  sellsFilled: SellFill[];
  /** Expired sell orders whose shares the house sent back to their seller. */
  sellsReturned: string[];
  refunded: string[];
  skipped: string[];
  errors: string[];
  /** The house filler's margin over fair, summed over this run's fills, in dollars. */
  marginUsd: number;
};

type Market = Awaited<ReturnType<typeof fetchMarket>>;

/** A component's transfer fee in basis points: the PreStock mirrors carry one, as the real PreStocks do. */
const feeBpsOf = (mint: string) => BY_SYMBOL_PRESTOCKS[symbolForWriteMint(mint) ?? ""]?.transferFeeBps ?? 0;

/**
 * One share at today's quotes, three ways. `fair` is the recipe at spot. `buy`
 * is what delivering it costs, each component grossed up for its transfer fee so
 * the vault still nets the recipe. `sell` is what redeeming it pays, each
 * component net of its fee on the way out. `fallback` is set when any quote came
 * from a fallback source rather than Jupiter.
 */
type Nav = { fair: number; buy: number; sell: number; fallback: boolean };

function priceShareUsd(basket: Basket, market: Market): Nav | null {
  const bySymbol = new Map(market.quotes.map((q) => [q.symbol, q]));
  const nav: Nav = { fair: 0, buy: 0, sell: 0, fallback: false };
  for (const c of basket.components) {
    const stock = stockForWriteMint(c.mint);
    const q = stock ? bySymbol.get(stock.symbol) : undefined;
    if (!q) return null;
    const v = (Number(c.unitsPerShare) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
    const f = feeBpsOf(c.mint) / 10_000;
    nav.fair += v;
    nav.buy += v / (1 - f);
    nav.sell += v * (1 - f);
    if (q.source && q.source !== "jupiter") nav.fallback = true;
  }
  return nav;
}

/** The margin the house asks: its own, plus a cushion when a price is a fallback. */
const marginFor = (nav: Nav) => FILL_MARGIN_BPS + (nav.fallback ? FALLBACK_EXTRA_BPS : 0);

/** What delivering `net` shares costs the filler at `nav`, creator, protocol and transfer fees included. */
const costOf = (net: bigint, basket: Basket, nav: Nav) => (Number(grossSharesForNet(net, basket.creatorFeeBps, basket.protocolFeeBps)) / Number(ONE_SHARE)) * nav.buy;

/** The filler's margin over cost, in basis points, when `net` shares are bought for `cash` dollars. */
const marginBps = (cash: number, net: bigint, basket: Basket, nav: Nav) => {
  const cost = costOf(net, basket, nav);
  return cost > 0 ? (cash / cost - 1) * 10_000 : 0;
};

/**
 * The most shares the house will deliver for `cash` dollars: the dollars must
 * cover them at the fee-grossed `nav.buy` plus the house's margin. Found from the
 * gross bound and nudged by the exact fee rounding, never by a search over time.
 */
function maxShares(cash: number, basket: Basket, nav: Nav): bigint {
  const grossCap = BigInt(Math.floor((cash / (nav.buy * (1 + marginFor(nav) / 10_000))) * Number(ONE_SHARE)));
  if (grossCap <= 0n) return 0n;
  const fee = BigInt(basket.creatorFeeBps + basket.protocolFeeBps);
  let net = (grossCap * (10_000n - fee)) / 10_000n;
  for (let i = 0; i < 4 && net > 0n && grossSharesForNet(net, basket.creatorFeeBps, basket.protocolFeeBps) > grossCap; i++) net--;
  for (let i = 0; i < 4 && grossSharesForNet(net + 1n, basket.creatorFeeBps, basket.protocolFeeBps) <= grossCap; i++) net++;
  return net;
}

// ------------------------------------------------------------ account checks

/** A token account's balance, delegate and whether a transfer into it would fail. */
type TokenState = { amount: bigint; delegate: string | null; delegated: bigint; frozen: boolean; memoRequired: boolean };

/**
 * Reads a token account (SPL or Token-2022): amount at 64, delegate option at
 * 72 (tag u32, key at 76), state at 108 (2 = frozen), delegated_amount at 121.
 * A Token-2022 account carries its type (2) at 165 and then TLV extensions from
 * 166; MemoTransfer is type 8, whose first byte set means every incoming
 * transfer needs a memo, which the program's transfers do not carry.
 */
function tokenState(data: Uint8Array | null | undefined): TokenState | null {
  if (!data || data.length < 165) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let memoRequired = false;
  if (b.length > 166 && b[165] === 2) {
    for (let at = 166; at + 4 <= b.length; ) {
      const type = b.readUInt16LE(at);
      const len = b.readUInt16LE(at + 2);
      if (type === 0) break;
      if (type === 8 && len >= 1 && b[at + 4] === 1) memoRequired = true;
      at += 4 + len;
    }
  }
  return {
    amount: b.readBigUInt64LE(64),
    delegate: b.readUInt32LE(72) === 1 ? new PublicKey(b.subarray(76, 108)).toBase58() : null,
    delegated: b.readBigUInt64LE(121),
    frozen: b[108] === 2,
    memoRequired,
  };
}

/** Many accounts, a hundred to a call. A failed batch reads as missing, so nothing is attempted blind. */
async function readMany(connection: Connection, keys: PublicKey[]) {
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100)).catch(() => keys.slice(i, i + 100).map(() => null));
    out.push(...infos.map((x) => (x ? new Uint8Array(x.data) : null)));
  }
  return out;
}

// ------------------------------------------------------------ failure memory

/**
 * Whatever failed with a program error, by key ("fill:<order>", "plan:<plan>"
 * and so on), with when it may be tried again. Kept in memory and in
 * keeper/failures.json, so a restart does not retry everything at once.
 */
type Failure = { fails: number; until: number; why: string };
const BACKOFF_MS = [5 * 60_000, 20 * 60_000, 60 * 60_000, 6 * 3600_000];
const FAILURES_OBJECT = "keeper/failures.json";
const failures = new Map<string, Failure>();
let failuresLoaded = false;
let failuresDirty = false;

async function loadFailures() {
  if (failuresLoaded || !gcsConfigured()) return;
  failuresLoaded = true;
  const doc = await getJson<Record<string, Failure>>(FAILURES_OBJECT).catch(() => null);
  for (const [k, f] of Object.entries(doc?.data ?? {})) if (!failures.has(k)) failures.set(k, f);
}

async function saveFailures() {
  // Long-expired entries are forgotten, so the memory stays small.
  for (const [k, f] of failures) if (f.until < Date.now() - 24 * 3600_000) failures.delete(k);
  if (!failuresDirty || !gcsConfigured()) return;
  failuresDirty = false;
  await putJson(FAILURES_OBJECT, Object.fromEntries(failures)).catch(() => undefined);
}

function noteFailure(key: string, why: string) {
  const n = (failures.get(key)?.fails ?? 0) + 1;
  failures.set(key, { fails: n, until: Date.now() + BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)], why: why.slice(0, 120) });
  failuresDirty = true;
}
function noteSuccess(key: string) {
  if (failures.delete(key)) failuresDirty = true;
}
const backingOff = (key: string) => (failures.get(key)?.until ?? 0) > Date.now();
const hasFailed = (key: string) => failures.has(key);

/**
 * The first second at which the auction owes at most/**
 * The first second at which the auction owes at most `target` shares, from the
 * line itself: required(t) = start − ⌊(start − end)·(t − startTs) / span⌋.
 * Null when even the auction's end asks for more.
 */
function firstSecondAtOrBelow(order: Pick<Order, "startShares" | "endShares" | "startTs" | "endTs">, target: bigint): number | null {
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

/**
 * The Memo program as the last remaining account. The program needs it to pay
 * into an account that requires a memo on incoming transfers (MemoTransfer);
 * passing it always is cheap and means such an account never blocks a fill, a
 * sale or a refund.
 */
function withMemo(ix: TransactionInstruction): TransactionInstruction {
  ix.keys.push({ pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false });
  return ix;
}

/** True when a transaction was refused for its size, before anything was sent. */
const tooLarge = (err: unknown) => /too large|overruns|exceeds|encoding/i.test((err as Error)?.message ?? "");

/**
 * The program's own reason when a transaction fails, from its logs ("Error
 * Code: OrderExpired" and the like), so a report says why and not only
 * "Simulation failed".
 */
function reason(err: unknown): string {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = e.logs ?? e.transactionLogs ?? [];
  const code = logs.map((l) => l.match(/Error Code: (\w+)/)?.[1] ?? l.match(/Error: (insufficient funds|[^.]+)/)?.[1]).find(Boolean);
  const head = (e.message ?? String(err)).split("\n")[0];
  return (code ? `${code}: ${head}` : head).slice(0, 160);
}

/**
 * Fill a dollar order in as few transactions as possible: the house tops up only
 * the stock it is short of, in the same transaction as the fill when that fits in
 * one packet, so a fill lands within seconds of the decision. A fill that has to
 * wait on a separate inventory transaction can miss an order whose auction is
 * about to end.
 */
async function fill(connection: Connection, order: Order, basket: Basket, gross: bigint) {
  const keeper = faucetKeypair()!;
  const componentProgram = new PublicKey(basket.tokenProgram);
  const shareMint = new PublicKey(basket.shareMint);
  const cashMint = new PublicKey(order.cashMint);
  const cashProgram = new PublicKey(order.cashTokenProgram);
  const holdings = basket.components.map((c) => tokenAccount(new PublicKey(c.mint), keeper.publicKey, componentProgram));
  const cashAta = tokenAccount(cashMint, keeper.publicKey, cashProgram);
  const creatorShares = tokenAccount(shareMint, new PublicKey(basket.creator), TOKEN_2022_PROGRAM_ID);
  const buyerShares = tokenAccount(shareMint, new PublicKey(order.buyer), TOKEN_2022_PROGRAM_ID);
  const [buyerInfo, cashInfo, creatorInfo, ...holdingInfos] = await connection.getMultipleAccountsInfo([buyerShares, cashAta, creatorShares, ...holdings]);
  // The buyer's share account must already exist: the order form creates it, so the
  // house never pays rent for a stranger's account.
  if (!buyerInfo) throw new Error("buyer has no share account yet");
  const table = basket.components.length >= ALT_MIN_COMPONENTS ? await ensureAlt(connection, keeper, basket) : null;

  const setup: TransactionInstruction[] = [];
  const mints: TransactionInstruction[] = [];
  basket.components.forEach((c, i) => {
    const mint = new PublicKey(c.mint);
    let need = (c.unitsPerShare * gross + ONE_SHARE - 1n) / ONE_SHARE;
    // PreStocks carry a transfer fee; deliver enough that the vault still gets the recipe.
    const fee = BY_SYMBOL_PRESTOCKS[symbolForWriteMint(c.mint) ?? ""]?.transferFeeBps ?? 0;
    if (fee > 0) need = (need * 10_000n + BigInt(10_000 - fee) - 1n) / BigInt(10_000 - fee) + 1n;
    const info = holdingInfos[i];
    const held = info && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
    if (!info) setup.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, holdings[i], keeper.publicKey, mint, componentProgram));
    if (held < need) mints.push(createMintToInstruction(mint, holdings[i], keeper.publicKey, need - held, [], componentProgram));
  });
  if (!cashInfo) setup.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, cashAta, keeper.publicKey, cashMint, cashProgram));
  if (basket.creatorFeeBps > 0 && !creatorInfo) {
    setup.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, creatorShares, new PublicKey(basket.creator), shareMint, TOKEN_2022_PROGRAM_ID));
  }
  // New accounts first (rare: once per mint), then stock and fill together.
  for (let i = 0; i < setup.length; i += 6) await send(connection, setup.slice(i, i + 6), table);
  const fillIx = withMemo(fillOrderIx({ filler: keeper.publicKey, order, basket }));
  try {
    return await send(connection, [...mints, fillIx], table);
  } catch (err) {
    if (!tooLarge(err) || mints.length === 0) throw err;
    for (let i = 0; i < mints.length; i += 4) await send(connection, mints.slice(i, i + 4), table);
    return send(connection, [fillIx], table);
  }
}

/**
 * Buy a sell order's shares and redeem them for the stocks in the same
 * transaction. The house pays in test dollars it mints for itself if it is short
 * (it holds the test dollar's mint authority on devnet; on mainnet a filler pays
 * from its own float). `cashUpper` is the most the fill can cost: the cash owed
 * only decays.
 */
async function fillSell(connection: Connection, order: SellOrder, basket: Basket, cashUpper: bigint) {
  const keeper = faucetKeypair()!;
  const componentProgram = new PublicKey(basket.tokenProgram);
  const shareMint = new PublicKey(basket.shareMint);
  const cashMint = new PublicKey(order.cashMint);
  const cashProgram = new PublicKey(order.cashTokenProgram);
  const cashAta = tokenAccount(cashMint, keeper.publicKey, cashProgram);
  const shareAta = tokenAccount(shareMint, keeper.publicKey, TOKEN_2022_PROGRAM_ID);
  const componentAtas = basket.components.map((c) => tokenAccount(new PublicKey(c.mint), keeper.publicKey, componentProgram));
  const infos = await connection.getMultipleAccountsInfo([cashAta, shareAta, ...componentAtas]);
  const prep: TransactionInstruction[] = [];
  const held = infos[0] && infos[0].data.length >= 72 ? Buffer.from(infos[0].data).readBigUInt64LE(64) : 0n;
  if (!infos[0]) prep.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, cashAta, keeper.publicKey, cashMint, cashProgram));
  if (held < cashUpper) prep.push(createMintToInstruction(cashMint, cashAta, keeper.publicKey, cashUpper - held, [], cashProgram));
  if (!infos[1]) prep.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, shareAta, keeper.publicKey, shareMint, TOKEN_2022_PROGRAM_ID));
  basket.components.forEach((c, i) => {
    if (!infos[i + 2]) prep.push(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, componentAtas[i], keeper.publicKey, new PublicKey(c.mint), componentProgram));
  });
  const table = basket.components.length >= ALT_MIN_COMPONENTS ? await ensureAlt(connection, keeper, basket) : null;
  const take = withMemo(fillSellOrderIx({ filler: keeper.publicKey, sellOrder: order, basket }));
  const redeem = redeemSharesInstruction({
    basket: new PublicKey(basket.address),
    shareMint,
    owner: keeper.publicKey,
    components: basket.components.map((c) => ({ mint: new PublicKey(c.mint) })),
    shares: order.shares,
    componentTokenProgram: componentProgram,
  });
  // Set-up, the buy and the redemption in one transaction when they fit; else set-up first, then the buy and redemption, then each alone.
  try {
    return await send(connection, [...prep, take, redeem], table);
  } catch (err) {
    if (!tooLarge(err)) throw err;
  }
  for (let i = 0; i < prep.length; i += 6) await send(connection, prep.slice(i, i + 6), table);
  try {
    return await send(connection, [take, redeem], table);
  } catch (err) {
    if (!tooLarge(err)) throw err;
    const sig = await send(connection, [take], table);
    await send(connection, [redeem], table);
    return sig;
  }
}

export async function runKeeper(opts: { maxActions?: number } = {}): Promise<Report> {
  const started = Date.now();
  const report: Report = { plansRun: [], ordersFilled: [], sellsFilled: [], sellsReturned: [], refunded: [], skipped: [], errors: [], marginUsd: 0 };
  const keeper = faucetKeypair();
  if (!keeper) {
    report.errors.push("No keeper key on this deployment.");
    return report;
  }
  const keeperKey = keeper.publicKey.toBase58();
  const connection = new Connection(WRITE_RPC, "confirmed");
  let budget = opts.maxActions ?? 6;
  let failedAttempts = 0;
  const fillLog: FillLogEntry[] = [];
  // Fixed slices of the route's 60 s: fills, then refunds, then plans, which always get their turn.
  const fillDeadline = started + 35_000;
  const refundDeadline = started + 40_000;
  const hardDeadline = started + 52_000;

  // The keeper spends the house key's SOL on rent it gets back later. Below this
  // floor it only refunds, so nobody can drain it by flooding the program.
  const [balance, clock] = await Promise.all([connection.getBalance(keeper.publicKey), chainClock(connection), loadFailures()]);
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
    return nav != null && nav.fair > 0 ? nav : null;
  };
  /** When the house would fill this order, by the cluster's clock, or null if never at today's prices. */
  const houseFillAt = (order: Order, basket: Basket, nav: Nav) =>
    firstSecondAtOrBelow(order, maxShares(Number(order.cashAmount) / 1e6, basket, nav));
  /** Never-failed first, then soonest; a few per wallet; at most MAX_JOBS. */
  const queue = <T extends { at: number; key: string; who: string }>(xs: T[]) => {
    const per = new Map<string, number>();
    return xs
      .sort((x, y) => Number(hasFailed(x.key)) - Number(hasFailed(y.key)) || x.at - y.at)
      .filter((j) => {
        const n = per.get(j.who) ?? 0;
        per.set(j.who, n + 1);
        return n < MAX_JOBS_PER_BUYER;
      })
      .slice(0, MAX_JOBS);
  };

  // 1. Live orders worth filling, first, since they are what a buyer is waiting on.
  // Every live order is priced (closed form, up to a sanity cap); those the house
  // would fill within the next half minute are kept, minus any backing off after a
  // failure, minus any whose buyer has no share account (or a frozen one) for the
  // shares to land in, checked in batches. Only then is the list cut, never-failed
  // first, soonest first, a few per buyer. Dollar orders under $5 are left to
  // other fillers: a fill costs the house rent for the creator's share account at
  // most, never the buyer's.
  const live = lowOnSol
    ? []
    : all
        .filter((o) => o.endTs >= now + 2 && o.cashAmount >= HOUSE_MIN_CASH && known.has(o.basket) && !backingOff(`fill:${o.address}`))
        .sort((x, y) => y.createdAt - x.createdAt)
        .slice(0, MAX_PRICED);
  let neverFair = 0;
  let later = 0;
  const priced: { order: Order; basket: Basket; nav: Nav; cash: number; at: number; key: string; who: string }[] = [];
  for (const order of live) {
    const basket = byAddress.get(order.basket)!;
    const nav = await navOf(basket);
    if (nav == null) continue;
    const at = houseFillAt(order, basket, nav);
    if (at == null || at > order.endTs - MIN_SECS_LEFT) neverFair++;
    else if (at - now > MAX_WAIT_SECS) later++;
    else priced.push({ order, basket, nav, cash: Number(order.cashAmount) / 1e6, at, key: `fill:${order.address}`, who: order.buyer });
  }
  if (neverFair) report.skipped.push(`${neverFair} open orders never fair at today's prices`);
  if (later) report.skipped.push(`${later} open orders reach the house's price more than ${MAX_WAIT_SECS}s from now`);
  const buyerShareInfos = await readMany(
    connection,
    priced.map((j) => tokenAccount(new PublicKey(j.basket.shareMint), new PublicKey(j.order.buyer), TOKEN_2022_PROGRAM_ID)),
  );
  const fillable = priced.filter((_, i) => {
    const st = tokenState(buyerShareInfos[i]);
    return st != null && !st.frozen;
  });
  if (priced.length > fillable.length) report.skipped.push(`${priced.length - fillable.length} fair orders whose buyer has no usable share account`);
  for (const job of queue(fillable)) {
    if (budget <= 0 || failedAttempts >= FAILED_ATTEMPTS) break;
    const wait = (job.at - clock()) * 1000;
    if (wait > 0 && Date.now() + wait > fillDeadline) {
      report.skipped.push(`${job.order.address.slice(0, 6)}: house price in ${Math.round(wait / 1000)}s`);
      continue;
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (job.order.endTs - clock() < MIN_SECS_LEFT) {
      report.skipped.push(`${job.order.address.slice(0, 6)}: auction ends in under ${MIN_SECS_LEFT}s`);
      continue;
    }
    // The auction only decays, so the count owed at the cluster's clock now is an
    // upper bound on what the fill will need when it lands.
    const shares = requiredShares(job.order, clock());
    const gross = grossSharesForNet(shares, job.basket.creatorFeeBps, job.basket.protocolFeeBps);
    const margin = marginBps(job.cash, shares, job.basket, job.nav);
    if (margin < marginFor(job.nav) - 0.01) {
      report.skipped.push(`${job.order.address.slice(0, 6)}: margin ${margin.toFixed(1)} bps, under ${marginFor(job.nav)}`);
      continue;
    }
    try {
      await fill(connection, job.order, job.basket, gross);
      const cost = costOf(shares, job.basket, job.nav);
      report.ordersFilled.push({
        order: job.order.address,
        shares: (Number(shares) / 1e6).toFixed(6),
        cash: job.cash.toFixed(2),
        marginBps: Math.round(margin * 10) / 10,
        navUsd: Math.round(job.nav.fair * 1e4) / 1e4,
        costUsd: Math.round(cost * 1e4) / 1e4,
        fallback: job.nav.fallback,
      });
      fillLog.push({ order: job.order.address, side: "buy", filler: "house", cash: job.cash, fair: cost, marginBps: Math.round(margin * 10) / 10, fallback: job.nav.fallback, at: Date.now() });
      report.marginUsd += job.cash - cost;
      openOrders.delete(job.order.address);
      noteSuccess(job.key);
      budget--;
    } catch (err) {
      // Another filler got there first: that is the auction working, not an error.
      if (!(await connection.getAccountInfo(new PublicKey(job.order.address)).catch(() => true))) {
        report.skipped.push(`${job.order.address.slice(0, 6)}: filled by another filler first`);
        openOrders.delete(job.order.address);
      } else {
        failedAttempts++;
        noteFailure(job.key, reason(err));
        report.errors.push(`order ${job.order.address.slice(0, 6)}: ${reason(err)}`);
      }
    }
  }

  // The dollar exit. A sell order's cash only decays, from what the seller asks to
  // their floor; the house buys once it is at most what the shares redeem for
  // (each component net of its transfer fee) less its margin, priced in closed
  // form like the buy side. The seller's canonical dollar account is checked
  // first: the fill pays into it, so a frozen one would fail every time (one that
  // requires a memo is fine: the Memo program rides along on every fill). Sell orders under $5 at their floor are left to other buyers.
  const everySell = lowOnSol ? [] : await fetchSellOrders(connection).catch(() => [] as SellOrder[]);
  const sells = everySell.filter((o) => o.cashMint === CASH_MINT && known.has(o.basket));
  const liveSells = sells
    .filter((o) => o.endTs >= now + 2 && o.endCash >= HOUSE_MIN_CASH && o.seller !== keeperKey && !backingOff(`sell:${o.address}`))
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, MAX_PRICED);
  const asLine = (o: SellOrder) => ({ startShares: o.startCash, endShares: o.endCash, startTs: o.startTs, endTs: o.endTs });
  const sellPriced: { order: SellOrder; basket: Basket; nav: Nav; value: number; at: number; key: string; who: string }[] = [];
  let sellNever = 0;
  for (const order of liveSells) {
    const basket = byAddress.get(order.basket)!;
    const nav = await navOf(basket);
    if (nav == null) continue;
    const value = (Number(order.shares) / Number(ONE_SHARE)) * nav.sell;
    const maxCash = BigInt(Math.floor(value * (1 - marginFor(nav) / 10_000) * 1e6));
    const at = firstSecondAtOrBelow(asLine(order), maxCash);
    if (at == null || at > order.endTs - MIN_SECS_LEFT) sellNever++;
    else if (at - now <= MAX_WAIT_SECS) sellPriced.push({ order, basket, nav, value, at, key: `sell:${order.address}`, who: order.seller });
  }
  if (sellNever) report.skipped.push(`${sellNever} sell orders whose floor is above the house's price`);
  const sellerCashInfos = await readMany(
    connection,
    sellPriced.map((j) => tokenAccount(new PublicKey(j.order.cashMint), new PublicKey(j.order.seller), new PublicKey(j.order.cashTokenProgram))),
  );
  const buyable = sellPriced.filter((_, i) => {
    // Missing is fine: the fill opens it, at the filler's expense.
    const st = tokenState(sellerCashInfos[i]);
    return sellerCashInfos[i] == null || (st != null && !st.frozen);
  });
  if (sellPriced.length > buyable.length) report.skipped.push(`${sellPriced.length - buyable.length} sell orders whose seller's dollar account cannot be paid into`);
  for (const job of queue(buyable)) {
    if (budget <= 0 || failedAttempts >= FAILED_ATTEMPTS) break;
    const wait = (job.at - clock()) * 1000;
    if (wait > 0 && Date.now() + wait > fillDeadline) {
      report.skipped.push(`sell ${job.order.address.slice(0, 6)}: house price in ${Math.round(wait / 1000)}s`);
      continue;
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (job.order.endTs - clock() < MIN_SECS_LEFT) {
      report.skipped.push(`sell ${job.order.address.slice(0, 6)}: auction ends in under ${MIN_SECS_LEFT}s`);
      continue;
    }
    const cash = requiredCash(job.order, clock());
    const discount = (1 - Number(cash) / 1e6 / job.value) * 10_000;
    if (discount < marginFor(job.nav) - 0.01) {
      report.skipped.push(`sell ${job.order.address.slice(0, 6)}: discount ${discount.toFixed(1)} bps, under ${marginFor(job.nav)}`);
      continue;
    }
    try {
      await fillSell(connection, job.order, job.basket, cash);
      const paid = Number(cash) / 1e6;
      const marginOnCash = ((job.value - paid) / paid) * 10_000;
      report.sellsFilled.push({
        order: job.order.address,
        shares: (Number(job.order.shares) / 1e6).toFixed(6),
        cash: paid.toFixed(2),
        discountBps: Math.round(discount * 10) / 10,
        navUsd: Math.round(job.nav.fair * 1e4) / 1e4,
        valueUsd: Math.round(job.value * 1e4) / 1e4,
        fallback: job.nav.fallback,
      });
      fillLog.push({ order: job.order.address, side: "sell", filler: "house", cash: paid, fair: job.value, marginBps: Math.round(marginOnCash * 10) / 10, fallback: job.nav.fallback, at: Date.now() });
      report.marginUsd += job.value - paid;
      noteSuccess(job.key);
      budget--;
    } catch (err) {
      if (!(await connection.getAccountInfo(new PublicKey(job.order.address)).catch(() => true))) {
        report.skipped.push(`sell ${job.order.address.slice(0, 6)}: bought by another filler first`);
      } else {
        failedAttempts++;
        noteFailure(job.key, reason(err));
        report.errors.push(`sell ${job.order.address.slice(0, 6)}: ${reason(err)}`);
      }
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
  // dollar account, so an order whose buyer has none, or a frozen one, can only
  // be cancelled by the buyer. Those are found in
  // batches, before the list is cut, and never attempted; anything that fails
  // anyway backs off. Attempts, not successes, are capped, and refunds stop in
  // time to leave the plans their slice.
  const plans = lowOnSol ? [] : await fetchPlans(connection);
  const planByAddress = new Map(plans.map((p) => [p.address, p]));
  const strike = (order: Order) => {
    const plan = order.plan ? planByAddress.get(order.plan) : undefined;
    if (plan) strikes.set(plan.address, { count: strikesFor(plan) + 1, fills: plan.fills, ref: plan.refSharesPerCashE9 });
  };
  const expiredAll = all.filter(
    (o) => o.endTs < now && (o.rentPayer === keeperKey || (o.endTs < now - REFUND_GRACE_SECS && o.cashAmount >= MIN_REFUND_CASH)),
  );
  const refundCash = await readMany(
    connection,
    expiredAll.map((o) => tokenAccount(new PublicKey(o.cashMint), new PublicKey(o.buyer), new PublicKey(o.cashTokenProgram))),
  );
  const refundable = expiredAll.filter((o, i) => {
    const st = tokenState(refundCash[i]);
    if (st && !st.frozen) return true;
    strike(o);
    return false;
  });
  if (expiredAll.length > refundable.length) {
    report.skipped.push(`${expiredAll.length - refundable.length} expired orders whose buyer's dollar account cannot be refunded into; only the buyer can cancel them`);
  }
  const expired = refundable
    .filter((o) => !backingOff(`refund:${o.address}`))
    .sort(
      (x, y) =>
        Number(y.rentPayer === keeperKey) - Number(x.rentPayer === keeperKey) ||
        Number(hasFailed(`refund:${x.address}`)) - Number(hasFailed(`refund:${y.address}`)) ||
        x.endTs - y.endTs,
    )
    .slice(0, 100);
  let attempts = 0;
  for (const order of expired) {
    if (attempts >= REFUND_ATTEMPTS || Date.now() > refundDeadline) break;
    attempts++;
    try {
      await send(connection, [withMemo(cancelOrderIx({ caller: keeper.publicKey, order }))]);
      report.refunded.push(order.address);
      openOrders.delete(order.address);
      noteSuccess(`refund:${order.address}`);
    } catch (err) {
      noteFailure(`refund:${order.address}`, reason(err));
      report.errors.push(`refund ${order.address.slice(0, 6)}: ${reason(err)}`);
    }
    strike(order);
  }

  // Expired sell orders: the shares go back to the seller's canonical share
  // account, the only place a third party may send them. The seller always paid
  // the rent, so the house waits out the same ten minutes, and shares the same
  // attempt cap and deadline.
  const expiredSellsAll = sells.filter((o) => o.endTs < now - REFUND_GRACE_SECS && o.endCash >= MIN_REFUND_CASH && !backingOff(`sellrefund:${o.address}`));
  const sellerShares = await readMany(
    connection,
    expiredSellsAll.map((o) => tokenAccount(new PublicKey(byAddress.get(o.basket)!.shareMint), new PublicKey(o.seller), TOKEN_2022_PROGRAM_ID)),
  );
  const expiredSells = expiredSellsAll
    .filter((_, i) => {
      const st = tokenState(sellerShares[i]);
      return st != null && !st.frozen;
    })
    .sort((x, y) => Number(hasFailed(`sellrefund:${x.address}`)) - Number(hasFailed(`sellrefund:${y.address}`)) || x.endTs - y.endTs)
    .slice(0, 100);
  if (expiredSellsAll.length > expiredSells.length) {
    report.skipped.push(`${expiredSellsAll.length - expiredSells.length} expired sell orders whose seller's share account cannot take the shares back; only the seller can cancel them`);
  }
  for (const order of expiredSells) {
    if (attempts >= REFUND_ATTEMPTS || Date.now() > refundDeadline) break;
    attempts++;
    try {
      await send(connection, [withMemo(cancelSellOrderIx({ caller: keeper.publicKey, sellOrder: order, basket: byAddress.get(order.basket)! }))]);
      report.sellsReturned.push(order.address);
      noteSuccess(`sellrefund:${order.address}`);
    } catch (err) {
      noteFailure(`sellrefund:${order.address}`, reason(err));
      report.errors.push(`sell refund ${order.address.slice(0, 6)}: ${reason(err)}`);
    }
  }

  // 3. Plans that are due. Only plans the house would sensibly run: Sheaf's test
  // dollar, a real basket, at least a minute between runs, an auction no longer
  // than two hours, at least $5 a run, and an auction that reaches the house's
  // price at today's quotes. One open order per plan (its last order must be filled
  // or refunded first), one plan per owner per call, none after two runs in a row
  // expired unfilled or failed (until the owner re-centres it), none while backing
  // off after a failed run, and a cap on house-paid plan orders open at once, with
  // some of it kept for plans that have filled before.
  //
  // The pure checks come first. Then one batched read of every candidate's share
  // account and dollar account: the owner must hold the basket's share account
  // (or the fill could never land), and the plan must draw from the owner's
  // canonical dollar account, unfrozen, holding at least a run, with the plan as
  // delegate for at least a run (or run_plan would fail). Proven plans go first.
  // Anyone else's plan can still be run by anyone; the house just won't pay for it.
  //
  // An expired order is waiting for its refund, not using the cap, and neither is
  // an open one whose owner has closed the share account since the run.
  const houseOpen = everyOrder.filter((o) => o.plan != null && o.rentPayer === keeperKey && openOrders.has(o.address) && o.endTs >= now && known.has(o.basket));
  const openShares = await readMany(
    connection,
    houseOpen.map((o) => tokenAccount(new PublicKey(byAddress.get(o.basket)!.shareMint), new PublicKey(o.buyer), TOKEN_2022_PROGRAM_ID)),
  );
  let housePlanOrders = 0;
  let unproven = 0;
  for (const [i, o] of houseOpen.entries()) {
    const basket = byAddress.get(o.basket)!;
    const nav = await navOf(basket);
    // An order that can never reach fair holds no slot: no new run of its plan will start.
    if (nav != null && houseFillAt(o, basket, nav) == null) continue;
    if (!openShares[i]) continue;
    housePlanOrders++;
    if ((planByAddress.get(o.plan!)?.fills ?? 0) === 0) unproven++;
  }
  const due: { plan: Plan; basket: Basket }[] = [];
  for (const plan of plans) {
    if (plan.legacy || plan.runsLeft <= 0 || now < plan.nextRunTs) continue;
    if (plan.cashMint !== CASH_MINT || !known.has(plan.basket) || plan.periodSecs < 60 || plan.auctionSecs > 7200 || plan.cashPerRun < HOUSE_MIN_CASH) continue;
    if (plan.lastOrder && openOrders.has(plan.lastOrder)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: last order still open`);
      continue;
    }
    if (strikesFor(plan) >= MAX_PLAN_STRIKES) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: last ${MAX_PLAN_STRIKES} runs expired unfilled; waiting for a re-centre`);
      continue;
    }
    if (backingOff(`plan:${plan.address}`)) continue;
    const basket = byAddress.get(plan.basket)!;
    const owner = new PublicKey(plan.owner);
    if (plan.cashAccount !== tokenAccount(new PublicKey(plan.cashMint), owner, new PublicKey(plan.cashTokenProgram)).toBase58()) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: draws from a dollar account that is not the owner's own, so a refund could never land`);
      continue;
    }
    const nav = await navOf(basket);
    const auction = planAuction(plan);
    if (nav == null || auction.end <= 0n || auction.end > maxShares(Number(plan.cashPerRun) / 1e6, basket, nav)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: its auction never reaches today's price`);
      continue;
    }
    due.push({ plan, basket });
  }
  const planInfos = await readMany(
    connection,
    due.flatMap(({ plan, basket }) => [tokenAccount(new PublicKey(basket.shareMint), new PublicKey(plan.owner), TOKEN_2022_PROGRAM_ID), new PublicKey(plan.cashAccount)]),
  );
  const runnable = due
    .filter(({ plan, basket }, i) => {
      const share = tokenState(planInfos[2 * i]);
      const cash = tokenState(planInfos[2 * i + 1]);
      const why =
        !share || share.frozen
          ? `the owner has no usable ${basket.symbol} share account for the fill to land in`
          : !cash || cash.frozen
            ? "its dollar account is missing or frozen"
            : cash.amount < plan.cashPerRun
              ? "the owner's dollar account holds less than one run"
              : cash.delegate !== plan.address || cash.delegated < plan.cashPerRun
                ? "the plan's allowance on the dollar account is revoked or spent"
                : null;
      if (why) report.skipped.push(`plan ${plan.address.slice(0, 6)}: ${why}`);
      return why == null;
    })
    .sort((x, y) => Number(y.plan.fills > 0) - Number(x.plan.fills > 0) || x.plan.nextRunTs - y.plan.nextRunTs);
  const owners = new Set<string>();
  let planAttempts = 0;
  for (const { plan } of runnable) {
    if (budget <= 0 || planAttempts >= MAX_PLAN_ATTEMPTS || failedAttempts >= FAILED_ATTEMPTS || Date.now() > hardDeadline) break;
    if (owners.has(plan.owner)) continue;
    if (housePlanOrders >= MAX_HOUSE_PLAN_ORDERS || (plan.fills === 0 && unproven >= MAX_UNPROVEN_PLAN_ORDERS)) {
      report.skipped.push(`plan ${plan.address.slice(0, 6)}: ${housePlanOrders} house-paid plan orders already open`);
      continue;
    }
    planAttempts++;
    try {
      const { ix } = runPlanIx({ cranker: keeper.publicKey, plan, nonce: freshNonce() });
      await send(connection, [ix]);
      report.plansRun.push(plan.address);
      owners.add(plan.owner);
      housePlanOrders++;
      if (plan.fills === 0) unproven++;
      noteSuccess(`plan:${plan.address}`);
      budget--;
    } catch (err) {
      // A run that fails is a strike, and backs off, like one that expires unfilled.
      failedAttempts++;
      strikes.set(plan.address, { count: strikesFor(plan) + 1, fills: plan.fills, ref: plan.refSharesPerCashE9 });
      noteFailure(`plan:${plan.address}`, reason(err));
      report.errors.push(`plan ${plan.address.slice(0, 6)}: ${reason(err)}`);
    }
  }
  await Promise.all([saveFailures(), recordFills(fillLog)]);
  return report;
}
