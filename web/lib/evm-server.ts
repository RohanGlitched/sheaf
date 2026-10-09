import "server-only";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  maxUint256,
  nonceManager,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  publicActions,
  createClient,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Account as TempoAccount, Actions as TempoActions, Addresses as TempoAddresses } from "viem/tempo";
import { sendTransactionSync } from "viem/actions";
import { DEPLOYED, type ChainBasket, type Deployment } from "./chains";
import {
  BASKET_ABI,
  DESK_ABI,
  DESK_V2_ABI,
  ERC20_ABI,
  MIRROR_ABI,
  ONE_SHARE,
  PLAN_DESK_ABI,
  PROTOCOL_FEE_BPS,
  TEMPO_PATH_USD,
  TEMPO_SIP_V2,
  auctionSharesAt,
  evmChain,
  fairSharesFor,
  fetchRobinhoodPrices,
  fromRaw,
  isTempo,
  mintAmounts,
  navFrom,
  publicClientFor,
  readDeskOrderV2,
  readDeskOrders,
  readDeskOrdersV2,
  readPlansOf,
  tempoSipV2Terms,
  v2FillSplit,
  v2Of,
  type DeskOrder,
  type DeskOrderV2,
  type PlanV2,
} from "./evm";

/**
 * The house account on the EVM testnets: the faucet that hands out Robinhood's
 * real test stock tokens, the gas drip, and the filler of last resort on the
 * creation desks. It is the testnet deployer key, read from EVM_FAUCET_PRIVATE_KEY,
 * and it never leaves the server. Everything it does is something any account
 * could do on chain; it just saves a visitor from having to find the tokens first.
 */

export function houseKey(): Hex | null {
  const raw = process.env.EVM_FAUCET_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : null;
}

let account: PrivateKeyAccount | null = null;
export function houseAccount(): PrivateKeyAccount | null {
  const key = houseKey();
  if (!key) return null;
  if (!account) account = privateKeyToAccount(key, { nonceManager });
  return account;
}

export function deploymentFor(network: string): Deployment | undefined {
  return DEPLOYED.find((c) => c.key === network)?.deployment;
}

export function walletFor(d: Deployment) {
  const acct = houseAccount();
  if (!acct) throw new Error("EVM_FAUCET_PRIVATE_KEY is not set on this deployment.");
  return createWalletClient({ account: acct, chain: evmChain(d), transport: http(d.rpc, { timeout: 20_000 }) });
}

/** One chain at a time: the house key's nonces must not race between requests. */
const locks = new Map<string, Promise<unknown>>();
export async function withChainLock<T>(network: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(network) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(network, prev.then(() => next));
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

/** A sliding-window counter. Per instance, deliberately simple, like the Solana faucet's. */
export function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): { ok: boolean; retryInSec: number } {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      hits.set(key, recent);
      if (recent.length >= max) return { ok: false, retryInSec: Math.ceil((windowMs - (now - recent[0])) / 1000) };
      return { ok: true, retryInSec: 0 };
    },
    hit(key: string) {
      const list = hits.get(key) ?? [];
      list.push(Date.now());
      hits.set(key, list);
    },
    /** Give back the latest hit, when the action it reserved did not happen. */
    undo(key: string) {
      hits.get(key)?.pop();
    },
  };
}

// ------------------------------------------------------------------ gas drip

/**
 * Tiny amounts of testnet ETH, only to an address that is nearly empty. Sized so
 * one drip covers the whole flow on that chain (faucet calls, approvals, a mint,
 * a redemption and a desk order) at today's testnet gas prices.
 */
export const GAS_DRIP: Record<string, { amount: string; below: string } | undefined> = {
  robinhoodTestnet: { amount: "0.00003", below: "0.00001" },
  // Arbitrum Sepolia gas rose: 0.00015 no longer covered 8 mints, 8 approvals and a create (Oct 9 QA).
  arbitrumSepolia: { amount: "0.0003", below: "0.0001" },
  baseSepolia: { amount: "0.00003", below: "0.00001" },
  // Sepolia: the house has almost nothing left. Tempo: there is no gas token.
};

export async function dripGas(d: Deployment, to: Address): Promise<{ hash?: Hex; note: string }> {
  const drip = GAS_DRIP[d.network];
  if (!drip) {
    return {
      note: isTempo(d)
        ? "Tempo has no gas token; fees are paid in pathUSD from the Tempo faucet."
        : "No gas drip on this chain. Use a public faucet for test ETH.",
    };
  }
  const client = publicClientFor(d);
  const have = await client.getBalance({ address: to });
  if (have >= parseEther(drip.below)) return { note: `Already holds ${formatEther(have)} ETH for gas.` };
  const wallet = walletFor(d);
  const hash = await wallet.sendTransaction({ to, value: parseEther(drip.amount) });
  return { hash, note: `${drip.amount} ETH for gas` };
}

