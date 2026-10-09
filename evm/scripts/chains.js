// Per-chain deployment plan for Sheaf.
//
// A chain either has real tokenized stocks on its testnet (Robinhood Chain
// testnet, the only one today) or gets a labelled mirror set: eight MockStock
// tokens named "<Company> (Sheaf testnet mirror)". The desk settles in a real
// testnet stablecoin where one exists (USDG on Robinhood Chain, AlphaUSD on
// Tempo) and in a MockDollar mirror elsewhere.
const RH = require("./robinhood");

const MIRROR_STOCKS = [
  { symbol: "TSLA", company: "Tesla" },
  { symbol: "NVDA", company: "Nvidia" },
  { symbol: "AAPL", company: "Apple" },
  { symbol: "MSFT", company: "Microsoft" },
  { symbol: "AMZN", company: "Amazon" },
  { symbol: "GOOGL", company: "Alphabet" },
  { symbol: "META", company: "Meta" },
  { symbol: "PLTR", company: "Palantir" },
];

// Seed baskets on mirror chains. Each targets a $10 net asset value per share
// at the live Robinhood quote for the underlying (fallbacks below if offline).
const MIRROR_SEEDS = [
  {
    name: "Magnificent Eight",
    symbol: "MAG8",
    feeBps: 25,
    weights: { TSLA: 1250, NVDA: 1250, AAPL: 1250, MSFT: 1250, AMZN: 1250, GOOGL: 1250, META: 1250, PLTR: 1250 },
  },
  { name: "AI Core", symbol: "AICORE", feeBps: 50, weights: { NVDA: 4000, MSFT: 2500, GOOGL: 2000, PLTR: 1500 } },
  { name: "Everyday Tech", symbol: "EVDY", feeBps: 0, weights: { AAPL: 3000, AMZN: 3000, META: 2000, TSLA: 2000 } },
];

// Used only when the Robinhood price API cannot be reached.
const FALLBACK_PRICES = {
  TSLA: 372, NVDA: 230, AAPL: 340, MSFT: 521, AMZN: 255, GOOGL: 347, META: 719, PLTR: 197, AMD: 617, NFLX: 71,
};

const MIRROR_DOLLAR = { name: "Sheaf Test Dollar (mirror)", symbol: "sUSD", decimals: 6 };

const CHAINS = {
  robinhoodTestnet: {
    label: "Robinhood Chain testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    verifier: "blockscout",
    stocks: "real",
    realTokens: Object.entries(RH.TOKENS).map(([symbol, t]) => ({ symbol, name: t.name, address: t.address, decimals: 18 })),
    stable: { symbol: "USDG", name: "Global Dollar (testnet)", address: RH.USDG, decimals: 6, isMirror: false },
    seeds: RH.SEEDS,
    seedShares: "1",
  },
  tempoTestnet: {
    label: "Tempo testnet (Moderato)",
    chainId: 42431,
    rpc: "https://rpc.moderato.tempo.xyz",
    explorer: "https://explore.testnet.tempo.xyz",
    verifier: "sourcify:https://contracts.tempo.xyz",
    stocks: "mirror",
    // A native TIP-20 dollar from the free Tempo faucet. pathUSD stays the fee
    // token, so the desk's cash and the gas budget never mix.
    stable: {
      symbol: "AlphaUSD",
      name: "AlphaUSD (Tempo testnet TIP-20)",
      address: "0x20c0000000000000000000000000000000000001",
      decimals: 6,
      isMirror: false,
    },
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
  arbitrumSepolia: {
    label: "Arbitrum Sepolia",
    chainId: 421614,
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://arbitrum-sepolia.blockscout.com",
    verifier: "blockscout",
    stocks: "mirror",
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
  sepolia: {
    label: "Ethereum Sepolia",
    chainId: 11155111,
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://eth-sepolia.blockscout.com",
    verifier: "blockscout",
    stocks: "mirror",
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
  baseSepolia: {
    label: "Base Sepolia",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    explorer: "https://base-sepolia.blockscout.com",
    verifier: "blockscout",
    stocks: "mirror",
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
  // Local dry run: `npx hardhat node`, then --network localhost.
  localhost: {
    label: "Local Hardhat node",
    chainId: 31337,
    rpc: "http://127.0.0.1:8545",
    explorer: "",
    verifier: "none",
    stocks: "mirror",
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
  hyperEvmTestnet: {
    label: "HyperEVM testnet",
    chainId: 998,
    rpc: "https://rpc.hyperliquid-testnet.xyz/evm",
    explorer: "https://testnet.purrsec.com",
    verifier: "none",
    stocks: "mirror",
    seeds: MIRROR_SEEDS,
    seedShares: "10",
  },
};

async function fetchQuotes(symbols) {
  const out = {};
  for (const sym of symbols) {
    try {
      const r = await fetch(`https://api.robinhood.com/rhj/prices/${sym}`);
      const q = (await r.json()).quotes[0];
      const mid = (Number(q.bid) + Number(q.ask)) / 2;
      if (!(mid > 0)) throw new Error("bad quote");
      out[sym] = mid;
    } catch {
      out[sym] = FALLBACK_PRICES[sym];
    }
  }
  return out;
}

/** Raw 18-decimal units per share of each component so one share is worth navUsd. */
function recipe(weights, addressOf, prices, navUsd = RH.SHARE_NAV_USD) {
  return Object.entries(weights).map(([sym, bps]) => {
    const usd = (navUsd * bps) / 10_000;
    const units = BigInt(Math.round((usd / prices[sym]) * 1e12)) * 10n ** 6n;
    return { token: addressOf[sym], unitsPerShare: units, weightBps: bps };
  });
}

module.exports = { CHAINS, MIRROR_STOCKS, MIRROR_SEEDS, MIRROR_DOLLAR, fetchQuotes, recipe };
