/**
 * The clock a basket's "beat SPY this week" market runs on.
 *
 * Tokens trade around the clock, but SPY's close-to-close change only exists at
 * US closes, so both sides of the comparison are read at the same two closes:
 * the last NYSE regular-session close of the first week whose close is at
 * least a day after trading opens, and of the week after. Closes come from the
 * exchange calendar: normally Friday 16:00 New York, Thursday's close when
 * Friday is a holiday, 13:00 on an early-close Friday. Trading closes at the
 * first of the two closes, when the measured week starts, so every share is
 * bought before anything of that week is known, and nobody trades a week that
 * is under way or decided.
 *
 * Shared by the market draft (lib/panta-server.ts), the NAV route's `?at=`
 * reader and the /predict page, so the rule, the window and the numbers can
 * never disagree.
 */

import { parseSchedule, type Session } from "./clock";
import { XSTOCKS } from "./universe";

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

/**
 * The NYSE regular-session calendar, from the schedule Pyth publishes for SPY
 * (captured in lib/universe.ts and parsed by lib/clock.ts): weekday hours plus
 * dated overrides for holidays (`1225/C`) and early closes (`1127/0930-1300`).
 * The overrides are month-day only and cover the year after the capture
 * (Sept 2026 to Sept 2027); re-run scripts/gen-universe.mjs to extend them.
 */
const SPY = parseSchedule(XSTOCKS.find((s) => s.base === "SPY")?.schedule ?? null);

/** The regular session on a New York calendar date, or null when the exchange is shut all day. */
export function sessionOn(y: number, m: number, d: number): Session {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const md = `${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  if (SPY) {
    if (SPY.overrides.has(md)) return SPY.overrides.get(md)!;
    return SPY.week[(dow + 6) % 7];
  }
  // No schedule: weekdays 09:30-16:00.
  return dow === 0 || dow === 6 ? null : { openMinute: 570, closeMinute: CLOSE_HOUR_NY * 60 };
}

const shift = (y: number, m: number, d: number, days: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** The actual close (unix) of the session on a date, or null if there is none. */
function closeOnDate(y: number, m: number, d: number): number | null {
  const s = sessionOn(y, m, d);
  return s ? nyToUnix(y, m, d, Math.floor(s.closeMinute / 60), s.closeMinute % 60) : null;
}

/** The last session close on or before a date: a holiday Friday gives Thursday's (possibly early) close. */
function lastCloseOnOrBefore(y: number, m: number, d: number): { day: number; close: number } {
  for (let back = 0; back < 10; back++) {
    const p = shift(y, m, d, -back);
    const close = closeOnDate(p.y, p.m, p.d);
    if (close != null) return { day: dayOf(p), close };
  }
  return { day: dayOf({ y, m, d }), close: nyToUnix(y, m, d, CLOSE_HOUR_NY) };
}

/**
 * The week-ending close at or after `unix`: for the Friday of that week, the
 * last session close on or before it (Thursday's on a holiday Friday, 13:00 on
 * an early close). If that has already passed, the next week's.
 */
function weekCloseOnOrAfter(unix: number): { friday: { y: number; m: number; d: number }; close: number } {
  const p = nyParts(unix);
  const ahead = (5 - p.weekday + 7) % 7;
  for (let week = 0; week < 4; week++) {
    const friday = shift(p.y, p.m, p.d, ahead + 7 * week);
    const { close } = lastCloseOnOrBefore(friday.y, friday.m, friday.d);
    if (close >= unix) return { friday, close };
  }
  const friday = shift(p.y, p.m, p.d, ahead + 28);
  return { friday, close: lastCloseOnOrBefore(friday.y, friday.m, friday.d).close };
}

/** Trading runs at least this long before it closes at the first close, so a Friday-afternoon market is not an hour wide. */
export const MIN_TRADING_S = 24 * 3600;

export type MarketWindow = {
  /** When trading opens on Panta: at least an hour out, as Panta requires. */
  opens: number;
  /** The week-ending close the week is measured from. Trading closes here: Panta's endTime. */
  fromClose: number;
  /** The week-ending close the measured week ends at. */
  toClose: number;
  /** When it can be resolved: once history has refreshed after the close. Panta's resolutionTime. */
  resolves: number;
};

/**
 * The window for a market opened at `now`. The measured week starts at the
 * first week-ending close at least a day after trading opens, and ends at the
 * next week's. Both are real NYSE closes: a holiday Friday (Dec 25 2026, Jan 1
 * 2027) uses Thursday's close, and an early-close Friday (Nov 27 2026) its
 * 13:00 close. Trading closes at the first close (`pantaTimes`), so every share
 * is bought before any of the measured week is known.
 */
export function marketWindow(now = Math.floor(Date.now() / 1000)): MarketWindow {
  const opens = now + 2 * 3600;
  const from = weekCloseOnOrAfter(opens + MIN_TRADING_S);
  const nextFriday = shift(from.friday.y, from.friday.m, from.friday.d, 7);
  const toClose = lastCloseOnOrBefore(nextFriday.y, nextFriday.m, nextFriday.d).close;
  return { opens, fromClose: from.close, toClose, resolves: toClose + CLOSE_SETTLE_S + 59 * 60 };
}

/**
 * The times Panta is sent for a window: trading opens at `opens` and closes at
 * the first close, when the measured week starts (endTime = fromClose); the
 * market resolves once the second close is final.
 */
export function pantaTimes(w: MarketWindow): { startTime: number; endTime: number; resolutionTime: number } {
  return { startTime: w.opens, endTime: w.fromClose, resolutionTime: w.resolves };
}

/**
 * The last full week that is already decided at `now`: its week-ending close
 * (`toClose`) is final (`CLOSE_SETTLE_S` after the bell), and `fromClose` is
 * the week-ending close before it. Both come from the exchange calendar, so a
 * holiday week ends at Thursday's close and the week before it at its own
 * Friday's. This is the week /predict resolves as a worked example; on a
 * Friday afternoon it is last week, not today's unsettled close.
 */
export function lastSettledWeek(now = Math.floor(Date.now() / 1000)): { fromClose: number; toClose: number } {
  const p = nyParts(now);
  const ahead = (5 - p.weekday + 7) % 7;
  for (let week = 0; week < 6; week++) {
    const friday = shift(p.y, p.m, p.d, ahead - 7 * week);
    const { close } = lastCloseOnOrBefore(friday.y, friday.m, friday.d);
    if (close + CLOSE_SETTLE_S <= now) {
      const before = shift(friday.y, friday.m, friday.d, -7);
      return { fromClose: lastCloseOnOrBefore(before.y, before.m, before.d).close, toClose: close };
    }
  }
  const friday = shift(p.y, p.m, p.d, ahead - 42);
  const before = shift(friday.y, friday.m, friday.d, -7);
  return {
    fromClose: lastCloseOnOrBefore(before.y, before.m, before.d).close,
    toClose: lastCloseOnOrBefore(friday.y, friday.m, friday.d).close,
  };
}

/** The close that ends the last decided week at `now` (see `lastSettledWeek`). */
export const lastSettledWeekClose = (now = Math.floor(Date.now() / 1000)) => lastSettledWeek(now).toClose;

/** "Oct 23": a week-ending close as its New York date, for the dated question. */
export const weekEndingLabel = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", { timeZone: NY, month: "short", day: "numeric" });

/**
 * The trading day (YYYYMMDD, New York) of the last regular-session close at or
 * before `unix`, on the exchange calendar: holidays are skipped and early
 * closes count from 13:00.
 */
export function closeDayAtOrBefore(unix: number): number {
  const p = nyParts(unix);
  for (let back = 0; back < 10; back++) {
    const q = shift(p.y, p.m, p.d, -back);
    const close = closeOnDate(q.y, q.m, q.d);
    if (close != null && close <= unix) return dayOf(q);
  }
  return dayOf(p);
}

/** The close (unix) on a YYYYMMDD trading day: its real session close, 16:00 if the calendar has none. */
export const closeOn = (day: number) => {
  const y = Math.floor(day / 10000);
  const m = Math.floor(day / 100) % 100;
  const d = day % 100;
  return closeOnDate(y, m, d) ?? nyToUnix(y, m, d, CLOSE_HOUR_NY);
};

export const fmtClose = (unix: number) => {
  const p = nyParts(unix);
  const date = new Date(unix * 1000).toLocaleString("en-US", {
    timeZone: NY,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${date}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} New York (${new Date(unix * 1000).toISOString().replace(".000Z", "Z")})`;
};

