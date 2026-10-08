"use client";

import Link from "next/link";
import { useBasket } from "@/lib/use-baskets";
import { useOnChainBasket, valueBasket } from "@/lib/basket-view";
import { useMarket } from "./market-provider";
import { BasketMosaic } from "./basket-mosaic";
import { Ticker } from "./ticker";
import { money, percent, quantity, shortAddress } from "@/lib/format";

/** The basket taken apart on the home page: The Big Five, the oldest one with holders. */
const ANATOMY = "6cUCq5GdhrdLGqJiy63iuc1epLFrEmAYQ45JvYEYGbg3";

/**
 * One share, taken apart. The recipe's raw units, the live price and multiplier
 * behind each, what that comes to, and whether the vault holds it: every figure
 * read from mainnet and devnet on this load, none of them written down.
 */
export function Anatomy() {
  const { basket, state } = useBasket(ANATOMY);
  const { snapshot } = useMarket();
  const { onChain } = useOnChainBasket(basket);

  if (state === "missing" || state === "error") return null;
  if (!basket) return <div className="skeleton h-[420px] border border-line" />;

  const v = valueBasket(basket, snapshot);
  const tiles = v.components.map((c) => ({
    key: c.mint,
    label: c.base,
    sub: c.company,
    weightBps: c.actualWeightBps ?? c.targetWeightBps,
    slot: c.slot,
  }));
  const coverage = onChain ? Math.min(...onChain.vaults.map((r) => r.coverage)) : null;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
      <div>
        <h2 className="display text-title max-w-[22ch] text-ink">One share, taken apart.</h2>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-ink-2">
          A share of {basket.name} is not a price. It is {v.components.length} exact quantities of
          tokens, written into the recipe once and sitting in a vault anyone can read. What it is
          worth follows from what those tokens are worth right now.
        </p>
        <div className="mt-8">
          <BasketMosaic tiles={tiles} height={300} />
        </div>
        <p className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-3">
          <span>
            ${basket.symbol} · {v.components.length} components · by {shortAddress(basket.creator)}
          </span>
          <Link href={`/basket/${basket.address}`} className="text-bind underline decoration-bind/40 underline-offset-4 hover:decoration-bind">
            Open the basket
          </Link>
        </p>
      </div>

      <div className="self-center">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-3">
              <th className="pb-3 font-normal">In one share</th>
              <th className="pb-3 text-right font-normal">Tokens</th>
              <th className="hidden pb-3 text-right font-normal sm:table-cell">Price × multiplier</th>
              <th className="pb-3 text-right font-normal">Worth</th>
              <th className="pb-3 text-right font-normal">Weight now</th>
            </tr>
          </thead>
          <tbody>
            {v.components.map((c) => (
              <tr key={c.mint} className="border-t border-line">
                <td className="py-3 pr-3">
                  <span className="text-ink">{c.base}</span>
                  <span className="block text-xs text-ink-3">{c.company}</span>
                </td>
                <td className="tnum py-3 text-right text-ink">{quantity(c.tokensPerShare, 4)}</td>
                <td className="tnum hidden py-3 text-right text-ink-2 sm:table-cell">
                  {c.quote ? (
                    <>
                      {money(c.quote.price)}
                      {c.quote.paysDividend && <span className="text-ink-3"> × {c.quote.multiplier.toFixed(4)}</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="tnum py-3 text-right text-ink">
                  <Ticker value={money(c.value)} />
                </td>
                <td className="tnum py-3 text-right text-ink-2">
                  {percent((c.actualWeightBps ?? c.targetWeightBps) / 100, 1)}
                  <span className="block text-xs text-ink-3">set {percent(c.targetWeightBps / 100, 1)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong">
              <td className="pt-4 text-ink" colSpan={3}>
                One share, at live prices
              </td>
              <td className="tnum display pt-4 text-right text-xl text-ink" colSpan={2}>
                <Ticker value={money(v.nav)} />
              </td>
            </tr>
          </tfoot>
        </table>

        <dl className="mt-7 grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
          <div className="bg-surface p-4">
            <dt className="text-xs text-ink-3">Shares outstanding</dt>
            <dd className="tnum display mt-1 text-xl text-ink">{onChain ? quantity(onChain.shares, 2) : "—"}</dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="text-xs text-ink-3">Vault covers the shares</dt>
            <dd className="tnum display mt-1 text-xl" style={{ color: coverage != null && coverage >= 1 ? "var(--color-gain)" : "var(--color-ink)" }}>
              {coverage == null ? "—" : `${(coverage * 100).toFixed(2)}%`}
            </dd>
          </div>
          <div className="bg-surface p-4">
            <dt className="text-xs text-ink-3">Dividends already inside</dt>
            <dd className="tnum display mt-1 text-xl text-ink">{v.accruedSharePct == null ? "—" : percent(v.accruedSharePct, 2)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          Coverage is the vault&rsquo;s balance of each token over what the outstanding shares claim, read from the token accounts on this load. Rounding
          favours holders, so it can only ever be at or above 100%.
        </p>
      </div>
    </div>
  );
}
