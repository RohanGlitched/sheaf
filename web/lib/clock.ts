/**
 * The two clocks a tokenised stock lives under.
 *
 * The exchange keeps banker's hours. The chain does not. That gap is the whole
 * reason these tokens are interesting, so Sheaf shows both clocks side by side
 * rather than pretending there is one.
 *
 * The exchange schedule is not hardcoded here: it is the string Pyth publishes
 * for each listing, captured in lib/universe.ts. Format, semicolon-separated:
 *
 *   America/New_York;0930-1600,...,C,C;0907/C,1127/0930-1300,1225/C
 *   ^ timezone       ^ Monday..Sunday        ^ dated overrides, MMDD/hours
 */

const WEEKDAY_ORDER = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type Session = { openMinute: number; closeMinute: number } | null;

export type Schedule = {
  timeZone: string;
  /** Monday-first. null means closed all day. */
  week: Session[];
  /** "MMDD" -> session, overriding the weekday. */
  overrides: Map<string, Session>;
};

function parseSession(spec: string): Session {
  const s = spec.trim();
  if (!s || s === "C") return null;
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return {
    openMinute: Number(m[1]) * 60 + Number(m[2]),
    closeMinute: Number(m[3]) * 60 + Number(m[4]),
  };
}

export function parseSchedule(raw: string | null): Schedule | null {
  if (!raw) return null;
  const [timeZone, weekPart, holidayPart] = raw.split(";");
  if (!timeZone || !weekPart) return null;

  const week = weekPart.split(",").map(parseSession);
  if (week.length !== 7) return null;

  const overrides = new Map<string, Session>();
  for (const entry of (holidayPart ?? "").split(",")) {
    const [date, hours] = entry.split("/");
    if (date?.length === 4) overrides.set(date, parseSession(hours ?? "C"));
  }
  return { timeZone, week, overrides };
}

/** Wall-clock fields in a named timezone, without pulling in a date library. */
function zoned(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return {
    weekday: get("weekday"),
    monthDay: `${get("month")}${get("day")}`,
    minuteOfDay: hour * 60 + Number(get("minute")),
    second: Number(get("second")),
  };
}

function sessionOn(schedule: Schedule, weekday: string, monthDay: string): Session {
  if (schedule.overrides.has(monthDay)) return schedule.overrides.get(monthDay)!;
  const index = WEEKDAY_ORDER.indexOf(weekday as (typeof WEEKDAY_ORDER)[number]);
  return index >= 0 ? schedule.week[index] : null;
}

export type MarketState = {
  open: boolean;
  /** Seconds until the state flips. Null when the schedule cannot say. */
  secondsToFlip: number | null;
  /** "closes 4:00 PM ET" or "opens 9:30 AM ET" — the label beside the countdown. */
  edge: string;
  timeZoneLabel: string;
  /** Why it is shut, when the reason is more specific than "out of hours". */
  reason: "session" | "after-hours" | "weekend" | "holiday" | "half-day-close";
};

function clockLabel(minuteOfDay: number): string {
  const h24 = Math.floor(minuteOfDay / 60) % 24;
  const m = minuteOfDay % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Where the exchange stands right now, and how long until that changes.
 *
 * Walks forward day by day to find the next open when the market is shut, so a
 * long holiday weekend counts down correctly rather than to the next weekday.
 */
export function marketState(
  schedule: Schedule | null,
  now: Date = new Date(),
): MarketState {
  if (!schedule) {
    return {
      open: false,
      secondsToFlip: null,
      edge: "schedule unavailable",
      timeZoneLabel: "ET",
      reason: "after-hours",
    };
  }

  const label = schedule.timeZone === "America/New_York" ? "ET" : schedule.timeZone;
  const here = zoned(now, schedule.timeZone);
  const today = sessionOn(schedule, here.weekday, here.monthDay);

  if (today && here.minuteOfDay >= today.openMinute && here.minuteOfDay < today.closeMinute) {
    const secondsLeft =
      (today.closeMinute - here.minuteOfDay) * 60 - here.second;
    const early = today.closeMinute < 16 * 60;
    return {
      open: true,
      secondsToFlip: secondsLeft,
      edge: `closes ${clockLabel(today.closeMinute)} ${label}`,
      timeZoneLabel: label,
      reason: early ? "half-day-close" : "session",
    };
  }

  // Shut. Find the next open, up to a week and a half out.
  let minutesAhead =
    today && here.minuteOfDay < today.openMinute
      ? today.openMinute - here.minuteOfDay
      : null;
  let openMinute = today?.openMinute ?? null;
  let dayOffset = 0;

  if (minutesAhead == null) {
    const minutesLeftToday = 24 * 60 - here.minuteOfDay;
    for (dayOffset = 1; dayOffset <= 10; dayOffset++) {
      const probe = new Date(now.getTime() + dayOffset * 86_400_000);
      const there = zoned(probe, schedule.timeZone);
      const session = sessionOn(schedule, there.weekday, there.monthDay);
      if (session) {
        minutesAhead =
          minutesLeftToday + (dayOffset - 1) * 24 * 60 + session.openMinute;
        openMinute = session.openMinute;
        break;
      }
    }
  }

  const isWeekend = here.weekday === "Saturday" || here.weekday === "Sunday";
  const isHoliday = !today && !isWeekend;

  return {
    open: false,
    secondsToFlip: minutesAhead == null ? null : minutesAhead * 60 - here.second,
    edge:
      openMinute == null
        ? "reopens soon"
        : `opens ${clockLabel(openMinute)} ${label}`,
    timeZoneLabel: label,
    reason: isHoliday ? "holiday" : isWeekend ? "weekend" : "after-hours",
  };
}

/** Human sentence for why the exchange is shut. Used under the clock. */
export const CLOSED_REASON: Record<MarketState["reason"], string> = {
  session: "Regular session",
  "half-day-close": "Shortened session",
  "after-hours": "Exchange closed for the day",
  weekend: "Exchange closed for the weekend",
  holiday: "Exchange closed for a holiday",
};
