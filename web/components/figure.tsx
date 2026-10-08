import { Ticker } from "./ticker";

/**
 * One number with the sentence that makes it mean something.
 *
 * Used in the four-cell grids on the composer and the basket page. The note is not
 * optional by accident: a figure without it is a number a visitor has to guess at.
 */
export function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "gain" | "loss" | "gold";
}) {
  const color =
    tone === "gain"
      ? "var(--color-gain)"
      : tone === "loss"
        ? "var(--color-loss)"
        : tone === "gold"
          ? "var(--color-bind)"
          : "var(--color-ink)";
  return (
    <div className="bg-surface p-5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd>
        <span className="tnum display mt-1.5 block text-xl" style={{ color }}>
          <Ticker value={value} />
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">
          {note}
        </span>
      </dd>
    </div>
  );
}
