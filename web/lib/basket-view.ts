"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { decodeBasket, tokenAccount, type Basket } from "./sheaf";
import { stockForWriteMint, symbolForWriteMint } from "./mirror";
import type { MarketSnapshot, Quote } from "./market";
import { ONE_SHARE } from "./config";

/**
 * What the chain says about a basket, as opposed to what its recipe says.
 *
 * Two numbers matter and both are read rather than computed: how many shares are
 * outstanding, and how much of each component the vault is actually holding. The
 * second divided by the recipe is the coverage, and the program's rounding rules
 * mean it can only ever be at or above 1. Showing it turns that guarantee from a
 * claim in a README into something a visitor can watch.
 */

export type VaultRow = {
  mint: string;
  /** Raw units the vault holds. */
  held: bigint;
  /**
   * Raw units the outstanding shares claim, plus the protocol-fee shares the
   * basket has accrued but not yet minted to the treasury: the program backs
   * `supply + protocol_fee_accrued`, so those units are owed, not surplus.
   */
  owed: bigint;
  /** held / owed. At least 1 if the program is behaving. */
  coverage: number;
};

export type OnChainBasket = {
  /** Raw share units in existence. */
  supply: bigint;
  /** Whole shares. */
  shares: number;
  /** Protocol-fee shares created and backed but not yet claimed (raw units). */
  feeAccrued: bigint;
  vaults: VaultRow[];
  /** True when every vault covers what the shares claim. */
  fullyBacked: boolean;
  /** Raw units the vault holds beyond what is claimed, per component. */
  surplus: bigint[];
};

const AMOUNT_OFFSET = 64; // SPL token account: mint(32) owner(32) amount(8)
const SUPPLY_OFFSET = 36; // Mint: mint_authority COption(36) supply(8)

function readU64(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

export function useOnChainBasket(basket: Basket | null) {
  const { connection } = useConnection();
  const [data, setData] = useState<OnChainBasket | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!basket) return;
    try {
      const basketKey = new PublicKey(basket.address);
      const tokenProgram = new PublicKey(basket.tokenProgram);
      // The basket account itself comes first, read fresh: its accrued
      // protocol fee changes with every creation and every claim.
      const keys = [
        basketKey,
        new PublicKey(basket.shareMint),
        ...basket.components.map((c) =>
          tokenAccount(new PublicKey(c.mint), basketKey, tokenProgram),
        ),
      ];
      const infos = await connection.getMultipleAccountsInfo(keys);

      const fresh = infos[0] ? decodeBasket(basketKey, new Uint8Array(infos[0].data)) : null;
      const feeAccrued = fresh?.protocolFeeAccrued ?? basket.protocolFeeAccrued ?? 0n;
      const mintInfo = infos[1];
      const supply = mintInfo
        ? readU64(new Uint8Array(mintInfo.data), SUPPLY_OFFSET)
        : 0n;

      const vaults: VaultRow[] = basket.components.map((component, i) => {
        const info = infos[i + 2];
        const held = info ? readU64(new Uint8Array(info.data), AMOUNT_OFFSET) : 0n;
        // Rounded up, as a redemption of every outstanding claim would need.
        const claimed = component.unitsPerShare * (supply + feeAccrued);
        const owed = (claimed + BigInt(ONE_SHARE) - 1n) / BigInt(ONE_SHARE);
        return {
          mint: component.mint,
          held,
          owed,
          coverage: owed === 0n ? 1 : Number(held) / Number(owed),
        };
      });

      setData({
        supply,
        shares: Number(supply) / ONE_SHARE,
        feeAccrued,
        vaults,
        fullyBacked: vaults.every((v) => v.held >= v.owed),
        surplus: vaults.map((v) => (v.held > v.owed ? v.held - v.owed : 0n)),
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "read failed");
    }
  }, [connection, basket]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { onChain: data, error, reload: load };
}

// ------------------------------------------------------------------- valuation

