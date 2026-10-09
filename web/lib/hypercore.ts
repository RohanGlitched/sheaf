import { createPublicClient, decodeAbiParameters, encodeAbiParameters, http, type Hex } from "viem";

/**
 * HyperCore stock-perp prices, read from HyperEVM testnet without gas.
 *
 * HyperEVM exposes HyperCore state through read-only precompiles. Two are used:
 *   0x…0807 oraclePx(uint32 index)       -> uint64 price, 6 - szDecimals decimals
 *   0x…080a perpAssetInfo(uint32 index)  -> (coin, marginTableId, szDecimals, maxLev, onlyIsolated)
 * A HIP-3 perp's index is dexIndex * 10000 + assetIndex. On testnet the trade.xyz
 * "xyz" dex is index 65, so xyz:NVDA is 650002. The coin name is checked on every
 * read, so a reshuffled universe shows as unpriced rather than as a wrong price.
 *
 * Nothing is deployed on Hyperliquid. This only prices a Sheaf recipe from
 * HyperCore, which trades around the clock, including when every stock market is shut.
 */

export const HYPEREVM_TESTNET = {
  chainId: 998,
  rpc: "https://rpc.hyperliquid-testnet.xyz/evm",
  dex: "xyz",
  dexIndex: 65,
  explorer: "https://testnet.purrsec.com",
} as const;

const ORACLE_PX = "0x0000000000000000000000000000000000000807" as const;
const PERP_ASSET_INFO = "0x000000000000000000000000000000000000080a" as const;

/** Asset indices in the xyz universe (same on mainnet and testnet). */
export const XYZ_ASSETS: Record<string, number> = {
  XYZ100: 0,
  TSLA: 1,
  NVDA: 2,
  HOOD: 4,
  PLTR: 6,
  META: 8,
  AAPL: 9,
  MSFT: 10,
  GOOGL: 12,
  AMZN: 13,
  AMD: 14,
  NFLX: 19,
};

export type PerpPrice = { symbol: string; coin: string; index: number; price: number };

const client = createPublicClient({ transport: http(HYPEREVM_TESTNET.rpc, { timeout: 12_000, batch: true }) });

const u32 = (n: number): Hex => encodeAbiParameters([{ type: "uint32" }], [n]);

async function readOne(symbol: string): Promise<PerpPrice | null> {
  const asset = XYZ_ASSETS[symbol];
  if (asset == null) return null;
  const index = HYPEREVM_TESTNET.dexIndex * 10_000 + asset;
  const [px, info] = await Promise.all([
    client.call({ to: ORACLE_PX, data: u32(index) }),
    client.call({ to: PERP_ASSET_INFO, data: u32(index) }),
  ]);
  if (!px.data || !info.data) return null;
  const [meta] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "coin", type: "string" },
          { name: "marginTableId", type: "uint32" },
          { name: "szDecimals", type: "uint8" },
          { name: "maxLeverage", type: "uint8" },
          { name: "onlyIsolated", type: "bool" },
        ],
      },
    ],
    info.data,
  );
  const coin = `${HYPEREVM_TESTNET.dex}:${symbol}`;
  if (meta.coin !== coin) return null;
  const raw = BigInt(px.data);
  if (raw === 0n) return null;
  return { symbol, coin, index, price: Number(raw) / 10 ** (6 - meta.szDecimals) };
}

/** Oracle prices for the given tickers. A ticker with no xyz perp is simply absent. */
export async function readHyperCorePrices(symbols: string[]): Promise<Record<string, PerpPrice>> {
  const out: Record<string, PerpPrice> = {};
  const rows = await Promise.all([...new Set(symbols)].map((s) => readOne(s).catch(() => null)));
  for (const r of rows) if (r) out[r.symbol] = r;
  return out;
}
