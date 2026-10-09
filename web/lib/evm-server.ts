import "server-only";
import {
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
  ERC20_ABI,
  MIRROR_ABI,
  ONE_SHARE,
  TEMPO_PATH_USD,
  TEMPO_SIP,
  evmChain,
  fetchRobinhoodPrices,
  fromRaw,
  isTempo,
  mintAmounts,
  navFrom,
  publicClientFor,
  readDeskOrders,
  type DeskOrder,
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
  arbitrumSepolia: { amount: "0.00015", below: "0.00005" },
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

export type FillResult = { network: string; id: number; status: "filled" | "skipped" | "failed"; reason?: string; hash?: Hex };

/** Above this, the house leaves a real-token order to other participants. */
const MAX_REAL_SHARES = 2n * ONE_SHARE;
/** Above this, even a mirror order is left alone. Mirrors are free, gas is not. */
const MAX_MIRROR_SHARES = 5n * ONE_SHARE;
/**
 * A mirror order must offer at least the shares' value less this band, at the live
 * quotes (the deploy-time prices when those are unreachable). The order form offers
 * 1% over, so this only turns away orders asking for shares far below their value.
 */
const MIRROR_BAND = 0.05;
/** House fills per buyer per hour, across chains. Per instance, like the faucets. */
const perBuyer = rateLimiter(60 * 60_000, 3);
/**
 * SIP instalments the house placed itself, as network:id. They are bounded by the
 * account's access-key budget already, so the per-buyer quota never strands one.
 */
const sipOrders = new Set<string>();

function basketOf(d: Deployment, address: string): ChainBasket | undefined {
  return d.baskets.find((b) => b.address.toLowerCase() === address.toLowerCase());
}

async function fillOne(d: Deployment, o: DeskOrder, prices: Record<string, number>): Promise<FillResult> {
  const base = { network: d.network, id: o.id };
  const basket = basketOf(d, o.basket);
  if (!basket) return { ...base, status: "skipped", reason: "basket not in this deployment's list" };
  if (o.expiry * 1000 <= Date.now()) return { ...base, status: "skipped", reason: "expired; the buyer can cancel it" };

  const acct = houseAccount()!;
  const client = publicClientFor(d);
  const need = mintAmounts(basket, o.shares);
  const isReal = d.tokenSource === "real";

  if (isReal) {
    if (o.shares > MAX_REAL_SHARES) return { ...base, status: "skipped", reason: "larger than the house fills; any holder of the components can fill it" };
    const nav = navFrom(basket, prices);
    if (nav == null) return { ...base, status: "skipped", reason: "no live price to check the order against" };
    const fair = nav * fromRaw(o.shares);
    const offered = fromRaw(o.usdgAmount, d.stable.decimals);
    if (offered < fair * 0.98) {
      return { ...base, status: "skipped", reason: `offers ${offered.toFixed(2)} ${d.stable.symbol} against a fair ${fair.toFixed(2)}` };
    }
  } else {
    if (o.shares > MAX_MIRROR_SHARES) return { ...base, status: "skipped", reason: "larger than the house fills" };
    const nav = navFrom(basket, { ...(basket.pricedAt ?? {}), ...prices });
    if (nav == null) return { ...base, status: "skipped", reason: "no price to check the order against" };
    const fair = nav * fromRaw(o.shares);
    const offered = fromRaw(o.usdgAmount, d.stable.decimals);
    if (offered < fair * (1 - MIRROR_BAND)) {
      return { ...base, status: "skipped", reason: `offers ${offered.toFixed(2)} ${d.stable.symbol} against a fair ${fair.toFixed(2)}` };
    }
  }
  const buyerKey = o.buyer.toLowerCase();
  const counted = !sipOrders.has(`${d.network}:${o.id}`);
  const quota = counted ? perBuyer.check(buyerKey) : { ok: true, retryInSec: 0 };
  if (!quota.ok) return { ...base, status: "skipped", reason: `the house has filled this buyer's orders enough for now; try again in ${Math.ceil(quota.retryInSec / 60)} min, or any holder can fill it` };

  const balances = await Promise.all(
    basket.components.map((c) => client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [acct.address] })),
  );
  const allowances = await Promise.all(
    basket.components.map((c) =>
      client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "allowance", args: [acct.address, d.desk as Address] }),
    ),
  );
  const short = basket.components.filter((_, i) => balances[i] < need[i]);
  if (isReal && short.length > 0) {
    return {
      ...base,
      status: "skipped",
      reason: `the house holds too little ${short.map((c) => c.symbol).join(", ")}; any holder of the components can fill it`,
    };
  }

  // Mirror chains: the house mints what it is missing from the public faucet, then fills.
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
      calls.push({ to: c.token as Address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [d.desk as Address, maxUint256] }) });
    }
  });
  const fillCall = { to: d.desk as Address, data: encodeFunctionData({ abi: DESK_ABI, functionName: "fill", args: [BigInt(o.id)] }) };

  if (isTempo(d)) {
    // One Tempo transaction: every mint, every approval and the fill, atomically, fees in pathUSD.
    const tempo = createClient({
      account: TempoAccount.fromSecp256k1(houseKey()!),
      chain: tempoModerato.extend({ feeToken: TEMPO_PATH_USD }),
      transport: http(d.rpc, { timeout: 20_000 }),
    }).extend(publicActions);
    const receipt = await sendTransactionSync(tempo, { calls: [...calls, fillCall] } as never);
    if (receipt.status !== "success") return { ...base, status: "failed", reason: "the fill reverted", hash: receipt.transactionHash };
    if (counted) perBuyer.hit(buyerKey);
    return { ...base, status: "filled", hash: receipt.transactionHash };
  }

  const wallet = walletFor(d);
  const prep = await Promise.all(calls.map((c) => wallet.sendTransaction({ to: c.to, data: c.data })));
  await Promise.all(prep.map((hash) => client.waitForTransactionReceipt({ hash, timeout: 60_000 })));
  const hash = await wallet.sendTransaction({ to: fillCall.to, data: fillCall.data });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") return { ...base, status: "failed", reason: "the fill reverted", hash };
  if (counted) perBuyer.hit(buyerKey);
  return { ...base, status: "filled", hash };
}