// --------------------------------------------------------------- house filler

export type FillResult = {
  network: string;
  id: number;
  /** Which desk the order is on: 1, the fixed-price CreationDesk; 2, the CreationDeskV2 auction. */
  version: 1 | 2;
  status: "filled" | "skipped" | "failed";
  reason?: string;
  hash?: Hex;
  /** A skipped v2 auction the house will take later: seconds until it reaches the house's price. */
  retryInSec?: number;
};

/** Above this, the house leaves a real-token order to other participants. */
const MAX_REAL_SHARES = 2n * ONE_SHARE;
/** Above this, even a mirror order is left alone. Mirrors are free, gas is not. */
const MAX_MIRROR_SHARES = 5n * ONE_SHARE;
/**
 * A v1 mirror order must offer at least the shares' value less this band, at the live
 * quotes (the deploy-time prices when those are unreachable). The v1 order form offered
 * 1% over, so this only turns away orders asking for shares far below their value.
 */
const MIRROR_BAND = 0.05;
/**
 * The house fills a v2 auction once the escrowed dollars cover the stocks it delivers
 * (the gross shares, both fees included) at fair value plus this margin: the same 15 bps
 * the Solana keeper waits for. Any other filler may fill earlier, for a better count.
 */
export const FILL_MARGIN_BPS = 15;
/** A named order's fill waits at most this long for the house's price; a sweep a little less. */
const MAX_WAIT_SECS = 30;
const SWEEP_WAIT_SECS = 20;
/** Expired v2 orders the house refunds per sweep (anyone may; the cash goes to the buyer). */
const REFUNDS_PER_SWEEP = 2;
/** A buyer's own expired order is theirs to cancel for this long before the house does it. */
const REFUND_GRACE_SECS = 10 * 60;
/** House fills per buyer per hour, across chains. Per instance, like the faucets. */
const perBuyer = rateLimiter(60 * 60_000, 3);
/**
 * SIP instalments the house placed itself, as network:v2:id. They are bounded by the
 * plan's own terms already, so the per-buyer quota never strands one.
 */
const sipOrders = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function basketOf(d: Deployment, address: string): ChainBasket | undefined {
  return d.baskets.find((b) => b.address.toLowerCase() === address.toLowerCase());
}

/** The price the house checks orders against: live quotes on Robinhood Chain; live, else deploy-time, on mirror chains. */
function navFor(d: Deployment, basket: ChainBasket, prices: Record<string, number>): number | null {
  return d.tokenSource === "real" ? navFrom(basket, prices) : navFrom(basket, { ...(basket.pricedAt ?? {}), ...prices });
}

type Delivery = { ok: true; hash: Hex } | { ok: false; reason: string; hash?: Hex };

/**
 * Deliver `need` of every component to `spender` and send `fillData` to it. On mirror
 * chains the house mints what it is missing from the public faucet first; on Robinhood
 * Chain it only fills from what it holds. On Tempo every mint, approval and the fill go
 * in one atomic transaction, fees in pathUSD.
 */
async function deliverAndFill(d: Deployment, basket: ChainBasket, need: readonly bigint[], spender: Address, fillData: Hex): Promise<Delivery> {
  const acct = houseAccount()!;
  const client = publicClientFor(d);
  const balances = await Promise.all(
    basket.components.map((c) => client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [acct.address] })),
  );
  const allowances = await Promise.all(
    basket.components.map((c) => client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "allowance", args: [acct.address, spender] })),
  );
  const short = basket.components.filter((_, i) => balances[i] < need[i]);
  if (d.tokenSource === "real" && short.length > 0) {
    return { ok: false, reason: `the house holds too little ${short.map((c) => c.symbol).join(", ")}; any holder of the components can fill it` };
  }
  const calls: { to: Address; data: Hex }[] = [];
  basket.components.forEach((c, i) => {
    let missing = need[i] > balances[i] ? need[i] - balances[i] : 0n;
    const cap = 100n * ONE_SHARE;
    while (missing > 0n) {
      const chunk = missing > cap ? cap : missing;
      calls.push({ to: c.token as Address, data: encodeFunctionData({ abi: MIRROR_ABI, functionName: "mint", args: [acct.address, chunk] }) });
      missing -= chunk;
    }
    if (allowances[i] < need[i]) {
      calls.push({ to: c.token as Address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, maxUint256] }) });
    }
  });
  const fillCall = { to: spender, data: fillData };

  if (isTempo(d)) {
    const tempo = createClient({
      account: TempoAccount.fromSecp256k1(houseKey()!),
      chain: tempoModerato.extend({ feeToken: TEMPO_PATH_USD }),
      transport: http(d.rpc, { timeout: 20_000 }),
    }).extend(publicActions);
    const receipt = await sendTransactionSync(tempo, { calls: [...calls, fillCall] } as never);
    return receipt.status === "success" ? { ok: true, hash: receipt.transactionHash } : { ok: false, reason: "the fill reverted", hash: receipt.transactionHash };
  }
  const wallet = walletFor(d);
  const prep = await Promise.all(calls.map((c) => wallet.sendTransaction({ to: c.to, data: c.data })));
  await Promise.all(prep.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 60_000 })));
  const hash = await wallet.sendTransaction(fillCall);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return receipt.status === "success" ? { ok: true, hash } : { ok: false, reason: "the fill reverted", hash };
}

