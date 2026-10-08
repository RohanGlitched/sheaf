import type { CSSProperties } from "react";

/**
 * The Sheaf mark: a basket drawn as what its name says.
 *
 * Every component is one stalk. A stalk's height above the band is its weight in
 * the recipe, its ear is the component's color, and all of them cross at one
 * band: the single share that binds them. Below the band the stalks flare again,
 * shorter, the way a tied sheaf stands on its own. The same function draws the
 * 20px avatar on a card and the hero on the home page, so a basket looks the same
 * everywhere it appears.
 */

export type Stalk = {
  key: string;
  /** Recipe weight as a fraction of 1. */
  weight: number;
  color: string;
  /** Ticker shown at the tip when labels are on. */
  label?: string;
  /** Second line under the ticker, e.g. a 24h move. */
  sub?: string;
  subTone?: "gain" | "loss" | "flat";
};

type Props = {
  stalks: Stalk[];
  /** Draw tickers at the tips. Use for large sizes only. */
  labels?: boolean;
  /** The stalks gather and the band ties them, once, on first paint. */
  animate?: boolean;
  /** Text on a leader line from the band, e.g. "100.0% backed". */
  bandNote?: string;
  className?: string;
  title?: string;
};

const W = 560;
const H = 600;
const CX = 280;
const CY = 420;

const deg = (r: number) => (r * 180) / Math.PI;

function layout(stalks: Stalk[]) {
  const n = stalks.length;
  if (n === 0) return [];
  // Heaviest stalks stand in the middle, lighter ones lean outward.
  const sorted = [...stalks].sort((a, b) => b.weight - a.weight);
  const order: Stalk[] = new Array(n);
  let left = Math.floor((n - 1) / 2);
  let right = left + 1;
  sorted.forEach((s, i) => {
    if (i % 2 === 0) order[left--] = s;
    else order[right++] = s;
  });
  const wMax = Math.max(...stalks.map((s) => s.weight), 1e-9);
  const span = n === 1 ? 0 : Math.min(84, 16 + 11 * (n - 1)) * (Math.PI / 180);
  return order.map((s, i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const angle = t * span; // radians from vertical, positive leans right
    const up = 130 + 150 * Math.sqrt(s.weight / wMax);
    const down = 104 + ((i * 37) % 17);
    const ux = Math.sin(angle);
    const uy = -Math.cos(angle);
    const tip = { x: CX + ux * up, y: CY + uy * up };
    // The lower half flares at a little over half the angle.
    const la = angle * 0.62;
    const foot = { x: CX - Math.sin(la) * down, y: CY + Math.cos(la) * down };
    // Bow the upper stalk outward, more for the outer stalks.
    const bow = 22 * t;
    const ctrl = {
      x: CX + ux * up * 0.55 + Math.cos(angle) * bow,
      y: CY + uy * up * 0.55 + Math.sin(angle) * bow,
    };
    return { s, i, angle, tip, foot, ctrl, ux, uy };
  });
}

function Ear({ x, y, ux, uy, color }: { x: number; y: number; ux: number; uy: number; color: string }) {
  const px = -uy;
  const py = ux;
  const a = deg(Math.atan2(uy, ux)) + 90;
  const seeds = [];
  for (let k = 0; k < 7; k++) {
    const side = k % 2 === 0 ? 1 : -1;
    const along = 6.4 * k + 4;
    const cx = x - ux * along + px * 3.4 * side;
    const cy = y - uy * along + py * 3.4 * side;
    seeds.push(
      <ellipse
        key={k}
        cx={cx}
        cy={cy}
        rx={3.5}
        ry={7.2}
        transform={`rotate(${a + side * 22} ${cx} ${cy})`}
        fill={color}
      />,
    );
  }
  return (
    <g>
      {seeds}
      <ellipse cx={x + ux * 3} cy={y + uy * 3} rx={3} ry={6.4} transform={`rotate(${a} ${x + ux * 3} ${y + uy * 3})`} fill={color} />
      {/* Awns: the fine bristles that make an ear read as grain, not a leaf. */}
      <line
        x1={x + ux * 6}
        y1={y + uy * 6}
        x2={x + ux * 24 + px * 4}
        y2={y + uy * 24 + py * 4}
        stroke={color}
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.7}
      />
      <line
        x1={x + ux * 6}
        y1={y + uy * 6}
        x2={x + ux * 22 - px * 5}
        y2={y + uy * 22 - py * 5}
        stroke={color}
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.7}
      />
    </g>
  );
}

