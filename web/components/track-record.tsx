"use client";

import { useId, useMemo, useState } from "react";
import { useHistory } from "@/lib/use-history";
import {
  RANGES,
  trackRecord,
  shortDay,
  type Range,
  type Track,
  type TrackComponent,
} from "@/lib/track";
import { money, percent, signedPercent } from "@/lib/format";
import { useMeasure } from "@/lib/use-measure";
import { Figure } from "./figure";

/**
 * What a recipe would have done.
 *
 * Every index product leads with a performance chart, and every one of them
 * asks to be believed. This one is arithmetic on public closes: the recipe's
 * fixed quantities times each day's price, ending exactly at today's value on
 * chain. The notes under it say what is held flat and what started late,
 * because a chart that hides either is a sales chart.
 */

const tone = (v: number | null | undefined) =>
  v == null ? undefined : v > 0 ? "gain" : v < 0 ? "loss" : undefined;

export function TrackRecord({
  components,
  symbol,
  createdAt,
}: {
  components: TrackComponent[];
  symbol: string;
  /** Unix seconds the basket was created, so the chart can say where the token's own life begins. */
  createdAt?: number;
}) {
  const { history, loading } = useHistory();
  const [range, setRange] = useState<Range>("1y");
  const track = useMemo(
    () => trackRecord(components, history, range),
    [components, history, range],
  );
  // No listed share behind any holding: there is nothing to draw at any range,
  // so the range buttons would only switch between empty panels.
  const noHistory = !loading && !track;
  const allUnlisted =
    history != null && components.length > 0 && components.every((c) => !history.series[c.base]);

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h2 className="display text-title text-ink">What this recipe would have done</h2>
          {!allUnlisted && (
            <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
              One {symbol} share is a fixed quantity of each holding, so its value on
              any past day is those quantities times that day&rsquo;s prices. Dividends
              are counted the way the tokens pay them, by compounding into the holding.
            </p>
          )}
        </div>
        <div className={`flex gap-2 ${noHistory ? "hidden" : ""}`} role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              className="border px-3 py-2 text-xs transition-colors rounded-[var(--radius-control)]"
              style={{
                borderColor: range === r.key ? "var(--color-bind)" : "var(--color-line)",
                color: range === r.key ? "var(--color-bind)" : "var(--color-ink-2)",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !track ? (
        <div className="mt-7 flex h-[280px] items-center justify-center rounded-[var(--radius-panel)] border border-line bg-surface text-sm text-ink-3">
          Reading a year of closes…
        </div>
      ) : !track ? (
        <p className="mt-5 max-w-[66ch] border-l-2 border-line-strong pl-4 text-sm leading-relaxed text-ink-2">
          {allUnlisted ? (
            <>
              Nothing to draw: every holding in {symbol} is a pre-IPO company, with no
              listed share and so no past closes. What a share is worth is what its
              tokens trade at on Solana today, shown above.
            </>
          ) : (
            <>No history could be read right now. Reload in a minute to try again.</>
          )}
        </p>
      ) : (
        <>
          <div className="mt-7 border border-line bg-surface p-4 sm:p-6 rounded-[var(--radius-panel)]">
            <Chart track={track} symbol={symbol} benchmark={history?.benchmark ?? "SPY"} createdAt={createdAt} />
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-4">
            <Figure
              label={`${RANGES.find((r) => r.key === range)?.label ?? ""}, total return`}
              value={signedPercent(track.returnPct)}
              note={
                Math.abs(track.returnPct - track.priceReturnPct) >= 0.05
                  ? `of which ${signedPercent(track.returnPct - track.priceReturnPct)} was dividends`
                  : "no dividends over this range"
              }
              tone={tone(track.returnPct)}
            />
            <Figure
              label={`Against ${history?.benchmark ?? "SPY"}`}
              value={
                track.benchReturnPct == null
                  ? "—"
                  : signedPercent(track.returnPct - track.benchReturnPct)
              }
              note={
                track.benchReturnPct == null
                  ? "benchmark unavailable"
                  : `the index fund did ${signedPercent(track.benchReturnPct)} over the same days`
              }
              tone={
                track.benchReturnPct == null ? undefined : tone(track.returnPct - track.benchReturnPct)
              }
            />
            <Figure
              label="Deepest fall"
              value={signedPercent(-Math.abs(track.maxDrawdownPct))}
              note="from a high to the low that followed it"
              tone={track.maxDrawdownPct < -10 ? "loss" : undefined}
            />
            <Figure
              label="Volatility, annualized"
              value={track.volPct == null ? "—" : percent(track.volPct, 1)}
              note={
                track.worstDay
                  ? `worst day ${signedPercent(track.worstDay.pct)} on ${shortDay(track.worstDay.d)}`
                  : "needs a month of closes"
              }
            />
          </dl>

          <Notes track={track} asOf={history?.asOf} />
        </>
      )}
    </section>
  );
}