/** v1: a fixed-price order, filled when it offers at least the shares' value (less a band on mirrors). */
async function fillOne(d: Deployment, o: DeskOrder, prices: Record<string, number>): Promise<FillResult> {
  const base = { network: d.network, id: o.id, version: 1 as const };
  const basket = basketOf(d, o.basket);
  if (!basket) return { ...base, status: "skipped", reason: "basket not in this deployment's list" };
  if (o.expiry * 1000 <= Date.now()) return { ...base, status: "skipped", reason: "expired; the buyer can cancel it" };
  const isReal = d.tokenSource === "real";
  if (o.shares > (isReal ? MAX_REAL_SHARES : MAX_MIRROR_SHARES)) {
    return { ...base, status: "skipped", reason: isReal ? "larger than the house fills; any holder of the components can fill it" : "larger than the house fills" };
  }
  const nav = navFor(d, basket, prices);
  if (nav == null) return { ...base, status: "skipped", reason: isReal ? "no live price to check the order against" : "no price to check the order against" };
  const fair = nav * fromRaw(o.shares);
  const offered = fromRaw(o.usdgAmount, d.stable.decimals);
  if (offered < fair * (isReal ? 0.98 : 1 - MIRROR_BAND)) {
    return { ...base, status: "skipped", reason: `offers ${offered.toFixed(2)} ${d.stable.symbol} against a fair ${fair.toFixed(2)}` };
  }
  const buyerKey = o.buyer.toLowerCase();
  const quota = perBuyer.check(buyerKey);
  if (!quota.ok) return { ...base, status: "skipped", reason: `the house has filled this buyer's orders enough for now; try again in ${Math.ceil(quota.retryInSec / 60)} min, or any holder can fill it` };
  const r = await deliverAndFill(d, basket, mintAmounts(basket, o.shares), d.desk as Address, encodeFunctionData({ abi: DESK_ABI, functionName: "fill", args: [BigInt(o.id)] }));
  if (!r.ok) return { ...base, status: r.hash ? "failed" : "skipped", reason: r.reason, hash: r.hash };
  perBuyer.hit(buyerKey);
  return { ...base, status: "filled", hash: r.hash };
}

/**
 * The most shares-to-buyer the house will deliver for an order's cash: the gross shares
 * (creator and protocol fee included) must cost at most cash / (1 + margin) at `nav`.
 */
function houseMaxShares(cash: bigint, decimals: number, creatorFeeBps: number, nav: number): bigint {
  const grossCap = BigInt(Math.floor((fromRaw(cash, decimals) / (nav * (1 + FILL_MARGIN_BPS / 10_000))) * 1e18));
  if (grossCap <= 0n) return 0n;
  let net = (grossCap * (10_000n - BigInt(creatorFeeBps) - PROTOCOL_FEE_BPS)) / 10_000n;
  for (let i = 0; i < 4 && net > 0n && v2FillSplit(net, creatorFeeBps).gross > grossCap; i++) net--;
  return net;
}

/** The first second at which the auction owes at most `target` shares; null if even its end asks for more. */
function firstSecondAtOrBelow(o: DeskOrderV2, target: bigint): number | null {
  if (o.startShares <= target) return o.startTs;
  if (o.endShares > target) return null;
  const drop = o.startShares - o.endShares;
  const span = BigInt(o.endTs - o.startTs);
  if (drop <= 0n || span <= 0n) return o.endTs;
  let t = o.startTs + Number(((o.startShares - target) * span + drop - 1n) / drop);
  for (let i = 0; i < 3 && t < o.endTs && auctionSharesAt(o, t) > target; i++) t++;
  return Math.min(t, o.endTs);
}