export function SheafMark({ stalks, labels = false, animate = false, bandNote, className, title }: Props) {
  const placed = layout(stalks);
  const n = placed.length;
  const bandW = 34 + Math.min(n, 8) * 9;
  const strokeW = labels ? 3.2 : 4.2;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {placed.map(({ s, i, angle, tip, foot, ctrl, ux, uy }) => {
        const style = animate
          ? ({
              transformOrigin: `${CX}px ${CY}px`,
              animation: `sheaf-gather 1150ms cubic-bezier(0.2, 0.8, 0.2, 1) both`,
              animationDelay: `${i * 70}ms`,
              "--a0": `${deg(angle) * 1.5 + (i % 2 ? 9 : -9)}deg`,
            } as CSSProperties)
          : undefined;
        return (
          <g key={s.key} style={style}>
            <path
              d={`M ${foot.x} ${foot.y} L ${CX} ${CY} Q ${ctrl.x} ${ctrl.y} ${tip.x} ${tip.y}`}
              fill="none"
              stroke={s.color}
              strokeOpacity={0.78}
              strokeWidth={strokeW}
              strokeLinecap="round"
            />
            <Ear x={tip.x} y={tip.y} ux={ux} uy={uy} color={s.color} />
          </g>
        );
      })}

      {n > 0 && (
        <g
          style={
            animate
              ? ({
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  animation: "sheaf-bind 560ms cubic-bezier(0.3, 0.9, 0.3, 1) both",
                  animationDelay: `${900 + n * 40}ms`,
                } as CSSProperties)
              : undefined
          }
        >
          <rect
            x={CX - bandW / 2}
            y={CY - 13}
            width={bandW}
            height={26}
            rx={8}
            fill="var(--color-bind)"
          />
          <rect
            x={CX - bandW / 2 + 5}
            y={CY - 9}
            width={bandW - 10}
            height={3}
            rx={1.5}
            fill="#ffffff"
            opacity={0.28}
          />
        </g>
      )}

      {labels &&
        placed.map(({ s, i, tip, ux, uy }) => {
          if (!s.label) return null;
          const lx = tip.x + ux * 40;
          const ly = tip.y + uy * 40;
          const anchor = ux > 0.12 ? "start" : ux < -0.12 ? "end" : "middle";
          const tone =
            s.subTone === "gain"
              ? "var(--color-gain)"
              : s.subTone === "loss"
                ? "var(--color-loss)"
                : "var(--color-ink-3)";
          return (
            <g
              key={`l-${s.key}`}
              style={
                animate
                  ? { animation: "sheaf-fade 420ms ease-out both", animationDelay: `${1200 + i * 50}ms` }
                  : undefined
              }
            >
              <text
                x={lx}
                y={ly - (s.sub ? 8 : 0)}
                textAnchor={anchor}
                className="display"
                fontSize={20}
                fontWeight={600}
                fill="var(--color-ink)"
              >
                {s.label}
              </text>
              {s.sub && (
                <text x={lx} y={ly + 12} textAnchor={anchor} fontSize={13} fill={tone} className="tnum">
                  {s.sub}
                </text>
              )}
            </g>
          );
        })}

      {labels && bandNote && n > 0 && (
        <g
          style={
            animate
              ? { animation: "sheaf-fade 420ms ease-out both", animationDelay: `${1500 + n * 40}ms` }
              : undefined
          }
        >
          <line
            x1={CX + bandW / 2 + 6}
            y1={CY}
            x2={CX + bandW / 2 + 70}
            y2={CY}
            stroke="var(--color-bind)"
            strokeWidth={1.2}
          />
          <text x={CX + bandW / 2 + 78} y={CY + 5} fontSize={14} fill="var(--color-bind)" className="tnum">
            {bandNote}
          </text>
        </g>
      )}
    </svg>
  );
}

/** Stalks for a recipe, colored by slot. */
export function stalksFromWeights(
  rows: { key: string; weightBps: number; color: string; label?: string; sub?: string; subTone?: Stalk["subTone"] }[],
): Stalk[] {
  return rows.map((r) => ({
    key: r.key,
    weight: r.weightBps / 10_000,
    color: r.color,
    label: r.label,
    sub: r.sub,
    subTone: r.subTone,
  }));
}
