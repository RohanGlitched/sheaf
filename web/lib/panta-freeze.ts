import "server-only";
import { gcsConfigured, getJson, putJson, GcsConflict } from "./gcs-store";

/**
 * Frozen `/api/nav/<basket>?at=` answers, so a Panta resolution replays exactly.
 *
 * A past close is computed from Yahoo's adjusted closes and the mints'
 * multipliers. Yahoo re-adjusts past closes after an ex-dividend date, so the
 * same `?at=` can give a slightly different number a week later. That is why
 * the rule reads both closes at the resolution time, on the same data.
 *
 * Each answer is stored in the project's GCS bucket under its close day and
 * the date of the data it was computed from (`asOf`, the newest close in the
 * history): `nav/<basket>/<closeDay>@<asOf>.json`. The first read for a given
 * close and data date is written once (a create-only write), and every later
 * read with the same pair returns those exact bytes. `&asOf=YYYY-MM-DD`
 * replays a stored answer even after newer data arrives.
 */

const key = (basket: string, closeDay: string, asOf: string) => `nav/${basket}/${closeDay}@${asOf}.json`;

export type Frozen<T> = { answer: T; storedAt: string; key: string };

/** A stored answer for this close and data date, or null (none yet, or no storage configured). */
export async function readFrozen<T>(basket: string, closeDay: string, asOf: string): Promise<Frozen<T> | null> {
  if (!gcsConfigured()) return null;
  try {
    const doc = await getJson<Frozen<T>>(key(basket, closeDay, asOf));
    return doc?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Store an answer once. Returns what is stored under the key afterwards: this
 * answer, or the one another instance wrote first (which then wins, so every
 * reader sees the same bytes). Null when storage is not configured or failed.
 */
export async function freeze<T>(basket: string, closeDay: string, asOf: string, answer: T): Promise<Frozen<T> | null> {
  if (!gcsConfigured()) return null;
  const record: Frozen<T> = { answer, storedAt: new Date().toISOString(), key: key(basket, closeDay, asOf) };
  try {
    await putJson(record.key, record, { ifGenerationMatch: "0" });
    return record;
  } catch (err) {
    if (err instanceof GcsConflict) return readFrozen<T>(basket, closeDay, asOf);
    return null;
  }
}

export const storageConfigured = gcsConfigured;
