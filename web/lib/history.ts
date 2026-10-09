/**
 * A year of daily closes for every listed company Sheaf composes.
 *
 * The program never prices anything, but a person deciding whether to hold a
 * basket wants to know what that recipe would have done, so every basket gets a
 * track record computed from the history of the shares behind its tokens. The
 * history is read from Yahoo Finance's chart endpoint, which needs no key and
 * returns adjusted closes, so the series is total return: dividends reinvested,
 * which is exactly how an xStock pays them, by raising the mint's multiplier.
 *
 * Reads happen on the server, once per ticker per hour, and a ticker whose
 * read fails falls back to the snapshot committed in history.snapshot.json
 * (written by scripts/snapshot-history.mjs), so the chart never goes blank and
 * at worst is as old as that file. The response says which it was.
 *
 * Pre-IPO companies (PreStocks) have no listed share and no history. They are
 * not in here; the track record holds them at today's price and says so.
 */

import snapshot from "./history.snapshot.json";
import { XSTOCKS } from "./universe";
import { CLOSE_SETTLE_S, closeDayAtOrBefore } from "./panta-window";

export type Series = {
  /** Trading days as YYYYMMDD integers, ascending. */
  t: number[];
  /** Closing price of the listed share. */
  close: number[];
  /** Adjusted close: the total-return series, dividends reinvested. */
  adj: number[];
  /** Cash dividends paid, as [day, amount per share]. */
  div: [number, number][];
};

export type History = {
  /** The day of the most recent close in the data. */
  asOf: string;
  benchmark: string;
  series: Record<string, Series>;
  /** Tickers served from the committed snapshot rather than a live read. */
  stale: string[];
};

export const BENCHMARK = "SPY";

/** Every listed ticker, plus the benchmark. */
export const HISTORY_SYMBOLS: string[] = [
  ...new Set([...XSTOCKS.map((s) => s.base), BENCHMARK]),
];

const SNAPSHOT = snapshot as unknown as { asOf: string; benchmark: string; series: Record<string, Series> };

const toDay = (unix: number) => {
  const d = new Date(unix * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

type YahooChart = {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators: {
        quote: { close: (number | null)[] }[];
        adjclose?: { adjclose: (number | null)[] }[];
      };
      events?: { dividends?: Record<string, { amount: number; date: number }> };
    }[];
  };
};

async function fetchSeries(symbol: string, timeoutMs = 8000): Promise<Series> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div`;
  const res = await fetch(url, {
    // Yahoo answers a plain browser user agent and rate-limits everything else.
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as YahooChart;
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`${symbol}: empty`);
  const quote = result.indicators.quote[0];
  const adjclose = result.indicators.adjclose?.[0]?.adjclose ?? quote.close;
  const t: number[] = [];
  const close: number[] = [];
  const adj: number[] = [];
  // While a session is open, Yahoo's last daily row is that day's price so far,
  // not a close. Keep only days whose close (on the exchange calendar, early
  // closes included) has passed and settled, so "the last five closes" are closes.
  const finalDay = closeDayAtOrBefore(Math.floor(Date.now() / 1000) - CLOSE_SETTLE_S);
  result.timestamp.forEach((ts, i) => {
    const c = quote.close[i];
    const a = adjclose[i];
    if (c == null || a == null) return;
    if (toDay(ts) > finalDay) return;
    t.push(toDay(ts));
    close.push(Number(c.toFixed(4)));
    adj.push(Number(a.toFixed(4)));
  });
  if (t.length < 2) throw new Error(`${symbol}: too short`);
  const div = Object.values(result.events?.dividends ?? {})
    .map((d) => [toDay(d.date), Number(d.amount)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return { t, close, adj, div };
}

const TTL_MS = 60 * 60 * 1000;
let cached: { at: number; value: History } | null = null;
let inFlight: Promise<History> | null = null;

/**
 * The whole history, read live with the snapshot as a per-ticker fallback.
 * Cached in memory for an hour per server instance; the CDN caches the response
 * on top of that.
 */
export async function readHistory(): Promise<History> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const series: Record<string, Series> = {};
    const stale: string[] = [];
    // A few at a time: the upstream rate-limits bursts, and twenty-one reads
    // in four lanes finish in a couple of seconds.
    const queue = [...HISTORY_SYMBOLS];
    const lane = async () => {
      for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
        try {
          series[symbol] = await fetchSeries(symbol);
        } catch {
          const fallback = SNAPSHOT.series[symbol];
          if (fallback) {
            series[symbol] = fallback;
            stale.push(symbol);
          }
        }
      }
    };
    await Promise.all([lane(), lane(), lane(), lane()]);

    let latest = 0;
    for (const s of Object.values(series)) {
      const last = s.t[s.t.length - 1];
      if (last > latest) latest = last;
    }
    const asOf = latest
      ? `${Math.floor(latest / 10000)}-${String(Math.floor((latest / 100) % 100)).padStart(2, "0")}-${String(latest % 100).padStart(2, "0")}`
      : SNAPSHOT.asOf;
    const value: History = { asOf, benchmark: BENCHMARK, series, stale: stale.sort() };
    // A read that fell back for everything is not worth remembering for an hour.
    if (stale.length < HISTORY_SYMBOLS.length) cached = { at: Date.now(), value };
    return value;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
