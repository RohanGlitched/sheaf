"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useBaskets } from "@/lib/use-baskets";
import { useMarket } from "./market-provider";
import { valueBasket } from "@/lib/basket-view";
import { BasketCard } from "./basket-card";
import { useOpenLaunches } from "@/lib/use-launches";
import { count, money } from "@/lib/format";
import { useHistory } from "@/lib/use-history";
import { trackRecord } from "@/lib/track";
import { CardSkeletons } from "./skeletons";

/**
 * Every basket, in an order the visitor chooses.
 *
 * There is no curation and no ranking algorithm here on purpose: the list is
 * literally what `getProgramAccounts` returns, and the only editorial act is the
 * sort key, which the visitor picks.
 */

type SortKey = "newest" | "value" | "activity" | "components" | "year";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "activity", label: "Most traded" },
  { key: "year", label: "Best past year" },
  { key: "newest", label: "Newest" },
  { key: "value", label: "Most valuable share" },
  { key: "components", label: "Most holdings" },
];

export function Explorer() {
  const { baskets, error, loading } = useBaskets();
  const launched = useOpenLaunches(baskets);
  const { snapshot } = useMarket();
  const { history } = useHistory();
  const [sort, setSort] = useState<SortKey>("activity");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    if (!baskets) return [];
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? baskets.filter(
          (b) =>
            b.name.toLowerCase().includes(needle) ||
            b.symbol.toLowerCase().includes(needle) ||
            b.creator.toLowerCase().startsWith(needle),
        )
      : baskets.slice();

    const navOf = (address: string) =>
      valueBasket(
        baskets.find((b) => b.address === address)!,
        snapshot,
      ).nav ?? 0;

    const yearOf = (address: string) => {
      const v = valueBasket(baskets.find((b) => b.address === address)!, snapshot);
      const track = trackRecord(
        v.components.map((c) => ({ base: c.base, valueNow: c.value ?? 0 })),
        history,
        "1y",
      );
      return track?.returnPct ?? -Infinity;
    };

    switch (sort) {
      case "value":
        return filtered.sort((a, b) => navOf(b.address) - navOf(a.address));
      case "year":
        return filtered.sort((a, b) => yearOf(b.address) - yearOf(a.address));
      case "activity":
        return filtered.sort(
          (a, b) =>
            Number(b.mintCount + b.redeemCount) -
            Number(a.mintCount + a.redeemCount),
        );
      case "components":
        return filtered.sort(
          (a, b) => b.components.length - a.components.length,
        );
      default:
        return filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
  }, [baskets, snapshot, history, sort, query]);

  const totalValue = useMemo(
    () =>
      (baskets ?? []).reduce(
        (sum, b) => sum + (valueBasket(b, snapshot).nav ?? 0),
        0,
      ),
    [baskets, snapshot],
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="display text-hero leading-[0.95] text-ink">
            Every basket
          </h1>
          <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-ink-2">
            Read straight from the program. Nothing here is listed,
            approved, or promoted. If somebody created it, it is on this page.
          </p>
        </div>
        {baskets && baskets.length > 0 && (
          <dl className="tnum flex gap-8 text-sm">
            <div>
              <dt className="text-xs text-ink-3">Baskets</dt>
              <dd className="display mt-1 text-xl text-ink">
                {count(baskets.length)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Combined share price</dt>
              <dd className="display mt-1 text-xl text-ink">
                {money(totalValue)}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {baskets && baskets.length > 0 && (
        <div className="mt-10 flex flex-wrap items-center gap-3 border-y border-line py-4">
          <label className="flex-1 min-w-[14rem]">
            <span className="sr-only">Search baskets</span>
            <input
              type="search"
              value={query}
              placeholder="Search by name, ticker, or creator"
              onChange={(event) => setQuery(event.target.value)}
              className="w-full border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none focus-visible:border-bind"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {SORTS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSort(option.key)}
                aria-pressed={sort === option.key}
                className="border px-3 py-2.5 text-xs transition-colors"
                style={{
                  borderColor:
                    sort === option.key
                      ? "var(--color-bind)"
                      : "var(--color-line)",
                  color:
                    sort === option.key
                      ? "var(--color-bind)"
                      : "var(--color-ink-2)",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && <CardSkeletons count={6} />}

      {error && (
        <p className="mt-12 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
          {error}
        </p>
      )}

      {baskets && baskets.length === 0 && (
        <div className="mt-12 border border-dashed border-line-strong/60 px-8 py-16 text-center">
          <p className="display text-xl text-ink">The program is empty.</p>
          <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            No baskets exist on this cluster yet. Creating one takes a
            single transaction.
          </p>
          <Link
            href="/compose"
            className="mt-7 inline-block border border-bind bg-bind px-5 py-3 text-sm text-page transition-colors hover:bg-bind-deep"
          >
            Create the first one
          </Link>
        </div>
      )}

      {baskets && baskets.length > 0 && rows.length === 0 && (
        <p className="mt-12 text-sm leading-relaxed text-ink-2">
          Nothing matches “{query.trim()}”. Clear the search to see all{" "}
          {count(baskets.length)}.
        </p>
      )}

      {rows.length > 0 && (
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <h2 className="sr-only">Baskets</h2>
          {rows.map((basket) => (
            <BasketCard key={basket.address} basket={basket} launched={launched.has(basket.address)} />
          ))}
        </div>
      )}
    </div>
  );
}
