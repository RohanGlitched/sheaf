import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import type { ChainBasket, Deployment } from "./chains";

/**
 * The EVM side of Sheaf, shared by the browser and the server routes.
 *
 * The ABIs are the human-readable subset of evm/contracts that the app calls,
 * errors included, so a revert surfaces as `ShortDeposit` or
 * `SpendingLimitExceeded` instead of a hex blob.
 */

export const ONE_SHARE = 10n ** 18n;

export const BASKET_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function vaultBalances() view returns (uint256[])",
  "function previewMint(uint256 shares) view returns (uint256[])",
  "function previewRedeem(uint256 shares) view returns (uint256[])",
  "function previewNetShares(uint256 shares) view returns (uint256 net, uint256 fee)",
  "function components() view returns ((address token, uint256 unitsPerShare, uint16 weightBps)[])",
  "function mintCount() view returns (uint64)",
  "function redeemCount() view returns (uint64)",
  "function creator() view returns (address)",
  "function mint(uint256 shares, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver) returns (uint256[])",
  "event SharesMinted(address indexed payer, address indexed receiver, uint256 sharesIssued, uint256 creatorFeeShares, uint256[] amountsIn)",
  "event SharesRedeemed(address indexed owner, address indexed receiver, uint256 sharesBurned, uint256[] amountsOut)",
  "error ZeroShares()",
  "error DustMint()",
  "error ShortDeposit(address token, uint256 expected, uint256 received)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

