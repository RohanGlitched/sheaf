import "server-only";
import { getAddress, isAddress, parseAbiItem, verifyMessage, type Address, type Hex } from "viem";
import { DEPLOYED, explorerAddressUrl, explorerTxUrl, type Deployment } from "./chains";
import { BASKET_ABI, DESK_ABI, DESK_V2_ABI, PLAN_DESK_ABI, PLAN_DESK_V3_ABI, publicClientFor, v2Of, v3Of } from "./evm";
import type { Proof } from "./voices-message";

/**
 * /voices for EVM wallets: an EIP-191 personal_sign over the same message, and
 * proof that the address really used Sheaf on one of its testnets.
 *
 * What counts, on every deployed chain (Robinhood Chain, Tempo, Sepolia,
 * Arbitrum Sepolia, Base Sepolia):
 *   - a plan opened on the v2 or v3 plan desk (plansOf(owner));
 *   - a dollar order placed on the v1, v2 or v3 desk (getOrder(id).buyer);
 *   - an in-kind creation (a basket's SharesMinted with this address as payer),
 *     or, where the chain's RPC refuses that log range, shares of a basket held.
 * All plain contract reads against each chain's public RPC; no indexer.
 */

const MINTED = parseAbiItem(
  "event SharesMinted(address indexed payer, address indexed receiver, uint256 sharesIssued, uint256 creatorFeeShares, uint256[] amountsIn)",
);
const MAX_ORDERS_PER_DESK = 1_000;
const ORDERS_TTL_MS = 60_000;

/** A checksummed EVM address, or null. */
export function evmAddress(raw: unknown): Address | null {
  return typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw) && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
}

export async function verifyEvmSigned(message: string, signature: unknown, address: Address): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    return await verifyMessage({ address, message, signature: signature as Hex });
  } catch {
    return false;
  }
}

const deployments = () => DEPLOYED.map((c) => c.deployment!).filter(Boolean) as Deployment[];
const symbolOf = (d: Deployment, basket: string) => d.baskets.find((b) => b.address.toLowerCase() === basket.toLowerCase())?.symbol ?? "a basket";

/** Buyers by order id, per desk, kept per instance and topped up with new orders only. */
const orderBuyers = new Map<string, { at: number; buyers: { buyer: string; basket: string }[] }>();

async function buyersOn(d: Deployment, desk: Address, v1: boolean) {
  const key = `${d.network}:${desk}`;
  const known = orderBuyers.get(key);
  if (known && Date.now() - known.at < ORDERS_TTL_MS) return known.buyers;
  const client = publicClientFor(d);
  const abi = v1 ? DESK_ABI : DESK_V2_ABI;
  const count = Math.min(MAX_ORDERS_PER_DESK, Number(await client.readContract({ address: desk, abi, functionName: "orderCount" })));
  const buyers = known?.buyers.slice(0, count) ?? [];
  const ids = Array.from({ length: count - buyers.length }, (_, i) => buyers.length + i);
  const rows = await Promise.all(
    ids.map((id) =>
      (v1
        ? client.readContract({ address: desk, abi: DESK_ABI, functionName: "getOrder", args: [BigInt(id)] })
        : client.readContract({ address: desk, abi: DESK_V2_ABI, functionName: "getOrder", args: [BigInt(id)] })
      ).then((o) => ({ buyer: o.buyer.toLowerCase(), basket: o.basket })),
    ),
  );
  const all = [...buyers, ...rows];
  orderBuyers.set(key, { at: Date.now(), buyers: all });
  return all;
}

async function proofOn(d: Deployment, owner: Address): Promise<Proof | null> {
  const client = publicClientFor(d);
  const walletUrl = explorerAddressUrl(d, owner);
  const base = { kind: "evm" as const, network: d.network, walletUrl, time: null };
  const v2 = v2Of(d);
  const v3 = v3Of(d);

  // Plans: one call per plan desk.
  for (const [desk, abi] of [
    [v3?.planDesk, PLAN_DESK_V3_ABI],
    [v2?.planDesk, PLAN_DESK_ABI],
  ] as const) {
    if (!desk) continue;
    const ids = await client.readContract({ address: desk as Address, abi, functionName: "plansOf", args: [owner] }).catch(() => [] as readonly bigint[]);
    if (ids.length > 0) return { ...base, signature: "", url: walletUrl, text: `opened a plan on ${d.label}` };
  }

  // Dollar orders on each desk version.
  const lower = owner.toLowerCase();
  for (const [desk, v1] of [
    [v3?.desk, false],
    [v2?.desk, false],
    [d.desk, true],
  ] as const) {
    if (!desk) continue;
    const buyers = await buyersOn(d, desk as Address, v1).catch(() => []);
    const hit = buyers.find((b) => b.buyer === lower);
    if (hit) return { ...base, signature: "", url: walletUrl, text: `placed a dollar order for ${symbolOf(d, hit.basket)} on ${d.label}` };
  }

  // In-kind creation: the basket's own event, else shares held where the RPC won't serve the logs.
  const baskets = d.baskets.map((b) => b.address as Address);
  if (baskets.length === 0) return null;
  try {
    const logs = await client.getLogs({ address: baskets, event: MINTED, args: { payer: owner }, fromBlock: BigInt(d.startBlock ?? 0), toBlock: "latest" });
    const log = logs[logs.length - 1];
    if (log?.transactionHash) {
      return { ...base, signature: log.transactionHash, url: explorerTxUrl(d, log.transactionHash), text: `created ${symbolOf(d, log.address)} shares in kind on ${d.label}` };
    }
    return null;
  } catch {
    const held = await Promise.all(
      baskets.map((b) => client.readContract({ address: b, abi: BASKET_ABI, functionName: "balanceOf", args: [owner] }).catch(() => 0n)),
    );
    const i = held.findIndex((x) => x > 0n);
    if (i >= 0) return { ...base, signature: "", url: walletUrl, text: `holds ${symbolOf(d, baskets[i])} shares on ${d.label}` };
    return null;
  }
}

/** The address's first Sheaf action on any EVM testnet, or null when none of them shows one. Throws only if every chain failed to answer. */
export async function findEvmProof(owner: Address): Promise<Proof | null> {
  const results = await Promise.allSettled(deployments().map((d) => proofOn(d, owner)));
  for (const r of results) if (r.status === "fulfilled" && r.value) return r.value;
  if (results.length > 0 && results.every((r) => r.status === "rejected")) throw new Error("No EVM chain answered");
  return null;
}