/** v2: an auction, filled once its count reaches the house's price (fair plus FILL_MARGIN_BPS), waiting up to `maxWait` seconds for it. */
async function fillOneV2(d: Deployment, o: DeskOrderV2, prices: Record<string, number>, maxWait: number): Promise<FillResult> {
  const v2 = v2Of(d)!;
  const base = { network: d.network, id: o.id, version: 2 as const };
  const basket = basketOf(d, o.basket);
  if (!basket) return { ...base, status: "skipped", reason: "basket not in this deployment's list" };
  const now = Math.floor(Date.now() / 1000);
  if (o.endTs <= now + 2) return { ...base, status: "skipped", reason: "the auction has ended; anyone can cancel it and the dollars go back to the buyer" };
  const isReal = d.tokenSource === "real";
  if (o.startShares > (isReal ? MAX_REAL_SHARES : MAX_MIRROR_SHARES)) {
    return { ...base, status: "skipped", reason: isReal ? "larger than the house fills; any holder of the components can fill it" : "larger than the house fills" };
  }
  const nav = navFor(d, basket, prices);
  if (nav == null) return { ...base, status: "skipped", reason: "no price to check the auction against" };
  const target = houseMaxShares(o.cashAmount, d.stable.decimals, basket.feeBps, nav);
  const at = firstSecondAtOrBelow(o, target);
  if (at == null) {
    return {
      ...base,
      status: "skipped",
      reason: `even its last count (${fromRaw(o.endShares).toFixed(4)} ${basket.symbol}) costs more than the escrow at today's price plus ${FILL_MARGIN_BPS / 100}%; any filler can still take it`,
    };
  }
  if (at - now > maxWait) {
    return { ...base, status: "skipped", reason: `the auction reaches the house's price (fair plus ${FILL_MARGIN_BPS / 100}%) in ${at - now}s; any filler can take it sooner`, retryInSec: at - now };
  }
  const buyerKey = o.buyer.toLowerCase();
  const counted = !sipOrders.has(`${d.network}:v2:${o.id}`);
  const quota = counted ? perBuyer.check(buyerKey) : { ok: true, retryInSec: 0 };
  if (!quota.ok) return { ...base, status: "skipped", reason: `the house has filled this buyer's orders enough for now; try again in ${Math.ceil(quota.retryInSec / 60)} min, or any holder can fill it` };

  if (at > now) await sleep((at - now) * 1000 + 1_000);
  // Another sweep (or another filler) may have taken it while this one waited for the chain lock or the price.
  const fresh = await readDeskOrderV2(d, o.id);
  if (fresh.status !== "Open") {
    return { ...base, status: "skipped", reason: fresh.status === "Filled" ? `already filled by ${fresh.filler.toLowerCase() === houseAccount()!.address.toLowerCase() ? "the house" : fresh.filler}` : "no longer open" };
  }
  // The count only falls, so the chain's own quote at its latest block bounds what the fill takes when it lands.
  const client = publicClientFor(d);
  let quote: readonly [bigint, bigint, readonly bigint[]] | null = null;
  for (let i = 0; i < 6; i++) {
    quote = await client.readContract({ address: v2.desk as Address, abi: DESK_V2_ABI, functionName: "quoteFill", args: [BigInt(o.id)] });
    if (quote[0] <= target) break;
    await sleep(1_500);
  }
  if (!quote || quote[0] > target) return { ...base, status: "skipped", reason: "the chain's clock has not reached the house's price yet", retryInSec: 5 };
  const r = await deliverAndFill(d, basket, quote[2], v2.desk as Address, encodeFunctionData({ abi: DESK_V2_ABI, functionName: "fill", args: [BigInt(o.id)] }));
  if (!r.ok) return { ...base, status: r.hash ? "failed" : "skipped", reason: r.reason, hash: r.hash };
  if (counted) perBuyer.hit(buyerKey);
  return { ...base, status: "filled", hash: r.hash };
}

/** Return the cash of expired, unfilled v2 orders to their buyers. Anyone may; the house does it after a grace period. */
async function refundExpiredV2(d: Deployment, orders: DeskOrderV2[]): Promise<FillResult[]> {
  const v2 = v2Of(d)!;
  const now = Math.floor(Date.now() / 1000);
  const due = orders.filter((o) => o.status === "Open" && o.endTs + REFUND_GRACE_SECS < now).slice(0, REFUNDS_PER_SWEEP);
  const out: FillResult[] = [];
  for (const o of due) {
    const base = { network: d.network, id: o.id, version: 2 as const };
    try {
      const data = encodeFunctionData({ abi: DESK_V2_ABI, functionName: "cancel", args: [BigInt(o.id)] });
      let hash: Hex;
      if (isTempo(d)) {
        const tempo = createClient({
          account: TempoAccount.fromSecp256k1(houseKey()!),
          chain: tempoModerato.extend({ feeToken: TEMPO_PATH_USD }),
          transport: http(d.rpc, { timeout: 20_000 }),
        }).extend(publicActions);
        hash = (await sendTransactionSync(tempo, { calls: [{ to: v2.desk as Address, data }] } as never)).transactionHash;
      } else {
        hash = await walletFor(d).sendTransaction({ to: v2.desk as Address, data });
        await publicClientFor(d).waitForTransactionReceipt({ hash, timeout: 60_000 });
      }
      out.push({ ...base, status: "skipped", reason: "the auction ended unfilled; the house cancelled it and the dollars went back to the buyer", hash });
    } catch (err) {
      out.push({ ...base, status: "failed", reason: `refund: ${((err as Error).message ?? "error").split("\n")[0].slice(0, 160)}` });
    }
  }
  return out;
}

