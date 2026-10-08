"use client";

import { useEffect, useRef, useState } from "react";
import { useMarket } from "./market-provider";
import { money } from "@/lib/format";

type Print = {
  signature: string;
  slot: number;
  time: number | null;
  symbol: string;
  base: string;
  amount: number;
  side: "buy" | "sell" | "move";
  wallet: string;
};
type Tape = { slot: number; via: "solami" | "public"; prints: Print[]; watching: string[] };

const ago = (t: number | null, now: number) => {
  if (!t) return "now";
  const s = Math.max(0, Math.round(now / 1000 - t));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

const SIDE = { buy: "Bought", sell: "Sold", move: "Moved" } as const;

/**
 * Tokenized stocks changing hands on Solana mainnet, polled every few seconds
 * through Solami. New rows arrive highlighted and settle, so the motion on this
 * section is the market's, not ours.
 */
export function LiveTape() {
  const { bySymbol } = useMarket();
  const [tape, setTape] = useState<Tape | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

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
          const arrived = new Set(t.prints.filter((p) => !known.current.has(p.signature)).map((p) => p.signature));
          t.prints.forEach((p) => known.current.add(p.signature));
          setTape(t);
          if (!first) setFresh(arrived);
        }
      } catch {}
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

  const rows = tape?.prints ?? [];

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
      <div>
        <h2 className="display text-title max-w-[16ch] text-ink">Stocks trading on Solana, right now.</h2>
        <p className="mt-5 max-w-[44ch] text-base leading-relaxed text-ink-2">
          Every row is a real trade in a tokenized stock on Solana mainnet, read from the chain a few
          seconds after it lands. These are the tokens a Sheaf basket holds, and the market that keeps
          its share price honest.
        </p>
        <p className="mt-6 flex items-center gap-2 text-sm text-ink-3">
          <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
          <span className="tnum">
            {tape ? `Slot ${tape.slot.toLocaleString("en-US")}` : "Connecting to mainnet"}
          </span>
          {tape && <span>read through {tape.via === "solami" ? "Solami" : "a public RPC"}</span>}
        </p>
      </div>

      <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_5.5rem] gap-3 border-b border-line px-5 py-3 text-xs text-ink-3">
          <span>When</span>
          <span>Trade</span>
          <span className="text-right">Value</span>
          <span className="text-right">Wallet</span>
        </div>
        <ol className="max-h-[420px] overflow-y-auto" aria-live="polite" aria-label="Recent trades">
          {rows.length === 0 &&
            Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="mx-5 my-3 h-6 rounded skeleton" />
            ))}
          {rows.map((p) => {
            const price = bySymbol(p.symbol)?.price ?? null;
            const value = price != null ? p.amount * price : null;
            return (
              <li
                key={p.signature}
                className={`grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_5.5rem] items-baseline gap-3 border-b border-line/70 px-5 py-2.5 text-sm transition-colors duration-[1600ms] last:border-0 ${
                  fresh.has(p.signature) ? "bg-bind-wash" : "bg-transparent"
                }`}
              >
                <span className="tnum text-xs text-ink-3">{ago(p.time, now)}</span>
                <span className="truncate text-ink">
                  <span className={p.side === "buy" ? "text-gain" : p.side === "sell" ? "text-loss" : "text-ink-2"}>
                    {SIDE[p.side]}
                  </span>{" "}
                  <span className="tnum">{p.amount < 0.01 ? p.amount.toFixed(4) : p.amount.toFixed(3)}</span>{" "}
                  <span className="font-medium">{p.base}</span>
                </span>
                <span className="tnum text-right text-ink-2">{value != null ? money(value) : "—"}</span>
                <a
                  href={`https://solscan.io/tx/${p.signature}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tnum truncate text-right text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink"
                  title="Open the transaction on Solscan"
                >
                  {p.wallet.slice(0, 4)}…{p.wallet.slice(-4)}
                </a>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
