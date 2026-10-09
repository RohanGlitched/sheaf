"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { ONE_SHARE } from "@/lib/config";
import { useBaskets } from "@/lib/use-baskets";
import { useMarket } from "./market-provider";
import { valueBasket } from "@/lib/basket-view";
import { BasketCard } from "./basket-card";
import { useOpenLaunches } from "@/lib/use-launches";
import { count, money } from "@/lib/format";
import { useHistory } from "@/lib/use-history";
import { trackRecord } from "@/lib/track";
import { CardSkeletons } from "./skeletons";
import { isTestBasket } from "@/lib/hidden";
import { useLedger, walletCounts } from "./ledger";

/**
 * Every basket, in an order the visitor chooses.
 *
 * There is no curation and no ranking algorithm here on purpose: the list is
 * what `getProgramAccounts` returns, sorted by a key the visitor picks. The one
 * editorial act is that baskets our own QA runs made start hidden, behind a
 * switch that shows them (lib/hidden.ts).
 */

type SortKey = "held" | "newest" | "value" | "activity" | "components" | "year";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "held", label: "Most held" },
  { key: "activity", label: "Most traded" },
  { key: "year", label: "Best past year" },
  { key: "newest", label: "Newest" },
  { key: "value", label: "Most valuable share" },
  { key: "components", label: "Most holdings" },
];

/** Share supply per basket, read in one call for every share mint. */
function useSupplies(shareMints: string[]) {
  const { connection } = useConnection();
  const key = shareMints.join(",");
  const [supplies, setSupplies] = useState<{ key: string; byMint: Map<string, number> } | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    const mints = key.split(",");
    connection
      .getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)))
      .then((infos) => {
        if (!live) return;
        const byMint = new Map<string, number>();
        infos.forEach((info, i) => {
          if (!info) return;
          const data = new Uint8Array(info.data);
          // Mint layout: mint_authority COption (36 bytes), then supply as a u64.
          const supply = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(36, true);
          byMint.set(mints[i], Number(supply) / ONE_SHARE);
        });
        setSupplies({ key, byMint });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connection, key]);

  return supplies?.key === key ? supplies.byMint : null;
}

export function Explorer() {
  const { baskets, error, loading } = useBaskets();
  const shareMints = useMemo(() => (baskets ?? []).map((b) => b.shareMint), [baskets]);
  const supplies = useSupplies(shareMints);
  const launched = useOpenLaunches(baskets);
  const { snapshot } = useMarket();
  const { history } = useHistory();
  const [sort, setSort] = useState<SortKey>("held");
  const [query, setQuery] = useState("");
  const [showTests, setShowTests] = useState(false);
  const { ledger, decoding } = useLedger();
  const traction = useMemo(() => (ledger ? walletCounts(ledger.entries) : null), [ledger]);
  const testCount = useMemo(() => (baskets ?? []).filter(isTestBasket).length, [baskets]);

  const rows = useMemo(() => {
    if (!baskets) return [];
    const needle = query.trim().toLowerCase();
    const visible = showTests ? baskets : baskets.filter((b) => !isTestBasket(b));
    const filtered = needle
      ? visible.filter(
          (b) =>
            b.name.toLowerCase().includes(needle) ||
            b.symbol.toLowerCase().includes(needle) ||
            b.creator.toLowerCase().startsWith(needle),
        )
      : visible.slice();
    const heldOf = (shareMint: string) => supplies?.get(shareMint) ?? 0;

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
      case "held":
        // Shares outstanding, most first; newest breaks a tie (and orders the list until supplies arrive).
        return filtered.sort((a, b) => heldOf(b.shareMint) - heldOf(a.shareMint) || b.createdAt - a.createdAt);
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
  }, [baskets, snapshot, history, sort, query, showTests, supplies]);

  // What every vault holds, at live prices: each share's value times the shares
  // outstanding. Adding up one share of each would be a number with no meaning.
  const heldInVaults = useMemo(() => {
    if (!baskets || !supplies) return null;
    return baskets.reduce(
      (sum, b) => sum + (valueBasket(b, snapshot).nav ?? 0) * (supplies.get(b.shareMint) ?? 0),
      0,
    );
  }, [baskets, snapshot, supplies]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="display text-hero leading-[0.95] text-ink">
            Every basket
          </h1>
          <p className="mt-4 max-w-[54ch] text-base leading-relaxed text-ink-2">
            Read straight from the program. Nothing here is listed,
            approved, or promoted. If somebody created it, it is on this page;
            the few our own QA runs made are behind the switch below.
          </p>
        </div>
        {baskets && baskets.length > 0 && (
          <dl className="tnum flex flex-wrap gap-x-8 gap-y-4 text-sm">
            <div>
              <dt className="text-xs text-ink-3">Baskets</dt>
              <dd className="display mt-1 text-xl text-ink">
                {count(baskets.length)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Held in vaults</dt>
              <dd className="display mt-1 text-xl text-ink">
                {heldInVaults == null ? "…" : money(heldInVaults)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Actions</dt>
              <dd className="display mt-1 text-xl text-ink">
                {traction ? count(traction.actions) : "…"}
              </dd>
            </div>
            {/* The ledger states the count either way; here it shows once someone outside the team has acted. */}
            {traction && traction.outside > 0 && (
            <div>
              <dt className="text-xs text-ink-3">
                <Link href="/ledger" className="underline decoration-line-strong underline-offset-4 hover:text-ink-2">
                  Wallets that aren&rsquo;t ours
                </Link>
              </dt>
              <dd className="display mt-1 text-xl text-ink">
                {decoding ? "…" : count(traction.outside)}
              </dd>
            </div>
            )}
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
              className="w-full border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none focus-visible:border-bind rounded-[var(--radius-control)]"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {testCount > 0 && (
              <label className="flex cursor-pointer items-center gap-2 border border-line px-3 py-2 text-xs text-ink-2 rounded-[var(--radius-control)]">
                <input
                  type="checkbox"
                  checked={showTests}
                  onChange={(event) => setShowTests(event.target.checked)}
                  className="accent-[var(--color-bind)]"
                />
                Show test baskets ({count(testCount)})
              </label>
            )}
            {SORTS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSort(option.key)}
                aria-pressed={sort === option.key}
                className="border px-3 py-2.5 text-xs transition-colors rounded-[var(--radius-control)]"
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
        <div className="mt-12 rounded-[var(--radius-panel)] border border-dashed border-line-strong/60 px-8 py-16 text-center">
          <p className="display text-xl text-ink">The program is empty.</p>
          <p className="mx-auto mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-2">
            No baskets exist on this cluster yet. Creating one takes a
            single transaction.
          </p>
          <Link
            href="/compose"
            className="mt-7 inline-block bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep rounded-[var(--radius-control)]"
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