/**
 * Fill the open, fair, unexpired orders on one chain, at most `max` per run: v2 auctions
 * first (at the house's price, waiting up to half a minute for it), then any v1 orders
 * still open. A named order needs its `version` (default 1, the v1 desk). A sweep also
 * refunds a couple of v2 orders that ended unfilled.
 */
export async function runEvmKeeper(
  d: Deployment,
  opts: { orderId?: number; max?: number; version?: 1 | 2; maxWaitSecs?: number } = {},
): Promise<FillResult[]> {
  const max = opts.max ?? 3;
  const named = opts.orderId != null;
  const version = named ? (opts.version ?? 1) : opts.version;
  const hasV2 = !!v2Of(d);
  const [v2Orders, v1Orders] = await Promise.all([
    hasV2 && version !== 1 ? readDeskOrdersV2(d, 15) : Promise.resolve([] as DeskOrderV2[]),
    version !== 2 ? readDeskOrders(d, 15) : Promise.resolve([] as DeskOrder[]),
  ]);
  const pick = <T extends { id: number; status: string }>(rows: T[]) => rows.filter((o) => o.status === "Open" && (!named || o.id === opts.orderId));
  const now = Math.floor(Date.now() / 1000);
  const openV2 = pick(v2Orders).filter((o) => named || o.endTs > now);
  const openV1 = pick(v1Orders);
  const expiredV2 = named ? [] : v2Orders.filter((o) => o.status === "Open" && o.endTs <= now);
  if (openV2.length === 0 && openV1.length === 0 && expiredV2.length === 0) return [];
  // Mirror chains are checked against the same quotes; a mirror basket falls back to its deploy-time prices.
  const prices = openV2.length + openV1.length > 0 ? await fetchRobinhoodPrices(d.tokens.map((t) => t.symbol)) : {};
  const wait = opts.maxWaitSecs ?? (named ? MAX_WAIT_SECS : SWEEP_WAIT_SECS);
  return withChainLock(d.network, async () => {
    const out: FillResult[] = [];
    const failed = (version: 1 | 2, id: number, err: unknown): FillResult => ({
      network: d.network,
      id,
      version,
      status: "failed",
      reason: ((err as Error).message ?? "error").split("\n")[0].slice(0, 200),
    });
    // Soonest to reach the house's price first.
    for (const o of openV2.sort((a, b) => a.endTs - b.endTs).slice(0, max)) {
      try {
        out.push(await fillOneV2(d, o, prices, wait));
      } catch (err) {
        out.push(failed(2, o.id, err));
      }
    }
    for (const o of openV1.slice(0, Math.max(0, max - out.length))) {
      try {
        out.push(await fillOne(d, o, prices));
      } catch (err) {
        out.push(failed(1, o.id, err));
      }
    }
    if (expiredV2.length > 0) out.push(...(await refundExpiredV2(d, expiredV2)));
    return out;
  });
}

// ------------------------------------------------------------ Tempo SIP keeper

/**
 * What the keeper does for a Tempo SIP account. `instalment` runs this period's plan;
 * the other three are the demonstrations, each refused: `overspend` runs the plan at 1
 * raw share unit for the plan's cash (the price cap refuses it), `tooSoon` runs it a
 * second time inside the interval, and `outOfScope` calls the desk directly at the key's
 * own price (the access key's scope refuses it).
 */
export type SipAction = "instalment" | "overspend" | "outOfScope" | "tooSoon";
export const SIP_ACTIONS: readonly SipAction[] = ["instalment", "overspend", "outOfScope", "tooSoon"];

export type SipResult = {
  action: SipAction;
  ok: boolean;
  hash?: Hex;
  planId?: number;
  orderId?: number;
  fairShares?: string;
  startShares?: string;
  endShares?: string;
  fill?: FillResult;
  /** The chain's or the plan contract's refusal, by name, when it refused. */
  refusal?: string;
};

/**
 * The plan terms a visitor signs on Tempo, priced the way the keeper prices each run:
 * the first basket, at live Robinhood quotes for the underlying stocks (deploy-time
 * prices for any quote that is missing). Bigints as decimal strings.
 */
export async function tempoSipTerms() {
  const d = deploymentFor("tempoTestnet");
  const v2 = d ? v2Of(d) : null;
  if (!d || !v2) throw new Error("Tempo v2 is not deployed.");
  const basket = d.baskets[0];
  const prices = await fetchRobinhoodPrices(basket.components.map((c) => c.symbol));
  const nav = navFor(d, basket, prices);
  if (nav == null) throw new SipRefused("No price for the basket right now. Try again in a moment.");
  const t = tempoSipV2Terms(nav, d.stable.decimals);
  return {
    basket: basket.address,
    symbol: basket.symbol,
    nav,
    planDesk: v2.planDesk,
    desk: v2.desk,
    cashPerRun: t.cashPerRun.toString(),
    interval: t.interval.toString(),
    auctionSecs: t.auctionSecs.toString(),
    bandBps: t.bandBps,
    fairShares: t.fairShares.toString(),
    minShares: t.minShares.toString(),
    maxShares: t.maxShares.toString(),
  };
}

