"use client";

import { useState } from "react";
import { useMarket } from "./market-provider";
import { changeColor, inkOn } from "@/lib/palette";
import { money, signedPercent } from "@/lib/format";

/**
 * Two prices for one company. Every xStock has the price its token trades at on
 * Solana and the price of the listed share behind it. The gap is the premium, and
 * it is the thing a basket of tokens cannot pretend away, so it is laid out here
 * as stones: one per ticker, colored by how far the token sits from the share.
 */
export function Premiums() {
  const { snapshot } = useMarket();
  const rows = (snapshot?.quotes ?? [])
    .filter((q) => q.premiumBps != null && q.sharePrice != null)
    .sort((a, b) => b.premiumBps! - a.premiumBps!);
  if (!rows.length) return <div className="skeleton h-40 border border-line" />;
  const widest = [...rows].sort((a, b) => Math.abs(b.premiumBps!) - Math.abs(a.premiumBps!))[0];
  const tightest = [...rows].sort((a, b) => Math.abs(a.premiumBps!) - Math.abs(b.premiumBps!))[0];

  return (
    <div>
      <ul className="grid grid-cols-3 gap-1 sm:grid-cols-5 lg:grid-cols-10" aria-label="Premium of each token to its listed share">
        {rows.map((q) => {
          const pct = q.premiumBps! / 100;
          return (
            <li
              key={q.symbol}
              className="mosaic-tile relative aspect-[5/4] rounded-[var(--radius-control)] p-2.5"
              style={{ background: changeColor(pct * 3), color: inkOn(changeColor(pct * 3)) }}
              title={`${q.base}: token ${money(q.price)}, share ${money(q.sharePrice)}`}
            >
              <span className="block text-[11px] font-semibold tracking-wide">{q.base}</span>
              <span className="tnum display absolute bottom-2 left-2.5 text-lg leading-none">{signedPercent(pct)}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-sm leading-relaxed text-ink-2">
        <span className="text-ink">{widest.base}</span> is the widest gap right now, {signedPercent(widest.premiumBps! / 100)} against a share at{" "}
        {money(widest.sharePrice)}; <span className="text-ink">{tightest.base}</span> the tightest, at {signedPercent(tightest.premiumBps! / 100)}.
        Read from Solana mainnet and the listing&rsquo;s last print; the color runs from a discount in rust to a premium in teal.
      </p>
    </div>
  );
}

/**
 * A dividend here is a number going up. A tokenized equity pays by raising the
 * mint's scaled-amount multiplier, not by sending anything, so a holder's balance
 * reads higher while the raw units never move. Sheaf stores recipes in raw units
 * for exactly this reason.
 */
export function Dividends() {
  const { snapshot } = useMarket();
  const [all, setAll] = useState(false);
  const payers = (snapshot?.quotes ?? []).filter((q) => q.paysDividend).sort((a, b) => b.accruedYieldPct - a.accruedYieldPct);
  if (!snapshot) return <div className="skeleton h-40 rounded-[var(--radius-panel)] border border-line" />;
  if (!payers.length) return null;
  const max = Math.max(...payers.map((p) => p.accruedYieldPct), 0.01);
  // Eight fill two rows of four, or four rows of two, with no empty cell. The
  // rest are one click away rather than another screen of cards on a phone.
  const shown = all ? payers : payers.slice(0, 8);
  const fillPhone = shown.length % 2;
  const fillWide = (4 - (shown.length % 4)) % 4;

  return (
    <div>
      <ul
        className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-4"
        aria-label="Tokens that pay dividends through their multiplier"
      >
        {shown.map((q) => (
          <li key={q.symbol} className="min-w-0 bg-page p-4 sm:p-5">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-ink">{q.base}</span>
              <span className="hidden truncate text-xs text-ink-3 sm:inline">{q.company}</span>
            </p>
            <p className="tnum display mt-3 text-2xl text-ink sm:text-3xl">×{q.multiplier.toFixed(4)}</p>
            <p className="mt-1 hidden text-xs text-ink-3 sm:block">one raw unit reads as this many</p>
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-line-strong">
              <div className="h-full rounded-full bg-bind" style={{ width: `${Math.max(2, (q.accruedYieldPct / max) * 100)}%` }} />
            </div>
            <p className="tnum mt-2 text-xs text-ink-2">
              {q.accruedYieldPct.toFixed(2)}% accrued
              {q.nextMultiplier != null && q.nextMultiplierAt ? (
                <span className="hidden sm:inline">
                  {` · next step ×${q.nextMultiplier.toFixed(4)} on ${new Date(q.nextMultiplierAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                </span>
              ) : null}
            </p>
          </li>
        ))}
        {/* Blank cells close the last row, so the grid never shows a grey hole. */}
        {Array.from({ length: Math.max(fillPhone, fillWide) }, (_, i) => (
          <li
            key={`fill-${i}`}
            aria-hidden
            className={`bg-page ${i < fillPhone ? "" : "hidden"} ${i < fillWide ? "lg:block" : "lg:hidden"}`}
          />
        ))}
      </ul>
      {payers.length > 8 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-2.5 text-sm text-ink transition-colors hover:border-ink-3"
        >
          {all ? "Show the top eight" : `Show all ${payers.length}`}
        </button>
      )}
    </div>
  );
}
