"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBaskets } from "@/lib/use-baskets";
import { LaunchHoldings } from "./launch-holdings";
import { useBalances } from "@/lib/use-balances";
import { valueBasket } from "@/lib/basket-view";
import { useMarket } from "./market-provider";
import { BasketMosaic } from "./basket-mosaic";
import { Figure } from "./figure";
import { FaucetButton } from "./faucet-button";
import { ConnectButton } from "./connect-button";
import { MosaicSkeleton } from "./skeletons";
import { TOKEN_2022_PROGRAM_ID, ONE_SHARE } from "@/lib/sheaf";
import { COMPOSABLE, writeMint, symbolForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { money, percent, quantity, signedPercent, count } from "@/lib/format";

/**
 * What the connected wallet owns, and what it owns underneath.
 *
 * The second part is the point. Holding three baskets that all contain the same
 * chipmaker is a concentrated position dressed up as diversification, and the only
 * way to see it is to look through the baskets to the companies. Nothing else in
 * the market can do this, because nothing else can read what is in the wrapper.
 */

const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID.toBase58();
const TOP_SLOTS = 7;

export function Portfolio() {
  const { connected } = useWallet();
  const { baskets, loading, error } = useBaskets();
  const { snapshot } = useMarket();

  // Every share mint plus every mirror mint, in one read.
  const watched = useMemo(() => {
    const list: { mint: string; tokenProgram: string }[] = [];
    for (const basket of baskets ?? []) {
      list.push({ mint: basket.shareMint, tokenProgram: TOKEN_PROGRAM });
    }
    for (const stock of COMPOSABLE) {
      const mirror = writeMint(stock.symbol);
      if (mirror) list.push({ mint: mirror, tokenProgram: TOKEN_PROGRAM });
    }
    return list;
  }, [baskets]);

  const balances = useBalances(watched);

  const view = useMemo(() => {
    const positions: {
      address: string;
      name: string;
      symbol: string;
      shares: number;
      nav: number | null;
      value: number | null;
      change24h: number | null;
      components: { company: string; base: string; value: number }[];
    }[] = [];

    for (const basket of baskets ?? []) {
      const raw = balances.raw.get(basket.shareMint) ?? 0n;
      if (raw === 0n) continue;
      const shares = Number(raw) / ONE_SHARE;
      const valuation = valueBasket(basket, snapshot);
      positions.push({
        address: basket.address,
        name: basket.name,
        symbol: basket.symbol,
        shares,
        nav: valuation.nav,
        value: valuation.nav == null ? null : valuation.nav * shares,
        change24h: valuation.change24h,
        components: valuation.components.map((c) => ({
          company: c.company,
          base: c.base,
          value: (c.value ?? 0) * shares,
        })),
      });
    }

    const loose: {
      mint: string;
      base: string;
      company: string;
      tokens: number;
      value: number | null;
      change24h: number | null;
    }[] = [];

    for (const stock of COMPOSABLE) {
      const mirror = writeMint(stock.symbol);
      if (!mirror) continue;
      const raw = balances.raw.get(mirror) ?? 0n;
      if (raw === 0n) continue;
      const quote = snapshot?.quotes.find((q) => q.symbol === stock.symbol);
      const tokens = Number(raw) / 10 ** stock.decimals;
      loose.push({
        mint: mirror,
        base: stock.base,
        company: stock.company,
        tokens,
        value: quote ? tokens * quote.price * quote.multiplier : null,
        change24h: quote?.change24h ?? null,
      });
    }

    // Look-through: one row per company, wherever the exposure came from.
    const byCompany = new Map<
      string,
      { base: string; company: string; inBaskets: number; loose: number }
    >();
    const bump = (
      base: string,
      company: string,
      value: number,
      where: "inBaskets" | "loose",
    ) => {
      const row =
        byCompany.get(base) ?? { base, company, inBaskets: 0, loose: 0 };
      row[where] += value;
      byCompany.set(base, row);
    };
    for (const position of positions) {
      for (const component of position.components) {
        bump(component.base, component.company, component.value, "inBaskets");
      }
    }
    for (const holding of loose) {
      bump(holding.base, holding.company, holding.value ?? 0, "loose");
    }

    const lookThrough = [...byCompany.values()]
      .map((row) => ({ ...row, total: row.inBaskets + row.loose }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);

    const basketValue = positions.reduce((a, p) => a + (p.value ?? 0), 0);
    const looseValue = loose.reduce((a, l) => a + (l.value ?? 0), 0);
    const total = basketValue + looseValue;

    const change24h =
      total > 0
        ? positions.reduce(
            (a, p) => a + (p.change24h ?? 0) * ((p.value ?? 0) / total),
            0,
          ) +
          loose.reduce(
            (a, l) => a + (l.change24h ?? 0) * ((l.value ?? 0) / total),
            0,
          )
        : null;

    return {
      positions,
      loose,
      lookThrough,
      basketValue,
      looseValue,
      total,
      change24h,
      largest: lookThrough[0] ?? null,
    };
  }, [baskets, balances.raw, snapshot]);

  // One share of every basket, looked through. Used only for the disconnected
  // state, where there are no balances to read but the idea still needs showing.
  const demo = useMemo(() => {
    const byCompany = new Map<
      string,
      { base: string; company: string; total: number }
    >();
    for (const basket of baskets ?? []) {
      for (const component of valueBasket(basket, snapshot).components) {
        const row =
          byCompany.get(component.base) ?? {
            base: component.base,
            company: component.company,
            total: 0,
          };
        row.total += component.value ?? 0;
        byCompany.set(component.base, row);
      }
    }
    const rows = [...byCompany.values()]
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
    return { rows, total: rows.reduce((a, r) => a + r.total, 0) };
  }, [baskets, snapshot]);

  const demoTiles = demo.rows.slice(0, TOP_SLOTS).map((row, index) => ({
    key: row.base,
    label: row.base,
    sub: row.company,
    weightBps: demo.total > 0 ? (row.total / demo.total) * 10_000 : 0,
    slot: index,
  }));
  // The tail has to be folded in rather than dropped, or the tiles would add up
  // to less than everything and quietly overstate the ones on screen.
  const demoTail = demo.rows.slice(TOP_SLOTS);
  if (demoTail.length > 0 && demo.total > 0) {
    demoTiles.push({
      key: "rest",
      label: `${demoTail.length} more`,
      sub: "Smaller positions",
      weightBps:
        (demoTail.reduce((a, r) => a + r.total, 0) / demo.total) * 10_000,
      slot: TOP_SLOTS,
    });
  }

  if (!connected) {
    return (
      <div>
        <div className="py-16 text-center">
          <h1 className="display text-hero leading-[0.95] text-ink">
            Your side of it
          </h1>
          <p className="mx-auto mt-5 max-w-[52ch] text-base leading-relaxed text-ink-2">
            Connect a wallet and this page reads your baskets, values them from
            live mainnet prices, and looks through them to the companies you
            actually own.
          </p>
          <div className="mt-9 flex justify-center">
            <ConnectButton />
          </div>
        </div>

        {/* Rather than an empty room, show the same arithmetic on public data:
            one share of every basket that exists, unwrapped to companies. */}
        {(demo.rows.length > 0 || ((loading || !snapshot) && !error)) && (
          <section className="mt-8 border-t border-line pt-12">
            <h2 className="display text-title text-ink">
              What the look-through does
            </h2>
            <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-ink-2">
              One share of{" "}
              {baskets ? `each of the ${count(baskets.length)} baskets` : "every basket"} on
              this program, unwrapped to the companies underneath and added up.
              Your own version of this reads your balances instead.
            </p>
            <div className="mt-7">
              {demo.rows.length > 0 ? (
                <BasketMosaic tiles={demoTiles} height={260} />
              ) : (
                <MosaicSkeleton height={260} label="Reading the baskets" />
              )}
            </div>
            {/* Rules drawn on the cells rather than as a background behind a
                gap, so a part-filled last row does not leave a lit empty tile. */}
            <div className="mt-6 grid border-l border-t border-line sm:grid-cols-2 lg:grid-cols-4">
              {demo.rows.map((row, index) => (
                <div
                  key={row.base}
                  className="border-b border-r border-line px-5 py-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-baseline gap-2.5">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 translate-y-px"
                        style={{
                          background: slotColor(
                            index < TOP_SLOTS ? index : TOP_SLOTS,
                          ),
                        }}
                      />
                      <span className="text-ink">{row.base}</span>
                    </span>
                    <span className="tnum text-ink-2">
                      {percent((row.total / demo.total) * 100, 1)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-ink-3">
                    {row.company}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  const empty =
    view.positions.length === 0 && view.loose.length === 0 && !balances.loading;

  const tiles = view.lookThrough.slice(0, TOP_SLOTS).map((row, index) => ({
    key: row.base,
    label: row.base,
    sub: row.company,
    weightBps: view.total > 0 ? (row.total / view.total) * 10_000 : 0,
    slot: index,
  }));
  const tail = view.lookThrough.slice(TOP_SLOTS);
  if (tail.length > 0) {
    const rest = tail.reduce((a, r) => a + r.total, 0);
    tiles.push({
      key: "rest",
      label: `${tail.length} more`,
      sub: "Everything else you hold",
      weightBps: (rest / view.total) * 10_000,
      slot: TOP_SLOTS,
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-8">
        <div>
          <h1 className="display text-hero leading-[0.95] text-ink">
            Your side of it
          </h1>
          <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-ink-2">
            Balances read from the chain, valued at live mainnet prices.
          </p>
        </div>
        <div className="text-right">
          <p className="tnum display text-hero leading-none text-ink">
            {money(view.total)}
          </p>
          <p
            className="tnum mt-2 text-sm"
            style={{
              color:
                view.change24h == null
                  ? "var(--color-ink-3)"
                  : view.change24h > 0
                    ? "var(--color-gain)"
                    : "var(--color-loss)",
            }}
          >
            {signedPercent(view.change24h)} today
          </p>
        </div>
      </div>

      {loading && (
        <p className="mt-12 text-sm text-ink-3">Reading the program…</p>
      )}
      {error && (
        <p className="mt-12 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
          {error}
        </p>
      )}

      {empty && (
        <div className="mt-12 border border-dashed border-line-strong/60 px-8 py-16 text-center">
          <p className="display text-xl text-ink">Nothing here yet.</p>
          <p className="mx-auto mt-3 max-w-[50ch] text-sm leading-relaxed text-ink-2">
            Claim a set of test tokens, then create a basket or create shares in one
            that already exists.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/compose"
              className="bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep rounded-[var(--radius-control)]"
            >
              Create a basket
            </Link>
            <FaucetButton
              symbols={COMPOSABLE.slice(0, 8).map((s) => s.symbol)}
              onDone={() => void balances.reload()}
              label="Claim a starter set"
            />
          </div>
        </div>
      )}

      {!empty && view.total > 0 && (
        <>
          <dl className="mt-10 grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            <Figure
              label="In baskets"
              value={money(view.basketValue)}
              note={`${count(view.positions.length)} ${
                view.positions.length === 1 ? "basket" : "baskets"
              } held`}
            />
            <Figure
              label="Loose tokens"
              value={money(view.looseValue)}
              note="Equities not inside a basket yet"
            />
            <Figure
              label="Companies underneath"
              value={count(view.lookThrough.length)}
              note="Counted once, however many baskets hold them"
            />
            <Figure
              label="Largest exposure"
              value={
                view.largest
                  ? percent((view.largest.total / view.total) * 100, 1)
                  : "—"
              }
              note={
                view.largest
                  ? `${view.largest.company}, across everything you hold`
                  : "Nothing held"
              }
              tone={
                view.largest && view.largest.total / view.total > 0.4
                  ? "gold"
                  : undefined
              }
            />
          </dl>

          <section className="mt-16">
            <h2 className="display text-title text-ink">
              What you actually own
            </h2>
            <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
              Baskets unwrapped down to the companies inside them, added to the
              tokens you hold directly. Two baskets that both lean on the same name
              show up here as one position, which is what it is.
            </p>
            <div className="mt-7">
              <BasketMosaic tiles={tiles} height={300} />
            </div>

            {/* The split between basket and wallet is the interesting part of this
                table but the least room-worthy, so a narrow screen keeps the
                totals and drops it rather than scrolling sideways. */}
            <div className="mt-7 border border-line">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="px-4 py-3 font-normal">Company</th>
                    <th className="hidden px-4 py-3 text-right font-normal sm:table-cell">
                      Through baskets
                    </th>
                    <th className="hidden px-4 py-3 text-right font-normal sm:table-cell">
                      Held directly
                    </th>
                    <th className="px-4 py-3 text-right font-normal">Total</th>
                    <th className="px-4 py-3 text-right font-normal">
                      Of everything
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.lookThrough.map((row, index) => (
                    <tr
                      key={row.base}
                      className="border-b border-line/60 last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden
                            className="size-2.5 shrink-0"
                            style={{
                              background: slotColor(
                                index < TOP_SLOTS ? index : TOP_SLOTS,
                              ),
                            }}
                          />
                          <span>
                            <span className="text-ink">{row.base}</span>
                            <span className="ml-2 text-xs text-ink-3">
                              {row.company}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="tnum hidden px-4 py-3 text-right text-ink-2 sm:table-cell">
                        {row.inBaskets > 0 ? money(row.inBaskets) : "—"}
                      </td>
                      <td className="tnum hidden px-4 py-3 text-right text-ink-2 sm:table-cell">
                        {row.loose > 0 ? money(row.loose) : "—"}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-ink">
                        {money(row.total)}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-ink-3">
                        {percent((row.total / view.total) * 100, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {view.positions.length > 0 && (
        <section className="mt-16">
          <h2 className="display text-title text-ink">Your baskets</h2>
          <div className="mt-7 divide-y divide-line border border-line">
            {view.positions.map((position) => (
              <Link
                key={position.address}
                href={`/basket/${position.address}`}
                className="flex flex-wrap items-baseline justify-between gap-4 px-5 py-5 transition-colors hover:bg-raised"
              >
                <div className="min-w-0">
                  <p className="display truncate text-lg text-ink">
                    {position.name}
                  </p>
                  <p className="tnum mt-0.5 text-xs text-ink-3">
                    {quantity(position.shares, 6)} {position.symbol} at{" "}
                    {money(position.nav)} each
                  </p>
                </div>
                <div className="text-right">
                  <p className="tnum display text-lg text-ink">
                    {money(position.value)}
                  </p>
                  <p
                    className="tnum text-xs"
                    style={{
                      color:
                        position.change24h == null
                          ? "var(--color-ink-3)"
                          : position.change24h > 0
                            ? "var(--color-gain)"
                            : "var(--color-loss)",
                    }}
                  >
                    {signedPercent(position.change24h)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <LaunchHoldings baskets={baskets} />

      {view.loose.length > 0 && (
        <section className="mt-16">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="display text-title text-ink">Loose tokens</h2>
              <p className="mt-3 max-w-[54ch] text-sm leading-relaxed text-ink-2">
                Equities sitting in your wallet on their own. These are what a
                basket is made from.
              </p>
            </div>
            <FaucetButton
              symbols={view.loose.slice(0, 8).map(
                (l) => symbolForWriteMint(l.mint) ?? "",
              )}
              onDone={() => void balances.reload()}
              label="Top these up"
            />
          </div>
          <div className="mt-7 grid border-l border-t border-line sm:grid-cols-2 lg:grid-cols-3">
            {view.loose.map((holding) => (
              <div
                key={holding.mint}
                className="border-b border-r border-line px-5 py-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-ink">{holding.base}</p>
                  <p className="tnum text-ink">{money(holding.value)}</p>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <p className="truncate text-xs text-ink-3">
                    {holding.company}
                  </p>
                  <p className="tnum shrink-0 text-xs text-ink-3">
                    {quantity(holding.tokens, 4)} tokens
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
