import "server-only";
import { GcsConflict, gcsConfigured, getJson, putJson } from "./gcs-store";

/**
 * What each of the site's fillers believed a fill was worth when it made it: the
 * fair value of what it delivered (or received) at its own prices, fees included,
 * against the dollars it was paid (or paid). The chain records the trade, not the
 * filler's price, so this is the only place the realized margin can come from.
 *
 * Kept in memory and in fills/log.json in the project's bucket, the newest
 * MAX_ENTRIES, written with a generation precondition so two instances never
 * drop each other's entries.
 */

export type FillLogEntry = {
  order: string;
  side: "buy" | "sell";
  filler: "house" | "second";
  /** Dollars the filler received (buy) or paid (sell). */
  cash: number;
  /** Fair value of the stocks it delivered (buy) or redeemed (sell), at its prices, transfer fees included. */
  fair: number;
  /** (cash − fair) / fair on a buy, (fair − cash) / cash on a sell, in basis points. */
  marginBps: number;
  /** True when any component was priced from a fallback source. */
  fallback?: boolean;
  at: number;
};

const OBJECT = "fills/log.json";
const MAX_ENTRIES = 2_000;

/** On globalThis, so every route bundle in one instance shares the same log. */
const g = globalThis as unknown as { __sheafFillLog?: { entries: FillLogEntry[]; readAt: number } };
const state = (g.__sheafFillLog ??= { entries: [], readAt: 0 });

async function load(): Promise<{ entries: FillLogEntry[]; generation: string }> {
  const doc = await getJson<FillLogEntry[]>(OBJECT);
  return { entries: doc?.data ?? [], generation: doc?.generation ?? "0" };
}

const merge = (a: FillLogEntry[], b: FillLogEntry[]) => {
  const byKey = new Map<string, FillLogEntry>();
  for (const e of [...a, ...b]) byKey.set(`${e.side}:${e.order}:${e.filler}`, e);
  return [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, MAX_ENTRIES);
};

/** Adds fills to the log; never throws. */
export async function recordFills(entries: FillLogEntry[]): Promise<void> {
  if (!entries.length) return;
  state.entries = merge(state.entries, entries);
  if (!gcsConfigured()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { entries: stored, generation } = await load();
      state.entries = merge(stored, state.entries);
      await putJson(OBJECT, state.entries, { ifGenerationMatch: generation });
      return;
    } catch (err) {
      if (!(err instanceof GcsConflict)) return;
    }
  }
}

/** Every logged fill, newest first, re-read from the bucket at most once a minute. */
export async function readFillLog(): Promise<FillLogEntry[]> {
  if (gcsConfigured() && Date.now() - state.readAt > 60_000) {
    state.readAt = Date.now();
    const stored = await load().catch(() => null);
    if (stored) state.entries = merge(stored.entries, state.entries);
  }
  return state.entries;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
};

/** Median realized margin per filler and side, from the log. */
export function realizedMargins(log: FillLogEntry[]) {
  const pick = (filler: FillLogEntry["filler"], side?: FillLogEntry["side"]) =>
    log.filter((e) => e.filler === filler && (!side || e.side === side)).map((e) => e.marginBps);
  return {
    house: { fills: pick("house").length, medianBps: median(pick("house")), buyMedianBps: median(pick("house", "buy")), sellMedianBps: median(pick("house", "sell")) },
    second: { fills: pick("second").length, medianBps: median(pick("second")), buyMedianBps: median(pick("second", "buy")), sellMedianBps: median(pick("second", "sell")) },
  };
}
