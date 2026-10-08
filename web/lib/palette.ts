/**
 * Every data colour in Sheaf comes from here, and every value below was
 * produced and checked by the scripts in ../../scripts, not chosen by eye:
 *
 *   scripts/build-palette.mjs    -> COMPONENT_SLOTS  (categorical, 8 fixed slots)
 *   scripts/build-diverging.mjs  -> CHANGE_SCALE     (diverging, 24h price change)
 *
 * Both are tuned for the white chart surface for lightness band, chroma
 * floor, protan/deutan separation, normal-vision separation and contrast.
 * If you change a hex here, re-run the script and paste the new passing set.
 */

export const CHART_SURFACE = "#ffffff";

/**
 * Basket components, in fixed slot order. A basket holds at most 8 components,
 * which is exactly the palette size, so hues are assigned by slot index and are
 * never cycled or generated.
 *
 * Ultramarine is reserved for the band that binds a basket, so no slot uses it.
 */
export const COMPONENT_SLOTS = [
  "#2f7d5b", // field
  "#b9821a", // wheat
  "#2b78a3", // river
  "#8a4fa0", // plum
  "#c0553a", // clay
  "#5d6f1c", // olive
  "#c76a8c", // rose
  "#6e5338", // bark
] as const;

export const slotColor = (index: number): string =>
  COMPONENT_SLOTS[index % COMPONENT_SLOTS.length];

/**
 * 24h price change, as a diverging scale: two single-hue ramps out of one
 * neutral midpoint. Gains sit at hue 186 rather than a true green because the
 * green/red pair collapses under deuteranopia; at 186 the poles hold a worst-case
 * separation of 8.1 while still reading as the market's cool/warm convention.
 *
 * Contrast against the surface is below 3:1 at the faint end, so tiles using this
 * scale must carry a visible signed label and the view must offer a table.
 */
export const CHANGE_SCALE = {
  loss: ["#efc7bd", "#d9846c", "#b8432c"],
  neutral: "#d3d9d1",
  gain: ["#b5ddd4", "#4ea795", "#0b7a6b"],
} as const;

/** Percentage moves at or above this read as the strongest tile. */
const STRONG_MOVE = 3;
/** Moves below this are noise and read as neutral. */
const FLAT_MOVE = 0.1;

/** Map a percentage change onto the diverging scale. */
export function changeColor(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return CHANGE_SCALE.neutral;
  const magnitude = Math.abs(percent);
  if (magnitude < FLAT_MOVE) return CHANGE_SCALE.neutral;
  const ramp = percent > 0 ? CHANGE_SCALE.gain : CHANGE_SCALE.loss;
  if (magnitude >= STRONG_MOVE) return ramp[2];
  if (magnitude >= STRONG_MOVE / 2) return ramp[1];
  return ramp[0];
}

/** Ink colour for a signed figure. Used on text, never as a fill. */
export function changeInk(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return "var(--color-ink-2)";
  if (Math.abs(percent) < FLAT_MOVE) return "var(--color-ink-2)";
  return percent > 0 ? "var(--color-gain)" : "var(--color-loss)";
}

/**
 * Legend steps for the diverging scale, from strongest loss to strongest gain.
 * Rendered wherever the market map appears, because colour alone never carries
 * meaning.
 */
export const CHANGE_LEGEND = [
  { color: CHANGE_SCALE.loss[2], label: `−${STRONG_MOVE}% or worse` },
  { color: CHANGE_SCALE.loss[1], label: `−${STRONG_MOVE / 2}%` },
  { color: CHANGE_SCALE.loss[0], label: "slightly down" },
  { color: CHANGE_SCALE.neutral, label: "flat" },
  { color: CHANGE_SCALE.gain[0], label: "slightly up" },
  { color: CHANGE_SCALE.gain[1], label: `+${STRONG_MOVE / 2}%` },
  { color: CHANGE_SCALE.gain[2], label: `+${STRONG_MOVE}% or better` },
] as const;

/** Text colour that stays readable on a given fill: deep ink on light tiles, white on dark ones. */
export function inkOn(fill: string): string {
  const hex = fill.replace("#", "");
  if (hex.length !== 6) return "#14251c";
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  // White wins when its contrast beats the ink's.
  return (1.05) / (lum + 0.05) >= (lum + 0.05) / (0.0168 + 0.05) ? "#ffffff" : "#14251c";
}