/**
 * The keeper side of a Tempo SIP. The visitor's account (a passkey, usually) opened a
 * plan on PlanDesk with its root key, then signed one key authorization naming the
 * house key as an access key, with a recurring AlphaUSD limit and two scoped calls:
 * AlphaUSD.approve with PlanDesk as spender, and PlanDesk.instalment. Here the house
 * signs as that access key, for that account. The plan contract fixes the amount, the
 * interval and the worst price; the chain fixes the budget and the scope. The keeper
 * only supplies today's fair share count, which must sit inside the visitor's bounds.
 */
export async function runTempoSip(account: Address, action: SipAction, opts: { auto?: boolean } = {}): Promise<SipResult> {
  const d = deploymentFor("tempoTestnet");
  const key = houseKey();
  if (!d || !key || !v2Of(d)) throw new Error("Tempo keeper not configured.");
  const slot = account.toLowerCase();
  if (sipInFlight.has(slot)) throw new SipRefused("The keeper is already acting for this account.");
  sipInFlight.add(slot);
  try {
    return await runTempoSipOnce(d, key, account, action, !!opts.auto);
  } finally {
    sipInFlight.delete(slot);
  }
}

/** A request the keeper turns down before it reaches the chain; `retryAt` is when asking again could succeed. */
export class SipRefused extends Error {
  constructor(message: string, readonly retryAt?: number) {
    super(message);
  }
}

/** One SIP call per account at a time, so two requests cannot both pass the schedule read. */
const sipInFlight = new Set<string>();

const CHAIN_REFUSAL = /(SpendingLimitExceeded|CallNotAllowed|KeyAlreadyRevoked|KeyExpired|KeyNotFound|[A-Z][A-Za-z]+(?:Exceeded|NotAllowed|Revoked|Expired))/;

/** The plan contract's own reason for a reverted run: the same call simulated from the account, its msg.sender. */
async function planRefusal(d: Deployment, account: Address, args: readonly [bigint, bigint]): Promise<string | null> {
  const v2 = v2Of(d)!;
  const reader = createClient({ chain: tempoModerato, transport: http(d.rpc, { timeout: 15_000 }) }).extend(publicActions);
  const reason = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return null;
    } catch (err) {
      const r = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      return r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? null) : null;
    }
  };
  const first = await reason(() => reader.simulateContract({ account, address: v2.planDesk as Address, abi: PLAN_DESK_ABI, functionName: "instalment", args }));
  // The schedule is checked before the price; when both refuse, say both.
  if (first === "TooSoon") {
    const price = await reason(() => reader.readContract({ address: v2.planDesk as Address, abi: PLAN_DESK_ABI, functionName: "auctionFor", args }));
    if (price) return `TooSoon, and ${price}`;
  }
  return first;
}

const shareText = (v: bigint) => fromRaw(v).toFixed(4);
const dayText = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

