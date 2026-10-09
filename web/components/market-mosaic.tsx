"use client";

import { useMemo, useState } from "react";
import { squarify, fitsTile } from "@/lib/treemap";
import { changeColor, CHANGE_LEGEND, CHART_SURFACE, COMPONENT_SLOTS, inkOn } from "@/lib/palette";
import {
  money,
  moneyCompact,
  signedPercent,
  count,
  percent,
} from "@/lib/format";
import type { Quote } from "@/lib/market";
import { useMeasure } from "@/lib/use-measure";
import { PRESTOCK_SYMBOLS } from "@/lib/prestocks";
import { Ticker } from "./ticker";

export type SizeBy = "liquidity" | "volume24h";

const SIZE_LABEL: Record<SizeBy, string> = {
  liquidity: "onchain liquidity",
  volume24h: "24h volume",
};

type Props = {
  quotes: Quote[];
  height?: number;
  sizeBy?: SizeBy;
  /** Mints currently in the basket being composed. Drawn with a gold border. */
  selected?: Set<string>;
  onToggle?: (mint: string) => void;
  /** Hide the legend and table toggle when a parent already shows them. */
  bare?: boolean;
  /**
   * Take the height of the box you are put in rather than a fixed number, so the
   * mosaic can grow to match a tall column beside it. `height` is then only the
   * value used before the box has been measured.
   */
  fill?: boolean;
};

/**
 * The market as a mosaic.
 *
 * Tile area is the depth of the on-chain market, so the tokens you could actually
 * buy in size are the tokens that dominate the picture. Color is the 24-hour
 * move on a diverging scale whose poles clear a worst-case color-vision
 * separation of 8.1; the signed figure is printed on every tile that can hold it,
 * and the table underneath carries every number for the tiles that cannot.
 */
