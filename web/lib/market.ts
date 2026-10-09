/**
 * Live market data for the twenty tokenized equities Sheaf composes.
 *
 * Everything here comes from Solana mainnet by way of Jupiter's public price and
 * token endpoints, which need no key. One call covers the whole universe and
 * carries three things no other source gives together:
 *
 *   usdPrice        the token's price on Solana, right now, 24 hours a day
 *   stockData.price the real listed share's last price, for the premium or
 *                   discount the token is trading at
 *   scaledUiConfig  the Token-2022 ScaledUiAmount multiplier, which is how these
 *                   tokens pay dividends, plus the next scheduled step and when
 *                   it takes effect
 *
 * The third is the one almost nothing surfaces. A holder's balance grows without
 * a transaction ever appearing: the mint's multiplier rises and every balance is
 * restated. Read the raw balance and divide by 10^decimals, as most apps do, and
 * you understate what somebody owns.
 *
 * When Jupiter does not answer for a token, its price comes from GeckoTerminal's
 * keyless on-chain price for the same mint (an independent indexer of the same
 * Solana pools), and failing that from the last snapshot that came back whole
 * (lib/price-snapshot.ts, at most six hours old). Each quote says which source it
 * came from: the site shows fallback prices, but its fillers fill on live Jupiter quotes only.
 */

import { XSTOCKS, BY_MINT, type XStock } from "./universe";
import { PRESTOCKS, PRESTOCK_SYMBOLS, asXStock } from "./prestocks";

const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";
const GECKO = "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price";

type JupPrice = {
  usdPrice?: number;
  priceChange24h?: number;
  liquidity?: number;
  decimals?: number;
  blockId?: number;
  stockData?: { price?: number; mcap?: number; updatedAt?: string };
  scaledUiConfig?: {
    multiplier?: number;
    newMultiplier?: number;
    newMultiplierEffectiveAt?: string;
    usdPricePrescaled?: number;
    circSupplyPrescaled?: number;
  };
};

type JupToken = {
  id: string;
  holderCount?: number;
  liquidity?: number;
  usdPrice?: number;
  mcap?: number;
  organicScore?: number;
  stats24h?: {
    priceChange?: number;
    buyVolume?: number;
    sellVolume?: number;
    numTraders?: number;
  };
};

/** One tile of the market mosaic. */
export type Quote = {
  /** Where the price came from: Jupiter, GeckoTerminal as the fallback, or the last good snapshot. */
  source?: "jupiter" | "geckoterminal" | "snapshot";
  symbol: string;
  base: string;
  company: string;
  mint: string;
  decimals: number;

  /** Price of one token on Solana, in USD. Live around the clock. */
  price: number;
  /** 24h change in the token's own price, in percent. */
  change24h: number | null;
  /** Depth of the on-chain market, in USD. Tile area is drawn from this. */
  liquidity: number;
  /** 24h traded volume across both sides, in USD. */
  volume24h: number | null;
  holders: number | null;
  /** Market capitalisation of the token on Solana. */
  onChainMcap: number | null;

  /** Last price of the actual listed share, in USD. */
  sharePrice: number | null;
  /**
   * How far the token trades from the share it represents, in percent. Positive
   * is a premium. Anyone can close this gap: Backed will create or redeem the
   * token one-for-one against the real share.
   */
  premiumBps: number | null;

  /**
   * The multiplier in force now. One raw unit of the mint is worth this many
   * nominal shares, and it only ever rises.
   */
  multiplier: number;
  /** The next multiplier, if one is already scheduled on the mint. */
  nextMultiplier: number | null;
  nextMultiplierAt: string | null;
  /**
   * Dividends collected since the token launched, as a percentage of principal.
   * This is the multiplier minus one: nothing more, nothing less.
   */
  accruedYieldPct: number;
  /** Whether this token has ever paid a dividend through its multiplier. */
  paysDividend: boolean;
};

