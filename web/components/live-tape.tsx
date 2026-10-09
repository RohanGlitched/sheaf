"use client";

import { useEffect, useRef, useState } from "react";
import { useMarket } from "./market-provider";
import { money } from "@/lib/format";

type Print = {
  signature: string;
  slot: number;
  time: number;
  timeSource: "chain" | "slot";
  symbol: string;
  base: string;
  raw: number;
  side: "buy" | "sell" | "arb" | "move";
  wallet: string;
  usd: number | null;
  quote: "USDC" | "USDT" | "SOL" | null;
  venue: string | null;
};
type Tape = {
  slot: number;
  via: "solami" | "public";
  fallback: string | null;
  stale: boolean;
  prints: Print[];
  polledAt: number;
  watching: string[];
  proof: {
    rpcMs: number | null;
    race: { solamiMs: number | null; publicMs: number | null; at: number } | null;
    calls: number;
    pollMs: number;
  };
};

const KEEP = 40;

const ago = (p: Print, now: number) => {
  const s = Math.max(0, Math.round(now / 1000 - p.time));
  const text = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  // Placed by slot distance rather than read from the block: say so.
  return p.timeSource === "slot" ? `~${text}` : text;
};

const SIDE = { buy: "Bought", sell: "Sold", arb: "Arb", move: "Moved" } as const;

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/**
 * Tokenized stocks changing hands on Solana mainnet, polled every few seconds
 * through Solami. New prints are merged into what is already on screen rather
 * than replacing it, so a poll answered by a cold server instance (which has
 * seen less) cannot thin the list, and a failed poll leaves the last good tape
 * in place. New rows arrive highlighted and settle, so the motion on this
 * section is the market's, not ours.
 */
