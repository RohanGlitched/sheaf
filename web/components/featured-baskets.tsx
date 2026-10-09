"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useBaskets } from "@/lib/use-baskets";
import { BasketCard } from "./basket-card";
import { useOpenLaunches } from "@/lib/use-launches";
import { CardSkeletons } from "./skeletons";
import { isTestBasket } from "@/lib/hidden";

/** Shown first, in this order; any other basket only fills a gap if one cannot be read. */
const FEATURED = [
  // The Big Five leads: listed megacaps, with a year of history and dividends inside.
  "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ",
  // Bitcoin, by proxy: its launch market is on the current curve (sheaf-nav-shelf-v2).
  "FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8",
  "EjoW8Gy9tJTctrtWcUJtkUiee5t9RFeCB3nbamutvghE",
  "6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv",
];

export function FeaturedBaskets() {
  const { baskets, error, loading } = useBaskets();
  const shown = useMemo(() => {
    if (!baskets) return null;
    const picked = FEATURED.map((a) => baskets.find((b) => b.address === a)).filter(
      (b): b is NonNullable<typeof b> => b != null,
    );
    const rest = baskets.filter((b) => !FEATURED.includes(b.address) && !isTestBasket(b));
    return [...picked, ...rest].slice(0, 3);
  }, [baskets]);
  const launched = useOpenLaunches(shown);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-title text-ink">Baskets on Sheaf</h2>
          <p className="mt-2 text-sm text-ink-2">
            Read straight from the program. Open one to see its vault, or create shares in it.
          </p>
        </div>
        <Link
          href="/explore"
          className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-2.5 text-sm text-ink transition-colors hover:border-ink-3"
        >
          {baskets ? `See all ${baskets.filter((b) => !isTestBasket(b)).length}` : "See all"}
        </Link>
      </div>

      {loading && <CardSkeletons />}

      {error && (
        <p className="mt-10 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
          {error}
        </p>
      )}

      {baskets && baskets.length === 0 && (
        <div className="mt-10 rounded-[var(--radius-panel)] border border-dashed border-line-strong/60 px-8 py-14 text-center">
          <p className="display text-xl text-ink">Nobody has created one yet.</p>
          <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            The program is deployed and waiting. The first basket takes one
            transaction and about four minutes.
          </p>
          <Link
            href="/compose"
            className="mt-7 inline-block bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep rounded-[var(--radius-control)]"
          >
            Create the first one
          </Link>
        </div>
      )}

      {shown && shown.length > 0 && (
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((basket) => (
            <BasketCard key={basket.address} basket={basket} launched={launched.has(basket.address)} />
          ))}
        </div>
      )}
    </div>
  );
}