function Notes({ track, asOf }: { track: Track; asOf?: string }) {
  const notes: string[] = [];
  if (track.unlisted.length) {
    notes.push(
      `${track.unlisted.join(", ")} ${track.unlisted.length === 1 ? "is a pre-IPO company with no listed share, so it is" : "are pre-IPO companies with no listed shares, so they are"} held flat at today's value: ${percent(track.listedShare * 100, 0)} of the basket has a history behind it.`,
    );
  }
  for (const s of track.startedLate) {
    notes.push(`${s.base} listed on ${shortDay(s.d, true)}, so the chart starts there.`);
  }
  if (track.stale.length) {
    notes.push(
      `Closes for ${track.stale.join(", ")} come from the snapshot in the repository${asOf ? `, last written ${asOf}` : ""}, because the live read failed.`,
    );
  }
  notes.push(
    "A backtest of the recipe at today's quantities, from the listed shares' closes. It is not the token's own trading history, and it does not include the cost of assembling the basket.",
  );
  return (
    <ul className="mt-5 max-w-[70ch] space-y-1.5 text-xs leading-relaxed text-ink-3">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------------------------- chart

const H = 280;
const PAD = { top: 18, right: 14, bottom: 26, left: 54 };

function Chart({
  track,
  symbol,
  benchmark,
  createdAt,
}: {
  track: Track;
  symbol: string;
  benchmark: string;
  createdAt?: number;
}) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  const w = Math.max(width, 280);

  const { points } = track;
  const xs = points.map((_, i) => i);
  const values = points.flatMap((p) => (p.bench == null ? [p.nav] : [p.nav, p.bench]));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || hi || 1;
  const yLo = lo - span * 0.06;
  const yHi = hi + span * 0.06;
  const x = (i: number) => PAD.left + (i / Math.max(1, xs.length - 1)) * (w - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

  const navPath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join("");
  const benchPath = points.every((p) => p.bench != null)
    ? points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.bench!).toFixed(1)}`).join("")
    : null;
  const area = `${navPath}L${x(points.length - 1).toFixed(1)},${(H - PAD.bottom).toFixed(1)}L${x(0).toFixed(1)},${(H - PAD.bottom).toFixed(1)}Z`;

  const first = points[0].nav;
  const y0 = y(first);

  // Up to five date ticks, at even intervals.
  const tickCount = w < 480 ? 3 : 5;
  const ticks = Array.from({ length: tickCount }, (_, k) =>
    Math.round((k * (points.length - 1)) / (tickCount - 1)),
  );
  const levels = [yLo + (yHi - yLo) * 0.1, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.1];

  // Where the basket itself was created, if that falls inside the range.
  const createdDay = createdAt
    ? Number(new Date(createdAt * 1000).toISOString().slice(0, 10).replaceAll("-", ""))
    : null;
  const createdIndex =
    createdDay != null && createdDay > points[0].d && createdDay <= points[points.length - 1].d
      ? points.findIndex((p) => p.d >= createdDay)
      : -1;

  const at = hover == null ? points.length - 1 : hover;
  const p = points[at];

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - PAD.left) / (w - PAD.left - PAD.right)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const up = track.returnPct >= 0;
  const line = up ? "var(--color-gain)" : "var(--color-loss)";

  return (
    <div ref={ref} className="min-w-0">
      <div className="tnum flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-xs text-ink-3">
        <span>
          <span className="text-ink">{shortDay(p.d, true)}</span>
          {" · "}
          <span className="inline-block size-2 align-middle" style={{ background: line }} aria-hidden />{" "}
          {symbol} <span className="text-ink">{money(p.nav)}</span>
          {p.bench != null && (
            <>
              {" · "}
              <span className="inline-block h-px w-3 border-t border-dashed border-ink-2 align-middle" aria-hidden />{" "}
              {benchmark} <span className="text-ink">{money(p.bench)}</span>
            </>
          )}
        </span>
        <span>
          from {shortDay(track.start, true)} to {shortDay(track.end, true)} · {points.length} sessions
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${H}`}
        width={w}
        height={H}
        className="mt-3 block max-w-full touch-none select-none"
        role="img"
        aria-label={`${symbol} would have returned ${signedPercent(track.returnPct)} from ${shortDay(track.start, true)} to ${shortDay(track.end, true)}${track.benchReturnPct != null ? `, against ${signedPercent(track.benchReturnPct)} for ${benchmark}` : ""}.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={line} stopOpacity="0.22" />
            <stop offset="1" stopColor={line} stopOpacity="0" />
          </linearGradient>
        </defs>

        {levels.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-line)" />
            <text x={PAD.left - 8} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--color-ink-3)" className="tnum">
              {money(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={w - PAD.right} y1={y0} y2={y0} stroke="var(--color-line-strong)" strokeDasharray="2 4" />

        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize="10" fill="var(--color-ink-3)">
            {shortDay(points[i].d)}
          </text>
        ))}

        {createdIndex > 0 && (
          <g>
            <line x1={x(createdIndex)} x2={x(createdIndex)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-bind)" strokeDasharray="2 3" />
            <text x={x(createdIndex) + 5} y={PAD.top + 10} fontSize="10" fill="var(--color-bind)">
              basket created
            </text>
          </g>
        )}

        <path d={area} fill={`url(#${gradientId})`} />
        {benchPath && <path d={benchPath} fill="none" stroke="var(--color-ink-2)" strokeWidth="1.25" strokeDasharray="4 4" />}
        <path d={navPath} fill="none" stroke={line} strokeWidth="2" strokeLinejoin="round" />

        <line x1={x(at)} x2={x(at)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-ink-3)" strokeOpacity={hover == null ? 0 : 0.6} />
        {p.bench != null && <circle cx={x(at)} cy={y(p.bench)} r="3" fill="var(--color-surface)" stroke="var(--color-ink-2)" strokeWidth="1.5" />}
        <circle cx={x(at)} cy={y(p.nav)} r="4.5" fill={line} stroke="var(--color-surface)" strokeWidth="2" />
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------- compact

/**
 * The past year in one line, for the composer: a sparkline that redraws as the
 * weights move, and the return against the benchmark beside it.
 */
export function TrackFigure({ components }: { components: TrackComponent[] }) {
  const { history, loading } = useHistory();
  const track = useMemo(() => trackRecord(components, history, "1y"), [components, history]);

  if (loading && !track) {
    return (
      <div className="col-span-2 bg-surface p-5">
        <p className="text-xs text-ink-3">Past year</p>
        <p className="mt-1.5 text-sm text-ink-3">Reading a year of closes…</p>
      </div>
    );
  }
  if (!track) {
    return (
      <div className="col-span-2 bg-surface p-5">
        <p className="text-xs text-ink-3">Past year</p>
        <p className="mt-1.5 text-sm text-ink-2">
          No listed history: every pick is a pre-IPO company.
        </p>
      </div>
    );
  }
  const relative = track.benchReturnPct == null ? null : track.returnPct - track.benchReturnPct;
  return (
    <div className="col-span-2 bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-ink-3">Past year, had it existed</p>
          <p className="tnum display mt-1.5 text-xl" style={{ color: track.returnPct >= 0 ? "var(--color-gain)" : "var(--color-loss)" }}>
            {signedPercent(track.returnPct)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            {relative == null
              ? "dividends compounded, costs excluded"
              : `${relative >= 0 ? "ahead of" : "behind"} ${history?.benchmark ?? "SPY"} by ${percent(Math.abs(relative), 1)} · fell ${percent(Math.abs(track.maxDrawdownPct), 0)} at worst`}
            {track.unlisted.length > 0 && ` · ${track.unlisted.join(", ")} held flat`}
          </p>
        </div>
        <Sparkline track={track} width={120} height={44} />
      </div>
    </div>
  );
}

/** A year in a hundred pixels. Green above where it started, red below. */
export function Sparkline({ track, width = 100, height = 32 }: { track: Track; width?: number; height?: number }) {
  const { points } = track;
  const lo = Math.min(...points.map((p) => p.nav));
  const hi = Math.max(...points.map((p) => p.nav));
  const span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * width;
  const y = (v: number) => 2 + (1 - (v - lo) / span) * (height - 4);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.nav).toFixed(1)}`).join("");
  const line = track.returnPct >= 0 ? "var(--color-gain)" : "var(--color-loss)";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="shrink-0" aria-hidden>
      <line x1={0} x2={width} y1={y(points[0].nav)} y2={y(points[0].nav)} stroke="var(--color-line-strong)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={line} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** The sparkline plus the number, for a card. */
export function CardTrack({ components }: { components: TrackComponent[] }) {
  const { history } = useHistory();
  const track = useMemo(() => trackRecord(components, history, "1y"), [components, history]);
  if (!track) {
    return <span className="text-ink-3">{history ? "pre-IPO, no history" : "…"}</span>;
  }
  return (
    /* Stacked, so on a phone-width card the line never runs into the next column. */
    <span className="flex flex-col items-start gap-1">
      <span style={{ color: track.returnPct >= 0 ? "var(--color-gain)" : "var(--color-loss)" }}>
        {signedPercent(track.returnPct, 1)}
      </span>
      <Sparkline track={track} width={56} height={16} />
    </span>
  );
}
