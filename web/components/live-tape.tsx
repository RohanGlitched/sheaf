"use client";

import { useEffect, useRef, useState } from "react";
import { useMarket } from "./market-provider";
import { money } from "@/lib/format";

type Side = "buy" | "sell" | "arb";
type Print = {
  signature: string;
  slot: number;
  time: number;
  timeSource: "chain" | "slot";
  symbol: string;
  base: string;
  raw: number;
  side: Side;
  wallet: string;
  usd: number | null;
  quote: "USDC" | "USDT" | "SOL" | null;
  venue: string | null;
  /** Landed after the server last read its mint: block-to-screen time is meaningful. */
  live?: boolean;
  /** Jupiter's price when the trade was read, and when that price was fetched (unix s). */
  refPrice?: number | null;
  refAt?: number | null;
};
/** A row from web/public/tape.seed.json: captured earlier, with the price of its own moment. */
type SeedPrint = Print & { multiplier?: number };
type Seed = { capturedAt: number; source: string; note: string; prints: SeedPrint[] };

type RaceSide = { medianMs: number | null; slot: number | null; answered: number; rateLimited: number };
type Proof = {
  instance: string;
  since: number;
  rpcMs: number | null;
  compare: {
    slot: { samples: number; solami: RaceSide; public: RaceSide; slotLead: number | null; at: number } | null;
    freshTx: { tried: number; solami: number; public: number };
    upstreams: { reads: { wanted: number; solami: number } };
  };
  calls: number;
  pollMs: number;
};
type Tape = {
  slot: number;
  via: "solami" | "public";
  fallback: string | null;
  stale: boolean;
  warming?: boolean;
  prints: Print[];
  polledAt: number;
  watching: string[];
  backlog: number;
  proof: Proof;
};

const KEEP = 40;
/** Earlier trades fill the list until this many rows have come from the server. */
const SEED_UNTIL = 8;
/** A fill is set against Jupiter only when the price was read this close to the trade. */
const PRICE_WINDOW_S = 120;

