import "server-only";
import type { MarketSnapshot, Quote } from "./market";
import { gcsConfigured, getJson, putJson } from "./gcs-store";

/**
 * The last market snapshot that came back whole, kept so the fillers and the
 * NAV pages never go dark because one price endpoint is down.
 *
 * Held in memory and, when the project's bucket is configured, in
 * prices/last-good.json, written at most every five minutes. fetchMarket fills
 * a quote Jupiter did not return from Pyth's 24/7 tokenized feed first, and
 * only then from here, marking each such quote with where it came from.
 */

const OBJECT = "prices/last-good.json";
const WRITE_EVERY_MS = 5 * 60_000;
/** Older than this, a snapshot is not used to price anything. */
export const SNAPSHOT_MAX_AGE_SECS = 6 * 3600;

let memory: MarketSnapshot | null = null;
let lastWrite = 0;
let readOnce: Promise<void> | null = null;

/** Remembers a snapshot that priced the whole universe. */
export async function saveLastGood(snapshot: MarketSnapshot): Promise<void> {
  if (snapshot.missing.length > 0 || snapshot.quotes.some((q) => q.source && q.source !== "jupiter")) return;
  memory = snapshot;
  if (!gcsConfigured() || Date.now() - lastWrite < WRITE_EVERY_MS) return;
  lastWrite = Date.now();
  await putJson(OBJECT, snapshot).catch(() => undefined);
}

/** The last whole snapshot, from memory or the bucket, if it is recent enough to price with. */
export async function lastGood(): Promise<MarketSnapshot | null> {
  if (!memory && gcsConfigured()) {
    readOnce ??= getJson<MarketSnapshot>(OBJECT)
      .then((doc) => {
        if (doc && (!memory || doc.data.fetchedAt > memory.fetchedAt)) memory = doc.data;
      })
      .catch(() => undefined);
    await readOnce;
  }
  if (!memory || Date.now() / 1000 - memory.fetchedAt > SNAPSHOT_MAX_AGE_SECS) return null;
  return memory;
}

/** One ticker's last good quote, marked as coming from the snapshot. */
export async function lastGoodQuote(symbol: string): Promise<Quote | null> {
  const q = (await lastGood())?.quotes.find((x) => x.symbol === symbol);
  return q ? { ...q, source: "snapshot" } : null;
}