export function LiveTape() {
  const { bySymbol } = useMarket();
  const [tape, setTape] = useState<Tape | null>(null);
  const [rows, setRows] = useState<Print[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [lastOk, setLastOk] = useState<number | null>(null);
  const known = useRef<Map<string, Print>>(new Map());
  const arrivedAt = useRef<Map<string, number>>(new Map());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [screenLag, setScreenLag] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch("/api/tape", { cache: "no-store" });
        if (res.ok) {
          const t = (await res.json()) as Tape;
          if (!live) return;
          const first = known.current.size === 0;
          const at = Date.now();
          const arrived = new Set<string>();
          for (const p of t.prints) {
            if (known.current.has(p.signature)) continue;
            known.current.set(p.signature, p);
            arrivedAt.current.set(p.signature, at);
            arrived.add(p.signature);
          }
          // Newest first by slot, then block time; keep a rolling window.
          const merged = [...known.current.values()].sort((a, b) => b.slot - a.slot || b.time - a.time);
          for (const p of merged.slice(KEEP)) {
            known.current.delete(p.signature);
            arrivedAt.current.delete(p.signature);
          }
          setRows(merged.slice(0, KEEP));
          // Only a newer server tape replaces the header line, so an older cached
          // answer cannot move the slot backwards.
          setTape((prev) => (!prev || t.slot >= prev.slot ? t : { ...prev, proof: t.proof }));
          setLastOk(at);
          if (!first && arrived.size) {
            setFresh(arrived);
            const newest = merged.find((p) => arrived.has(p.signature) && p.timeSource === "chain");
            if (newest) setScreenLag(at - newest.time * 1000);
          }
        }
      } catch {
        // Keep the last good tape on screen; the next tick tries again.
      }
      if (live) timer = setTimeout(tick, document.hidden ? 15_000 : 4_000);
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  const view = rows
    .map((p) => {
      const q = bySymbol(p.symbol);
      const ui = q ? p.raw * q.multiplier : p.raw;
      const value = p.usd ?? (q ? ui * q.price : null);
      const fill = p.usd != null && ui > 0 ? p.usd / ui : null;
      const vsJup = fill != null && q ? (fill / q.price - 1) * 100 : null;
      // A fill more than 15% off the market is a decode we do not trust (a
      // multi-leg route, a mint-and-swap): show the trade, not a price.
      const trusted = vsJup != null && Math.abs(vsJup) < 15;
      return { p, ui, value, fill: trusted ? fill : null, vsJup: trusted ? vsJup : null };
    })
    // Dust: under a dollar is a route's rounding, not a trade.
    .filter((r) => r.value == null || r.value >= 1);

  const reconnecting = lastOk != null && now - lastOk > 20_000;
  const race = tape?.proof.race;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
      <div>
        <h2 className="display text-title max-w-[16ch] text-ink">Stocks trading on Solana, right now.</h2>
        <p className="mt-5 max-w-[44ch] text-base leading-relaxed text-ink-2">
          Real trades in tokenized stocks on Solana mainnet, read from the chain seconds after they land:
          the newest few on two of ten stock mints each poll, so a sample, not every fill. The fill price
          is decoded from what the pool was paid, set against Jupiter&apos;s price for the same token.
          These are the tokens a Sheaf basket holds, and the market that keeps its share price honest.
        </p>
        <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
          <span
            className={`live-dot size-1.5 rounded-full ${reconnecting || tape?.stale ? "bg-loss" : "bg-gain"}`}
            aria-hidden
          />
          <span className="tnum">
            {tape ? `Slot ${tape.slot.toLocaleString("en-US")}` : "Connecting to mainnet"}
          </span>
          {tape && (
            <span>
              read through {tape.via === "solami" ? "Solami" : "a public RPC"}
              {reconnecting ? ", reconnecting" : tape.stale ? ", last good tape" : ""}
            </span>
          )}
        </p>
        {tape?.fallback && <p className="mt-2 max-w-[48ch] text-xs leading-relaxed text-ink-3">{tape.fallback}.</p>}

        {tape && (
          <dl className="mt-7 grid max-w-[30rem] grid-cols-2 gap-px border border-line bg-line text-sm">
            <div className="bg-page px-4 py-3">
              <dt className="text-xs text-ink-3">{tape.via === "solami" ? "Solami" : "RPC"} round trip</dt>
              <dd className="tnum mt-1 text-ink">{tape.proof.rpcMs != null ? `${tape.proof.rpcMs} ms` : "—"}</dd>
            </div>
            <div className="bg-page px-4 py-3">
              <dt className="text-xs text-ink-3">Block to this screen</dt>
              <dd className="tnum mt-1 text-ink">{screenLag != null ? seconds(screenLag) : "next new print"}</dd>
            </div>
            <div className="bg-page px-4 py-3">
              <dt className="text-xs text-ink-3">getSlot, Solami vs public</dt>
              <dd className="tnum mt-1 text-ink">
                {race ? `${race.solamiMs ?? "—"} ms / ${race.publicMs ?? "—"} ms` : "—"}
              </dd>
            </div>
            <div className="bg-page px-4 py-3">
              <dt className="text-xs text-ink-3">Last poll</dt>
              <dd className="tnum mt-1 text-ink">
                {tape.proof.calls} calls in {seconds(tape.proof.pollMs)}
              </dd>
            </div>
          </dl>
        )}
        {tape && (
          <p className="mt-3 max-w-[48ch] text-xs leading-relaxed text-ink-3">
            Calls are sent one at a time, about 240 ms apart, so a poll stays under the free tier&apos;s five
            requests a second. &ldquo;~&rdquo; marks a time placed by slot distance when the node had not yet
            reported the block&apos;s time.
          </p>
        )}
      </div>

      <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <div className="grid grid-cols-[3.75rem_minmax(0,1fr)_4.5rem] gap-3 border-b border-line px-4 py-3 text-xs text-ink-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_5rem_5.5rem] sm:px-5">
          <span>When</span>
          <span>Trade</span>
          <span className="hidden text-right sm:block">Fill vs Jupiter</span>
          <span className="text-right">Value</span>
          <span className="hidden text-right sm:block">Wallet</span>
        </div>
        <ol className="max-h-[440px] overflow-y-auto" aria-live="polite" aria-label="Recent trades">
          {view.length === 0 &&
            (tape ? (
              <li className="px-5 py-10 text-center text-sm text-ink-3">
                Watching {tape.watching.length} stock mints. No trade over a dollar has landed since this
                server started reading; the next one appears here.
              </li>
            ) : (
              Array.from({ length: 6 }, (_, i) => <li key={i} className="mx-5 my-3 h-6 rounded skeleton" />)
            ))}
          {view.map(({ p, ui, value, fill, vsJup }) => (
            <li
              key={p.signature}
              className={`grid grid-cols-[3.75rem_minmax(0,1fr)_4.5rem] items-baseline gap-3 border-b border-line/70 px-4 py-2.5 text-sm transition-colors duration-[1600ms] last:border-0 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_5rem_5.5rem] sm:px-5 ${
                fresh.has(p.signature) ? "bg-bind-wash" : "bg-transparent"
              }`}
            >
              <span
                className="tnum text-xs text-ink-3"
                title={`Slot ${p.slot.toLocaleString("en-US")}${p.timeSource === "slot" ? ", time estimated from slot" : ""}`}
              >
                {ago(p, now)}
              </span>
              <span className="min-w-0 truncate text-ink">
                <span className={p.side === "buy" ? "text-gain" : p.side === "sell" ? "text-loss" : "text-ink-2"}>
                  {SIDE[p.side]}
                </span>{" "}
                <span className="tnum">{ui < 0.01 ? ui.toFixed(4) : ui < 100 ? ui.toFixed(3) : ui.toFixed(1)}</span>{" "}
                <span className="font-medium">{p.base}</span>
                {p.venue && <span className="ml-1.5 hidden text-xs text-ink-3 md:inline">{p.venue}</span>}
              </span>
              <span className="tnum hidden truncate text-right text-ink-2 sm:block">
                {fill != null ? (
                  <>
                    {money(fill)}{" "}
                    <span
                      className={`text-xs ${Math.abs(vsJup!) < 0.05 ? "text-ink-3" : vsJup! > 0 ? "text-gain" : "text-loss"}`}
                    >
                      {vsJup! >= 0 ? "+" : "−"}
                      {Math.abs(vsJup!).toFixed(2)}%
                    </span>
                  </>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </span>
              <span className="tnum text-right text-ink-2">{value != null ? money(value) : "—"}</span>
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
          ))}
        </ol>
      </div>
    </div>
  );
}
