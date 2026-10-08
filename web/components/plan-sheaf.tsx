import { SheafMark } from "./sheaf-mark";

/**
 * A monthly plan drawn as a sheaf that grows: every run that has filled adds one
 * stalk, so a year of buying is a full bundle. Stalks are coloured by run, from
 * the first (deepest) to the latest (brightest), and the band ties whatever has
 * been gathered so far.
 */
const SHADES = ["#1f5c40", "#2f7d5b", "#3f8f68", "#5a9f6f", "#7aad6c", "#9bb866", "#b9821a", "#c99a35"];

export function PlanSheaf({ filled, total, className }: { filled: number; total: number; className?: string }) {
  const n = Math.max(1, Math.min(filled, 12));
  const stalks =
    filled === 0
      ? [{ key: "seed", weight: 0.4, color: "#c2cbbd" }]
      : Array.from({ length: n }, (_, i) => ({
          key: `run-${i}`,
          // Later runs stand a touch taller, so the bundle reads as growing.
          weight: 0.6 + (0.4 * (i + 1)) / n,
          color: SHADES[Math.floor((i / Math.max(1, n - 1)) * (SHADES.length - 1))],
        }));
  return (
    <SheafMark
      stalks={stalks}
      className={className}
      title={`${filled} of ${total} runs gathered`}
    />
  );
}
