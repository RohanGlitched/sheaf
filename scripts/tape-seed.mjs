#!/usr/bin/env node
// Capture ~40 real, recent xStock trades from Sheaf's own tape decoder into
// web/public/tape.seed.json. The home page shows them, labelled "Earlier
// trades" with their real block times, while a cold server instance is still
// reading its first live trades. They are never shown as live.
//
// The rows come from a running Sheaf server's /api/tape (the same decoder and
// filters as the live tape, reading mainnet through Solami), so the seed holds
// exactly what the tape itself would have shown. Jupiter's price and the mint's
// dividend multiplier at capture time are stored with each row, so the page can
// set an old fill against the price of its own moment, not today's.
//
// Usage: node scripts/tape-seed.mjs [baseUrl] [count]
//   baseUrl defaults to http://localhost:3900, count to 40.
// Plain fetch, no dependencies; works in Windows node or WSL.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://localhost:3900").replace(/\/$/, "");
const WANT = Number(process.argv[3] ?? 40);
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../web/public/tape.seed.json");
const DEADLINE = Date.now() + 6 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const market = await getJson("/api/market");
const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));

const rows = new Map();
let via = null;
while (rows.size < WANT && Date.now() < DEADLINE) {
  try {
    const tape = await getJson("/api/tape?depth=60");
    via = tape.via;
    for (const p of tape.prints ?? []) {
      if (rows.has(p.signature)) continue;
      const q = quotes.get(p.symbol);
      const multiplier = q?.multiplier ?? 1;
      const ui = p.raw * multiplier;
      const value = p.usd ?? (q ? ui * q.price : null);
      // The page's own dust filter: under a dollar is a route's rounding.
      if (value != null && value < 1) continue;
      rows.set(p.signature, {
        signature: p.signature,
        slot: p.slot,
        time: p.time,
        timeSource: p.timeSource,
        symbol: p.symbol,
        base: p.base,
        raw: p.raw,
        side: p.side,
        wallet: p.wallet,
        usd: p.usd,
        quote: p.quote,
        venue: p.venue,
        multiplier,
        refPrice: q?.price ?? null,
      });
    }
    process.stdout.write(`\r${rows.size}/${WANT} trades captured (read via ${via})   `);
  } catch (err) {
    process.stdout.write(`\n${err.message}; retrying\n`);
  }
  if (rows.size < WANT) await sleep(5_000);
}
process.stdout.write("\n");
if (rows.size === 0) {
  console.error("No trades captured; seed left unchanged.");
  process.exit(1);
}

const prints = [...rows.values()].sort((a, b) => b.slot - a.slot).slice(0, WANT);
const seed = {
  capturedAt: Math.round(Date.now() / 1000),
  source: `Solana mainnet, read through ${via === "solami" ? "Solami" : "a public RPC"} and decoded by Sheaf's /api/tape`,
  note: "Earlier trades, not live. Each row links to its transaction; times are the block's.",
  prints,
};
writeFileSync(OUT, JSON.stringify(seed, null, 2) + "\n");
console.log(`Wrote ${prints.length} trades to ${OUT}`);
