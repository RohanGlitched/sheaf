"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMarket } from "./market-provider";
import { MarketMosaic } from "./market-mosaic";
import { BasketMosaic, type BasketTile } from "./basket-mosaic";
import { Figure } from "./figure";
import { TrackFigure } from "./track-record";
import { slotColor } from "@/lib/palette";
import { money, percent, moneyCompact, quantity, signedPercent } from "@/lib/format";
import { equalWeights, proportionalWeights, setWeight, WEIGHT_TOTAL } from "@/lib/weights";
import { COMPOSABLE, writeMint } from "@/lib/mirror";
import { PRESTOCK_SYMBOLS } from "@/lib/prestocks";
import { unitsForWeights } from "@/lib/sheaf";
import { buildCreateBasket, sendSteps, explainError } from "@/lib/tx";
import { MAX_COMPONENTS, MAX_CREATOR_FEE_BPS, explorerTx } from "@/lib/config";
import type { Quote } from "@/lib/market";
import { MosaicSkeleton } from "./skeletons";
import { ConnectButton } from "./connect-button";

type Pick = { symbol: string; slot: number };

const MIRRORED = new Set(COMPOSABLE.map((s) => s.symbol));
const MINT_TO_SYMBOL = new Map(COMPOSABLE.map((s) => [s.mint, s.symbol]));

const DEFAULT_SHARE_PRICE = 100;

type Preset = { id: string; label: string; hint: string; symbols: string[] };

/**
 * Starting points, not products.
 *
 * A blank canvas is the fastest way to lose somebody on a page like this, so there
 * are three recognisable baskets to open from. Each one is a normal basket after
 * the first click: every ticker and every weight can be changed.
 */
const PRESETS: Preset[] = [
  {
    id: "mag",
    label: "The big five",
    hint: "Equal weight across the largest tokenized names",
    symbols: ["NVDAx", "AAPLx", "MSFTx", "GOOGLx", "METAx"],
  },
  {
    id: "bitcoin-proxy",
    label: "Bitcoin, by proxy",
    hint: "Companies whose balance sheets are the trade",
    symbols: ["MSTRx", "COINx", "HOODx"],
  },
  {
    id: "income",
    label: "Dividend payers",
    hint: "Only tickers already accruing dividends on chain",
    symbols: [],
  },
  {
    id: "frontier",
    label: "Frontier Labs",
    hint: "Pre-IPO SPVs from PreStocks — Anthropic, OpenAI, SpaceX, Anduril",
    symbols: ["ANTHROPIC", "OPENAI", "SPACEX", "ANDURIL"],
  },
];

