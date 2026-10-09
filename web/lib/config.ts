/**
 * Sheaf reads from one cluster and writes to another.
 *
 * Prices, premiums and dividend multipliers come from mainnet, because the twenty
 * xStocks only exist there. Minting and redeeming run on
 * NEXT_PUBLIC_WRITE_CLUSTER against mock mints that mirror the mainnet ones
 * extension for extension, so the only stand-in is the settlement layer and every
 * figure on screen stays real.
 */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://sheaf.vercel.app").replace(/\/$/, "");

export const MAINNET_RPC =
  process.env.NEXT_PUBLIC_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";

export type WriteCluster = "devnet" | "localnet";

export const WRITE_CLUSTER: WriteCluster =
  (process.env.NEXT_PUBLIC_WRITE_CLUSTER as WriteCluster) ?? "devnet";

/**
 * The write cluster's RPC. On the server it is Helius when a key is configured;
 * in the browser it is this site's own /api/rpc, which forwards to the same
 * endpoint, so the key never reaches a visitor and the public devnet RPC's rate
 * limits never reach the page.
 */
function serverWriteRpc(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (WRITE_CLUSTER === "localnet") return "http://127.0.0.1:8899";
  return key ? `https://devnet.helius-rpc.com/?api-key=${key}` : "https://api.devnet.solana.com";
}

export const WRITE_RPC =
  typeof window === "undefined"
    ? serverWriteRpc()
    : WRITE_CLUSTER === "localnet"
      ? "http://127.0.0.1:8899"
      : `${window.location.origin}/api/rpc`;

/** Subscriptions cannot go through the proxy; the app confirms by polling, but a wallet may subscribe. */
export const WRITE_WS = WRITE_CLUSTER === "localnet" ? "ws://127.0.0.1:8900" : "wss://api.devnet.solana.com";

export const serverRpcUrl = serverWriteRpc;

/** The endpoint shown to people who check a vault themselves: public, keyless, the same on server and client. */
export const PUBLIC_WRITE_RPC = WRITE_CLUSTER === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com";

export const SHEAF_PROGRAM_ID =
  process.env.NEXT_PUBLIC_SHEAF_PROGRAM_ID ??
  "GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz";

/** Where a signature can be looked up, for the cluster it was signed on. */
export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${WRITE_CLUSTER === "localnet" ? "custom" : WRITE_CLUSTER}`;
}

export function explorerAddress(address: string, mainnet = false): string {
  if (mainnet) return `https://explorer.solana.com/address/${address}`;
  return `https://explorer.solana.com/address/${address}?cluster=${WRITE_CLUSTER === "localnet" ? "custom" : WRITE_CLUSTER}`;
}

/** A share of a Sheaf basket is always six decimals. Matches the program. */
export const SHARE_DECIMALS = 6;
export const ONE_SHARE = 1_000_000;
/** The program's hard ceiling on components per basket. Also the palette size. */
export const MAX_COMPONENTS = 8;
/** The program's hard ceiling on the creator fee. */
export const MAX_CREATOR_FEE_BPS = 100;