const ago = (p: Print, now: number) => {
  const s = Math.max(0, Math.round(now / 1000 - p.time));
  const text =
    s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : s < 86_400
          ? `${Math.floor(s / 3600)}h ago`
          : new Date(p.time * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // Placed by slot distance rather than read from the block: say so.
  return p.timeSource === "slot" ? `~${text}` : text;
};

const SIDE: Record<Side, string> = { buy: "Bought", sell: "Sold", arb: "Arb" };

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const stamp = (unix: number) =>
  new Date(unix * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Proofs from every server instance that has answered, merged. Each instance
 * keeps its own counters, so a younger instance's small totals never replace an
 * older one's: per instance the latest answer wins, and the page sums them.
 */
function merge(proofs: Map<string, Proof>) {
  const all = [...proofs.values()];
  const race = all
    .map((p) => p.compare.slot)
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.at - a.at)[0] ?? null;
  const sum = (f: (p: Proof) => number) => all.reduce((n, p) => n + f(p), 0);
  return {
    instances: all.length,
    /** When the oldest instance that answered started (ms): the span the summed counters cover. */
    since: Math.min(...all.map((p) => p.since)),
    race,
    fresh: {
      tried: sum((p) => p.compare.freshTx.tried),
      solami: sum((p) => p.compare.freshTx.solami),
      public: sum((p) => p.compare.freshTx.public),
    },
    reads: {
      wanted: sum((p) => p.compare.upstreams.reads?.wanted ?? 0),
      solami: sum((p) => p.compare.upstreams.reads?.solami ?? 0),
    },
  };
}

/**
 * Tokenized stocks changing hands on Solana mainnet, polled every few seconds
 * through Solami. New prints are merged into what is already on screen rather
 * than replacing it, so a poll answered by a cold server instance (which has
 * seen less) cannot thin the list, and a failed poll leaves the last good tape
 * in place. New rows arrive highlighted and settle, so the motion on this
 * section is the market's, not ours.
 *
 * Until enough rows have come from the server, trades captured earlier
 * (public/tape.seed.json, written by scripts/tape-seed.mjs) fill the list
 * under an "Earlier trades" divider, with their real block times. They are
 * never highlighted, never counted as live, and never feed the figures.
 *
 * The Solami figures sit in a disclosure under the trades: what the tape
 * depends on first (slot freshness, just-landed transactions, reads answered,
 * block to screen), and the raw round trip stated plainly in the note.
 */
export function LiveTape({ openDetails = false }: { openDetails?: boolean } = {}) {
  const { bySymbol, snapshot } = useMarket();
  // The read that matters most to the product: every basket's value, and every
  // Panta resolution, use the dividend multipliers read through this RPC.
  const chain = snapshot?.chain ?? null;
  const mintCount = snapshot?.quotes.length ?? 0;
  const [tape, setTape] = useState<Tape | null>(null);
  const [rows, setRows] = useState<Print[]>([]);
  const [seed, setSeed] = useState<Seed | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastOk, setLastOk] = useState<number | null>(null);
  const known = useRef<Map<string, Print>>(new Map());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const lags = useRef<number[]>([]);
  const [screenLag, setScreenLag] = useState<{ ms: number; n: number } | null>(null);
  const proofs = useRef<Map<string, Proof>>(new Map());
  const [stats, setStats] = useState<ReturnType<typeof merge> | null>(null);

  useEffect(() => {
    let live = true;
    // The rolling seed a warm server keeps in storage first; the copy committed
    // with the last deploy only if there is none.
    const load = async (url: string) => {
      try {
        const r = await fetch(url);
        if (r.status !== 200) return null;
        const s = (await r.json()) as Seed;
        return s?.prints?.length ? s : null;
      } catch {
        return null;
      }
    };
    void (async () => {
      const s = (await load("/api/tape/seed")) ?? (await load("/tape.seed.json"));
      if (live && s) setSeed(s);
    })();

    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let soon = false;
      try {
        const res = await fetch("/api/tape", { cache: "no-store" });
        if (res.ok) {
          const t = (await res.json()) as Tape;
          if (!live) return;
          // A cold server instance still backfilling: show whatever rows it has
          // decoded so far (the seed stays under them), and ask again soon.
          if (t.warming) {
            soon = true;
            if (!t.prints.length) {
              timer = setTimeout(tick, 2_500);
              return;
            }
          }
          const first = known.current.size === 0;
          const at = Date.now();
          const arrived = new Set<string>();
          for (const p of t.prints) {
            if (known.current.has(p.signature) || !(p.side in SIDE)) continue;
            known.current.set(p.signature, p);
            arrived.add(p.signature);
          }
          // Newest first by slot, then block time; keep a rolling window.
          const merged = [...known.current.values()].sort((a, b) => b.slot - a.slot || b.time - a.time);
          for (const p of merged.slice(KEEP)) known.current.delete(p.signature);
          setRows(merged.slice(0, KEEP));
          // Only a newer server tape replaces the header line, so an older cached
          // answer cannot move the slot backwards.
          setTape((prev) => (!prev || t.slot >= prev.slot ? t : prev));
          if (t.proof?.instance && !t.warming) {
            const prev = proofs.current.get(t.proof.instance);
            // A CDN copy can be older than one already seen from the same instance.
            if (!prev || t.proof.compare.upstreams.reads.wanted >= prev.compare.upstreams.reads.wanted) {
              proofs.current.set(t.proof.instance, t.proof);
              setStats(merge(proofs.current));
            }
          }
          setLastOk(at);
          if (!first && arrived.size) {
            setFresh(arrived);
            // Block to screen counts only trades that landed while the server was
            // watching their mint, with a block time read from the chain.
            const timed = merged.filter((p) => arrived.has(p.signature) && p.live && p.timeSource === "chain");
            if (timed.length) {
              lags.current = [...lags.current, ...timed.map((p) => at - p.time * 1000)].slice(-15);
              setScreenLag({ ms: median(lags.current)!, n: lags.current.length });
            }
          }
        }
      } catch {
        // Keep the last good tape on screen; the next tick tries again.
      }
      if (live) timer = setTimeout(tick, document.hidden ? 15_000 : soon ? 2_500 : 4_000);
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  const price = (p: Print, seeded: boolean) => {
    const q = bySymbol(p.symbol);
    const multiplier = (seeded ? (p as SeedPrint).multiplier : null) ?? q?.multiplier ?? 1;
    // Jupiter's price from the moment the trade was read, never today's: a fill
    // is only set against it when that price is within two minutes of the trade.
    const ref = p.refPrice ?? null;
    const near = ref != null && p.refAt != null && Math.abs(p.refAt - p.time) <= PRICE_WINDOW_S;
    const ui = p.raw * multiplier;
    const value = p.usd ?? (ref != null ? ui * ref : q ? ui * q.price : null);
    const fill = p.usd != null && ui > 0 ? p.usd / ui : null;
    const vsJup = fill != null && near ? (fill / ref! - 1) * 100 : null;
    // A fill more than 15% off the market is a decode we do not trust (a
    // multi-leg route, a mint-and-swap): show the trade, not a price.
    const trusted = vsJup == null || Math.abs(vsJup) < 15;
    return {
      p,
      ui,
      value,
      fill: trusted ? fill : null,
      vsJup: trusted ? vsJup : null,
      seeded,
    };
  };
  // Dust: under a dollar is a route's rounding, not a trade.
  const worth = (r: ReturnType<typeof price>) => r.value == null || r.value >= 1;

  const view = rows.map((p) => price(p, false)).filter(worth);
  const onScreen = new Set(view.map((r) => r.p.signature));
  const oldestLive = view.length ? Math.min(...view.map((r) => r.p.slot)) : Infinity;
  const earlier =
    seed && view.length < SEED_UNTIL
      ? seed.prints
          .filter((p) => p.side in SIDE && !onScreen.has(p.signature) && p.slot < oldestLive)
          .map((p) => price({ ...p, refAt: p.refAt ?? seed.capturedAt }, true))
          .filter(worth)
          .slice(0, KEEP - view.length)
      : [];

  const reconnecting = lastOk != null && now - lastOk > 20_000;
  const race = stats?.race ?? null;
  const lead = race?.slotLead;

  const cell = (label: string, value: string, note?: string) => (
    <div className="bg-page px-4 py-3">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tnum mt-1 text-ink">{value}</dd>
      {note && <dd className="mt-0.5 text-[11px] leading-snug text-ink-3">{note}</dd>}
    </div>
  );

  const grid =
    "grid grid-cols-[4rem_minmax(0,1fr)_4.5rem] gap-3 px-4 sm:grid-cols-[4.5rem_minmax(0,1fr)_6.5rem_5rem_5.5rem] sm:px-5";

  const row = ({ p, ui, value, fill, vsJup, seeded }: ReturnType<typeof price>) => (
    <li
      key={p.signature}
      className={`${grid} items-baseline border-b border-line/70 py-2.5 text-sm transition-colors duration-[1600ms] last:border-0 ${
        !seeded && fresh.has(p.signature) ? "bg-bind-wash" : "bg-transparent"
      } ${seeded ? "opacity-75" : ""}`}
    >
      <a
        href={`https://solscan.io/tx/${p.signature}`}
        target="_blank"
        rel="noreferrer"
        className="tnum text-xs text-ink-3 underline decoration-line-strong decoration-dotted underline-offset-4 hover:text-ink sm:no-underline"
        title={`${stamp(p.time)}, slot ${p.slot.toLocaleString("en-US")}${p.timeSource === "slot" ? ", time estimated from slot" : ""}. Open on Solscan.`}
      >
        {ago(p, now)}
      </a>
      <span className="min-w-0 text-ink">
        <span className="block">
          <span className={p.side === "buy" ? "text-gain" : p.side === "sell" ? "text-loss" : "text-ink-2"}>
            {SIDE[p.side]}
          </span>{" "}
          <span className="tnum">{ui < 0.01 ? ui.toFixed(4) : ui < 100 ? ui.toFixed(3) : ui.toFixed(1)}</span>{" "}
          <span className="font-medium">{p.base}</span>
        </span>
        {p.venue && <span className="block text-xs leading-snug text-ink-3">{p.venue}</span>}
      </span>
      <span className="tnum hidden text-right text-ink-2 sm:block">
        {fill != null ? (
          <>
            {money(fill)}
            {vsJup != null ? (
              <span
                className={`block text-xs ${Math.abs(vsJup) < 0.05 ? "text-ink-3" : vsJup > 0 ? "text-gain" : "text-loss"}`}
              >
                {vsJup >= 0 ? "+" : "−"}
                {Math.abs(vsJup).toFixed(2)}%
              </span>
            ) : (
              <span className="block text-xs text-ink-3" title="No Jupiter price from within two minutes of this trade">
                no price then
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </span>
      <span className="tnum text-right text-ink-2">
        {p.usd != null ? (
          money(value!)
        ) : value != null ? (
          // The quote leg was not decoded: an estimate from Jupiter's price, marked as one.
          <span title="Estimated from Jupiter's price; the quote leg of this trade was not decoded">≈{money(value)}</span>
        ) : (
          <span className="text-xs text-ink-3" title="The quote leg of this trade was not decoded">
            {ui < 0.01 ? ui.toFixed(4) : ui.toFixed(3)} {p.base}
          </span>
        )}
      </span>
      <a
        href={`https://solscan.io/tx/${p.signature}`}
        target="_blank"
        rel="noreferrer"
        className="tnum hidden truncate text-right text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink sm:block"
        title="Open the transaction on Solscan"
      >
        {p.wallet.slice(0, 4)}…{p.wallet.slice(-4)}
      </a>
    </li>
  );

  const reads = stats?.reads;
  const fx = stats?.fresh;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
      <div>
        <h2 className="display text-title max-w-[16ch] text-ink">Stocks trading on Solana, right now.</h2>
        <p className="mt-5 max-w-[44ch] text-base leading-relaxed text-ink-2">
          Real trades in tokenized stocks on Solana mainnet, read from the chain seconds after they land:
          the newest few on two of ten stock mints each poll, so a sample, not every fill. Plain transfers
          are left out. The fill price is decoded from what the pool was paid, and set against
          Jupiter&apos;s price for the same token at the time of the trade. These are the tokens a Sheaf
          basket holds, and the market that keeps its share price honest.
        </p>
        <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
          <span
            className={`live-dot size-1.5 rounded-full ${reconnecting || tape?.stale ? "bg-loss" : "bg-gain"}`}
            aria-hidden
          />
          <span className="tnum">
            {tape && tape.slot > 0 ? `Slot ${tape.slot.toLocaleString("en-US")}` : "Reading mainnet through Solami"}
          </span>
          {tape && (
            <span>
              · read through {tape.via === "solami" ? "Solami" : "a public RPC"}
              {reconnecting ? ", reconnecting" : tape.stale ? ", last good tape" : ""}
            </span>
          )}
        </p>
        {tape?.fallback && <p className="mt-2 max-w-[48ch] text-xs leading-relaxed text-ink-3">{tape.fallback}.</p>}
        <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-ink-2">
          {chain ? (
            <>
              Every basket&apos;s value and every Panta resolution read their dividend multipliers through{" "}
              {chain.via === "solami" ? "Solami" : "a public RPC (Solami was unavailable)"} too: the Token-2022
              config on all {mintCount || 28} stock mints, in one call, at slot{" "}
              <span className="tnum">{chain.slot.toLocaleString("en-US")}</span>.
            </>
          ) : (
            <>
              Every basket&apos;s value and every Panta resolution read their dividend multipliers through
              Solami too: the Token-2022 config on every stock mint, in one call.
            </>
          )}
        </p>
      </div>

      <div className="order-first min-w-0 self-start lg:order-none">
        <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
          {/* On phones the table comes before the section's heading, so it carries its own source line. */}
          <p className="flex flex-wrap items-center gap-x-2 border-b border-line px-4 py-2.5 text-xs text-ink-3 sm:px-5 lg:hidden">
            <span
              className={`live-dot size-1.5 rounded-full ${reconnecting || tape?.stale ? "bg-loss" : "bg-gain"}`}
              aria-hidden
            />
            <span>Solana mainnet</span>
            <span>· read through {tape?.via === "public" ? "a public RPC" : "Solami"}</span>
            <span className="tnum">· {tape && tape.slot > 0 ? `slot ${tape.slot.toLocaleString("en-US")}` : "reading"}</span>
          </p>
          <div className={`${grid} border-b border-line py-3 text-xs text-ink-3`}>
            <span>When</span>
            <span>Trade</span>
            <span className="hidden text-right sm:block" title="Against Jupiter's price within two minutes of the trade">
              Fill vs Jupiter
            </span>
            <span className="text-right">Value</span>
            <span className="hidden text-right sm:block">Wallet</span>
          </div>
          <ol className="max-h-[440px] overflow-y-auto" aria-live="polite" aria-label="Recent trades">
            {view.length === 0 &&
              (tape ? (
                <li className="px-5 py-8 text-center text-sm leading-relaxed text-ink-3">
                  Waiting for the next xStock trade on mainnet. Trades usually land every few seconds during US
                  market hours.
                  {tape.backlog > 0 && " Reading the last few minutes of trades first."}
                </li>
              ) : (
                !earlier.length &&
                Array.from({ length: 6 }, (_, i) => <li key={i} className="mx-5 my-3 h-6 rounded skeleton" />)
              ))}
            {view.map(row)}
          </ol>
          {earlier.length > 0 && seed && (
            <div className="border-t border-line" aria-label="Earlier trades, not live">
              <p
                className="flex flex-wrap items-baseline justify-between gap-x-3 bg-page/60 px-4 py-2 text-xs text-ink-3 sm:px-5"
                title={seed.source}
              >
                <span className="text-ink-2">Earlier trades, not live</span>
                <span className="tnum">captured {stamp(seed.capturedAt)}</span>
              </p>
              <ol className="max-h-[300px] overflow-y-auto">{earlier.map(row)}</ol>
            </div>
          )}
        </div>

        {tape && (
          <details className="group mt-4 text-sm" open={openDetails || undefined}>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-2 hover:text-ink">
              <span aria-hidden className="text-ink-3 transition-transform group-open:rotate-90">
                ›
              </span>
              What Solami does for this tape, against the public RPC
            </summary>
            <dl className="mt-3 grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2">
              {cell(
                "Dividend multipliers behind every basket",
                chain ? `slot ${chain.slot.toLocaleString("en-US")} via ${chain.via === "solami" ? "Solami" : "public RPC"}` : "—",
                `${mintCount || 28} Token-2022 mints in one getMultipleAccounts. These set each basket's value and every Panta resolution (/api/nav sources.multipliers).`,
              )}
              {cell(
                "Mainnet reads Solami served",
                reads?.wanted
                  ? `${reads.solami.toLocaleString("en-US")} of ${reads.wanted.toLocaleString("en-US")}`
                  : "—",
                stats && reads?.wanted
                  ? `over ${Math.max(1, Math.round((now - stats.since) / 60_000))} min on ${stats.instances} server instance${stats.instances === 1 ? "" : "s"}, after one retry on a 429. The public endpoint allows 40 calls per method per 10 s per IP, shared with every app on that IP.`
                  : undefined,
              )}
              {cell(
                "Chain tip, same instant",
                lead == null
                  ? "measured once a minute"
                  : lead > 0
                    ? `Solami ahead by ${lead} slot${lead === 1 ? "" : "s"}`
                    : lead < 0
                      ? `Public RPC ahead by ${-lead} slot${lead === -1 ? "" : "s"}`
                      : "Same slot on both",
                race ? `median gap over ${race.samples} paired getSlot calls` : undefined,
              )}
              {cell(
                "Just-landed transactions served",
                fx?.tried ? `Solami ${fx.solami} of ${fx.tried} · public ${fx.public} of ${fx.tried}` : "measured once a minute",
                "getTransaction for a trade seconds old, asked of both at once",
              )}
              {cell(
                "Block to this screen",
                screenLag ? seconds(screenLag.ms) : "at the next live trade",
                screenLag
                  ? `median of ${screenLag.n} live trade${screenLag.n === 1 ? "" : "s"}, including the mint rotation`
                  : "from the trade's block time to this page",
              )}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              {race?.solami.medianMs != null && race.public.medianMs != null
                ? race.solami.medianMs <= race.public.medianMs
                  ? `On raw round trip Solami was also quicker in the latest paired run: getSlot in ${race.solami.medianMs} ms against the public RPC's ${race.public.medianMs} ms (median of ${race.samples}, warm connections). `
                  : `Raw round trip is left off this list because Solami does not win it here: in the latest paired run the public RPC answered getSlot in ${race.public.medianMs} ms against Solami's ${race.solami.medianMs} ms (median of ${race.samples}, warm connections), since it sits a few milliseconds from the server. `
                : "Raw round trip is measured too, once a minute, and appears here after the first run. "}
              What the tape needs is a key it can call every few seconds without being cut off, a fresh slot,
              and transactions served moments after they land; the public endpoint is documented as not meant
              for production traffic. Calls go out one at a time, 667 ms apart (1.5 a second), so three
              server instances together stay under the free tier&apos;s five requests a second. Every figure
              is in{" "}
              <a href="/api/tape" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                /api/tape
              </a>{" "}
              under <code>proof</code>. &ldquo;~&rdquo; marks a time placed by slot distance.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
