// Robinhood Chain testnet addresses and the seed basket recipes.

const TOKENS = {
  TSLA: { address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", name: "Tesla" },
  AMZN: { address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", name: "Amazon" },
  AMD: { address: "0x71178BAc73cBeb415514eB542a8995b82669778d", name: "AMD" },
  PLTR: { address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0", name: "Palantir" },
  NFLX: { address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93", name: "Netflix" },
};
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";

// Each seed basket targets a $10 net asset value per share at today's prices.
const SHARE_NAV_USD = 10;
const SEEDS = [
  {
    name: "Robinhood Five",
    symbol: "HOOD5",
    feeBps: 25,
    weights: { TSLA: 2000, AMZN: 2000, AMD: 2000, PLTR: 2000, NFLX: 2000 },
  },
  { name: "Compute Rush", symbol: "CHIPS", feeBps: 50, weights: { AMD: 5000, PLTR: 3000, TSLA: 2000 } },
  { name: "Prime Time", symbol: "PRIME", feeBps: 0, weights: { AMZN: 5500, NFLX: 4500 } },
];

/** Live mid prices from Robinhood's Stock Token API (underlying equity quote). */
async function fetchPrices() {
  const out = {};
  for (const sym of Object.keys(TOKENS)) {
    const r = await fetch(`https://api.robinhood.com/rhj/prices/${sym}`);
    const q = (await r.json()).quotes[0];
    out[sym] = (Number(q.bid) + Number(q.ask)) / 2;
  }
  return out;
}

/** Raw 18-decimal units of each component so one share is worth SHARE_NAV_USD. */
function recipeFor(seed, prices) {
  return Object.entries(seed.weights).map(([sym, bps]) => {
    const usd = (SHARE_NAV_USD * bps) / 10_000;
    const units = BigInt(Math.round((usd / prices[sym]) * 1e12)) * 10n ** 6n;
    return { token: TOKENS[sym].address, unitsPerShare: units, weightBps: bps };
  });
}

module.exports = { TOKENS, USDG, SEEDS, SHARE_NAV_USD, fetchPrices, recipeFor };