export type MarketSnapshot = {
  quotes: Quote[];
  /** Unix seconds. */
  fetchedAt: number;
  /** Mainnet slot the prices were read at, when Jupiter reports one. */
  blockId: number | null;
  /** Tickers we asked for and did not get back. Shown, never hidden. */
  missing: string[];
  /**
   * The mainnet slot the mint accounts were read at, and through which RPC.
   * Null when the chain read failed and the multipliers are Jupiter's copy.
   */
  chain: { slot: number; via: "solami" | "public" } | null;
};

// Public equities and pre-IPO SPV tokens, priced the same way: both are real
// mints with real Jupiter liquidity, and neither is a fixture.
const UNIVERSE: XStock[] = [...XSTOCKS, ...PRESTOCKS.map(asXStock)];
export const UNIVERSE_MINTS = UNIVERSE.map((s) => s.mint);
const mints = UNIVERSE_MINTS;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The multiplier that applies right now.
 *
 * A mint can carry a scheduled step: a new multiplier and the timestamp it turns
 * on. Token-2022 switches over on its own at that moment, so once the timestamp
 * has passed the new value is the live one.
 */
export function effectiveMultiplier(
  cfg: JupPrice["scaledUiConfig"],
  now = Date.now(),
): { current: number; next: number | null; nextAt: string | null } {
  if (!cfg) return { current: 1, next: null, nextAt: null };
  const base = cfg.multiplier ?? 1;
  const stepAt = cfg.newMultiplierEffectiveAt
    ? Date.parse(cfg.newMultiplierEffectiveAt)
    : NaN;
  const step = cfg.newMultiplier ?? null;

  if (step != null && Number.isFinite(stepAt) && stepAt <= now) {
    return { current: step, next: null, nextAt: null };
  }
  return {
    current: base,
    next: step != null && step > base ? step : null,
    nextAt: Number.isFinite(stepAt) ? cfg.newMultiplierEffectiveAt! : null,
  };
}

function buildQuote(
  stock: XStock,
  price: JupPrice | undefined,
  token: JupToken | undefined,
): Quote | null {
  const usd = price?.usdPrice;
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;

  // A PreStock is a pre-IPO SPV. Jupiter's `stockData` for it is PreStocks' own
  // mark on the private company, not a listed share anyone can arbitrage
  // against, and its multiplier restates share ratios rather than paying
  // dividends. The multiplier still values the token; neither reading is shown.
  const prestock = PRESTOCK_SYMBOLS.has(stock.symbol);
  const share = prestock ? null : (price?.stockData?.price ?? null);
  const mult = effectiveMultiplier(price?.scaledUiConfig);
  const dividend = !prestock && mult.current > 1;
  const vol =
    token?.stats24h?.buyVolume != null || token?.stats24h?.sellVolume != null
      ? (token?.stats24h?.buyVolume ?? 0) + (token?.stats24h?.sellVolume ?? 0)
      : null;

  return {
    source: "jupiter",
    symbol: stock.symbol,
    base: stock.base,
    company: stock.company,
    mint: stock.mint,
    decimals: price?.decimals ?? stock.decimals,

    price: usd,
    change24h: price?.priceChange24h ?? token?.stats24h?.priceChange ?? null,
    liquidity: price?.liquidity ?? token?.liquidity ?? 0,
    volume24h: vol,
    holders: token?.holderCount ?? null,
    onChainMcap: token?.mcap ?? null,

    sharePrice: share,
    premiumBps:
      share != null && share > 0 ? ((usd - share) / share) * 10_000 : null,

    multiplier: mult.current,
    nextMultiplier: mult.next,
    nextMultiplierAt: mult.nextAt,
    accruedYieldPct: dividend ? (mult.current - 1) * 100 : 0,
    paysDividend: dividend,
  };
}

/** GeckoTerminal's USD price per token for each mint, 30 to a call, keyless. */
async function geckoPrices(stocks: XStock[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < stocks.length; i += 30) {
    const chunk = stocks.slice(i, i + 30);
    const res = await getJson<{ data?: { attributes?: { token_prices?: Record<string, string | null> } } }>(
      `${GECKO}/${chunk.map((s) => s.mint).join(",")}`,
    );
    const prices = res?.data?.attributes?.token_prices ?? {};
    for (const stock of chunk) {
      const price = Number(prices[stock.mint]);
      if (Number.isFinite(price) && price > 0) out.set(stock.symbol, price);
    }
  }
  return out;
}

