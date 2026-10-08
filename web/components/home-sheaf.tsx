"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useBaskets } from "@/lib/use-baskets";
import { valueBasket, useOnChainBasket } from "@/lib/basket-view";
import { slotColor } from "@/lib/palette";
import { signedPercent, money } from "@/lib/format";
import { useMarket } from "./market-provider";
import { SheafMark, type Stalk } from "./sheaf-mark";

/** The basket the hero draws, when it can be read; otherwise the first one. */
const HERO_BASKET = "5Z8XUzGVJjcYPxPZ6Hfxx8uJRNKibFcmZd7yStuSPr1p";

/** Drawn while the chain is being read, so the hero is never empty. */
const PLACEHOLDER: Stalk[] = [
  { key: "a", weight: 0.3, color: slotColor(0) },
  { key: "b", weight: 0.22, color: slotColor(1) },
  { key: "c", weight: 0.18, color: slotColor(2) },
  { key: "d", weight: 0.15, color: slotColor(3) },
  { key: "e", weight: 0.1, color: slotColor(4) },
  { key: "f", weight: 0.05, color: slotColor(5) },
];

export function HomeSheaf() {
  const { baskets } = useBaskets();
  const { snapshot } = useMarket();
  const basket = useMemo(
    () => baskets?.find((b) => b.address === HERO_BASKET) ?? baskets?.[0] ?? null,
    [baskets],
  );
  const valuation = useMemo(() => (basket ? valueBasket(basket, snapshot) : null), [basket, snapshot]);
  const { onChain } = useOnChainBasket(basket);

  const stalks: Stalk[] | null = useMemo(() => {
    if (!valuation) return null;
    return valuation.components.map((c) => {
      const move = c.quote?.change24h ?? null;
      return {
        key: c.mint,
        weight: (c.actualWeightBps ?? c.targetWeightBps) / 10_000,
        color: slotColor(c.slot),
        label: c.base,
        sub: move == null ? undefined : signedPercent(move),
        subTone: move == null ? "flat" : move > 0.05 ? "gain" : move < -0.05 ? "loss" : "flat",
      };
    });
  }, [valuation]);

  const coverage = onChain
    ? Math.min(...onChain.vaults.map((v) => (v.owed === 0n ? 1 : v.coverage)))
    : null;
  const bandNote =
    coverage == null ? "one share" : `${(Math.min(coverage, 9.999) * 100).toFixed(1)}% backed`;

  return (
    <figure className="relative">
      <SheafMark
        stalks={stalks ?? PLACEHOLDER}
        labels={stalks != null}
        animate
        bandNote={stalks ? bandNote : undefined}
        className="mx-auto w-full max-w-[560px]"
        title={basket ? `${basket.name}: ${stalks?.length ?? 0} tokenized stocks bound into one share` : "A basket of tokenized stocks bound into one share"}
      />
      {basket && valuation && (
        <figcaption className="mx-auto mt-2 flex max-w-[560px] flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
          <Link href={`/basket/${basket.address}`} className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-bind">
            {basket.name}
          </Link>
          <span className="tnum text-ink-2">
            {valuation.nav != null ? `${money(valuation.nav)} a share` : "Pricing"}
            {valuation.change24h != null && (
              <span className={valuation.change24h >= 0 ? "text-gain" : "text-loss"}>
                {"  "}
                {signedPercent(valuation.change24h)} today
              </span>
            )}
          </span>
        </figcaption>
      )}
    </figure>
  );
}