async function runTempoSipOnce(d: Deployment, key: Hex, account: Address, action: SipAction, auto: boolean): Promise<SipResult> {
  const v2 = v2Of(d)!;
  const keeper = TempoAccount.fromSecp256k1(key, { access: account });
  const client = createClient({
    account: keeper,
    chain: tempoModerato.extend({ feeToken: TEMPO_PATH_USD }),
    transport: http(d.rpc, { timeout: 20_000 }),
  }).extend(publicActions);
  const alpha = d.stable.address as Address;
  const planDesk = v2.planDesk as Address;
  const now = Math.floor(Date.now() / 1000);

  // The visitor's newest open plan on PlanDesk, for a basket this deployment lists.
  let plan: PlanV2 | undefined;
  if (action !== "outOfScope") {
    let plans: PlanV2[];
    try {
      plans = await readPlansOf(d, account);
    } catch {
      throw new SipRefused("Could not read this account's plan on Tempo. Try again in a moment.");
    }
    plan = [...plans].reverse().find((p) => p.active && basketOf(d, p.basket));
    if (!plan) throw new SipRefused("This account has no open plan on PlanDesk. Sign the plan first.", auto ? Date.now() + 6 * 3_600_000 : undefined);
    if (action === "instalment" && plan.nextRunAt > now) {
      throw new SipRefused(`This period's installment has already run. The next one is due ${dayText(plan.nextRunAt)}.`, plan.nextRunAt * 1000);
    }
    if (action === "tooSoon" && plan.nextRunAt <= now) {
      throw new SipRefused("This period's installment is due, so running it now would not be too soon. Run the installment first.");
    }
  }

  // The schedule only acts for a live key; the visitor's own buttons pass a dead one through, so the chain says no.
  if (auto) {
    const reader = createClient({ chain: tempoModerato, transport: http(d.rpc, { timeout: 15_000 }) }).extend(publicActions);
    const accessKey = keeper.accessKeyAddress;
    let live = false;
    try {
      const meta = await TempoActions.accessKey.getMetadata(reader, { account, accessKey });
      live =
        !meta.isRevoked &&
        meta.address.toLowerCase() === accessKey.toLowerCase() &&
        (meta.expiry === 0n || meta.expiry * 1000n > BigInt(Date.now()));
    } catch {
      throw new SipRefused("Could not read this plan's access key on Tempo. Try again in a moment.");
    }
    if (!live) throw new SipRefused("No live access key for this account.");
  }

  let fair = 0n;
  let calls: { to: Address; data: Hex }[];
  if (action === "outOfScope") {
    // What the v1 scope allowed: an order at the key's own price, straight on the desk.
    const basket = d.baskets[0];
    calls = [
      {
        to: v2.desk as Address,
        data: encodeFunctionData({
          abi: DESK_V2_ABI,
          functionName: "placeOrder",
          args: [basket.address as Address, TEMPO_SIP_V2.cashPerRun, 1n, 1n, BigInt(now), BigInt(now + 600)],
        }),
      },
    ];
  } else {
    const p = plan!;
    const basket = basketOf(d, p.basket)!;
    const prices = await fetchRobinhoodPrices(basket.components.map((c) => c.symbol));
    const nav = navFor(d, basket, prices);
    if (nav == null) throw new SipRefused("No price for the basket right now. Try again in a moment.", Date.now() + 600_000);
    fair = fairSharesFor(p.cashPerRun, d.stable.decimals, nav);
    if (action !== "overspend" && (fair < p.minShares || fair > p.maxShares)) {
      throw new SipRefused(
        `Today's price makes a run ${shareText(fair)} ${basket.symbol}, outside this plan's bounds (${shareText(p.minShares)} to ${shareText(p.maxShares)}). The keeper will not post it; open a new plan at today's price to go on.`,
        Date.now() + 6 * 3_600_000,
      );
    }
    const runFair = action === "overspend" ? 1n : fair;
    calls = [
      { to: alpha, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [planDesk, p.cashPerRun] }) },
      { to: planDesk, data: encodeFunctionData({ abi: PLAN_DESK_ABI, functionName: "instalment", args: [BigInt(p.id), runFair] }) },
    ];
  }

  let receipt;
  try {
    receipt = await sendTransactionSync(client, { calls } as never);
  } catch (err) {
    const e = err as { details?: string; shortMessage?: string; message?: string };
    const text = `${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`;
    const named = text.match(CHAIN_REFUSAL)?.[1];
    const fromPlan = !named && plan ? await planRefusal(d, account, [BigInt(plan.id), action === "overspend" ? 1n : fair]) : null;
    return {
      action,
      ok: false,
      planId: plan?.id,
      refusal: named ?? fromPlan ?? (e.shortMessage ?? "refused").split("\n")[0].slice(0, 160),
    };
  }
  if (receipt.status !== "success") return { action, ok: false, hash: receipt.transactionHash, planId: plan?.id, refusal: "reverted" };

  const ran = parseEventLogs({ abi: PLAN_DESK_ABI, logs: receipt.logs, eventName: "Instalment" })[0];
  const orderId = ran ? Number(ran.args.orderId) : undefined;
  let fill: FillResult | undefined;
  if (orderId != null) {
    // The house is also a participant: it fills once the auction reaches fair plus its margin.
    // The auction opens above that, so this answers at once with when; any filler can take it sooner.
    sipOrders.add(`${d.network}:v2:${orderId}`);
    fill = (await runEvmKeeper(d, { orderId, max: 1, version: 2, maxWaitSecs: 0 }))[0];
  }
  return {
    action,
    ok: true,
    hash: receipt.transactionHash,
    planId: plan?.id,
    orderId,
    fairShares: ran ? ran.args.fairShares.toString() : undefined,
    startShares: ran ? ran.args.startShares.toString() : undefined,
    endShares: ran ? ran.args.endShares.toString() : undefined,
    fill,
  };
}

// ------------------------------------------------------------ SIP schedule

/**
 * The schedule half of a Tempo SIP, run by the cron's sweep: every account that
 * authorized the house key gets its installment once its plan is due, without anyone
 * pressing a button. Accounts are found from the keychain's own KeyAuthorized events
 * naming the house key, so there is no list to keep. Each account's PlanDesk plan says
 * when it is next due (nextRunAt), and the contract refuses an early run anyway.
 */
const KEY_AUTHORIZED = parseAbiItem("event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry)");
/** Tempo's RPC answers getLogs over at most this many blocks. */
const LOG_RANGE = 100_000n;
/** Leave a fresh authorization to the visitor's own Installment button for this long. */
const SIP_GRACE_MS = 15 * 60_000;
/** Installments the schedule places per sweep, so one sweep stays short. */
const SIP_PER_SWEEP = 2;
/** Plans the schedule reads per sweep; the rest wait for the next sweep. */
const SIP_CHECKS_PER_SWEEP = 6;