/** One holding of the recipe, as it is frozen into the rule. */
export type RecipeLine = { base: string; unitsPerShare: string; decimals: number };

/** "NVDA 0.1127068, AAPL 0.05857223": units of each listed share per basket share. */
export const recipeText = (recipe: RecipeLine[]) =>
  recipe
    .map((r) => `${r.base} ${(Number(r.unitsPerShare) / 10 ** r.decimals).toFixed(r.decimals).replace(/\.?0+$/, "")}`)
    .join(", ");

/**
 * The resolution rule, word for word as it is sent to Panta and shown on the
 * page. With `recipe`, the units per share are written into the rule itself,
 * so it can be resolved from public closes and mainnet multipliers alone, even
 * if the devnet basket account it was read from is reset.
 */
export function resolutionRule(
  symbol: string,
  navUrl: string,
  w: Pick<MarketWindow, "fromClose" | "toClose" | "resolves">,
  recipe?: RecipeLine[],
) {
  return (
    `YES if ${symbol}'s navPerShare.listed from ${navUrl}?at=${w.toClose} divided by navPerShare.listed from ${navUrl}?at=${w.fromClose} ` +
    `is greater than spy.adjClose divided the same way (the same two URLs). ` +
    `Those times are the NYSE regular-session closes ending each week, on ${fmtClose(w.fromClose)} and ${fmtClose(w.toClose)}, ` +
    `taken from the exchange calendar (a holiday Friday uses Thursday's close, an early close its 13:00 close); the JSON states the day used as closeDay. ` +
    `Trading closes at the first of the two closes, before any of the measured week is known. ` +
    (recipe?.length
      ? `navPerShare.listed is the sum over one ${symbol} share's fixed recipe (${recipeText(recipe)} shares) of units x that day's adjusted close x the token's Token-2022 multiplier on Solana mainnet; anyone can recompute it from those units without the page. `
      : "") +
    `Both URLs are read at or after the resolution time, ${new Date(w.resolves * 1000).toISOString().replace(".000Z", "Z")}, so both closes use the same data. ` +
    `NO otherwise, including a tie. Every input is listed in the JSON.`
  );
}
