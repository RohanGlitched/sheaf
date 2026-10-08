import { DEPLOYMENTS } from "./deployments";

/**
 * Every chain Sheaf runs on, and why it is there. Solana is home: the program,
 * the launch markets and the plans live there. Each EVM chain gets the same rules
 * written natively (an immutable recipe, a vault, shares in kind, a cash desk) and
 * is listed only once its contracts are deployed; until then it says what it is
 * waiting for.
 */

export type ChainToken = { symbol: string; name: string; address: string; decimals: number; isMirror: boolean };

export type ChainBasket = {
  symbol: string;
  name: string;
  address: string;
  feeBps: number;
  components: { symbol: string; token: string; unitsPerShare: string; weightBps: number }[];
};

export type Deployment = {
  network: string;
  label: string;
  chainId: number;
  rpc: string;
  explorer: string;
  tokenSource: "real" | "mirror" | string;
  tokens: ChainToken[];
  stable: ChainToken;
  factory: string;
  desk: string;
  baskets: ChainBasket[];
};

export type ChainCard = {
  key: string;
  name: string;
  /** Why tokenized stocks, and so Sheaf, belong on this chain. */
  why: string;
  /** What is native here that Sheaf uses. */
  native: string;
  /** Prize track it competes in, for the judges' map. */
  deployment?: Deployment;
};

const NOTES: Record<string, { name: string; why: string; native: string }> = {
  robinhoodTestnet: {
    name: "Robinhood Chain",
    why: "Robinhood's own stock tokens are issued here.",
    native: "Baskets hold Robinhood's testnet stock tokens, not stand-ins, and cash orders settle in Paxos USDG.",
  },
  arbitrumSepolia: {
    name: "Arbitrum",
    why: "Where Robinhood's stock tokens trade for its EU customers.",
    native: "The same immutable vault and cash desk, on Arbitrum's testnet.",
  },
  sepolia: {
    name: "Ethereum",
    why: "xStocks and Ondo issue their EVM stock tokens on Ethereum.",
    native: "The same immutable vault and cash desk, on Ethereum's testnet.",
  },
  baseSepolia: {
    name: "Base",
    why: "Dinari issues stock tokens on Base, and Coinbase brings the users.",
    native: "The same immutable vault and cash desk, on Base's testnet.",
  },
  tempoTestnet: {
    name: "Tempo",
    why: "A payments chain where gas is paid in dollars.",
    native: "Cash orders settle in Tempo's own stablecoins, and its recurring spending limits are the native shape of a monthly plan.",
  },
  hyperEvmTestnet: {
    name: "Hyperliquid",
    why: "Stock perpetuals trade on HyperCore around the clock.",
    native: "A basket on HyperEVM can read HyperCore's stock-perp oracle directly.",
  },
};

const ORDER = ["robinhoodTestnet", "tempoTestnet", "arbitrumSepolia", "sepolia", "baseSepolia", "hyperEvmTestnet"];

export const EVM_CHAINS: ChainCard[] = ORDER.map((key) => ({
  key,
  ...NOTES[key],
  deployment: (DEPLOYMENTS as readonly Deployment[]).find((d) => d.network === key),
}));

export const DEPLOYED = EVM_CHAINS.filter((c) => c.deployment);