export const DESK_ABI = parseAbi([
  "function orderCount() view returns (uint256)",
  "function getOrder(uint256 id) view returns ((address buyer, address basket, uint96 expiry, uint256 shares, uint256 usdgAmount, uint8 status, address filler))",
  "function placeOrder(address basket, uint256 shares, uint256 usdgAmount, uint96 expiry) returns (uint256)",
  "function fill(uint256 id) returns (uint256)",
  "function cancel(uint256 id)",
  "event OrderPlaced(uint256 indexed id, address indexed buyer, address indexed basket, uint256 shares, uint256 usdgAmount, uint96 expiry)",
  "event OrderFilled(uint256 indexed id, address indexed filler, uint256 sharesDelivered)",
  "event OrderCancelled(uint256 indexed id)",
  "error UnknownBasket()",
  "error ZeroAmount()",
  "error BadExpiry()",
  "error NotOpen()",
  "error Expired()",
  "error NotBuyer()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/** MockStock and MockDollar: free, labeled testnet mirrors with a public faucet. */
export const MIRROR_ABI = parseAbi([
  "function faucet(uint256 amount)",
  "function mint(address to, uint256 amount)",
  "function MAX_MINT_PER_CALL() view returns (uint256)",
  "error MintCapExceeded(uint256 requested, uint256 cap)",
]);

/** ERC-8056 Scaled UI Amount, which Robinhood Stock Tokens implement. */
export const UI_MULTIPLIER_ABI = parseAbi(["function uiMultiplier() view returns (uint256)"]);

/** Tempo's fee token for plain EVM transactions that call a non-TIP-20 contract. */
export const TEMPO_PATH_USD = "0x20c0000000000000000000000000000000000000" as const;

/**
 * The v1 Tempo SIP: what one access-key authorization grants the keeper, scoped
 * to the v1 desk's placeOrder (so the key picks the price). The same numbers the
 * recorded demo in evm/scripts/tempo-sip.mjs used. v2 is TEMPO_SIP_V2 below.
 */
export const TEMPO_SIP = {
  period: 30 * 86_400,
  /** AlphaUSD per period, 6 decimals. */
  limit: 25_000_000n,
  /** pathUSD per period for the keeper's fees, 6 decimals. */
  feeLimit: 2_000_000n,
  /** One instalment: 1 share of the first basket at 10.10 AlphaUSD. */
  instalment: 10_100_000n,
  /** Deliberately past what is left after one instalment. */
  overspend: 20_000_000n,
} as const;

// ------------------------------------------------------------------- v2

/**
 * v2: CreationDeskV2 (a Dutch auction on share count, the 0.10% protocol fee) and
 * PlanDesk (plans whose amount, schedule and worst price are on chain). Deployed
 * beside v1 on every chain and serving the same factory's baskets; v1's desk and
 * DESK_ABI keep working unchanged. Addresses are under `v2` in each deployment
 * record: read them with v2Of(d).
 */
export const DESK_V2_ABI = parseAbi([
  "function PROTOCOL_FEE_BPS() view returns (uint16)",
  "function MAX_ORDER_SECS() view returns (uint64)",
  "function cash() view returns (address)",
  "function factory() view returns (address)",
  "function treasury() view returns (address)",
  "function orderCount() view returns (uint256)",
  "function getOrder(uint256 id) view returns ((address buyer, uint64 startTs, uint8 status, address basket, uint64 endTs, uint128 cashAmount, uint128 sharesOut, uint128 startShares, uint128 endShares, address filler))",
  "function sharesAt(uint256 id, uint256 ts) view returns (uint256)",
  "function grossFor(address basket, uint256 sharesOut) view returns (uint256)",
  "function quoteFill(uint256 id) view returns (uint256 sharesOut, uint256 grossShares, uint256[] amounts)",
  "function auctionBounds(uint256 fairShares, uint16 bandBps, uint256 minShares) pure returns (uint256 startShares, uint256 endShares)",
  "function placeOrder(address basket, uint256 cashAmount, uint256 startShares, uint256 endShares, uint64 startTs, uint64 endTs) returns (uint256)",
  "function placeOrderFor(address buyer, address basket, uint256 cashAmount, uint256 startShares, uint256 endShares, uint64 startTs, uint64 endTs) returns (uint256)",
  "function placeAuction(address basket, uint256 cashAmount, uint256 fairShares, uint16 bandBps, uint64 auctionSecs, uint256 minShares) returns (uint256)",
  "function fill(uint256 id) returns (uint256)",
  "function cancel(uint256 id)",
  "event OrderPlaced(uint256 indexed id, address indexed buyer, address indexed basket, address payer, uint256 cashAmount, uint256 startShares, uint256 endShares, uint64 startTs, uint64 endTs)",
  "event OrderFilled(uint256 indexed id, address indexed filler, uint256 sharesToBuyer, uint256 grossShares, uint256 creatorFeeShares, uint256 protocolFeeShares, uint256 cashPaid)",
  "event OrderCancelled(uint256 indexed id, uint256 refund)",
  "event ProtocolFeePaid(address indexed basket, address indexed treasury, uint256 shares)",
  "error UnknownBasket()",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error BadAuctionShares()",
  "error BadAuctionWindow()",
  "error BandTooWide()",
  "error FairBelowFloor()",
  "error ShortCash(uint256 expected, uint256 received)",
  "error NotOpen()",
  "error Expired()",
  "error NotBuyer()",
  "error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

export const PLAN_DESK_ABI = parseAbi([
  "function desk() view returns (address)",
  "function cash() view returns (address)",
  "function planCount() view returns (uint256)",
  "function getPlan(uint256 id) view returns ((address owner, uint64 interval, uint32 runs, bool active, address basket, uint64 lastRunAt, address keeper, uint64 auctionSecs, uint16 bandBps, uint128 cashPerRun, uint128 minShares, uint128 maxShares))",
  "function plansOf(address owner) view returns (uint256[])",
  "function nextRunAt(uint256 id) view returns (uint256)",
  "function auctionFor(uint256 id, uint256 fairShares) view returns (uint256 startShares, uint256 endShares)",
  "function openPlan(address basket, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint256 minShares, uint256 maxShares, address keeper) returns (uint256)",
  "function closePlan(uint256 id)",
  "function instalment(uint256 id, uint256 fairShares) returns (uint256)",
  "event PlanOpened(uint256 indexed id, address indexed owner, address indexed basket, address keeper, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint256 minShares, uint256 maxShares)",
  "event PlanClosed(uint256 indexed id)",
  "event Instalment(uint256 indexed id, uint256 indexed orderId, address indexed caller, uint256 fairShares, uint256 startShares, uint256 endShares, uint32 run)",
  "error UnknownBasket()",
  "error ZeroAmount()",
  "error BadSchedule()",
  "error BandTooWide()",
  "error BadBounds()",
  "error NotOwner()",
  "error NotAllowed()",
  "error PlanClosedAlready()",
  "error TooSoon(uint256 nextRunAt)",
  "error FairOutOfBounds(uint256 fairShares, uint256 minShares, uint256 maxShares)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

/** The v2 desk's protocol fee, in basis points of the gross shares a fill creates. Immutable. */
export const PROTOCOL_FEE_BPS = 10n;
const BPS = 10_000n;

/** The v2 contracts on one chain, as evm/scripts/deploy-v2.js records them. */
export type DeploymentV2 = {
  desk: string;
  planDesk: string;
  treasury: string;
  protocolFeeBps: number;
  cash: string;
  factory: string;
  startBlock?: number;
  deployedAt?: string;
  verified?: { via: string; at: string; contracts: Record<string, boolean> };
  smoke?: { passedAt: string; basket: string; auctionOrderId: number; planId: number; planOrderId: number; txs: Record<string, string> };
  /** Tempo only: the recorded access-key run against PlanDesk (evm/scripts/tempo-sip-v2.mjs). */
  sip?: {
    at: string;
    keeperKey: string;
    planId: number;
    openPlanTx: string;
    authorizeTx: string;
    instalmentTx: string;
    fillTx: string;
    orderId: number;
    cashPerRun: string;
    minSharesPerRun: string;
    maxSharesPerRun: string;
    sharesToInvestor: string;
    limitPerPeriod: string;
    periodSeconds: number;
    scopes: string[];
    refused: Record<string, string>;
  };
};

/** The chain's v2 contracts, or null where v2 is not deployed. */
export function v2Of(d: Deployment): DeploymentV2 | null {
  return (d as Deployment & { v2?: DeploymentV2 }).v2 ?? null;
}

export type DeskOrderV2 = {
  id: number;
  buyer: Address;
  basket: Address;
  cashAmount: bigint;
  startShares: bigint;
  endShares: bigint;
  startTs: number;
  endTs: number;
  status: OrderStatus;
  /** Shares the buyer received; 0 until filled. */
  sharesOut: bigint;
  filler: Address;
};

/** SheafAuction.sharesAt: the shares the buyer must receive at `ts` (unix seconds). */
export function auctionSharesAt(o: Pick<DeskOrderV2, "startShares" | "endShares" | "startTs" | "endTs">, ts: number): bigint {
  if (ts <= o.startTs) return o.startShares;
  if (ts >= o.endTs) return o.endShares;
  return o.startShares - ((o.startShares - o.endShares) * BigInt(ts - o.startTs)) / BigInt(o.endTs - o.startTs);
}

/** SheafAuction.bounds: fair × (1 ± band), both floored, the end never below `minShares`. */
export function auctionBounds(fairShares: bigint, bandBps: number, minShares = 0n): { startShares: bigint; endShares: bigint } {
  let startShares = (fairShares * (BPS + BigInt(bandBps))) / BPS;
  let endShares = (fairShares * (BPS - BigInt(bandBps))) / BPS;
  if (endShares < minShares) endShares = minShares;
  if (startShares < endShares) startShares = endShares;
  return { startShares, endShares };
}

/**
 * How a v2 fill of `sharesOut` splits, exactly as CreationDeskV2.fill does it: the
 * gross shares created, the basket's creator cut, the protocol's 0.10%, and what
 * the buyer receives (never less than `sharesOut`, at most 2 raw units more).
 */
export function v2FillSplit(sharesOut: bigint, creatorFeeBps: number) {
  const fee = BigInt(creatorFeeBps) + PROTOCOL_FEE_BPS;
  const gross = mulDivCeil(sharesOut, BPS, BPS - fee);
  const creatorFee = (gross * BigInt(creatorFeeBps)) / BPS;
  const protocolFee = (gross * PROTOCOL_FEE_BPS) / BPS;
  return { gross, creatorFee, protocolFee, toBuyer: gross - creatorFee - protocolFee };
}

/** Whole-share count (18 decimals) that `cash` raw units buy at `navUsd` a share. */
export function fairSharesFor(cash: bigint, cashDecimals: number, navUsd: number): bigint {
  // Price in micro-dollars, so the division stays in integers.
  const micro = BigInt(Math.round(navUsd * 1e6));
  if (micro <= 0n) return 0n;
  return (cash * ONE_SHARE * 1_000_000n) / (micro * 10n ** BigInt(cashDecimals));
}

/**
 * The v2 Tempo SIP. The visitor's root key opens a PlanDesk plan (the amount, the
 * schedule and the price cap), then authorizes the keeper's access key for two
 * calls only: approve with PlanDesk as spender, and PlanDesk.instalment. The key
 * signs as the owner, so openPlan and closePlan must stay out of its scope; it can
 * run the plan, never rewrite it, and a run below `minShares` reverts on chain.
 */
export const TEMPO_SIP_V2 = {
  period: 30 * 86_400,
  /** AlphaUSD per period on the access key, 6 decimals: room for two runs. */
  limit: 25_000_000n,
  feeLimit: 2_000_000n,
  /** One run's cash, 6 decimals. */
  cashPerRun: 10_100_000n,
  /** The plan's own schedule: one run per 30 days, enforced by PlanDesk (TooSoon). */
  interval: 30n * 86_400n,
  /** Four minutes, as the Solana demo plan: the house reaches its price (fair plus 0.15%) about 2.5 minutes in. */
  auctionSecs: 240n,
  bandBps: 200,
  /** The visitor's cap, as a fraction of the fair count at authorization: no run below 97% of it. */
  capBps: 9_700,
  /** And no fair above 105% of it, so a keeper cannot post a run no filler would take. */
  ceilingBps: 10_500,
} as const;

/** The plan terms a visitor signs for `navUsd` a share now (see TEMPO_SIP_V2). */
export function tempoSipV2Terms(navUsd: number, cashDecimals = 6) {
  const fair = fairSharesFor(TEMPO_SIP_V2.cashPerRun, cashDecimals, navUsd);
  return {
    cashPerRun: TEMPO_SIP_V2.cashPerRun,
    interval: TEMPO_SIP_V2.interval,
    auctionSecs: TEMPO_SIP_V2.auctionSecs,
    bandBps: TEMPO_SIP_V2.bandBps,
    fairShares: fair,
    minShares: (fair * BigInt(TEMPO_SIP_V2.capBps)) / BPS,
    maxShares: (fair * BigInt(TEMPO_SIP_V2.ceilingBps)) / BPS,
  };
}

/** The access-key scopes for a v2 Tempo SIP: approve(PlanDesk) and PlanDesk.instalment, nothing else. */
export function tempoSipV2Scopes(d: Deployment) {
  const v2 = v2Of(d);
  if (!v2) throw new Error(`no v2 deployment on ${d.network}`);
  return [
    { address: d.stable.address as Address, selector: "approve(address,uint256)", recipients: [v2.planDesk as Address] },
    { address: v2.planDesk as Address, selector: "instalment(uint256,uint256)" },
  ];
}

function toOrderV2(id: number, o: {
  buyer: Address;
  startTs: bigint;
  status: number;
  basket: Address;
  endTs: bigint;
  cashAmount: bigint;
  sharesOut: bigint;
  startShares: bigint;
  endShares: bigint;
  filler: Address;
}): DeskOrderV2 {
  return {
    id,
    buyer: o.buyer,
    basket: o.basket,
    cashAmount: o.cashAmount,
    startShares: o.startShares,
    endShares: o.endShares,
    startTs: Number(o.startTs),
    endTs: Number(o.endTs),
    status: ORDER_STATUS[o.status] ?? "None",
    sharesOut: o.sharesOut,
    filler: o.filler,
  };
}

/**
 * Which desk an order is on. 1: the v1 fixed-price CreationDesk. 2: the first
 * CreationDeskV2 (auction, protocol fee to the deployer). 3: the CreationDeskV2
 * deployed with PlanDeskV3, whose protocol fee goes to a separate cold treasury.
 * Desks 2 and 3 run the same contract code.
 */
export type DeskVersion = 1 | 2 | 3;

/** The desk contract for a version on this chain, or null where it is not deployed. */
export function deskAddress(d: Deployment, version: DeskVersion): Address | null {
  if (version === 1) return d.desk as Address;
  const rec = version === 3 ? v3Of(d) : v2Of(d);
  return rec ? (rec.desk as Address) : null;
}

/** The newest auction desk on this chain: 3 where deployed, else 2, else null. */
export function auctionDeskVersion(d: Deployment): 2 | 3 | null {
  return v3Of(d) ? 3 : v2Of(d) ? 2 : null;
}

/** The last `limit` orders on an auction desk (v2 by default), newest first; [] where it is not deployed. */
export async function readDeskOrdersV2(d: Deployment, limit = 12, version: 2 | 3 = 2): Promise<DeskOrderV2[]> {
  const desk = deskAddress(d, version);
  if (!desk) return [];
  const client = publicClientFor(d);
  const count = Number(await client.readContract({ address: desk, abi: DESK_V2_ABI, functionName: "orderCount" }));
  const ids = Array.from({ length: Math.min(limit, count) }, (_, i) => count - 1 - i);
  const rows = await Promise.all(
    ids.map((id) => client.readContract({ address: desk, abi: DESK_V2_ABI, functionName: "getOrder", args: [BigInt(id)] })),
  );
  return rows.map((o, i) => toOrderV2(ids[i], o));
}

export async function readDeskOrderV2(d: Deployment, id: number, version: 2 | 3 = 2): Promise<DeskOrderV2> {
  const desk = deskAddress(d, version);
  if (!desk) throw new Error(`no v${version} desk on ${d.network}`);
  const o = await publicClientFor(d).readContract({ address: desk, abi: DESK_V2_ABI, functionName: "getOrder", args: [BigInt(id)] });
  return toOrderV2(id, o);
}

export type PlanV2 = {
  id: number;
  owner: Address;
  basket: Address;
  keeper: Address;
  cashPerRun: bigint;
  interval: number;
  auctionSecs: number;
  bandBps: number;
  minShares: bigint;
  maxShares: bigint;
  runs: number;
  lastRunAt: number;
  active: boolean;
  /** Unix seconds; 0 means it may run now. */
  nextRunAt: number;
};

/** Every PlanDesk plan `owner` has opened, oldest first; [] where v2 is not deployed. */
export async function readPlansOf(d: Deployment, owner: Address): Promise<PlanV2[]> {
  const v2 = v2Of(d);
  if (!v2) return [];
  const client = publicClientFor(d);
  const plans = v2.planDesk as Address;
  const ids = await client.readContract({ address: plans, abi: PLAN_DESK_ABI, functionName: "plansOf", args: [owner] });
  const rows = await Promise.all(ids.map((id) => client.readContract({ address: plans, abi: PLAN_DESK_ABI, functionName: "getPlan", args: [id] })));
  return rows.map((p, i) => ({
    id: Number(ids[i]),
    owner: p.owner,
    basket: p.basket,
    keeper: p.keeper,
    cashPerRun: p.cashPerRun,
    interval: Number(p.interval),
    auctionSecs: Number(p.auctionSecs),
    bandBps: p.bandBps,
    minShares: p.minShares,
    maxShares: p.maxShares,
    runs: p.runs,
    lastRunAt: Number(p.lastRunAt),
    active: p.active,
    nextRunAt: p.runs === 0 ? 0 : Number(p.lastRunAt) + Number(p.interval),
  }));
}

// ------------------------------------------------------------------- v3

/**
 * v3: PlanDeskV3, plans with trailing bounds under the owner's hard floor and
 * ceiling, on a fresh CreationDeskV2 whose immutable treasury is a separate cold
 * key (not the deployer, not the keeper). Recorded under `v3`: read with v3Of(d).
 */
export const PLAN_DESK_V3_ABI = parseAbi([
  "function desk() view returns (address)",
  "function cash() view returns (address)",
  "function MAX_STEP_BPS() view returns (uint16)",
  "function planCount() view returns (uint256)",
  "function getPlan(uint256 id) view returns ((address owner, uint64 interval, uint32 runs, address basket, uint64 lastRunAt, uint16 bandBps, uint16 stepBps, address keeper, uint64 auctionSecs, bool active, uint128 cashPerRun, uint128 refShares, uint128 hardMin, uint128 hardMax, uint64 lastOrderPlusOne))",
  "function plansOf(address owner) view returns (uint256[])",
  "function nextRunAt(uint256 id) view returns (uint256)",
  "function windowOf(uint256 id) view returns (uint256 refShares, uint256 low, uint256 high)",
  "function auctionFor(uint256 id, uint256 fairShares) view returns (uint256 startShares, uint256 endShares)",
  "function openPlan(address basket, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint16 stepBps, uint256 refShares, uint256 hardMin, uint256 hardMax, address keeper) returns (uint256)",
  "function recenter(uint256 id, uint256 refShares, uint256 hardMin, uint256 hardMax)",
  "function closePlan(uint256 id)",
  "function instalment(uint256 id, uint256 fairShares) returns (uint256)",
  "event PlanOpened(uint256 indexed id, address indexed owner, address indexed basket, address keeper, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint16 stepBps, uint256 refShares, uint256 hardMin, uint256 hardMax)",
  "event PlanClosed(uint256 indexed id)",
  "event Recentered(uint256 indexed id, uint256 refShares, uint256 hardMin, uint256 hardMax, bool byOwner)",
  "event Instalment(uint256 indexed id, uint256 indexed orderId, address indexed caller, uint256 fairShares, uint256 startShares, uint256 endShares, uint32 run)",
  "error UnknownBasket()",
  "error ZeroAmount()",
  "error BadSchedule()",
  "error BandTooWide()",
  "error StepTooWide()",
  "error BadBounds()",
  "error NotOwner()",
  "error NotAllowed()",
  "error PlanClosedAlready()",
  "error TooSoon(uint256 nextRunAt)",
  "error FairOutOfBounds(uint256 fairShares, uint256 low, uint256 high)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error SafeERC20FailedOperation(address token)",
]);

/** The v3 contracts on one chain, as evm/scripts/deploy-v3.js records them. Same shape as v2. */
export type DeploymentV3 = Omit<DeploymentV2, "sip" | "smoke"> & {
  smoke?: { passedAt: string; basket: string; treasury: string; auctionOrderId: number; planId: number; planOrderIds: number[]; txs: Record<string, string> };
  /** Tempo only: the recorded access-key run against PlanDeskV3 (evm/scripts/tempo-sip-v3.mjs). */
  sip?: {
    at: string;
    keeperKey: string;
    planId: number;
    openPlanTx: string;
    authorizeTx: string;
    instalmentTxs: string[];
    fillTxs: string[];
    orderIds: number[];
    cashPerRun: string;
    hardMinShares: string;
    hardMaxShares: string;
    stepPct: number;
    intervalSeconds: number;
    run2Fair: string;
    recenteredOn: string;
    sharesToInvestor: string[];
    limitPerPeriod: string;
    periodSeconds: number;
    scopes: string[];
    refused: Record<string, string>;
  };
};

/** The chain's v3 contracts, or null where v3 is not deployed. */
export function v3Of(d: Deployment): DeploymentV3 | null {
  return (d as Deployment & { v3?: DeploymentV3 }).v3 ?? null;
}

export type PlanV3 = {
  id: number;
  owner: Address;
  basket: Address;
  keeper: Address;
  cashPerRun: bigint;
  interval: number;
  auctionSecs: number;
  bandBps: number;
  stepBps: number;
  hardMin: bigint;
  hardMax: bigint;
  /** The window the next run's fair count must sit in, the reference already moved to the last fill. */
  refShares: bigint;
  low: bigint;
  high: bigint;
  runs: number;
  lastRunAt: number;
  active: boolean;
  /** Unix seconds; 0 means it may run now. */
  nextRunAt: number;
};

/** Every PlanDeskV3 plan `owner` has opened, oldest first, with each one's live window; [] where v3 is not deployed. */
export async function readPlansOfV3(d: Deployment, owner: Address): Promise<PlanV3[]> {
  const v3 = v3Of(d);
  if (!v3) return [];
  const client = publicClientFor(d);
  const plans = v3.planDesk as Address;
  const ids = await client.readContract({ address: plans, abi: PLAN_DESK_V3_ABI, functionName: "plansOf", args: [owner] });
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [p, w] = await Promise.all([
        client.readContract({ address: plans, abi: PLAN_DESK_V3_ABI, functionName: "getPlan", args: [id] }),
        client.readContract({ address: plans, abi: PLAN_DESK_V3_ABI, functionName: "windowOf", args: [id] }),
      ]);
      return { p, w };
    }),
  );
  return rows.map(({ p, w }, i) => ({
    id: Number(ids[i]),
    owner: p.owner,
    basket: p.basket,
    keeper: p.keeper,
    cashPerRun: p.cashPerRun,
    interval: Number(p.interval),
    auctionSecs: Number(p.auctionSecs),
    bandBps: p.bandBps,
    stepBps: p.stepBps,
    hardMin: p.hardMin,
    hardMax: p.hardMax,
    refShares: w[0],
    low: w[1],
    high: w[2],
    runs: p.runs,
    lastRunAt: Number(p.lastRunAt),
    active: p.active,
    nextRunAt: p.runs === 0 ? 0 : Number(p.lastRunAt) + Number(p.interval),
  }));
}

/**
 * The v3 Tempo SIP. Same shape as v2 (the root key opens the plan, then scopes the
 * keeper's access key to approve(PlanDeskV3) and PlanDeskV3.instalment), with
 * trailing bounds: each run's fair count must sit within 10% of what the last run
 * filled at, and never outside the owner's hard bounds of 70% to 150% of the fair
 * count at signing. So a monthly plan follows normal moves, and the owner's worst
 * price is fixed at signing: no run buys fewer than 70% of today's count.
 */
export const TEMPO_SIP_V3 = {
  ...TEMPO_SIP_V2,
  stepBps: 1_000,
  hardMinBps: 7_000,
  hardMaxBps: 15_000,
} as const;

/** The plan terms a visitor signs for `navUsd` a share now (see TEMPO_SIP_V3). */
export function tempoSipV3Terms(navUsd: number, cashDecimals = 6) {
  const fair = fairSharesFor(TEMPO_SIP_V3.cashPerRun, cashDecimals, navUsd);
  return {
    cashPerRun: TEMPO_SIP_V3.cashPerRun,
    interval: TEMPO_SIP_V3.interval,
    auctionSecs: TEMPO_SIP_V3.auctionSecs,
    bandBps: TEMPO_SIP_V3.bandBps,
    stepBps: TEMPO_SIP_V3.stepBps,
    refShares: fair,
    hardMin: (fair * BigInt(TEMPO_SIP_V3.hardMinBps)) / BPS,
    hardMax: (fair * BigInt(TEMPO_SIP_V3.hardMaxBps)) / BPS,
  };
}

/** The access-key scopes for a v3 Tempo SIP: approve(PlanDeskV3) and PlanDeskV3.instalment, nothing else. */
export function tempoSipV3Scopes(d: Deployment) {
  const v3 = v3Of(d);
  if (!v3) throw new Error(`no v3 deployment on ${d.network}`);
  return [
    { address: d.stable.address as Address, selector: "approve(address,uint256)", recipients: [v3.planDesk as Address] },
    { address: v3.planDesk as Address, selector: "instalment(uint256,uint256)" },
  ];
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const ORDER_STATUS = ["None", "Open", "Filled", "Cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export type DeskOrder = {
  id: number;
  buyer: Address;
  basket: Address;
  expiry: number;
  shares: bigint;
  usdgAmount: bigint;
  status: OrderStatus;
  filler: Address;
};

/** Native gas symbol per chain. Tempo has none: fees are paid in a TIP-20 dollar. */
export function gasSymbol(d: Pick<Deployment, "network">): string {
  return d.network === "tempoTestnet" ? "pathUSD" : "ETH";
}

export function isTempo(d: Pick<Deployment, "network">): boolean {
  return d.network === "tempoTestnet";
}

/**
 * A plain chain definition for every deployment. Deliberately not viem's Tempo
 * chain: its formatters add Tempo transaction fields that an injected wallet
 * does not understand. A plain type-2 transaction works on Tempo, and the fee
 * cascades to pathUSD (or to the TIP-20 being called).
 */
export function evmChain(d: Deployment): Chain {
  return defineChain({
    id: d.chainId,
    name: d.label,
    // Tempo has no native token. Wallets insist on one, so it gets a dollar-named placeholder.
    nativeCurrency: isTempo(d) ? { name: "USD", symbol: "USD", decimals: 18 } : { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [d.rpc] } },
    blockExplorers: { default: { name: "Explorer", url: d.explorer } },
    // Multicall3 is at its canonical address on every chain Sheaf is deployed to.
    contracts: { multicall3: { address: MULTICALL3 } },
    testnet: true,
  });
}

const clients = new Map<string, PublicClient>();

export function publicClientFor(d: Deployment): PublicClient {
  let c = clients.get(d.network);
  if (!c) {
    // Reads made in the same tick go out as one Multicall3 eth_call. Public testnet RPCs
    // rate-limit per IP and some cap JSON-RPC batch size, so this is the polite shape.
    c = createPublicClient({
      chain: evmChain(d),
      batch: { multicall: { wait: 16 } },
      transport: http(d.rpc, { timeout: 15_000, retryCount: 2 }),
    }) as PublicClient;
    clients.set(d.network, c);
  }
  return c;
}

export const mulDivCeil = (a: bigint, b: bigint, c: bigint) => (a * b + c - 1n) / c;

/** Raw units of every component that `shares` pulls on a mint (rounds up, as the contract does). */
export function mintAmounts(basket: ChainBasket, shares: bigint): bigint[] {
  return basket.components.map((c) => mulDivCeil(BigInt(c.unitsPerShare), shares, ONE_SHARE));
}

/** Raw units of every component that `shares` pays out on a redemption (rounds down). */
export function redeemAmounts(basket: ChainBasket, shares: bigint): bigint[] {
  return basket.components.map((c) => (BigInt(c.unitsPerShare) * shares) / ONE_SHARE);
}

export function tokenFor(d: Deployment, address: string) {
  return d.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/** Value of one share at the given per-symbol prices, or null if any component is unpriced. */
export function navFrom(basket: ChainBasket, prices: Record<string, number | null | undefined>): number | null {
  let total = 0;
  for (const c of basket.components) {
    const p = prices[c.symbol];
    if (p == null || !Number.isFinite(p)) return null;
    total += (Number(BigInt(c.unitsPerShare)) / 1e18) * p;
  }
  return total;
}

export function toShares(amount: string): bigint | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Six decimal places of a share is plenty; go through a string to dodge float drift.
  const [whole, frac = ""] = n.toFixed(6).split(".");
  return BigInt(whole) * ONE_SHARE + BigInt(frac.padEnd(18, "0").slice(0, 18));
}

export const fromRaw = (raw: bigint, decimals = 18) => Number(raw) / 10 ** decimals;

/** A wallet or contract error, in one line a person can act on. */
export function explainEvmError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      switch (name) {
        case "ShortDeposit":
          return "A component arrived short. The vault refuses tokens that skim on transfer.";
        case "ERC20InsufficientBalance":
          return "Not enough of a token in this wallet for that amount.";
        case "ERC20InsufficientAllowance":
          return "An approval is missing or too small. Run the steps again.";
        case "NotOpen":
          return "That order is no longer open.";
        case "Expired":
          return "That order has expired. Cancel it to get the dollars back.";
        case "NotBuyer":
          return "Only the buyer can cancel an order before it expires.";
        case "BadExpiry":
          return "The order expiry is in the past. Check the device clock.";
        case "UnknownBasket":
          return "The desk does not know this basket.";
        case "MintCapExceeded":
          return "The faucet caps each call. Ask for less.";
        case "FairOutOfBounds":
          return "Refused by the plan: that price is outside the bounds the owner set.";
        case "TooSoon":
          return "Refused by the plan: this period's installment has already run.";
        case "NotAllowed":
          return "Only the plan's owner, or the keeper it names, can run this plan.";
        case "NotOwner":
          return "Only the plan's owner can close it.";
        case "PlanClosedAlready":
          return "That plan is closed.";
        case "BadBounds":
          return "The plan's price bounds are inverted or zero.";
        case "StepTooWide":
          return "The plan's trailing step is capped at 50%.";
        case "BadSchedule":
          return "The plan needs a non-zero interval and an auction of at most 30 days.";
        case "BadAuctionShares":
          return "The auction must start at or above where it ends, and end above zero.";
        case "BadAuctionWindow":
          return "The auction window is empty, already over, or more than 30 days out.";
        case "BandTooWide":
          return "The auction band is capped at 50%.";
        case "FairBelowFloor":
          return "The fair share count is below your own floor.";
        case "ShortCash":
          return "The cash token arrived short. The desk refuses tokens that skim on transfer.";
        case "ZeroShares":
        case "DustMint":
          return "That amount is too small to create a share.";
        default:
          if (name) return `The contract refused it: ${name}.`;
      }
    }
    const msg = err.shortMessage || err.message;
    if (/user rejected|denied|rejected the request/i.test(msg)) return "You declined it in the wallet.";
    if (/insufficient funds/i.test(msg)) return "Not enough gas in this wallet. Use the gas drip above.";
    if (/SpendingLimitExceeded/i.test(err.message)) return "Refused by the chain: SpendingLimitExceeded.";
    if (/CallNotAllowed/i.test(err.message)) return "Refused by the chain: CallNotAllowed (outside the access key's scope).";
    return msg.split("\n")[0];
  }
  const anyErr = err as { code?: number; message?: string };
  if (anyErr?.code === 4001) return "You declined it in the wallet.";
  return anyErr?.message?.split("\n")[0] ?? "Something went wrong.";
}

