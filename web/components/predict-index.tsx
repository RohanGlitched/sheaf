"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useBaskets } from "@/lib/use-baskets";
import { isTestBasket } from "@/lib/hidden";
import { PoweredByPanta } from "./panta-steps";
import { pantaGet, pantaPost, short, usdcBase, type PantaMode } from "@/lib/panta-client";

type Nav = {
  navPerShare: { recipe: number | null; vault: number | null; listed: number | null };
  sharesOutstanding: number | null;
  trailingWeek: { from: number; to: number; navReturnPct: number; spyReturnPct: number | null; beatsSpy: boolean | null } | null;
  resolution?: {
    /** False when a holding has no listed history (pre-IPO): there is no number to resolve from. */
    offered?: boolean;
    reason?: string;
    rule?: string;
    nextWindow?: { opens: string; from: string; to: string; fromClose: number; toClose: number; resolves: string };
  };
};

/** The ?at= answer at a past close, trimmed for the page. */
type AtNav = { closeDay: string; navPerShare: { listed: number | null }; spy: { closeDay: string; close: number; adjClose: number } };

type CatalogMarket = {
  marketId: string;
  title: string;
  description?: string;
  category: string;
  phase: string;
  endTime: string;
  volumeUsdc: string;
  yesPrice: string | null;
  noPrice: string | null;
};
type Catalog = {
  mode: PantaMode;
  fixture?: boolean;
  markets: CatalogMarket[];
  category?: { category: string; offered: string[]; preferred: boolean };
};

/** BIG5 leads: the basket with the longest listed history, so its trailing week and JSON are complete. */
const LEAD = "BIG5";
const question = (name: string, symbol: string) => `Will ${name.replace(/^The /, "the ")} (${symbol}) beat SPY this week?`;

type Fee = { paymentUsdc?: string; liquidityInjectionUsdc?: string; platformRevenueUsdc?: string; fixture?: boolean };