/**
 * Read the whole universe. Two calls, no key, no cache; a token Jupiter misses is
 * priced from GeckoTerminal, then from the last good snapshot.
 */
export async function fetchMarket(): Promise<MarketSnapshot> {
  const snapshot = await fetchJupiter();
  if (typeof window !== "undefined") return snapshot;
  const { lastGoodQuote, saveLastGood } = await import("./price-snapshot");
  if (snapshot.missing.length === 0) {
    await saveLastGood(snapshot).catch(() => undefined);
    return snapshot;
  }
  const missingStocks = UNIVERSE.filter((s) => snapshot.missing.includes(s.symbol));
  const second = await geckoPrices(missingStocks).catch(() => new Map<string, number>());
  const quotes = [...snapshot.quotes];
  const missing: string[] = [];
  for (const stock of missingStocks) {
    const last = await lastGoodQuote(stock.symbol);
    const price = second.get(stock.symbol);
    if (price != null) {
      // A live price, with what the last good snapshot knew about the token (its multiplier above all).
      const base = last ?? buildQuote(stock, { usdPrice: price }, undefined)!;
      quotes.push({ ...base, price, source: "geckoterminal" });
    } else if (last) quotes.push(last);
    else missing.push(stock.symbol);
  }
  quotes.sort((a, b) => b.liquidity - a.liquidity);
  return { ...snapshot, quotes, missing };
}

async function fetchJupiter(): Promise<MarketSnapshot> {
  const ids = mints.join(",");
  const [prices, tokens] = await Promise.all([
    getJson<Record<string, JupPrice>>(`${JUP_PRICE}?ids=${ids}`),
    getJson<JupToken[]>(`${JUP_SEARCH}?query=${ids}`),
  ]);

  const byId = new Map<string, JupToken>();
  for (const t of tokens ?? []) byId.set(t.id, t);

  const quotes: Quote[] = [];
  const missing: string[] = [];
  for (const stock of UNIVERSE) {
    const q = buildQuote(stock, prices?.[stock.mint], byId.get(stock.mint));
    if (q) quotes.push(q);
    else missing.push(stock.symbol);
  }

  quotes.sort((a, b) => b.liquidity - a.liquidity);

  const blockIds = Object.values(prices ?? {})
    .map((p) => p.blockId)
    .filter((b): b is number => typeof b === "number");

  return {
    quotes,
    fetchedAt: Math.floor(Date.now() / 1000),
    blockId: blockIds.length ? Math.max(...blockIds) : null,
    missing,
    chain: null,
  };
}

/**
 * Replace each multiplier with the one read from its mint account. The mint is
 * the authority on what a raw unit is worth; an aggregator only relays it.
 */
export function withChainMultipliers(
  snapshot: MarketSnapshot,
  chain: {
    slot: number;
    via: "solami" | "public";
    mints: Map<
      string,
      { supply: number; multiplier: number; nextMultiplier: number | null; nextMultiplierAt: string | null }
    >;
  } | null,
): MarketSnapshot {
  if (!chain) return snapshot;
  const quotes = snapshot.quotes.map((q) => {
    const mint = chain.mints.get(q.mint);
    if (!mint) return q;
    const dividend = !PRESTOCK_SYMBOLS.has(q.symbol) && mint.multiplier > 1;
    return {
      ...q,
      multiplier: mint.multiplier,
      nextMultiplier: mint.nextMultiplier,
      nextMultiplierAt: mint.nextMultiplierAt,
      accruedYieldPct: dividend ? (mint.multiplier - 1) * 100 : 0,
      paysDividend: dividend,
      // The price is per UI token, which is the raw supply restated by the multiplier.
      onChainMcap: mint.supply * mint.multiplier * q.price,
    };
  });
  return { ...snapshot, quotes, chain: { slot: chain.slot, via: chain.via } };
}

/** Look up one ticker in a snapshot. */
export function quoteFor(
  snapshot: MarketSnapshot | null,
  mint: string,
): Quote | undefined {
  return snapshot?.quotes.find((q) => q.mint === mint);
}

export { BY_MINT };