const sipAccounts = new Map<string, { account: Address; authorizedAt: number; nextCheck: number }>();
let sipScannedTo: bigint | null = null;
let sipScan: Promise<void> | null = null;

async function discoverSipAccounts(d: Deployment) {
  const client = publicClientFor(d);
  const house = houseAccount()!.address;
  const latest = await client.getBlockNumber();
  const [head, back] = await Promise.all([
    client.getBlock({ blockNumber: latest }),
    client.getBlock({ blockNumber: latest > LOG_RANGE ? latest - LOG_RANGE : 0n }),
  ]);
  const secsPerBlock = Math.max(0.05, Number(head.timestamp - back.timestamp) / Number(latest > LOG_RANGE ? LOG_RANGE : latest || 1n));
  // First pass: one period back, since an older key has had this period's installment or expired.
  const lookback = BigInt(Math.ceil((TEMPO_SIP_V2.period + 86_400) / secsPerBlock));
  let from = sipScannedTo != null ? sipScannedTo + 1n : latest > lookback ? latest - lookback : 0n;
  const ranges: [bigint, bigint][] = [];
  for (; from <= latest; from += LOG_RANGE) ranges.push([from, from + LOG_RANGE - 1n > latest ? latest : from + LOG_RANGE - 1n]);
  for (let i = 0; i < ranges.length; i += 6) {
    const batch = await Promise.all(
      ranges.slice(i, i + 6).map(([fromBlock, toBlock]) =>
        client.getLogs({ address: TempoAddresses.accountKeychain as Address, event: KEY_AUTHORIZED, args: { publicKey: house }, fromBlock, toBlock }),
      ),
    );
    for (const log of batch.flat()) {
      const account = log.args.account;
      if (!account || log.blockNumber == null) continue;
      const authorizedAt = (Number(head.timestamp) - Number(latest - log.blockNumber) * secsPerBlock) * 1000;
      const prev = sipAccounts.get(account.toLowerCase());
      // A newer authorization (after a revoke, say) is a fresh plan: check it again.
      if (!prev || prev.authorizedAt < authorizedAt) sipAccounts.set(account.toLowerCase(), { account, authorizedAt, nextCheck: 0 });
    }
  }
  sipScannedTo = latest;
}

export type SipScheduleResult = {
  accounts: number;
  checked: number;
  placed: { account: string; ok: boolean; planId?: number; orderId?: number; fill?: string; refusal?: string }[];
  ms: number;
};

export async function runSipSchedule(): Promise<SipScheduleResult> {
  const started = Date.now();
  const d = deploymentFor("tempoTestnet");
  if (!d || !houseKey() || !v2Of(d)) return { accounts: 0, checked: 0, placed: [], ms: 0 };
  sipScan ??= discoverSipAccounts(d).finally(() => (sipScan = null));
  await sipScan;
  const placed: SipScheduleResult["placed"] = [];
  const now = Date.now();
  let checked = 0;
  for (const entry of sipAccounts.values()) {
    if (placed.length >= SIP_PER_SWEEP || checked >= SIP_CHECKS_PER_SWEEP) break;
    if (now < entry.nextCheck || now - entry.authorizedAt < SIP_GRACE_MS) continue;
    checked++;
    // Gate on the plan itself: no open plan, or not yet due, means no transaction at all.
    let plans: PlanV2[];
    try {
      plans = await readPlansOf(d, entry.account);
    } catch {
      entry.nextCheck = now + 600_000;
      continue;
    }
    const plan = [...plans].reverse().find((p) => p.active && basketOf(d, p.basket));
    if (!plan) {
      // A v1 authorization (scoped to the old desk) or a closed plan: nothing to run.
      entry.nextCheck = now + 6 * 3_600_000;
      continue;
    }
    if (plan.nextRunAt * 1000 > now) {
      entry.nextCheck = plan.nextRunAt * 1000;
      continue;
    }
    try {
      const r = await runTempoSip(entry.account, "instalment", { auto: true });
      placed.push({ account: entry.account, ok: r.ok, planId: r.planId, orderId: r.orderId, fill: r.fill?.status, refusal: r.refusal });
      // Placed: the plan's next due date. Refused by the chain (no AlphaUSD, say): try again in an hour.
      entry.nextCheck = r.ok ? now + plan.interval * 1000 : now + 3_600_000;
    } catch (err) {
      entry.nextCheck = err instanceof SipRefused ? (err.retryAt ?? now + 6 * 3_600_000) : now + 600_000;
    }
  }
  return { accounts: sipAccounts.size, checked, placed, ms: Date.now() - started };
}

export { BASKET_ABI };
