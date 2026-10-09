/**
 * The clock a basket's "beat SPY this week" market runs on.
 *
 * Tokens trade around the clock, but SPY's close-to-close change only exists at
 * US closes, so both sides of the comparison are read at the same two closes:
 * the regular-session close (16:00 New York time) on the Friday before the
 * market ends, and on the Friday it ends. When a Friday is a market holiday,
 * the close used is the last one at or before it.
 *
 * Shared by the market draft (lib/panta-server.ts), the NAV route's `?at=`
 * reader and the /predict page, so the rule, the window and the numbers can
 * never disagree.
 */

const NY = "America/New_York";
export const CLOSE_HOUR_NY = 16;
/** A close is only final once history has had time to refresh after it (its cache is an hour). */
export const CLOSE_SETTLE_S = 61 * 60;

type Parts = { y: number; m: number; d: number; hour: number; minute: number; weekday: number };

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall-clock parts in New York for a unix time in seconds. */
export function nyParts(unix: number): Parts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(unix * 1000)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** Unix seconds for a New York wall-clock time (correct across daylight saving). */
export function nyToUnix(y: number, m: number, d: number, hour: number, minute = 0): number {
  const guess = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  const seen = nyParts(guess);
  const asUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hour, seen.minute) / 1000;
  return guess - (asUtc - guess);
}

export const dayOf = (p: { y: number; m: number; d: number }) => p.y * 10000 + p.m * 100 + p.d;
export const dayIso = (day: number) =>
  `${Math.floor(day / 10000)}-${String(Math.floor(day / 100) % 100).padStart(2, "0")}-${String(day % 100).padStart(2, "0")}`;

/** Friday 16:00 New York on the week containing `unix` (or the next Friday if that one has passed). */
function fridayCloseOnOrAfter(unix: number): number {
  const p = nyParts(unix);
  const ahead = (5 - p.weekday + 7) % 7;
  const on = (days: number) => {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
    return nyToUnix(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), CLOSE_HOUR_NY);
  };
  const close = on(ahead);
  return close >= unix ? close : on(ahead + 7);
}

export type MarketWindow = {
  /** When trading opens on Panta: at least an hour out, as Panta requires. */
  opens: number;
  /** The Friday close the week is measured from. */
  fromClose: number;
  /** The Friday close it ends at: Panta's endTime. */
  toClose: number;
  /** When it can be resolved: once history has refreshed after the close. Panta's resolutionTime. */
  resolves: number;
};

/**
 * The window for a market opened at `now`: it ends at the first Friday close at
 * least a day after trading opens, and measures from the Friday close a week
 * before that. Part of the week can have passed when trading opens; the page
 * and the rule say so.
 */
export function marketWindow(now = Math.floor(Date.now() / 1000)): MarketWindow {
  const opens = now + 2 * 3600;
  const toClose = fridayCloseOnOrAfter(opens + 24 * 3600);
  // Noon a week earlier is safely on the previous Friday whatever daylight saving did.
  const before = nyParts(toClose - 7 * 86_400 - 4 * 3600);
  const fromClose = nyToUnix(before.y, before.m, before.d, CLOSE_HOUR_NY);
  return { opens, fromClose, toClose, resolves: toClose + CLOSE_SETTLE_S + 59 * 60 };
}

/**
 * The trading day (YYYYMMDD, New York) of the last regular-session close at or
 * before `unix`, before holidays: a time before 16:00 on a weekday names the
 * previous weekday, a weekend names Friday. Holidays are resolved against the
 * price history, which has no row for them (the last day at or before wins).
 */
export function closeDayAtOrBefore(unix: number): number {
  let p = nyParts(unix);
  let t = unix;
  const isClosed = (q: Parts) => q.weekday === 0 || q.weekday === 6 || q.hour < CLOSE_HOUR_NY;
  // Step back a day at a time (from noon, clear of DST edges) until a weekday at or after its close.
  if (isClosed(p)) {
    for (let i = 0; i < 7; i++) {
      t = nyToUnix(p.y, p.m, p.d, 12) - 86_400;
      p = nyParts(t);
      if (p.weekday !== 0 && p.weekday !== 6) break;
    }
  }
  return dayOf(p);
}

/** The close (unix) on a YYYYMMDD trading day. */
export const closeOn = (day: number) =>
  nyToUnix(Math.floor(day / 10000), Math.floor(day / 100) % 100, day % 100, CLOSE_HOUR_NY);

export const fmtClose = (unix: number) =>
  `${new Date(unix * 1000).toLocaleString("en-US", {
    timeZone: NY,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })}, 16:00 New York (${new Date(unix * 1000).toISOString().replace(".000Z", "Z")})`;

/** The resolution rule, word for word as it is sent to Panta and shown on the page. */
export function resolutionRule(symbol: string, navUrl: string, w: Pick<MarketWindow, "fromClose" | "toClose">) {
  return (
    `YES if ${symbol}'s navPerShare.listed from ${navUrl}?at=${w.toClose} divided by navPerShare.listed from ${navUrl}?at=${w.fromClose} ` +
    `is greater than spy.adjClose divided the same way (the same two URLs). ` +
    `Those times are the US regular-session closes on ${fmtClose(w.fromClose)} and ${fmtClose(w.toClose)}; ` +
    `if either Friday is a market holiday, the last close before it is used, which the JSON states as closeDay. ` +
    `NO otherwise, including a tie. Both values are recomputable from the inputs the JSON lists.`
  );
}
