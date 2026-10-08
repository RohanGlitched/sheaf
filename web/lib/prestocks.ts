/**
 * PreStocks: tokenized SPV exposure to pre-IPO companies, on Solana mainnet.
 *
 * Same shape of problem xStocks solve for public equities, one step earlier:
 * these trade today, at real mint addresses, with real Jupiter liquidity, and
 * nobody can package a themed basket of them without an entity. Unlike every
 * xStock, several of these mints also carry `TransferFeeConfig` — a fee taken
 * out of every transfer at the token-program level, which a naive in-kind
 * recipe would silently under-back against. Sheaf's mint path grosses up
 * for it; see `gross_for_transfer_fee` in the program.
 *
 * Mint addresses and live fee bps read from https://prestocks.com/api/prestocks
 * and each mint's on-chain TransferFeeConfig extension, 2026-09-18.
 */

import type { XStock } from "./universe";

export type PreStock = {
  symbol: string;
  company: string;
  /** Token-2022 mint on Solana mainnet. */
  mint: string;
  decimals: number;
  /** Live transfer-fee basis points on the mint, or null if it carries none. */
  transferFeeBps: number | null;
  hue: string;
};

export const PRESTOCKS: PreStock[] = [
  {
    symbol: "ANDURIL",
    company: "Anduril",
    mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#6B4A9E",
  },
  {
    symbol: "ANTHROPIC",
    company: "Anthropic",
    mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#D08A3E",
  },
  {
    symbol: "FIGUREAI",
    company: "Figure AI",
    mint: "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#3E7DD0",
  },
  {
    symbol: "KALSHI",
    company: "Kalshi",
    mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#4F9E5C",
  },
  {
    symbol: "NEURALINK",
    company: "Neuralink",
    mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#C94F6B",
  },
  {
    symbol: "OPENAI",
    company: "OpenAI",
    mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#2E9E8F",
  },
  {
    symbol: "POLYMARKET",
    company: "Polymarket",
    mint: "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#9E7A3E",
  },
  {
    symbol: "SPACEX",
    company: "SpaceX",
    mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    decimals: 9,
    transferFeeBps: 50,
    hue: "#5C6B9E",
  },
];

export const BY_SYMBOL_PRESTOCKS: Record<string, PreStock> = Object.fromEntries(
  PRESTOCKS.map((s) => [s.symbol, s]),
);

export const BY_MINT_PRESTOCKS: Record<string, PreStock> = Object.fromEntries(
  PRESTOCKS.map((s) => [s.mint, s]),
);

/** Cheap membership check, so any component elsewhere in the app can tell a
 *  PreStocks pre-IPO token from an xStock without importing the full list. */
export const PRESTOCK_SYMBOLS: Set<string> = new Set(PRESTOCKS.map((s) => s.symbol));

/**
 * A PreStock, in the shape the rest of the app already knows how to price and
 * display. There is no real listed share behind these, so the feed and
 * schedule fields are honestly null rather than borrowed from something else.
 */
export function asXStock(p: PreStock): XStock {
  return {
    symbol: p.symbol,
    base: p.symbol,
    company: p.company,
    mint: p.mint,
    decimals: p.decimals,
    equityFeedId: null,
    redemptionFeedId: null,
    tokenizedFeedId: null,
    schedule: null,
    hue: p.hue,
  };
}
