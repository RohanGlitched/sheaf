"use client";

import { slotColor } from "@/lib/palette";
import { SheafMark } from "./sheaf-mark";

export type BasketTile = {
  key: string;
  /** Ticker, e.g. "NVDA". */
  label: string;
  /** Company name, shown beside the ticker when there is room. */
  sub?: string;
  weightBps: number;
  /** Palette slot. Fixed per component so a weight change never repaints. */
  slot: number;
};

/**
 * A basket as it stands: its sheaf on the left, and the recipe beside it as a
 * column of stalk-colored weight bars, heaviest first.
 *
 * Color is identity, not magnitude, so it comes from the eight-slot palette and
 * is pinned to the component. Change a weight and the stalk and its bar move;
 * nothing changes color, so the eye can follow one holding.
 */
export function BasketMosaic({
  tiles,
  height = 260,
  onRemove,
  emptyHint = "Pick a ticker to add the first holding.",
}: {
  tiles: BasketTile[];
  height?: number;
  onRemove?: (key: string) => void;
  emptyHint?: string;
}) {
  if (tiles.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-[var(--radius-panel)] border border-dashed border-line-strong bg-surface"
      >
        <p className="max-w-[24ch] text-center text-sm leading-relaxed text-ink-3">{emptyHint}</p>
      </div>
    );
  }

  const total = tiles.reduce((s, t) => s + t.weightBps, 0) || 1;
  const rows = [...tiles].sort((a, b) => b.weightBps - a.weightBps);
  const max = rows[0].weightBps || 1;
  const compact = height < 180;

  return (
    <div style={{ minHeight: height }} className="flex items-center gap-4 sm:gap-6">
      <div className="aspect-square shrink-0" style={{ width: `min(${Math.round(height * 0.9)}px, 38%)` }}>
        <SheafMark
          stalks={tiles.map((t) => ({ key: t.key, weight: t.weightBps / total, color: slotColor(t.slot) }))}
          className="h-full w-full"
          title={`${tiles.length} holdings bound into one share`}
        />
      </div>
      <ul className={`min-w-0 flex-1 ${compact ? "space-y-1" : "space-y-2.5"}`} style={{ maxHeight: height, overflow: "hidden" }}>
        {rows.map((t) => {
          const share = t.weightBps / total;
          return (
            <li key={t.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={`truncate ${compact ? "text-xs" : "text-sm"} text-ink`}>
                  <span className="font-medium">{t.label}</span>
                  {t.sub && !compact && <span className="ml-2 text-ink-3">{t.sub}</span>}
                </span>
                <span className={`tnum shrink-0 ${compact ? "text-xs" : "text-sm"} text-ink-2`}>
                  {(share * 100).toFixed(share < 0.1 ? 1 : 0)}%
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(t.key)}
                      className="ml-2 rounded px-1 text-ink-3 hover:bg-sunk hover:text-loss"
                      aria-label={`Remove ${t.label}`}
                    >
                      ×
                    </button>
                  )}
                </span>
              </div>
              <div className={`mt-1 ${compact ? "h-1" : "h-1.5"} rounded-full bg-sunk`}>
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${(t.weightBps / max) * 100}%`, background: slotColor(t.slot) }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