export type ComponentView = {
  mint: string;
  symbol: string;
  base: string;
  company: string;
  decimals: number;
  unitsPerShare: bigint;
  /** Whole tokens of this component behind one share. */
  tokensPerShare: number;
  /** Weight the creator set at creation. */
  targetWeightBps: number;
  quote: Quote | undefined;
  /** Dollar value of this component inside one share. */
  value: number | null;
  /** Its weight right now, which drifts from the target as prices move. */
  actualWeightBps: number | null;
  slot: number;
};

export type BasketValuation = {
  components: ComponentView[];
  /** What one share is worth from live component prices. */
  nav: number | null;
  /** What one share would be worth valuing components at the listed share price. */
  navAtSharePrices: number | null;
  /**
   * How far the components trade from the shares behind them, weighted. Positive
   * means the basket's tokens are collectively at a premium.
   */
  premiumBps: number | null;
  /** Weighted 24-hour move. */
  change24h: number | null;
  /** Share of the basket's value that is dividends already collected on chain. */
  accruedSharePct: number | null;
  /** Components whose price could not be read. */
  unpriced: string[];
};

/**
 * Value a basket from live mainnet prices.
 *
 * The components on chain are mirror mints on the write cluster, so each one is
 * translated back to its mainnet ticker before a price is looked up. A component
 * with no mirror is reported rather than skipped: a basket valued from half its
 * holdings would be worse than no number at all.
 */
export function valueBasket(
  basket: Basket,
  snapshot: MarketSnapshot | null,
): BasketValuation {
  const bySymbol = new Map((snapshot?.quotes ?? []).map((q) => [q.symbol, q]));

  const components: ComponentView[] = basket.components.map((component, index) => {
    const stock = stockForWriteMint(component.mint);
    const symbol = symbolForWriteMint(component.mint) ?? component.mint.slice(0, 6);
    const quote = stock ? bySymbol.get(stock.symbol) : undefined;

    const tokensPerShare =
      Number(component.unitsPerShare) / 10 ** component.decimals;
    const value = quote
      ? (Number(component.unitsPerShare) * quote.price * quote.multiplier) /
        10 ** component.decimals
      : null;

    return {
      mint: component.mint,
      symbol: stock?.symbol ?? symbol,
      base: stock?.base ?? symbol,
      company: stock?.company ?? "Unknown mint",
      decimals: component.decimals,
      unitsPerShare: component.unitsPerShare,
      tokensPerShare,
      targetWeightBps: component.weightBps,
      quote,
      value,
      actualWeightBps: null,
      slot: index,
    };
  });

  const unpriced = components.filter((c) => c.value == null).map((c) => c.base);
  const nav = unpriced.length
    ? null
    : components.reduce((a, c) => a + (c.value ?? 0), 0);

  if (nav && nav > 0) {
    for (const c of components) {
      c.actualWeightBps = ((c.value ?? 0) / nav) * 10_000;
    }
  }

  const navAtSharePrices = components.every((c) => c.quote?.sharePrice != null)
    ? components.reduce(
        (a, c) =>
          a +
          (Number(c.unitsPerShare) * c.quote!.sharePrice! * c.quote!.multiplier) /
            10 ** c.decimals,
        0,
      )
    : null;

  const premiumBps =
    nav != null && navAtSharePrices != null && navAtSharePrices > 0
      ? ((nav - navAtSharePrices) / navAtSharePrices) * 10_000
      : null;

  const change24h =
    nav && nav > 0 && components.every((c) => c.quote?.change24h != null)
      ? components.reduce(
          (a, c) => a + (c.quote!.change24h! * (c.value ?? 0)) / nav,
          0,
        )
      : null;

  const accruedSharePct =
    nav && nav > 0
      ? (components.reduce(
          (a, c) =>
            a +
            (c.quote?.paysDividend
              ? (c.value ?? 0) * (1 - 1 / c.quote.multiplier)
              : 0),
          0,
        ) /
          nav) *
        100
      : null;

  return {
    components,
    nav,
    navAtSharePrices,
    premiumBps,
    change24h,
    accruedSharePct,
    unpriced,
  };
}
