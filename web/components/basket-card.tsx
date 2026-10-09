"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { Basket } from "@/lib/sheaf";
import { valueBasket } from "@/lib/basket-view";
import { PRESTOCK_SYMBOLS } from "@/lib/prestocks";
import { useMarket } from "./market-provider";
import { BasketMosaic } from "./basket-mosaic";
import { money, signedPercent, percent, count, shortAddress } from "@/lib/format";
import { CardTrack } from "./track-record";

/** Bar rows a card can show before the list is cut off (at the taller card height below). */
const CARD_ROWS = 6;

export function BasketCard({ basket, launched = false }: { basket: Basket; launched?: boolean }) {
  const { snapshot } = useMarket();
  const valuation = useMemo(
    () => valueBasket(basket, snapshot),
    [basket, snapshot],
  );

  // The card's bar list has room for six rows. A bigger basket shows its five
  // heaviest holdings and folds the rest into one "+N more" row, so no holding
  // silently disappears off the bottom of the card.
  const tiles = useMemo(() => {
    const all = valuation.components
      .map((c) => ({
        key: c.mint,
        label: c.base,
        weightBps: c.actualWeightBps ?? c.targetWeightBps,
        slot: c.slot,
      }))
      .sort((a, b) => b.weightBps - a.weightBps);
    if (all.length <= CARD_ROWS) return all;
    const shown = all.slice(0, CARD_ROWS - 1);
    const rest = all.slice(CARD_ROWS - 1);
    return [
      ...shown,
      {
        key: "rest",
        label: `+${rest.length} more`,
        weightBps: rest.reduce((sum, t) => sum + t.weightBps, 0),
        slot: rest[0].slot,
      },
    ];
  }, [valuation]);

  const hasPreStocks = valuation.components.some((c) =>
    PRESTOCK_SYMBOLS.has(c.symbol),
  );

  const trackComponents = useMemo(
    () => valuation.components.map((c) => ({ base: c.base, valueNow: c.value ?? 0 })),
    [valuation],
  );

  return (
    <Link
      href={`/basket/${basket.address}`}
      className="group lift block overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface hover:border-line-strong"
    >
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <h3 className="display truncate text-lg text-ink">{basket.name}</h3>
          <p className="tnum mt-0.5 text-xs text-ink-3">
            {basket.symbol} · {basket.components.length}{" "}
            {basket.components.length === 1 ? "component" : "components"} · by{" "}
            {shortAddress(basket.creator)}
          </p>
          {(hasPreStocks || launched) && (
            <p className="mt-1.5 flex gap-2 text-xs">
              {hasPreStocks && (
                <span className="text-ink-3">Includes PreStocks</span>
              )}
              {launched && <span className="text-bind">Launch market live</span>}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="tnum display text-lg text-ink">
            {money(valuation.nav)}
          </p>
          <p
            className="tnum text-xs"
            style={{
              color:
                valuation.change24h == null
                  ? "var(--color-ink-3)"
                  : valuation.change24h > 0
                    ? "var(--color-gain)"
                    : "var(--color-loss)",
            }}
          >
            {signedPercent(valuation.change24h)}
          </p>
        </div>
      </div>

      <div className="mt-4 px-5">
        <BasketMosaic tiles={tiles} height={tiles.length > 4 ? 164 : 132} />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line px-5 py-4 text-xs">
        <div>
          <dt className="text-ink-3">Past year</dt>
          <dd className="tnum mt-0.5 text-ink-2">
            {valuation.nav != null ? <CardTrack components={trackComponents} /> : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Creations</dt>
          <dd className="tnum mt-0.5 text-ink-2">
            {count(Number(basket.mintCount))}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Dividends inside</dt>
          <dd className="tnum mt-0.5">
            {valuation.accruedSharePct && valuation.accruedSharePct > 0.005 ? (
              <span className="text-bind">
                {percent(valuation.accruedSharePct)}
              </span>
            ) : (
              <span className="text-ink-3">none yet</span>
            )}
          </dd>
        </div>
      </dl>
    </Link>
  );
}
