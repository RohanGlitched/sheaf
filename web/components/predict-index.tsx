"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useBaskets } from "@/lib/use-baskets";
import { PoweredByPanta } from "./panta-steps";
import { pantaGet, pantaPost, short, usdcBase, type PantaMode } from "@/lib/panta-client";

type Nav = {
  navPerShare: { recipe: number | null; vault: number | null; listed: number | null };
  sharesOutstanding: number | null;
  week: { from: number; to: number; navReturnPct: number; spyReturnPct: number | null; beatsSpy: boolean | null } | null;
};

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
  { verb: "Discovery", endpoint: "GET /markets/, GET /categories/", where: "This page and every basket page" },
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
  const { baskets, error } = useBaskets();
  const [mode, setMode] = useState<PantaMode | null>(null);
  const [fee, setFee] = useState<Fee | null>(null);
  const [navs, setNavs] = useState<Record<string, Nav | "error">>({});

  useEffect(() => {
    void pantaGet<{ mode: PantaMode }>("/api/panta").then((r) => setMode(r.ok ? r.data.mode : "off"));
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
  const firstNav = rows[0] ? navs[rows[0].address] : undefined;
  const sample =
    firstNav && firstNav !== "error"
      ? (() => {
          const j = firstNav as Nav & Record<string, unknown>;
          const comps = (j.components as Record<string, unknown>[] | undefined) ?? [];
          const sources = (j.sources as Record<string, unknown> | undefined) ?? {};
          return JSON.stringify(
            {
              question: j.question,
              at: j.at,
              navPerShare: j.navPerShare,
              sharesOutstanding: j.sharesOutstanding,
              week: j.week,
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
    return n && n !== "error" && n.week?.beatsSpy;
  }).length;
  const measured = rows.filter((b) => {
    const n = navs[b.address];
    return n && n !== "error" && n.week?.beatsSpy != null;
  }).length;

  return (
    <>
      <section className="grid gap-10 pt-16 pb-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-end">
        <div>
          <p className="text-sm text-bind">Predict</p>
          <h1 className="display mt-2 text-hero leading-[0.95] text-ink">A market on every basket.</h1>
          <p className="mt-6 max-w-[58ch] text-lg leading-relaxed text-ink-2">
            Every Sheaf basket carries one question: will it beat SPY this week? Because a basket&apos;s
            value is held in a vault anyone can read, the answer can be computed from chain state and public
            prices, with no one&apos;s say-so. Panta runs the market: a USDC bonding curve on Solana, opened,
            traded and claimed through its API.
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
            multipliers. The trailing week compares the same recipe with SPY over the last five closes.
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
            const w = nav?.week ?? null;
            return (
              <div
                key={b.address}
                className="grid gap-3 border-b border-line px-5 py-5 last:border-0 md:grid-cols-[minmax(0,1.6fr)_7rem_minmax(0,1fr)_minmax(0,1fr)_8rem] md:items-baseline md:gap-4"
              >
                <div className="min-w-0">
                  <Link href={`/basket/${b.address}`} className="text-ink hover:underline hover:underline-offset-4">
                    Will {b.name} ({b.symbol}) beat SPY this week?
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
                  ) : (
                    <span className="text-ink-3">{n ? "—" : ""}</span>
                  )}
                </p>
                <p className="text-sm text-ink-2">
                  {mode === "sandbox" ? (
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

      <section className="mt-24 grid gap-10 border-t border-line pt-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div>
          <h2 className="display text-title max-w-[18ch] text-ink">How a market resolves.</h2>
          <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
            YES if one share, valued from its vault at the closing time, rose more than SPY&apos;s
            close-to-close change over the same week. NO otherwise. The value is published as JSON at{" "}
            <code className="text-sm">/api/nav/&lt;basket&gt;</code>, and the market names that URL as its
            first source of truth.
          </p>
          <p className="mt-4 max-w-[48ch] text-sm leading-relaxed text-ink-3">
            Nothing in it needs trusting Sheaf. The recipe (units of each stock per share) and the vault
            balances are public accounts; each stock&apos;s dividend multiplier sits on its mainnet mint; the
            prices are Jupiter&apos;s public API. The JSON lists every input and the curl commands to fetch
            them yourself.
          </p>
        </div>
        <div className="rounded-[var(--radius-panel)] border border-line bg-vault p-6 text-vault-ink">
          <p className="text-xs opacity-70">
            What /api/nav answers for {rows[0] ? rows[0].symbol : "a basket"}, live, trimmed
          </p>
          <pre className="mt-3 max-h-[26rem] overflow-auto text-[12px] leading-relaxed">{sample ?? "Reading…"}</pre>
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
            <div key={row.verb} className="grid gap-2 px-5 py-4 md:grid-cols-[9rem_minmax(0,1fr)_16rem] md:gap-6">
              <span className="text-ink">{row.verb}</span>
              <code className="text-xs leading-relaxed text-ink-2">{row.endpoint}</code>
              <span className="text-sm text-ink-3">{row.where}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-24 grid gap-10 border-t border-line pt-16 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="display text-title max-w-[18ch] text-ink">Why the sandbox.</h2>
          <p className="mt-5 max-w-[50ch] text-base leading-relaxed text-ink-2">
            Opening a market on Panta costs about 50 USDC plus SOL, and Sheaf spends no real money. A{" "}
            <code className="text-sm">pk_test_</code> key runs the identical flow against Panta&apos;s
            fixtures: same endpoints, same request bodies, canned answers, nothing on mainnet. Those answers
            are labelled wherever they appear, so a fixed sandbox quote is never passed off as this
            basket&apos;s price.
          </p>
        </div>
        <div>
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