const pct = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`);
const usd = (x: number | null | undefined) =>
  x == null ? "—" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayLabel = (d: number) =>
  new Date(Date.UTC(Math.floor(d / 10000), Math.floor((d / 100) % 100) - 1, d % 100)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const LIFECYCLE: { verb: string; endpoint: string; where: string }[] = [
  { verb: "Discovery", endpoint: "GET /markets/, GET /categories/", where: "“Panta's catalog” on this page, and every basket page" },
  { verb: "Data", endpoint: "GET /markets/{id}/, GET /markets/{id}/trades/", where: "Positions on /portfolio" },
  { verb: "Creation", endpoint: "POST /markets/create/quote/ → /markets/create/build/ → wallet signs → POST /markets/register/", where: "Basket page, “Open it on Panta”" },
  { verb: "Trading", endpoint: "POST /primaryorderquote/ → /primaryorderbuild/ → wallet signs → /primaryordersubmit/ → /primaryorderverify/ → POST /trades/", where: "Basket page, “Take a side”" },
  { verb: "Positions", endpoint: "GET /positions/?wallet=", where: "/portfolio, Predictions" },
  { verb: "Claims", endpoint: "POST /claim/build/ → wallet signs → POST /trades/", where: "/portfolio, Predictions" },
  { verb: "Creator fees", endpoint: "POST /claim/creator-fees/build/", where: "Basket page, “Creator fees”" },
];

/**
 * /predict: the "beats SPY this week" market for every basket at once, with
 * the number each one resolves from, the trailing week, and what opening one
 * costs on Panta.
 */
export function PredictIndex() {
  const { baskets: all, error } = useBaskets();
  // Baskets our QA runs made stay reachable by URL but are left out of the list.
  // BIG5 first, then the most-minted: a basket with history and holders leads.
  const baskets = useMemo(
    () =>
      all
        ? all
            .filter((b) => !isTestBasket(b))
            .sort((a, b) => Number(b.symbol === LEAD) - Number(a.symbol === LEAD) || Number(b.mintCount ?? 0) - Number(a.mintCount ?? 0))
        : null,
    [all],
  );
  const [mode, setMode] = useState<PantaMode | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fee, setFee] = useState<Fee | null>(null);
  const [navs, setNavs] = useState<Record<string, Nav | "error">>({});

  useEffect(() => {
    void pantaGet<Catalog>("/api/panta").then((r) => {
      setMode(r.ok ? r.data.mode : "off");
      if (r.ok) setCatalog(r.data);
    });
  }, []);

  useEffect(() => {
    if (!baskets?.length) return;
    let live = true;
    // One quote stands for all: the opening fee comes from Panta's on-chain
    // config, not from the question, and quotes are rate limited.
    const first = baskets[0];
    void pantaPost<Fee>({ kind: "create-quote", wallet: first.creator, basket: first.address, name: first.name, symbol: first.symbol }).then(
      (r) => live && r.ok && setFee(r.data),
    );
    void (async () => {
      for (const b of baskets) {
        const r = await pantaGet<Nav>(`/api/nav/${b.address}`);
        if (!live) return;
        setNavs((x) => ({ ...x, [b.address]: r.ok ? r.data : "error" }));
      }
    })();
    return () => {
      live = false;
    };
  }, [baskets]);

  const rows = baskets ?? [];
  // The JSON sample is the first basket whose answer has a trailing week, so
  // the fields a market resolves from are filled in, not null.
  const sampleBasket = rows.find((b) => {
    const n = navs[b.address];
    return n && n !== "error" && n.trailingWeek != null && n.navPerShare.listed != null;
  });
  const sampleNav = sampleBasket ? (navs[sampleBasket.address] as Nav) : undefined;
  const win = sampleNav?.resolution?.nextWindow;
  // Two past closes a week apart, the way a resolver reads them: the last two
  // Fridays before the next window starts.
  const pastTo = win ? win.fromClose - 7 * 86_400 : null;
  const pastFrom = pastTo != null ? pastTo - 7 * 86_400 : null;
  const [past, setPast] = useState<{ from: AtNav; to: AtNav } | null>(null);
  useEffect(() => {
    if (!sampleBasket || pastFrom == null || pastTo == null) return;
    let live = true;
    void Promise.all([
      pantaGet<AtNav>(`/api/nav/${sampleBasket.address}?at=${pastFrom}`),
      pantaGet<AtNav>(`/api/nav/${sampleBasket.address}?at=${pastTo}`),
    ]).then(([a, b]) => live && a.ok && b.ok && setPast({ from: a.data, to: b.data }));
    return () => {
      live = false;
    };
  }, [sampleBasket, pastFrom, pastTo]);
  const pastRatio =
    past && past.from.navPerShare.listed && past.to.navPerShare.listed
      ? {
          basket: (past.to.navPerShare.listed / past.from.navPerShare.listed - 1) * 100,
          spy: (past.to.spy.adjClose / past.from.spy.adjClose - 1) * 100,
        }
      : null;
  const sample =
    sampleNav
      ? (() => {
          const j = sampleNav as Nav & Record<string, unknown>;
          const comps = (j.components as Record<string, unknown>[] | undefined) ?? [];
          const sources = (j.sources as Record<string, unknown> | undefined) ?? {};
          return JSON.stringify(
            {
              question: j.question,
              at: j.at,
              navPerShare: j.navPerShare,
              sharesOutstanding: j.sharesOutstanding,
              trailingWeek: j.trailingWeek,
              components: [
                ...comps.slice(0, 2).map((c) => ({
                  base: c.base,
                  unitsPerShare: c.unitsPerShare,
                  decimals: c.decimals,
                  price: c.price,
                  multiplier: c.multiplier,
                  vaultHeld: c.vaultHeld,
                })),
                ...(comps.length > 2 ? [`… ${comps.length - 2} more`] : []),
              ],
              sources: { multipliers: sources.multipliers },
            },
            null,
            2,
          );
        })()
      : null;
  const leading = rows.filter((b) => {
    const n = navs[b.address];
    return n && n !== "error" && n.trailingWeek?.beatsSpy;
  }).length;
  const measured = rows.filter((b) => {
    const n = navs[b.address];
    return n && n !== "error" && n.trailingWeek?.beatsSpy != null;
  }).length;

  return (
    <>
      <section className="grid grid-cols-1 gap-10 pt-16 pb-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-end">
        <div className="min-w-0">
          <p className="text-sm text-bind">Predict</p>
          <h1 className="display mt-2 text-hero leading-[0.95] text-ink">A market on every basket.</h1>
          <p className="mt-6 max-w-[58ch] text-lg leading-relaxed text-ink-2">
            Every Sheaf basket carries one question: will it beat SPY this week? A basket&apos;s recipe is
            on chain, so the answer can be recomputed by anyone from public accounts and two public price
            sources, between two Friday US closes. Panta runs the market: a USDC bonding curve on Solana,
            opened, traded and claimed through its API.
          </p>
          <PoweredByPanta className="mt-7" />
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line">
          <div className="bg-surface p-5">
            <dt className="text-xs text-ink-3">Baskets with a question</dt>
            <dd className="display tnum mt-2 text-3xl text-ink">{baskets ? rows.length : "—"}</dd>
          </div>
          <div className="bg-surface p-5">
            <dt className="text-xs text-ink-3">Opening one on Panta</dt>
            <dd className="display tnum mt-2 text-3xl text-ink">{fee ? `${usdcBase(fee.paymentUsdc)} USDC` : "—"}</dd>
            {fee?.fixture && <dd className="mt-1 text-xs text-ink-3">sandbox quote</dd>}
          </div>
          <div className="bg-surface p-5">
            <dt className="text-xs text-ink-3">Ahead of SPY, trailing week</dt>
            <dd className="display tnum mt-2 text-3xl text-ink">{measured ? `${leading} of ${measured}` : "—"}</dd>
          </div>
          <div className="bg-surface p-5">
            <dt className="text-xs text-ink-3">Panta</dt>
            <dd className="display mt-2 text-3xl text-ink">{mode === "sandbox" ? "Sandbox" : mode === "live" ? "Live" : mode === "off" ? "Off" : "—"}</dd>
            {mode === "sandbox" && <dd className="mt-1 text-xs text-ink-3">pk_test_ key, nothing on mainnet</dd>}
          </div>
        </dl>
      </section>

      <section className="border-t border-line pt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="display text-title text-ink">The questions</h2>
          <p className="max-w-[56ch] text-sm leading-relaxed text-ink-3">
            Value per share is read live from each basket&apos;s recipe at mainnet prices and dividend
            multipliers. The trailing week compares the same recipe with SPY over the last five closes. A
            market resolves from neither of these live figures: it reads navPerShare.listed at two Friday
            closes, as set out below.
          </p>
        </div>
        {error && <p className="mt-6 text-sm text-loss">{error}</p>}
        <div className="mt-7 overflow-hidden border border-line">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_8rem] gap-4 border-b border-line bg-raised px-5 py-3 text-xs text-ink-3 md:grid">
            <span>Question</span>
            <span className="text-right">One share</span>
            <span className="text-right">Trailing week</span>
            <span>Market</span>
            <span className="text-right">Resolves from</span>
          </div>
          {!baskets && !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="mx-5 my-4 h-10 rounded skeleton" />)}
          {rows.map((b) => {
            const n = navs[b.address];
            const nav = n && n !== "error" ? n : null;
            const w = nav?.trailingWeek ?? null;
            return (
              <div
                key={b.address}
                className="grid grid-cols-1 gap-3 border-b border-line px-5 py-5 last:border-0 md:grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_8rem] md:items-baseline md:gap-4"
              >
                <div className="min-w-0">
                  <Link href={`/basket/${b.address}`} className="text-ink hover:underline hover:underline-offset-4">
                    {question(b.name, b.symbol)}
                  </Link>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {b.components.length} holdings · created by {short(b.creator, 4, 4)}
                  </p>
                </div>
                <p className="tnum text-ink md:text-right">
                  <span className="text-xs text-ink-3 md:hidden">One share </span>
                  {n === "error" ? "—" : nav ? usd(nav.navPerShare.recipe) : <span className="inline-block h-4 w-16 rounded skeleton" />}
                </p>
                <p className="tnum text-sm md:text-right">
                  {w ? (
                    <>
                      <span className={w.navReturnPct >= 0 ? "text-gain" : "text-loss"}>{pct(w.navReturnPct)}</span>
                      <span className="text-ink-3"> vs SPY {pct(w.spyReturnPct)}</span>
                      <span className="block text-xs text-ink-3">
                        {dayLabel(w.from)} to {dayLabel(w.to)} · {w.beatsSpy ? "ahead" : "behind"}
                      </span>
                    </>
                  ) : nav?.resolution?.offered === false || (nav && nav.navPerShare.listed == null) ? (
                    <span className="text-xs text-ink-3">No listed history (pre-IPO)</span>
                  ) : (
                    <span className="text-ink-3">{n ? "—" : ""}</span>
                  )}
                </p>
                <p className="text-sm text-ink-2">
                  {nav?.resolution?.offered === false ? (
                    <span className="text-ink-3" title={nav.resolution.reason}>
                      No market: nothing listed to resolve from
                    </span>
                  ) : mode === "sandbox" ? (
                    <>
                      Not opened on mainnet.{" "}
                      <Link href={`/basket/${b.address}`} className="text-ink underline underline-offset-4">
                        Run the sandbox flow
                      </Link>
                    </>
                  ) : mode === "live" ? (
                    <Link href={`/basket/${b.address}`} className="text-ink underline underline-offset-4">
                      Quote it
                    </Link>
                  ) : (
                    "—"
                  )}
                </p>
                <a
                  href={`/api/nav/${b.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink md:text-right"
                >
                  /api/nav/{short(b.address, 4, 4)}
                </a>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-24 grid grid-cols-1 gap-10 border-t border-line pt-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="min-w-0">
          <h2 className="display text-title max-w-[18ch] text-ink">How a market resolves.</h2>
          <p className="mt-5 max-w-[50ch] text-base leading-relaxed text-ink-2">
            The week runs between two US closes, 16:00 New York time: the first Friday at or after trading
            opens, and the Friday after. So none of the measured week is known when the first share is
            bought. Stock tokens trade around the clock, but SPY only has a close at the close, so both sides
            are read there. If a Friday is a market holiday, the last close before it counts.
          </p>
          <ol className="mt-5 max-w-[50ch] list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-2">
            <li>
              Read <code className="text-xs">navPerShare.listed</code> and <code className="text-xs">spy.adjClose</code>{" "}
              from <code className="text-xs">/api/nav/&lt;basket&gt;?at=&lt;close&gt;</code> at both closes.
            </li>
            <li>Divide the later value by the earlier one, for the basket and for SPY.</li>
            <li>YES if the basket&apos;s ratio is greater. NO otherwise, including a tie.</li>
            <li>Read both at or after the market&apos;s resolution time, two hours after the second close, so both use the same data.</li>
          </ol>
          {win && (
            <p className="mt-5 max-w-[50ch] text-sm leading-relaxed text-ink-3">
              A market opened on {sampleBasket?.symbol} now would trade from{" "}
              {new Date(win.opens).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{" "}
              and measure {win.from} to {win.to}. Both are total return: adjusted closes reinvest dividends, the
              way an xStock&apos;s multiplier does. A close is served once it is final, an hour after the bell; a
              time in the future is refused, never answered with today&apos;s number. A basket holding a company
              that is not listed yet has no such number, so it gets no market.
            </p>
          )}
          <p className="mt-5 max-w-[50ch] text-sm leading-relaxed text-ink-3">
            Every input is public, and the JSON lists a command to fetch each one. The only off-chain inputs
            are Jupiter&apos;s prices and the daily closes:
          </p>
          <ul className="mt-3 max-w-[50ch] space-y-1.5 text-sm leading-relaxed text-ink-3">
            <li>• The recipe, units of each stock per share: the basket account on Solana.</li>
            <li>• Shares outstanding and what each vault holds: the share mint and vault token accounts.</li>
            <li>• Each stock&apos;s dividend multiplier: the Token-2022 config on its mainnet mint.</li>
            <li>• Daily closes and adjusted closes for every holding and SPY: Yahoo Finance&apos;s chart API.</li>
            <li>• Live prices for the &ldquo;now&rdquo; figures: Jupiter&apos;s price API.</li>
          </ul>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-vault p-6 text-vault-ink">
            <p className="text-xs opacity-70">
              What /api/nav answers for {sampleBasket ? sampleBasket.symbol : "a basket"}, live, trimmed
            </p>
            <pre className="mt-3 max-h-[26rem] overflow-auto text-[12px] leading-relaxed">{sample ?? "Reading…"}</pre>
          </div>

          {/* The rule worked once, on the last full week, from the same ?at= reads a resolver makes. */}
          <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface p-6">
            <p className="text-xs text-ink-3">
              Last week, resolved the way a market would be{sampleBasket ? ` (${sampleBasket.symbol})` : ""}
            </p>
            {past && pastRatio && sampleBasket && pastFrom != null && pastTo != null ? (
              <>
                <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-xs text-ink-3">Close</dt>
                    <dd className="tnum mt-1 text-ink-2">{past.from.closeDay}</dd>
                    <dd className="tnum text-ink-2">{past.to.closeDay}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">navPerShare.listed</dt>
                    <dd className="tnum mt-1 text-ink">{usd(past.from.navPerShare.listed)}</dd>
                    <dd className="tnum text-ink">{usd(past.to.navPerShare.listed)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">spy.adjClose</dt>
                    <dd className="tnum mt-1 text-ink">{usd(past.from.spy.adjClose)}</dd>
                    <dd className="tnum text-ink">{usd(past.to.spy.adjClose)}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-sm text-ink-2">
                  {sampleBasket.symbol} {pct(pastRatio.basket)} against SPY {pct(pastRatio.spy)}:{" "}
                  <span className={pastRatio.basket > pastRatio.spy ? "text-gain" : "text-loss"}>
                    {pastRatio.basket > pastRatio.spy ? "YES" : "NO"}
                  </span>
                  .
                </p>
                <p className="mt-3 break-all text-xs leading-relaxed text-ink-3">
                  From{" "}
                  <a href={`/api/nav/${sampleBasket.address}?at=${pastFrom}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    ?at={pastFrom}
                  </a>{" "}
                  and{" "}
                  <a href={`/api/nav/${sampleBasket.address}?at=${pastTo}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    ?at={pastTo}
                  </a>
                  .
                </p>
              </>
            ) : (
              <div className="mt-4 h-24 rounded skeleton" />
            )}
          </div>
        </div>
      </section>

      <section className="mt-24 border-t border-line pt-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="display text-title max-w-[22ch] text-ink">Panta&apos;s catalog, as this key sees it.</h2>
          {catalog?.fixture && (
            <span className="rounded-full border border-line px-3 py-1 text-xs text-ink-3">
              Sandbox fixture · not mainnet markets
            </span>
          )}
        </div>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Read live from <code className="text-xs">GET /markets/</code> and <code className="text-xs">GET /categories/</code>{" "}
          through Sheaf&apos;s server, read-only.{" "}
          {catalog?.mode === "sandbox"
            ? "With a pk_test_ key Panta answers with its sandbox fixture, so this is the one test market it serves, shown as it comes back. With a pk_live_ key the same list is Panta's mainnet catalog."
            : catalog?.mode === "live"
              ? "This is Panta's mainnet catalog."
              : ""}
        </p>
        {catalog?.category && (
          <p className="mt-3 text-xs text-ink-3">
            Categories offered: {catalog.category.offered.join(", ") || "—"}. A basket&apos;s market is filed
            under {catalog.category.category}
            {catalog.category.preferred ? "." : ", since finance is not offered on this key."}
          </p>
        )}
        <div className="mt-6 divide-y divide-line border border-line">
          {!catalog && <div className="mx-5 my-4 h-10 rounded skeleton" />}
          {catalog && catalog.markets.length === 0 && (
            <p className="px-5 py-5 text-sm text-ink-3">Panta returned no markets for this key.</p>
          )}
          {catalog?.markets.slice(0, 8).map((m) => (
            <div
              key={m.marketId}
              className="grid grid-cols-1 gap-2 px-5 py-4 text-sm md:grid-cols-[minmax(0,1.6fr)_7rem_8rem_9rem] md:items-baseline md:gap-4"
            >
              <div className="min-w-0">
                <p className="text-ink">{m.title}</p>
                {m.description && <p className="mt-0.5 text-xs text-ink-3">{m.description}</p>}
              </div>
              <span className="text-ink-3">
                {m.category} · {m.phase}
              </span>
              <span className="tnum text-ink-2">
                Yes {m.yesPrice ?? "—"} · No {m.noPrice ?? "—"}
              </span>
              <span className="tnum text-xs text-ink-3 md:text-right">
                {Number(m.volumeUsdc).toLocaleString("en-US")} USDC traded · ends{" "}
                {new Date(m.endTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 border-t border-line pt-16">
        <h2 className="display text-title max-w-[22ch] text-ink">Every part of Panta&apos;s API, used.</h2>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Each write is a session: quote, build an unsigned transaction, the wallet signs, then Panta is told
          the signature. Sheaf drives all of them and shows Panta&apos;s answer at every step.
        </p>
        <div className="mt-8 divide-y divide-line border border-line">
          {LIFECYCLE.map((row) => (
            <div key={row.verb} className="grid grid-cols-1 gap-2 px-5 py-4 md:grid-cols-[9rem_minmax(0,1fr)_16rem] md:gap-6">
              <span className="text-ink">{row.verb}</span>
              <code className="min-w-0 break-words text-xs leading-relaxed text-ink-2">{row.endpoint}</code>
              <span className="text-sm text-ink-3">{row.where}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 grid grid-cols-1 gap-10 border-t border-line pt-16 lg:grid-cols-2 lg:gap-16">
        <div className="min-w-0">
          <h2 className="display text-title max-w-[18ch] text-ink">Why the sandbox.</h2>
          <p className="mt-5 max-w-[50ch] text-base leading-relaxed text-ink-2">
            Opening a market on Panta costs about 50 USDC plus SOL, and Sheaf spends no real money. A{" "}
            <code className="text-sm">pk_test_</code> key runs the identical flow against Panta&apos;s
            fixtures: same endpoints, same request bodies, canned answers, nothing on mainnet. Those answers
            are labeled wherever they appear, so a fixed sandbox quote is never passed off as this
            basket&apos;s price.
          </p>
          <p className="mt-4 max-w-[50ch] text-sm leading-relaxed text-ink-3">
            One thing in the sandbox flow is not Panta&apos;s: its builds return no real transaction, so the
            wallet signs a stand-in Sheaf compiles (a memo on a fresh devnet blockhash). That signed stand-in
            is never broadcast to any cluster, and the signature reported back to Panta&apos;s sandbox
            proves the flow, not a trade.
          </p>
        </div>
        <div className="min-w-0">
          <h2 className="display text-title max-w-[18ch] text-ink">What changes for live.</h2>
          <p className="mt-5 max-w-[50ch] text-base leading-relaxed text-ink-2">
            One environment variable: a <code className="text-sm">pk_live_</code> key in{" "}
            <code className="text-sm">PANTA_API_KEY</code>. Discovery, data, positions and quotes then read
            Panta&apos;s mainnet catalog. Building, signing and reporting stay locked to the sandbox in
            Sheaf&apos;s server code until a market is sponsored, so the live demo cannot move USDC by
            accident.
          </p>
          <PoweredByPanta className="mt-7" />
        </div>
      </section>
    </>
  );
}
