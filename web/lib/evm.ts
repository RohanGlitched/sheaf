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
 * The Tempo SIP: what one access-key authorization grants the keeper. The same
 * numbers the recorded demo in evm/scripts/tempo-sip.mjs used.
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
