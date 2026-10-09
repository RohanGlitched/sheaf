import { DEPLOYMENTS } from "./deployments";

/**
 * Every chain Sheaf runs on, and why it is there. Solana is home: the program,
 * the launch markets and the plans live there. Each EVM chain gets the same rules
 * written natively (an immutable recipe, a vault, shares in kind, a cash desk).
 *
 * Two tiers, and nothing in between. A chain is "live" when its contracts are
 * deployed and verified and a visitor can create, redeem and order shares on it
 * from a wallet. A chain is "next" when there is a reason for Sheaf to be there
 * but nothing is deployed yet; it gets one quiet line, never a placeholder card.
 */

export type ChainToken = { symbol: string; name: string; address: string; decimals: number; isMirror: boolean };

export type ChainBasket = {
  symbol: string;
  name: string;
  address: string;
  feeBps: number;
  components: { symbol: string; token: string; unitsPerShare: string; weightBps: number }[];
  /** Prices the recipe was sized at, at deploy time. A fallback, never the live price. */
  pricedAt?: Record<string, number>;
};

export type Deployment = {
  network: string;
  label: string;
  chainId: number;
  rpc: string;
  explorer: string;
  tokenSource: "real" | "mirror" | string;
  deployer?: string;
  tokens: ChainToken[];
  stable: ChainToken;
  factory: string;
  desk: string;
  startBlock?: number;
  baskets: ChainBasket[];
  sip?: {
    at: string;
    keeperKey: string;
    authorizeTx: string;
    instalmentTx: string;
    orderId: number;
    limitPerPeriod: string;
    periodSeconds: number;
  };
};

export type ChainTier = "feature" | "portable" | "next";

export type ChainCard = {
  key: string;
  name: string;
  /** Why tokenized stocks, and so Sheaf, belong on this chain. */
  why: string;
  /** What is native here that Sheaf uses. The first line of the card. */
  native: string;
  /** feature: a chain-native primitive in the UI. portable: the same contracts, redeployed. next: not deployed. */
  tier: ChainTier;
  deployment?: Deployment;
};

const NOTES: Record<string, { name: string; why: string; native: string; tier: ChainTier }> = {
  robinhoodTestnet: {
    name: "Robinhood Chain",
    why: "Robinhood's own stock tokens are issued here.",
    native:
      "Baskets hold Robinhood's testnet stock tokens, not stand-ins, read through their split-and-dividend multiplier, and dollar orders settle in Paxos USDG.",
    tier: "feature",
  },
  tempoTestnet: {
    name: "Tempo",
    why: "A payments chain where gas is paid in dollars.",
    native:
      "A monthly plan is a PlanDesk plan plus a Tempo access key: the key may spend 25 AlphaUSD a month on two calls only, and every run's price is capped on chain at the minimum share count you signed.",
    tier: "feature",
  },
  sepolia: {
    name: "Ethereum",
    why: "xStocks and Ondo issue their EVM stock tokens on Ethereum mainnet.",
    native: "The same immutable vault and cash desk on Sepolia, holding labeled mirrors until an issuer ships a testnet.",
    tier: "portable",
  },
  arbitrumSepolia: {
    name: "Arbitrum",
    why: "Robinhood Chain is an Arbitrum Orbit chain, and Robinhood's EU stock tokens trade on Arbitrum One.",
    native: "The same immutable vault and cash desk on Arbitrum Sepolia, holding labeled mirrors.",
    tier: "portable",
  },
  baseSepolia: {
    name: "Base",
    why: "Dinari issues stock tokens on Base, and Coinbase brings the users.",
    native: "The same immutable vault and cash desk on Base Sepolia, holding labeled mirrors.",
    tier: "portable",
  },
  hyperEvmTestnet: {
    name: "Hyperliquid",
    why: "Stock perpetuals trade on HyperCore around the clock.",
    native: "HyperEVM reads HyperCore's stock-perp oracle through a precompile, so a basket can be priced when every stock market is shut.",
    tier: "next",
  },
};

const ORDER = ["robinhoodTestnet", "tempoTestnet", "sepolia", "arbitrumSepolia", "baseSepolia", "hyperEvmTestnet"];

const ALL = DEPLOYMENTS as readonly Deployment[];

export const EVM_CHAINS: ChainCard[] = ORDER.map((key) => {
  const deployment = ALL.find((d) => d.network === key);
  const note = NOTES[key];
  // A chain with no deployment can never be shown as live, whatever the notes say.
  return { key, ...note, tier: deployment ? note.tier : "next", deployment };
});

export const DEPLOYED = EVM_CHAINS.filter((c) => c.deployment);
export const NEXT = EVM_CHAINS.filter((c) => !c.deployment);

export function chainCard(network: string): ChainCard | undefined {
  return EVM_CHAINS.find((c) => c.key === network);
}

export function findBasket(
  network: string,
  symbolOrAddress: string,
): { chain: ChainCard; deployment: Deployment; basket: ChainBasket } | null {
  const chain = chainCard(network);
  const deployment = chain?.deployment;
  if (!chain || !deployment) return null;
  const key = symbolOrAddress.toLowerCase();
  const basket = deployment.baskets.find((b) => b.symbol.toLowerCase() === key || b.address.toLowerCase() === key);
  return basket ? { chain, deployment, basket } : null;
}

/** The path of one EVM basket's page. Symbols are unique per chain. */
export function basketHref(network: string, symbol: string): string {
  return `/chains/${network}/${symbol.toLowerCase()}`;
}

export function explorerTxUrl(d: Pick<Deployment, "explorer">, hash: string): string {
  return `${d.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(d: Pick<Deployment, "explorer">, address: string): string {
  return `${d.explorer}/address/${address}`;
}