/** Read the last `limit` desk orders, newest first. Plain reads; no log range limits to trip over. */
export async function readDeskOrders(d: Deployment, limit = 12): Promise<DeskOrder[]> {
  const client = publicClientFor(d);
  const desk = d.desk as Address;
  const count = Number(await client.readContract({ address: desk, abi: DESK_ABI, functionName: "orderCount" }));
  const ids = Array.from({ length: Math.min(limit, count) }, (_, i) => count - 1 - i);
  const rows = await Promise.all(
    ids.map((id) => client.readContract({ address: desk, abi: DESK_ABI, functionName: "getOrder", args: [BigInt(id)] })),
  );
  return rows.map((o, i) => ({
    id: ids[i],
    buyer: o.buyer,
    basket: o.basket,
    expiry: Number(o.expiry),
    shares: o.shares,
    usdgAmount: o.usdgAmount,
    status: ORDER_STATUS[o.status] ?? "None",
    filler: o.filler,
  }));
}

export async function readDeskOrder(d: Deployment, id: number): Promise<DeskOrder> {
  const client = publicClientFor(d);
  const o = await client.readContract({ address: d.desk as Address, abi: DESK_ABI, functionName: "getOrder", args: [BigInt(id)] });
  return {
    id,
    buyer: o.buyer,
    basket: o.basket,
    expiry: Number(o.expiry),
    shares: o.shares,
    usdgAmount: o.usdgAmount,
    status: ORDER_STATUS[o.status] ?? "None",
    filler: o.filler,
  };
}

/** Live Robinhood Stock Token quotes (underlying mid), the same source the recipes were sized from. */
export async function fetchRobinhoodPrices(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    [...new Set(symbols)].map(async (sym) => {
      try {
        const r = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(sym)}`, {
          next: { revalidate: 60 },
          signal: AbortSignal.timeout(6_000),
        } as RequestInit);
        if (!r.ok) return;
        const q = ((await r.json()) as { quotes?: { bid: string; ask: string }[] }).quotes?.[0];
        const mid = q ? (Number(q.bid) + Number(q.ask)) / 2 : NaN;
        if (mid > 0) out[sym] = mid;
      } catch {
        // Missing stays missing; the page says so.
      }
    }),
  );
  return out;
}