export function Composer() {
  const router = useRouter();
  const { snapshot, loading } = useMarket();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [picks, setPicks] = useState<Pick[]>([]);
  const [weights, setWeights] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [feeBps, setFeeBps] = useState(25);
  const [sharePrice, setSharePrice] = useState(DEFAULT_SHARE_PRICE);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<{ signature: string; basket: string } | null>(
    null,
  );

  const quotes = useMemo(() => snapshot?.quotes ?? [], [snapshot]);

  // On a phone the basket panel sits two screens below the market, so a tap on
  // a tile changes nothing you can see. A bar pinned to the bottom says what is
  // picked until the panel itself comes into view.
  const panel = useRef<HTMLDivElement>(null);
  const [panelBelow, setPanelBelow] = useState(true);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setPanelBelow(!entry.isIntersecting && entry.boundingClientRect.top > 0),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const composable = useMemo(
    () => quotes.filter((q) => MIRRORED.has(q.symbol)),
    [quotes],
  );
  const quoteBySymbol = useMemo(
    () => new Map(quotes.map((q) => [q.symbol, q])),
    [quotes],
  );

  const selectedMints = useMemo(
    () =>
      new Set(
        picks
          .map((p) => COMPOSABLE.find((s) => s.symbol === p.symbol)?.mint)
          .filter((m): m is string => Boolean(m)),
      ),
    [picks],
  );

  /** Free palette slots stay stable, so a tile keeps its color when others leave. */
  const nextSlot = useCallback(
    (current: Pick[]) => {
      const used = new Set(current.map((p) => p.slot));
      for (let i = 0; i < MAX_COMPONENTS; i++) if (!used.has(i)) return i;
      return 0;
    },
    [],
  );

  const toggleSymbol = useCallback(
    (symbolToToggle: string) => {
      setError(null);
      setPicks((current) => {
        const index = current.findIndex((p) => p.symbol === symbolToToggle);
        if (index >= 0) {
          const next = current.filter((_, i) => i !== index);
          setWeights(next.length ? equalWeights(next.length) : []);
          return next;
        }
        if (current.length >= MAX_COMPONENTS) {
          setError(
            `A basket holds at most ${MAX_COMPONENTS} components. Remove one first.`,
          );
          return current;
        }
        const next = [
          ...current,
          { symbol: symbolToToggle, slot: nextSlot(current) },
        ];
        setWeights(equalWeights(next.length));
        return next;
      });
    },
    [nextSlot],
  );

  const toggleMint = useCallback(
    (mint: string) => {
      const found = MINT_TO_SYMBOL.get(mint);
      if (found) toggleSymbol(found);
    },
    [toggleSymbol],
  );

  function applyPreset(preset: Preset) {
    const symbols =
      preset.id === "income"
        ? composable
            .filter((q) => q.paysDividend)
            .sort((a, b) => b.accruedYieldPct - a.accruedYieldPct)
            .slice(0, MAX_COMPONENTS)
            .map((q) => q.symbol)
        : preset.symbols.filter((s) => MIRRORED.has(s));

    const next = symbols.slice(0, MAX_COMPONENTS).map((s, i) => ({
      symbol: s,
      slot: i,
    }));
    setPicks(next);
    setWeights(equalWeights(next.length));
    setName(preset.label);
    setSymbol(
      preset.id === "income"
        ? "TESSY"
        : preset.id === "mag"
          ? "BIG5"
          : preset.id === "frontier"
            ? "FRNTR"
            : "BTCPX",
    );
    setError(null);
  }

  function weightByLiquidity() {
    setWeights(
      proportionalWeights(
        picks.map((p) => quoteBySymbol.get(p.symbol)?.liquidity ?? 0),
      ),
    );
  }

  // -------------------------------------------------------------- the recipe
  const recipe = useMemo(() => {
    const rows = picks.map((pick, i) => {
      const quote = quoteBySymbol.get(pick.symbol);
      const stock = COMPOSABLE.find((s) => s.symbol === pick.symbol)!;
      return {
        pick,
        quote,
        stock,
        weightBps: weights[i] ?? 0,
      };
    });

    const priced = rows.filter((r) => r.quote);
    const units =
      priced.length === rows.length && rows.length > 0
        ? unitsForWeights({
            targetSharePrice: sharePrice,
            components: rows.map((r) => ({
              mint: r.stock.mint,
              decimals: r.stock.decimals,
              price: r.quote!.price,
              multiplier: r.quote!.multiplier,
              weightBps: r.weightBps,
            })),
          })
        : null;

    // Actual NAV after rounding to whole raw units, which is what a share is worth.
    let nav = 0;
    let accrued = 0;
    const values: number[] = [];
    if (units) {
      units.forEach((u, i) => {
        const r = rows[i];
        const perRawUnit =
          (r.quote!.price * r.quote!.multiplier) / 10 ** r.stock.decimals;
        const value = Number(u.unitsPerShare) * perRawUnit;
        values.push(value);
        nav += value;
        if (r.quote!.paysDividend) accrued += value * (1 - 1 / r.quote!.multiplier);
      });
    }

    return {
      rows,
      units,
      nav: units ? nav : null,
      /** Dollar value of each component inside one share, in row order. */
      values,
      /** Share of the basket's value that is dividends already collected. */
      accruedShare: units && nav > 0 ? (accrued / nav) * 100 : null,
      change24h: rows.length
        ? rows.reduce(
            (a, r) => a + ((r.quote?.change24h ?? 0) * r.weightBps) / WEIGHT_TOTAL,
            0,
          )
        : null,
      premiumBps: rows.every((r) => r.quote?.premiumBps != null)
        ? rows.reduce(
            (a, r) => a + (r.quote!.premiumBps! * r.weightBps) / WEIGHT_TOTAL,
            0,
          )
        : null,
      thinnest: rows.length
        ? rows.reduce((a, r) =>
            (r.quote?.liquidity ?? Infinity) < (a.quote?.liquidity ?? Infinity) ? r : a,
          )
        : null,
    };
  }, [picks, weights, quoteBySymbol, sharePrice]);

  // The track record redraws as the weights move, so it reads the recipe's own
  // per-component values rather than anything cached.
  const trackComponents = useMemo(
    () =>
      recipe.units
        ? recipe.rows.map((r, i) => ({ base: r.stock.base, valueNow: recipe.values[i] ?? 0 }))
        : [],
    [recipe],
  );

  const tiles: BasketTile[] = recipe.rows.map((r) => ({
    key: r.pick.symbol,
    label: r.stock.base,
    sub: r.stock.company,
    weightBps: r.weightBps,
    slot: r.pick.slot,
  }));

  // ------------------------------------------------------------- validation
  const trimmedName = name.trim();
  const trimmedSymbol = symbol.trim().toUpperCase();
  const problems: string[] = [];
  if (picks.length === 0) problems.push("Pick at least one ticker.");
  if (!trimmedName) problems.push("Give the basket a name.");
  if (trimmedName.length > 32) problems.push("The name is over 32 characters.");
  if (!trimmedSymbol) problems.push("Give the basket a symbol.");
  if (trimmedSymbol.length > 10) problems.push("The symbol is over 10 characters.");
  if (!/^[A-Z0-9]*$/.test(trimmedSymbol))
    problems.push("The symbol can only hold letters and digits.");
  if (feeBps < 0 || feeBps > MAX_CREATOR_FEE_BPS)
    problems.push(`The fee has to be between 0 and ${MAX_CREATOR_FEE_BPS / 100}%.`);
  if (!recipe.units) problems.push("Waiting on a price for every ticker.");
  if (recipe.units?.some((u) => u.unitsPerShare <= 1n))
    problems.push(
      "One component rounds to a single raw unit. Raise the share price.",
    );

  const ready = problems.length === 0 && connected;

  // ------------------------------------------------------------------ submit
  async function create() {
    if (!publicKey || !recipe.units) return;
    setSubmitting(true);
    setError(null);
    try {
      const components = recipe.units.map((u, i) => {
        const mirror = writeMint(recipe.rows[i].pick.symbol);
        if (!mirror) throw new Error(`No mirror mint for ${recipe.rows[i].pick.symbol}`);
        return {
          mint: new PublicKey(mirror),
          unitsPerShare: u.unitsPerShare,
          weightBps: u.weightBps,
        };
      });

      // The share mint keypair rides along inside the steps that need it to sign.
      const { steps, basket } = await buildCreateBasket({
        connection,
        creator: publicKey,
        name: trimmedName,
        symbol: trimmedSymbol,
        creatorFeeBps: feeBps,
        components,
      });

      const signatures = await sendSteps(
        steps,
        connection,
        sendTransaction,
        (done, total) => setStep({ done, total }),
      );
      setDone({
        signature: signatures[signatures.length - 1],
        basket: basket.toBase58(),
      });
    } catch (err) {
      setError(explainError(err));
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  }

  if (done) {
    const next = [
      {
        n: "1",
        title: "Create the first shares",
        body: "Hand the vault the components and get shares back. The page tops up test tokens if you are short.",
        href: `/basket/${done.basket}`,
        cta: `Create ${trimmedSymbol}`,
      },
      {
        n: "2",
        title: "Open a launch market",
        body: "Put a Meteora bonding curve in front of the basket, priced off its own NAV. You earn half its trading fees.",
        href: `/basket/${done.basket}#launch`,
        cta: "Open the market",
      },
      {
        n: "3",
        title: "Share it",
        body: "The basket page has its own preview card, so a link shows the recipe wherever it is posted.",
        href: `/basket/${done.basket}`,
        cta: "Copy the link",
        copy: true,
      },
    ];
    return (
      <div className="mx-auto max-w-[60rem] py-20">
        <div className="text-center">
          <p className="text-sm text-bind">Created</p>
          <h1 className="display mt-4 text-title text-ink">{trimmedName} exists.</h1>
          <p className="mx-auto mt-5 max-w-[42rem] text-base leading-relaxed text-ink-2">
            The recipe is written into a program account and the share mint&apos;s authority
            now belongs to it. Anybody can create shares by handing the vault the components,
            and redeem them for the same components back.{" "}
            <a
              href={explorerTx(done.signature)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              View the transaction
            </a>
          </p>
        </div>
        <ol className="mt-14 grid gap-px border border-line bg-line md:grid-cols-3">
          {next.map((step) => (
            <li key={step.n} className="flex flex-col bg-raised p-6">
              <p className="display text-2xl text-bind">{step.n}</p>
              <h2 className="mt-3 text-base text-ink">{step.title}</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-2">{step.body}</p>
              <button
                type="button"
                onClick={() => {
                  if (step.copy) {
                    void navigator.clipboard
                      ?.writeText(`${window.location.origin}${step.href}`)
                      .then(() => setCopied(true));
                  } else {
                    router.push(step.href);
                  }
                }}
                className={
                  step.n === "1"
                    ? "mt-6 bg-bind px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
                    : "mt-6 border border-line-strong px-4 py-2.5 text-sm text-ink transition-colors hover:border-bind hover:text-bind"
                }
              >
                {step.copy && copied ? "Copied" : step.cta}
              </button>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="grid gap-10 [&>*]:min-w-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-12">
      {/* ------------------------------------------------------------ picking */}
      {/* A column, so the mosaic can take whatever height is left after the
          heading and the presets. The basket panel beside it is much taller than
          the market picture needs to be, and a market you are asked to click
          should fill that space rather than leave it blank. */}
      <div className="flex flex-col">
        <h1 className="display text-title text-ink">Create a basket</h1>
        <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-ink-2">
          Pick a tile to put that company in the basket, or pick it from the
          Table, then set the weights. Up to {MAX_COMPONENTS} components, and every one of them is
          a token already trading on Solana — public equities as xStocks, and
          pre-IPO companies as PreStocks, composed the same way.
        </p>

        <div className="mt-7 flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              title={preset.hint}
              className="border border-line px-3 py-2 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink rounded-[var(--radius-control)]"
            >
              {preset.label}
            </button>
          ))}
          {picks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setPicks([]);
                setWeights([]);
              }}
              className="border border-line px-3 py-2 text-xs text-ink-3 transition-colors hover:border-loss/60 hover:text-loss rounded-[var(--radius-control)]"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mt-7 flex min-h-[440px] flex-1 flex-col">
          {loading && !snapshot ? (
            <MosaicSkeleton height={440} label="Reading mainnet prices" />
          ) : (
            <MarketMosaic
              quotes={composable}
              height={440}
              fill
              selected={selectedMints}
              onToggle={toggleMint}
            />
          )}
        </div>

        {/* ------------------------------------------------------------ naming */}
        {/* Under the market rather than in the panel on the right. These four
            fields describe the token you are about to issue, not the basket you
            are still picking, and the panel beside them is much the taller of
            the two columns — the mosaic above takes whatever height this leaves,
            so moving the form here squares the page up as a side effect. */}
        <div className="mt-10 border-t border-line pt-8">
          <h2 className="display text-xl text-ink">Name the token</h2>
          <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            The share carries this name and symbol on chain. The target price
            only sets how much of each component stands behind one share.
          </p>

          <div className="mt-6 grid gap-5 sm:grid-cols-[minmax(0,1fr)_9rem] lg:grid-cols-[minmax(0,1fr)_9rem_11rem]">
            <label className="block">
              <span className="text-xs text-ink-3">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                placeholder="Semiconductors, equal weight"
                className="mt-1.5 w-full border border-line bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-3/60 rounded-[var(--radius-control)]"
              />
            </label>
            <label className="block">
              <span className="text-xs text-ink-3">Symbol</span>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                maxLength={10}
                placeholder="CHIPS"
                className="tnum mt-1.5 w-full border border-line bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-3/60 rounded-[var(--radius-control)]"
              />
            </label>
            <label className="block sm:col-span-2 lg:col-span-1">
              <span className="text-xs text-ink-3">Target share price</span>
              <input
                type="number"
                min={1}
                max={100000}
                value={sharePrice}
                onChange={(e) =>
                  setSharePrice(Math.max(1, Number(e.target.value) || 1))
                }
                className="tnum mt-1.5 w-full border border-line bg-page px-3 py-2 text-sm text-ink rounded-[var(--radius-control)]"
              />
            </label>
          </div>

          <div className="mt-8 grid items-start gap-x-10 gap-y-3 sm:grid-cols-2">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-3">
                  Your fee on every share created
                </span>
                <span className="tnum text-sm text-ink">
                  {percent(feeBps / 100)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={MAX_CREATOR_FEE_BPS}
                step={5}
                value={feeBps}
                aria-label="Creator fee in basis points"
                onChange={(e) => setFeeBps(Number(e.target.value))}
                className="slider mt-3 w-full"
                style={sliderStyle("var(--color-bind)", feeBps, 0, MAX_CREATOR_FEE_BPS)}
              />
            </div>
            <p className="text-xs leading-relaxed text-ink-3">
              Taken in shares, not out of the vault, so it can never eat into
              what a holder can redeem. The program caps it at{" "}
              {percent(MAX_CREATOR_FEE_BPS / 100)}.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ basket */}
      <div ref={panel} className="scroll-mt-4 sm:scroll-mt-24 lg:sticky lg:top-24 lg:self-start">
        <div className="border border-line bg-surface">
          <div className="border-b border-line px-6 py-5">
            <h2 className="display text-xl text-ink">
              {trimmedName || "Your basket"}
            </h2>
            <p className="mt-1 text-xs text-ink-3">
              {picks.length === 0
                ? "Nothing in it yet"
                : `${picks.length} component${picks.length === 1 ? "" : "s"} · one share targets ${money(sharePrice)}`}
            </p>
          </div>

          {/* One padded block, so the panel keeps its bottom margin whether or
              not there are weights to show under the mosaic. */}
          <div className="space-y-7 px-6 py-6">
            <BasketMosaic
              tiles={tiles}
              height={220}
              onRemove={(key) => toggleSymbol(key)}
              emptyHint="Tap a company in the market to add it."
            />

            {/* weights */}
            {recipe.rows.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm text-ink">Weights</h3>
                  <button
                    type="button"
                    onClick={weightByLiquidity}
                    className="text-xs text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink"
                  >
                    Weight by liquidity
                  </button>
                </div>
                <ul className="mt-4 space-y-4">
                  {recipe.rows.map((row, i) => (
                    <li key={row.pick.symbol}>
                      <div className="flex items-baseline gap-2.5">
                        <span
                          className="size-2.5 shrink-0"
                          style={{ background: slotColor(row.pick.slot) }}
                          aria-hidden
                        />
                        <span className="text-sm text-ink">
                          {row.stock.base}
                        </span>
                        {PRESTOCK_SYMBOLS.has(row.stock.symbol) && (
                          <span className="text-xs text-ink-3">
                            PreStocks
                          </span>
                        )}
                        <span className="truncate text-xs text-ink-3">
                          {row.stock.company}
                        </span>
                        <span className="tnum ml-auto text-sm text-ink">
                          {percent(row.weightBps / 100, 1)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={100}
                        max={WEIGHT_TOTAL - 100 * (recipe.rows.length - 1)}
                        step={50}
                        value={row.weightBps}
                        aria-label={`${row.stock.base} weight`}
                        onChange={(e) =>
                          setWeights((w) => setWeight(w, i, Number(e.target.value)))
                        }
                        disabled={recipe.rows.length === 1}
                        className="slider mt-2 w-full"
                        style={sliderStyle(
                          slotColor(row.pick.slot),
                          row.weightBps,
                          100,
                          WEIGHT_TOTAL - 100 * (recipe.rows.length - 1),
                        )}
                      />
                      {row.quote && recipe.units && (
                        <p className="tnum mt-1 text-xs text-ink-3">
                          {quantity(
                            Number(recipe.units[i].unitsPerShare) /
                              10 ** row.stock.decimals,
                            6,
                          )}{" "}
                          {row.stock.symbol} per share · {money(row.quote.price)}
                          {row.quote.paysDividend && (
                            <span className="text-bind">
                              {" "}
                              · +{percent(row.quote.accruedYieldPct)} accrued
                            </span>
                          )}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* the numbers */}
          {recipe.nav != null && (
            <dl className="grid grid-cols-2 gap-px border-t border-line bg-line">
              <Figure
                label="One share, right now"
                value={money(recipe.nav)}
                note={
                  Math.abs(recipe.nav - sharePrice) > 0.005
                    ? `${money(Math.abs(recipe.nav - sharePrice))} off target from rounding to whole units`
                    : "exactly on target"
                }
              />
              <Figure
                label="24h move, weighted"
                value={signedPercent(recipe.change24h)}
                note="what the basket would have done"
                tone={
                  recipe.change24h == null
                    ? undefined
                    : recipe.change24h > 0
                      ? "gain"
                      : "loss"
                }
              />
              <Figure
                label="Dividends already inside"
                value={
                  recipe.accruedShare == null
                    ? "—"
                    : `${percent(recipe.accruedShare)}`
                }
                note="of the basket's value, accrued into the mints"
                tone={recipe.accruedShare ? "gold" : undefined}
              />
              <Figure
                label="Thinnest component"
                value={moneyCompact(recipe.thinnest?.quote?.liquidity)}
                note={
                  recipe.thinnest
                    ? `${recipe.thinnest.stock.base} sets how large a mint can go`
                    : "—"
                }
              />
              <TrackFigure components={trackComponents} />
            </dl>
          )}

          {/* submit */}
          <div className="border-t border-line px-6 py-6">
            {error && (
              <p className="mb-4 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
                {error}
              </p>
            )}
            {connected && problems.length > 0 && (
              <ul className="mb-4 space-y-1 text-sm text-ink-3">
                {problems.slice(0, 2).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {!connected ? (
              <ConnectButton block label="Connect a wallet to create it" />
            ) : (
            <button
              type="button"
              onClick={() => void create()}
              disabled={!ready || submitting}
              className="w-full bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-3 rounded-[var(--radius-control)]"
            >
              {submitting
                ? step && step.total > 1
                  ? `Creating the basket · ${Math.min(step.done + 1, step.total)} of ${
                      step.total
                    }`
                  : "Creating the basket…"
                : "Create the basket"}
            </button>
            )}
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              It creates the share mint, names it, hands its authority to the
              basket, and writes the recipe. Nothing is minted yet. A Solana
              transaction holds 1,232 bytes, so the largest baskets ask for a
              second signature.
            </p>
          </div>
        </div>
      </div>

      {picks.length > 0 && panelBelow && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-raised/95 backdrop-blur-md lg:hidden">
          <div className="flex items-center justify-between gap-4 px-5 py-3">
            <div className="min-w-0">
              <p className="text-sm text-ink">
                {picks.length} of {MAX_COMPONENTS} picked
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
                {picks.map((pick) => (
                  <span key={pick.symbol} className="flex items-center gap-1">
                    <span aria-hidden className="size-2" style={{ background: slotColor(pick.slot) }} />
                    {quoteBySymbol.get(pick.symbol)?.base ?? pick.symbol}
                  </span>
                ))}
              </p>
            </div>
            <button
              type="button"
              onClick={() => panel.current?.scrollIntoView({ block: "start" })}
              className="shrink-0 border border-bind/60 bg-bind/10 px-4 py-2 text-sm text-ink transition-colors hover:bg-bind/20 rounded-[var(--radius-control)]"
            >
              Set weights
            </button>
          </div>
          {error && <p className="px-5 pb-3 text-xs text-loss">{error}</p>}
        </div>
      )}
    </div>
  );
}

function sliderStyle(fill: string, value: number, min: number, max: number) {
  const filled = max > min ? ((value - min) / (max - min)) * 100 : 100;
  return { "--fill": fill, "--filled": `${filled}%` } as React.CSSProperties;
}

export type { Quote };