export function MarketMosaic({
  quotes,
  height = 460,
  sizeBy = "liquidity",
  selected,
  onToggle,
  bare = false,
  fill = false,
}: Props) {
  const { ref, width, height: measured } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [size, setSize] = useState<SizeBy>(sizeBy);

  // Rounded, because a fractional height would relay the whole mosaic on every
  // sub-pixel change the observer reports.
  const box = fill && measured > 0 ? Math.round(measured) : height;

  const tiles = useMemo(() => {
    if (!width) return [];
    const values = quotes.map((q) => ({
      key: q.mint,
      value: (size === "liquidity" ? q.liquidity : q.volume24h ?? 0) || 1,
    }));
    return squarify(values, width, box, 3);
  }, [quotes, width, box, size]);

  const byMint = useMemo(
    () => new Map(quotes.map((q) => [q.mint, q])),
    [quotes],
  );
  const hovered = hover ? byMint.get(hover) : null;
  const hoveredTile = hover ? tiles.find((t) => t.key === hover) : null;

  return (
    <figure className={fill ? "m-0 flex h-full flex-col" : "m-0"}>
      {!bare && (
        <figcaption className="mb-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="display text-xl text-ink">
              Tokenized equities and pre-IPO SPVs, live on Solana
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              Tile area is {SIZE_LABEL[size]}. Color is the 24-hour move. The{" "}
              <span
                className="inline-block size-2 rounded-full align-[-1px]"
                style={{ background: COMPONENT_SLOTS[3] }}
                aria-hidden
              />{" "}
              mark is PreStocks: a pre-IPO SPV, not a listed company.
            </p>
          </div>
          <div className="flex items-center gap-1 text-xs">
            {(["liquidity", "volume24h"] as SizeBy[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSize(option)}
                aria-pressed={size === option}
                className={`border px-2.5 py-1.5 transition-colors ${
                  size === option
                    ? "border-bind/60 bg-bind/10 text-ink"
                    : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                }`}
              >
                {option === "liquidity" ? "Liquidity" : "Volume"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              className={`ml-2 border px-2.5 py-1.5 transition-colors ${
                asTable
                  ? "border-bind/60 bg-bind/10 text-ink"
                  : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
              }`}
            >
              Table
            </button>
          </div>
        </figcaption>
      )}

      {asTable ? (
        <QuoteTable quotes={quotes} selected={selected} onToggle={onToggle} />
      ) : (
        <div
          ref={ref}
          // Capped: a mosaic you have to scroll to see is no longer a picture of
          // the market, however much room the column beside it has.
          className={fill ? "relative min-h-0 max-h-[46rem] flex-1" : "relative"}
          style={fill ? undefined : { height }}
        >
          {width > 0 && (
            <svg
              width={width}
              height={box}
              role="group"
              aria-label={`Market map of ${quotes.length} tokenized equities, sized by ${SIZE_LABEL[size]}`}
              style={{ background: CHART_SURFACE }}
            >
              {tiles.map((tile, index) => {
                const q = byMint.get(tile.key);
                if (!q) return null;
                const isSelected = selected?.has(tile.key) ?? false;
                const isHovered = hover === tile.key;
                // Each line has to fit the string it will actually draw, and no
                // line appears without the one above it — a tile showing only a
                // percentage would be a percentage of nothing named.
                const change = signedPercent(q.change24h, 2);
                const roomForLabel =
                  tile.height > 30 && fitsTile(q.base, 13, tile.width, 9);
                const roomForChange =
                  roomForLabel &&
                  tile.height > 46 &&
                  fitsTile(change, 12, tile.width, 9);
                const roomForName =
                  roomForChange &&
                  tile.height > 76 &&
                  fitsTile(q.company, 11, tile.width, 9);

                return (
                  <g
                    key={tile.key}
                    onMouseEnter={() => setHover(tile.key)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(tile.key)}
                    onBlur={() => setHover(null)}
                    onClick={onToggle ? () => onToggle(tile.key) : undefined}
                    tabIndex={onToggle ? 0 : -1}
                    role={onToggle ? "checkbox" : "img"}
                    aria-checked={onToggle ? isSelected : undefined}
                    aria-label={`${q.company}, ${q.symbol}, ${money(q.price)}, ${signedPercent(q.change24h)} over 24 hours`}
                    onKeyDown={
                      onToggle
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onToggle(tile.key);
                            }
                          }
                        : undefined
                    }
                    className="mosaic-tile"
                    style={{
                      cursor: onToggle ? "pointer" : "default",
                      animationDelay: `${Math.min(index, 30) * 14}ms`,
                    }}
                  >
                    <title>{`${q.base}, ${q.company}: ${money(q.price)}, ${change} over 24 hours`}</title>
                    <rect
                      x={tile.x}
                      y={tile.y}
                      width={tile.width}
                      height={tile.height}
                      fill={changeColor(q.change24h)}
                      opacity={hover && !isHovered ? 0.62 : 1}
                    />
                    {(isSelected || isHovered) && (
                      <rect
                        x={tile.x + 1}
                        y={tile.y + 1}
                        width={Math.max(0, tile.width - 2)}
                        height={Math.max(0, tile.height - 2)}
                        fill="none"
                        stroke={isSelected ? "var(--color-bind)" : "var(--color-ink)"}
                        strokeWidth={2}
                      />
                    )}
                    {q.paysDividend && tile.width > 40 && tile.height > 40 && (
                      // A dividend is accruing into this mint's multiplier.
                      <circle
                        cx={tile.x + tile.width - 8}
                        cy={tile.y + 8}
                        r={2.5}
                        fill="var(--color-bind)"
                      />
                    )}
                    {PRESTOCK_SYMBOLS.has(q.symbol) &&
                      tile.width > 40 &&
                      tile.height > 40 && (
                        // A PreStocks pre-IPO token, not a public xStock equity.
                        <circle
                          cx={tile.x + 8}
                          cy={tile.y + 8}
                          r={2.5}
                          fill={COMPONENT_SLOTS[3]}
                        />
                      )}
                    {roomForLabel && (
                      <text
                        x={tile.x + 9}
                        y={tile.y + 20}
                        className="tnum"
                        fill={inkOn(changeColor(q.change24h))}
                        fontSize={13}
                        fontWeight={500}
                        pointerEvents="none"
                      >
                        {q.base}
                      </text>
                    )}
                    {roomForChange && (
                      <text
                        x={tile.x + 9}
                        y={tile.y + 37}
                        className="tnum"
                        fill={inkOn(changeColor(q.change24h))}
                        fillOpacity={0.86}
                        fontSize={12}
                        pointerEvents="none"
                      >
                        {change}
                      </text>
                    )}
                    {roomForName && (
                      <text
                        x={tile.x + 9}
                        y={tile.y + tile.height - 10}
                        fill={inkOn(changeColor(q.change24h))}
                        fillOpacity={0.62}
                        fontSize={11}
                        pointerEvents="none"
                      >
                        {q.company}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {hovered && hoveredTile && (
            <TileTooltip
              quote={hovered}
              anchor={hoveredTile}
              containerWidth={width}
              containerHeight={box}
            />
          )}
        </div>
      )}

      {!bare && !asTable && <ChangeLegend />}
    </figure>
  );
}

function TileTooltip({
  quote,
  anchor,
  containerWidth,
  containerHeight,
}: {
  quote: Quote;
  anchor: { x: number; y: number; width: number; height: number };
  containerWidth: number;
  containerHeight: number;
}) {
  const W = 268;
  const left = Math.min(
    Math.max(4, anchor.x + anchor.width / 2 - W / 2),
    Math.max(4, containerWidth - W - 4),
  );
  const below = anchor.y + anchor.height / 2 < containerHeight / 2;
  const style = below
    ? { left, top: anchor.y + anchor.height + 8 }
    : { left, bottom: containerHeight - anchor.y + 8 };

  return (
    <div
      className="pointer-events-none absolute z-30 border border-line-strong bg-page/97 p-4 shadow-2xl shadow-black/60 rounded-[var(--radius-panel)]"
      style={{ width: W, ...style }}
      role="tooltip"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink">{quote.company}</span>
        <span className="tnum text-xs text-ink-3">{quote.symbol}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-2.5">
        <span className="tnum display text-2xl text-ink">
          {money(quote.price)}
        </span>
        <span
          className="tnum text-sm"
          style={{
            color:
              quote.change24h == null
                ? "var(--color-ink-2)"
                : quote.change24h > 0
                  ? "var(--color-gain)"
                  : "var(--color-loss)",
          }}
        >
          {signedPercent(quote.change24h)}
        </span>
      </div>

      <dl className="mt-4 space-y-1.5 text-xs">
        {PRESTOCK_SYMBOLS.has(quote.symbol) ? (
          <Row label="Source" value="PreStocks · pre-IPO SPV" gold={false} lapis />
        ) : (
          <>
            <Row
              label="Listed share"
              value={money(quote.sharePrice)}
            />
            <Row
              label="Token vs share"
              value={
                quote.premiumBps == null
                  ? "—"
                  : `${quote.premiumBps > 0 ? "+" : "−"}${Math.abs(quote.premiumBps / 100).toFixed(2)}%`
              }
            />
          </>
        )}
        <Row label="Liquidity" value={moneyCompact(quote.liquidity)} />
        <Row label="24h volume" value={moneyCompact(quote.volume24h)} />
        <Row label="Holders" value={count(quote.holders)} />
        <Row label="Value on Solana" value={moneyCompact(quote.onChainMcap)} />
        {quote.paysDividend && (
          <Row
            label="Dividends accrued"
            value={`+${percent(quote.accruedYieldPct)}`}
            gold
          />
        )}
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  gold = false,
  lapis = false,
}: {
  label: string;
  value: string;
  gold?: boolean;
  lapis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd
        className={`tnum ${gold ? "text-bind" : "text-ink-2"}`}
        style={lapis ? { color: COMPONENT_SLOTS[3] } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

export function ChangeLegend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-3">
      <div className="flex items-center gap-1.5">
        {CHANGE_LEGEND.map((step) => (
          <span
            key={step.label}
            className="size-3"
            style={{ background: step.color }}
            title={step.label}
            aria-hidden
          />
        ))}
        <span className="ml-1.5">24h move, −3% to +3%</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-bind" aria-hidden />
        <span>pays a dividend into its multiplier</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="size-1.5 rounded-full"
          style={{ background: COMPONENT_SLOTS[3] }}
          aria-hidden
        />
        <span>PreStocks: a pre-IPO SPV, not a public company</span>
      </div>
    </div>
  );
}

export function QuoteTable({
  quotes,
  selected,
  onToggle,
}: {
  quotes: Quote[];
  selected?: Set<string>;
  onToggle?: (mint: string) => void;
}) {
  return (
    // Seven columns of numbers will not fit a phone, so this one does scroll
    // sideways — but `min-w-0` keeps the scrolling inside the box instead of
    // letting the table's minimum width widen the page around it.
    <div className="min-w-0 overflow-x-auto border border-line">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">
          Every tokenized equity with its price, 24-hour move, premium to the
          listed share, liquidity and accrued dividends.
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th scope="col" className="px-4 py-3 font-normal">Ticker</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">Token</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">24h</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">Listed share</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">Premium</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">Liquidity</th>
            <th scope="col" className="px-4 py-3 text-right font-normal">Dividends</th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => {
            const isSelected = selected?.has(q.mint) ?? false;
            return (
              <tr
                key={q.mint}
                className={`border-b border-line/60 last:border-0 ${isSelected ? "bg-bind/[0.06]" : ""}`}
              >
                <th scope="row" className="px-4 py-2.5 text-left font-normal">
                  {onToggle ? (
                    // The smallest tiles are too small to tap, so when the table
                    // stands in for the mosaic every row can be picked from here.
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      onClick={() => onToggle(q.mint)}
                      className="-mx-2 -my-1.5 flex items-center gap-2.5 px-2 py-1.5 text-left transition-colors hover:bg-sunk"
                    >
                      <span
                        aria-hidden
                        className={`size-3 shrink-0 border ${isSelected ? "border-bind bg-bind" : "border-line-strong"}`}
                      />
                      <span className="text-ink">{q.base}</span>
                      <span className="text-xs text-ink-3">{q.company}</span>
                    </button>
                  ) : (
                    <>
                      <span className="text-ink">{q.base}</span>
                      <span className="ml-2 text-xs text-ink-3">{q.company}</span>
                    </>
                  )}
                </th>
                <td className="tnum px-4 py-2.5 text-right text-ink">
                  <Ticker value={money(q.price)} />
                </td>
                <td
                  className="tnum px-4 py-2.5 text-right"
                  style={{
                    color:
                      q.change24h == null
                        ? "var(--color-ink-2)"
                        : q.change24h > 0
                          ? "var(--color-gain)"
                          : "var(--color-loss)",
                  }}
                >
                  {signedPercent(q.change24h)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-2">
                  {money(q.sharePrice)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-2">
                  {q.premiumBps == null
                    ? "—"
                    : `${q.premiumBps > 0 ? "+" : "−"}${Math.abs(q.premiumBps / 100).toFixed(2)}%`}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-2">
                  {moneyCompact(q.liquidity)}
                </td>
                <td className="tnum px-4 py-2.5 text-right">
                  {q.paysDividend ? (
                    <span className="text-bind">+{percent(q.accruedYieldPct)}</span>
                  ) : PRESTOCK_SYMBOLS.has(q.symbol) ? (
                    <span className="text-ink-3">pre-IPO</span>
                  ) : (
                    <span className="text-ink-3">none yet</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
