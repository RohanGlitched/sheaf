"use client";

import { useMemo } from "react";
import { squarify, fitsTile, fitLabel } from "@/lib/treemap";
import { slotColor, CHART_SURFACE, inkOn } from "@/lib/palette";
import { percent } from "@/lib/format";
import { useMeasure } from "@/lib/use-measure";

export type BasketTile = {
  key: string;
  /** Ticker, e.g. "NVDA". */
  label: string;
  /** Company name, drawn only when a tile is large enough to hold it. */
  sub?: string;
  weightBps: number;
  /** Palette slot. Fixed per component so a weight change never repaints. */
  slot: number;
};

/**
 * The basket as it stands: one sheaves per component, area exactly its weight.
 *
 * Colour here is identity, not magnitude, so it comes from the eight-slot
 * categorical palette and is pinned to the component rather than to its rank. Drag
 * a weight and tiles resize; nothing changes colour, so the eye can follow a
 * single holding through the rearrangement.
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
  const { ref, width } = useMeasure<HTMLDivElement>();

  const laid = useMemo(() => {
    if (!width || !tiles.length) return [];
    const map = new Map(tiles.map((t) => [t.key, t]));
    return squarify(
      tiles.map((t) => ({ key: t.key, value: t.weightBps })),
      width,
      height,
      3,
    ).map((tile) => ({ ...tile, meta: map.get(tile.key)! }));
  }, [tiles, width, height]);

  return (
    <div ref={ref} style={{ height }} className="relative">
      {tiles.length === 0 ? (
        <div
          className="flex h-full items-center justify-center border border-dashed border-line-strong/60"
          style={{ background: CHART_SURFACE }}
        >
          <p className="max-w-[24ch] text-center text-sm leading-relaxed text-ink-3">
            {emptyHint}
          </p>
        </div>
      ) : (
        width > 0 && (
          <svg
            width={width}
            height={height}
            style={{ background: CHART_SURFACE }}
            role="img"
            aria-label={`Basket composition: ${tiles
              .map((t) => `${t.label} ${percent(t.weightBps / 100, 1)}`)
              .join(", ")}`}
          >
            {laid.map((tile) => {
              const color = slotColor(tile.meta.slot);
              // Nothing clips an SVG label, so each line is drawn only if the
              // string it holds fits the sheaf it belongs to.
              const weight = percent(tile.meta.weightBps / 100, 1);
              const label =
                tile.height > 26 ? fitLabel(tile.meta.label, 13, tile.width, 8) : null;
              const roomForLabel = label !== null;
              const roomForWeight =
                roomForLabel &&
                tile.height > 44 &&
                fitsTile(weight, 12, tile.width, 8);
              const roomForSub =
                roomForWeight &&
                tile.height > 68 &&
                !!tile.meta.sub &&
                fitsTile(tile.meta.sub, 11, tile.width, 8);
              return (
                <g
                  key={tile.key}
                  className="group mosaic-tile"
                  onClick={onRemove ? () => onRemove(tile.key) : undefined}
                  style={{ cursor: onRemove ? "pointer" : "default" }}
                >
                  <title>{`${tile.meta.label} ${weight}`}</title>
                  <rect
                    x={tile.x}
                    y={tile.y}
                    width={tile.width}
                    height={tile.height}
                    fill={color}
                    style={{
                      transition:
                        "x 300ms cubic-bezier(.2,.7,.2,1), y 300ms cubic-bezier(.2,.7,.2,1), width 300ms cubic-bezier(.2,.7,.2,1), height 300ms cubic-bezier(.2,.7,.2,1)",
                    }}
                  />
                  {roomForLabel && (
                    <text
                      x={tile.x + 8}
                      y={tile.y + 19}
                      fill={inkOn(color)}
                      fontSize={13}
                      fontWeight={600}
                      pointerEvents="none"
                      style={{ transition: "x 300ms, y 300ms" }}
                    >
                      {label}
                    </text>
                  )}
                  {roomForWeight && (
                    <text
                      x={tile.x + 8}
                      y={tile.y + 35}
                      className="tnum"
                      fill={inkOn(color)}
                      fillOpacity={0.7}
                      fontSize={12}
                      pointerEvents="none"
                      style={{ transition: "x 300ms, y 300ms" }}
                    >
                      {weight}
                    </text>
                  )}
                  {roomForSub && (
                    <text
                      x={tile.x + 8}
                      y={tile.y + tile.height - 9}
                      fill={inkOn(color)}
                      fillOpacity={0.55}
                      fontSize={11}
                      pointerEvents="none"
                      style={{ transition: "x 300ms, y 300ms" }}
                    >
                      {tile.meta.sub}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )
      )}
    </div>
  );
}
