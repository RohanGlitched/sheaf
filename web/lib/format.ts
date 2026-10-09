/** Number and time formatting. Every figure shown to a reader passes through here. */

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd4 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01) return usd4.format(value);
  return usd2.format(value);
}

export function moneyWhole(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return usd0.format(value);
}

/** Compact money for axis ticks and dense tables: $27.5M, $857K. */
export function moneyCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(v / 1e9 >= 10 ? 0 : 1)}B`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(v / 1e6 >= 10 ? 0 : 1)}M`;
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(v / 1e3 >= 10 ? 0 : 1)}K`;
  return `${sign}$${v.toFixed(0)}`;
}

/**
 * A signed percentage, using a real minus sign rather than a hyphen. A value
 * that rounds to zero at the shown precision carries no sign, so nothing ever
 * reads "−0.00%".
 */
export function signedPercent(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const shown = Math.abs(value).toFixed(digits);
  if (Number(shown) === 0) return `${shown}%`;
  const sign = value > 0 ? "+" : "−";
  return `${sign}${shown}%`;
}

/** "1 share", "2 shares": the noun follows the number. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function percent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

/** Token quantities: enough precision to be honest, not enough to be noise. */
export function quantity(value: number | null | undefined, digits = 6): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) < 1e-6) return value.toExponential(2);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Convert a raw Token-2022 balance to the amount a holder actually owns.
 *
 * xStocks carry the ScaledUiAmount extension and use it to accrue dividends: the
 * multiplier drifts upward over time, so one raw unit is worth progressively more
 * than one nominal share. Dividing raw by 10^decimals — what most apps do —
 * understates the balance. The multiplier is the correction.
 */
export function scaledUiAmount(
  rawAmount: bigint | string | number,
  decimals: number,
  multiplier = 1,
): number {
  const raw = typeof rawAmount === "bigint" ? rawAmount : BigInt(rawAmount);
  return (Number(raw) / 10 ** decimals) * multiplier;
}

export function toRawUnits(amount: number, decimals: number): bigint {
  // Round rather than truncate, then go through a string to dodge float drift.
  const scaled = (amount * 10 ** decimals).toFixed(0);
  return BigInt(scaled);
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(timestampSeconds: number): string {
  const delta = timestampSeconds - Date.now() / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(delta) >= seconds) {
      return relative.format(Math.round(delta / seconds), unit);
    }
  }
  return "just now";
}

/** "2d 4h 11m" — used for the countdown to the next opening bell. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}
