#!/usr/bin/env node
/**
 * Write web/lib/history.snapshot.json: a year of daily closes for every listed
 * ticker Sheaf composes, plus the benchmark.
 *
 * The track record on every basket page is computed from this history. The
 * site reads it live from Yahoo Finance's chart endpoint and falls back to this
 * file per ticker when that read fails, so the chart never goes blank and is at
 * worst as old as this snapshot. Re-run before a release:
 *
 *   node scripts/snapshot-history.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "web", "lib", "history.snapshot.json");

const BENCHMARK = "SPY";
// The listed tickers, read off the generated universe rather than imported, so
// this runs on any Node without a TypeScript loader.
const universe = readFileSync(join(here, "..", "web", "lib", "universe.ts"), "utf8");
const bases = [...universe.matchAll(/"base":\s*"([A-Z.]+)"/g)].map((m) => m[1]);
const symbols = [...new Set([...bases, BENCHMARK])];

const day = (unix) => {
  const d = new Date(unix * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

async function fetchSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=div`;
  const res = await fetch(url, {
    // Yahoo answers a plain browser user agent and rate-limits everything else.
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`${symbol}: empty`);
  const quote = result.indicators.quote[0];
  const adjclose = result.indicators.adjclose?.[0]?.adjclose ?? quote.close;
  const t = [];
  const close = [];
  const adj = [];
  result.timestamp.forEach((ts, i) => {
    const c = quote.close[i];
    const a = adjclose[i];
    if (c == null || a == null) return;
    t.push(day(ts));
    close.push(Number(c.toFixed(4)));
    adj.push(Number(a.toFixed(4)));
  });
  const div = Object.values(result.events?.dividends ?? {})
    .map((d) => [day(d.date), Number(d.amount)])
    .sort((a, b) => a[0] - b[0]);
  return { t, close, adj, div };
}

const series = {};
for (const symbol of symbols) {
  try {
    series[symbol] = await fetchSeries(symbol);
    process.stdout.write(`${symbol}: ${series[symbol].t.length} days\n`);
  } catch (err) {
    process.stdout.write(`${symbol}: FAILED ${err.message}\n`);
  }
  await new Promise((r) => setTimeout(r, 350));
}

const snapshot = { asOf: new Date().toISOString().slice(0, 10), benchmark: BENCHMARK, series };
writeFileSync(out, JSON.stringify(snapshot));
process.stdout.write(`wrote ${out} (${Object.keys(series).length} series)\n`);