/** Fill the open, fair, unexpired orders on one chain, newest first, at most `max` per run. */
export async function runEvmKeeper(d: Deployment, opts: { orderId?: number; max?: number } = {}): Promise<FillResult[]> {
  const max = opts.max ?? 3;
  const orders = await readDeskOrders(d, 15);
  const open = orders.filter((o) => o.status === "Open" && (opts.orderId == null || o.id === opts.orderId));
  if (open.length === 0) return [];
  // Mirror chains are checked against the same quotes; a mirror basket falls back to its deploy-time prices.
  const prices = await fetchRobinhoodPrices(d.tokens.map((t) => t.symbol));
  return withChainLock(d.network, async () => {
    const out: FillResult[] = [];
    for (const o of open.slice(0, max)) {
      try {
        out.push(await fillOne(d, o, prices));
      } catch (err) {
        out.push({ network: d.network, id: o.id, status: "failed", reason: ((err as Error).message ?? "error").split("\n")[0].slice(0, 200) });
      }
    }
    return out;
  });
}

// ------------------------------------------------------------ Tempo SIP keeper

export type SipAction = "instalment" | "overspend" | "outOfScope";
export type SipResult = {
  action: SipAction;
  ok: boolean;
  hash?: Hex;
  orderId?: number;
  fill?: FillResult;
  /** The chain's refusal, verbatim, when it refused. */
  refusal?: string;
};

