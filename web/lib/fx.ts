/**
 * One rupee rate for the whole site, so /plans, /business and the plan form
 * never disagree. Works on the server and in the browser (no React here; the
 * client hook is `useInrRate` in components/india-fx.tsx).
 *
 * The live rate comes from open.er-api.com (free, keyless, updated daily) and is
 * kept for an hour. If it can't be read, the dated fallback below is used and
 * labelled as such, never passed off as today's rate.
 */

export type Fx = {
  /** Rupees per US dollar. */
  rate: number;
  /** The day the rate is from, YYYY-MM-DD (UTC). */
  asOf: string;
  /** False when this is the fixed fallback, not a rate read just now. */
  live: boolean;
};

/** Used only when the live rate can't be read. Update the date with the number. */
export const FX_FALLBACK: Fx = { rate: 96.88, asOf: "2026-10-09", live: false };

const SOURCE = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 60 * 60 * 1000;

let cached: { fx: Fx; at: number } | null = null;
let inflight: Promise<Fx> | null = null;

async function read(): Promise<Fx> {
  try {
    const r = await fetch(SOURCE, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(8_000) } as RequestInit);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { rates?: { INR?: unknown }; time_last_update_unix?: unknown };
    const rate = j.rates?.INR;
    if (typeof rate !== "number" || !(rate > 0)) throw new Error("no INR rate");
    const at = typeof j.time_last_update_unix === "number" ? new Date(j.time_last_update_unix * 1000) : new Date();
    const fx: Fx = { rate, asOf: at.toISOString().slice(0, 10), live: true };
    cached = { fx, at: Date.now() };
    return fx;
  } catch {
    // Keep the last good live rate if there is one; otherwise the dated fallback. Retry on the next call.
    return cached?.fx ?? FX_FALLBACK;
  }
}

/** Today's rupees per dollar, cached for an hour; never throws. */
export function getInrRate(): Promise<Fx> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.fx);
  inflight ??= read().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** ₹ in the Indian grouping, whole rupees: ₹1,00,000. */
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** "9 Oct 2026" for an Fx's date. */
export function fxDate(fx: Fx): string {
  const d = new Date(`${fx.asOf}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "₹96.88 to the dollar today", or "₹96.88 to the dollar (rate of 9 Oct 2026)" for the fallback. */
export function fxNote(fx: Fx): string {
  return `₹${fx.rate.toFixed(2)} to the dollar ${fx.live ? "today" : `(rate of ${fxDate(fx)})`}`;
}
