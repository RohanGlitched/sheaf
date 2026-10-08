"use client";

import { useCallback, useState } from "react";
import { Figure } from "./figure";
import { priceMint } from "@/lib/mirror";
import { money, percent } from "@/lib/format";
import type { FillCost, FillLegRequest } from "@/lib/fill-cost";
import type { ComponentView } from "@/lib/basket-view";

/** Sizes worth asking about. Impact only becomes the story at the top end. */
const SIZES = [1, 10, 100];

/**
 * The honest answer to "so I have to buy eight tokens first?"
 *
 * Creating shares in kind is what lets the program refuse to trust a price, and
 * the cost of that refusal is that somebody holding only dollars has to assemble
 * the components. Rather than claim the cost is small, this measures it: real
 * Jupiter routes on mainnet for every component, at the size you choose, with the
 * shortfall against the recipe turned into a single number in basis points.
 *
 * Nothing here is executed. It is a measurement of the route that exists today.
 */
export function FillCostPanel({
  components,
  nav,
}: {
  components: ComponentView[];
  nav: number | null;
}) {
  const [shares, setShares] = useState(1);
  const [cost, setCost] = useState<FillCost | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceable = components.every((c) => c.value != null && priceMint(c.symbol));

  const run = useCallback(
    async (size: number) => {
      setLoading(true);
      setError(null);
      try {
        const legs: FillLegRequest[] = [];
        for (const component of components) {
          const mint = priceMint(component.symbol);
          if (!mint || component.value == null) {
            throw new Error(`No mainnet route for ${component.base}.`);
          }
          legs.push({
            mint,
            base: component.base,
            units: (component.unitsPerShare * BigInt(size)).toString(),
            usd: component.value * size,
          });
        }

        const res = await fetch("/api/fill-cost", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shares: size, legs }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "The quote failed.");
        setCost(body as FillCost);
        setShares(size);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The quote failed.");
        setCost(null);
      } finally {
        setLoading(false);
      }
    },
    [components],
  );

  return (
    <section className="mt-16 border-t border-line pt-10">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="max-w-[62ch]">
          <h2 className="display text-xl text-ink">The last mile</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Creating shares means handing the vault the components themselves,
            which is what lets the program refuse to trust a price. Somebody
            holding only dollars has to buy those components first, so here is
            what that costs right now, priced through the routes that actually
            exist on mainnet.
          </p>
        </div>

        <div className="flex items-center gap-1 text-xs">
          {SIZES.map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => void run(size)}
              disabled={loading || !priceable}
              aria-pressed={cost != null && shares === size}
              className={`border px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:border-line disabled:text-ink-3/50 ${
                cost != null && shares === size
                  ? "border-bind/60 bg-bind/10 text-ink"
                  : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
              }`}
            >
              {size === 1 ? "One share" : `${size} shares`}
            </button>
          ))}
        </div>
      </div>

      {!priceable && (
        <p className="mt-7 text-sm text-ink-3">
          One component has no mainnet price, so there is nothing honest to
          quote.
        </p>
      )}

      {loading && (
        <p className="mt-7 text-sm text-ink-3">
          Routing {components.length} components through Jupiter…
        </p>
      )}

      {error && (
        <p className="mt-7 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
          {error}
        </p>
      )}

      {!loading && !error && !cost && priceable && (
        <p className="mt-7 text-sm text-ink-3">
          Pick a size to price it. Nothing is bought — this asks for a quote and
          reads the answer.
        </p>
      )}

      {cost && !loading && (
        <>
          <dl className="mt-7 grid grid-cols-1 gap-px bg-line sm:grid-cols-3">
            <Figure
              label={`Buying the components for ${shares === 1 ? "one share" : `${shares} shares`}`}
              value={money(cost.usdcIn)}
              note="USDC through the routes below"
            />
            <Figure
              label="Selling them straight back"
              value={cost.usdcBack == null ? "—" : money(cost.usdcBack)}
              note={
                cost.usdcBack == null
                  ? `no return route for ${cost.unroutable.join(", ")}`
                  : "what the same router returns, same moment"
              }
            />
            <Figure
              label="The cost of the last mile"
              value={
                cost.roundTripBps == null
                  ? "—"
                  : percent(cost.roundTripBps / 100, 2)
              }
              note={
                cost.roundTripBps == null
                  ? "not every component could be routed"
                  : cost.worstImpactPct == null
                    ? "the round trip, spread and impact both ways"
                    : `round trip. Worst single-leg impact ${percent(cost.worstImpactPct, 3)}`
              }
              tone={
                cost.roundTripBps != null && cost.roundTripBps > 100
                  ? "loss"
                  : "gold"
              }
            />
          </dl>

          {/* Six columns of numbers will not fit a phone, so this one scrolls
              sideways. `min-w-0` keeps the scrolling inside the box. */}
          <div className="mt-6 min-w-0 overflow-x-auto border border-line">
            <table className="w-full border-collapse text-sm sm:min-w-[40rem]">
              <caption className="sr-only">
                Every component, with the USDC a route would take, how much of the
                recipe that fills, the price impact and the venues used.
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th scope="col" className="px-3 py-3 font-normal sm:px-4">
                    Component
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-normal sm:px-4">
                    USDC in
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-normal sm:px-4">
                    Round trip
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-3 text-right font-normal sm:table-cell"
                  >
                    Fills
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-3 text-right font-normal sm:table-cell"
                  >
                    Impact
                  </th>
                  <th
                    scope="col"
                    className="hidden px-4 py-3 font-normal md:table-cell"
                  >
                    Route
                  </th>
                </tr>
              </thead>
              <tbody>
                {cost.legs.map((leg) => (
                  <tr key={leg.base} className="border-b border-line/60 last:border-0">
                    <th
                      scope="row"
                      className="px-3 py-2.5 text-left font-normal text-ink sm:px-4"
                    >
                      {leg.base}
                    </th>
                    <td className="tnum px-3 py-2.5 text-right text-ink-2 sm:px-4">
                      {money(leg.usdcIn)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-right sm:px-4">
                      {leg.roundTripBps == null ? (
                        <span className="text-ink-3">
                          {leg.error ?? "—"}
                        </span>
                      ) : (
                        <span
                          className={
                            leg.roundTripBps > 100 ? "text-loss" : "text-ink-2"
                          }
                        >
                          {percent(leg.roundTripBps / 100, 2)}
                        </span>
                      )}
                    </td>
                    <td className="tnum hidden px-4 py-2.5 text-right text-ink-2 sm:table-cell">
                      {leg.coverage == null
                        ? "—"
                        : percent(leg.coverage * 100, 1)}
                    </td>
                    <td className="tnum hidden px-4 py-2.5 text-right text-ink-2 sm:table-cell">
                      {leg.priceImpactPct == null
                        ? "—"
                        : percent(leg.priceImpactPct, 3)}
                    </td>
                    <td className="hidden px-4 py-2.5 text-xs text-ink-3 md:table-cell">
                      {leg.venues.length ? leg.venues.join(" → ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5 max-w-[80ch] text-xs leading-relaxed text-ink-3">
            Each component is quoted twice through the same router — dollars in,
            then straight back out — so the round trip is what a buyer pays to
            hold the component instead of the dollars, measured against itself
            rather than against a price feed that might disagree.
            &ldquo;Fills&rdquo; is how much of the recipe the buy leg covers, which
            is where the spread shows up. Nothing is executed and no wallet is
            touched.
            {nav != null && (
              <>
                {" "}
                One share is worth {money(nav)} from component prices.
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}