/**
 * The keeper side of a Tempo SIP. The visitor's account (a passkey, usually)
 * signed one key authorization naming the house key as an access key, with a
 * recurring AlphaUSD limit and a call scope. Here the house signs as that access
 * key, for that account. The chain decides whether it may; the keeper only adds
 * the schedule (one instalment per period).
 */
export async function runTempoSip(account: Address, action: SipAction, opts: { auto?: boolean } = {}): Promise<SipResult> {
  const d = deploymentFor("tempoTestnet");
  const key = houseKey();
  if (!d || !key) throw new Error("Tempo keeper not configured.");
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

/** One SIP call per account at a time, so two requests cannot both pass the budget read. */
const sipInFlight = new Set<string>();

async function runTempoSipOnce(d: Deployment, key: Hex, account: Address, action: SipAction, auto: boolean): Promise<SipResult> {
  const keeper = TempoAccount.fromSecp256k1(key, { access: account });
  const client = createClient({
    account: keeper,
    chain: tempoModerato.extend({ feeToken: TEMPO_PATH_USD }),
    transport: http(d.rpc, { timeout: 20_000 }),
  }).extend(publicActions);
  const alpha = d.stable.address as Address;

  // The chain caps what the key may spend in a period, not how often. The keeper
  // adds the schedule: one instalment per period, read from the key's own budget
  // (untouched means no instalment yet this period). The overspend demo only runs
  // once an instalment has left too little for it, so it can only ever be refused.
  // A revoked, expired or missing key is passed through: the chain refuses it.
  if (action !== "outOfScope") {
    // Read without the access-key account: the budget read reverts for a key the account never authorized.
    const reader = createClient({ chain: tempoModerato, transport: http(d.rpc, { timeout: 15_000 }) }).extend(publicActions);
    const accessKey = keeper.accessKeyAddress;
    let budget: { remaining: bigint; periodEnd?: bigint } | null = null;
    try {
      const meta = await TempoActions.accessKey.getMetadata(reader, { account, accessKey });
      const live =
        !meta.isRevoked &&
        meta.address.toLowerCase() === accessKey.toLowerCase() &&
        (meta.expiry === 0n || meta.expiry * 1000n > BigInt(Date.now()));
      if (live) budget = await TempoActions.accessKey.getRemainingLimit(reader, { account, accessKey, token: alpha });
    } catch {
      throw new SipRefused("Could not read this plan's budget on Tempo. Try again in a moment.");
    }
    // No live key: let the chain say no, unless this is the schedule, which only acts for live keys.
    if (!budget && auto) throw new SipRefused("No live access key for this account.");
    if (budget) {
      const resets = budget.periodEnd ? ` It resets ${new Date(Number(budget.periodEnd) * 1000).toISOString().slice(0, 10)}.` : "";
      if (action === "instalment" && budget.remaining < TEMPO_SIP.limit) {
        throw new SipRefused(`This period's instalment has already been placed.${resets}`, budget.periodEnd ? Number(budget.periodEnd) * 1000 : undefined);
      }
      if (action === "overspend" && budget.remaining >= TEMPO_SIP.overspend) {
        throw new SipRefused("Place this period's instalment first; the overspend test needs the budget it leaves.");
      }
    }
  }
  const desk = d.desk as Address;
  const basket = d.baskets[0];
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const order = (amount: bigint) => [
    { to: alpha, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [desk, amount] }) },
    { to: desk, data: encodeFunctionData({ abi: DESK_ABI, functionName: "placeOrder", args: [basket.address as Address, ONE_SHARE, amount, expiry] }) },
  ];
  const calls =
    action === "outOfScope"
      ? [{ to: alpha, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [keeper.accessKeyAddress, 1n] }) }]
      : order(action === "overspend" ? TEMPO_SIP.overspend : TEMPO_SIP.instalment);

  let receipt;
  try {
    receipt = await sendTransactionSync(client, { calls } as never);
  } catch (err) {
    const e = err as { details?: string; shortMessage?: string; message?: string };
    const text = `${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`;
    const named = text.match(/(SpendingLimitExceeded|CallNotAllowed|KeyAlreadyRevoked|KeyExpired|KeyNotFound|[A-Z][A-Za-z]+(?:Exceeded|NotAllowed|Revoked|Expired))/);
    return { action, ok: false, refusal: named ? named[1] : (e.shortMessage ?? "refused").split("\n")[0].slice(0, 160) };
  }
  if (receipt.status !== "success") return { action, ok: false, hash: receipt.transactionHash, refusal: "reverted" };

  const placed = parseEventLogs({ abi: DESK_ABI, logs: receipt.logs, eventName: "OrderPlaced" });
  const orderId = placed[0] ? Number(placed[0].args.id) : undefined;
  let fill: FillResult | undefined;
  if (orderId != null) {
    // The house is also a participant: deliver the mirrors in kind and mint the shares to the investor.
    if (action === "instalment") sipOrders.add(`${d.network}:${orderId}`);
    fill = (await runEvmKeeper(d, { orderId, max: 1 }))[0];
  }
  return { action, ok: true, hash: receipt.transactionHash, orderId, fill };
}

// ------------------------------------------------------------ SIP schedule

/**
 * The schedule half of a Tempo SIP, run by the cron's sweep: every account that
 * authorized the house key gets its instalment once a period, without anyone
 * pressing a button. Accounts are found from the keychain's own KeyAuthorized
 * events naming the house key, so there is no list to keep; the budget read in
 * runTempoSip keeps it to one instalment per period.
 */
const KEY_AUTHORIZED = parseAbiItem("event KeyAuthorized(address indexed account, address indexed publicKey, uint8 signatureType, uint64 expiry)");
/** Tempo's RPC answers getLogs over at most this many blocks. */
const LOG_RANGE = 100_000n;
/** Leave a fresh authorization to the visitor's own Instalment button for this long. */
const SIP_GRACE_MS = 15 * 60_000;
/** Instalments the schedule places per sweep, so one sweep stays short. */
const SIP_PER_SWEEP = 2;
/** Budgets the schedule reads per sweep (two Tempo reads each); the rest wait for the next sweep. */
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
  // First pass: one period back, since an older key has had this period's instalment or expired.
  const lookback = BigInt(Math.ceil((TEMPO_SIP.period + 86_400) / secsPerBlock));
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
  placed: { account: string; ok: boolean; orderId?: number; fill?: string; refusal?: string }[];
  ms: number;
};

export async function runSipSchedule(): Promise<SipScheduleResult> {
  const started = Date.now();
  const d = deploymentFor("tempoTestnet");
  if (!d || !houseKey()) return { accounts: 0, checked: 0, placed: [], ms: 0 };
  sipScan ??= discoverSipAccounts(d).finally(() => (sipScan = null));
  await sipScan;
  const placed: SipScheduleResult["placed"] = [];
  const now = Date.now();
  let checked = 0;
  for (const entry of sipAccounts.values()) {
    if (placed.length >= SIP_PER_SWEEP || checked >= SIP_CHECKS_PER_SWEEP) break;
    if (now < entry.nextCheck || now - entry.authorizedAt < SIP_GRACE_MS) continue;
    checked++;
    try {
      const r = await runTempoSip(entry.account, "instalment", { auto: true });
      placed.push({ account: entry.account, ok: r.ok, orderId: r.orderId, fill: r.fill?.status, refusal: r.refusal });
      // Placed: next period. Refused by the chain (no AlphaUSD, say): try again in an hour.
      entry.nextCheck = now + (r.ok ? TEMPO_SIP.period * 1000 : 3_600_000);
    } catch (err) {
      entry.nextCheck = err instanceof SipRefused ? (err.retryAt ?? now + 6 * 3_600_000) : now + 600_000;
    }
  }
  return { accounts: sipAccounts.size, checked, placed, ms: Date.now() - started };
}

export { BASKET_ABI };
