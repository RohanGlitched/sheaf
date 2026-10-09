import "server-only";
import { gcsConfigured, getJson, putJson } from "./gcs-store";
import type { Print, Tape } from "./tape-server";

/**
 * The rolling "earlier trades" seed, kept in the project's GCS bucket (keyless,
 * through lib/gcs-store.ts).
 *
 * A warm instance whose tape has at least 20 live rows writes its newest 40
 * rows here, at most every 10 minutes, from `after()`. A cold page load shows
 * this seed first (GET /api/tape/seed), so the earlier trades are minutes or
 * hours old rather than whatever web/public/tape.seed.json held at the last
 * deploy. That committed file stays as the last fallback: with GCS unset, or
 * nothing written yet, the page reads it instead.
 *
 * The rows are the tape's own decoded prints, real chain reads with their
 * block times and the Jupiter price from their own moment; the page still
 * shows them under "Earlier trades, not live".
 */

const NAME = "tape/seed.json";
const MIN_LIVE = 20;
const KEEP = 40;
const SAVE_EVERY_MS = 10 * 60_000;
const READ_TTL_MS = 60_000;

export type SeedFile = {
  capturedAt: number;
  source: string;
  note: string;
  prints: (Omit<Print, "seenAt"> & { multiplier?: number })[];
};

let lastSave = 0;
let saving = false;
let memo: { at: number; value: SeedFile | null } | null = null;

/** The rolling seed, or null when GCS is not configured, unreachable, or empty. */
export async function readSeed(): Promise<SeedFile | null> {
  if (!gcsConfigured()) return null;
  if (memo && Date.now() - memo.at < READ_TTL_MS) return memo.value;
  try {
    const doc = await getJson<SeedFile>(NAME);
    const value = doc?.data?.prints?.length ? doc.data : null;
    memo = { at: Date.now(), value };
    return value;
  } catch {
    memo = { at: Date.now(), value: memo?.value ?? null };
    return memo.value;
  }
}

/** Write the tape's newest rows as the seed, if it has enough live ones and the last write is old enough. */
export async function maybeSaveSeed(tape: Tape): Promise<void> {
  if (!gcsConfigured() || saving || tape.stale || tape.warming) return;
  if (Date.now() - lastSave < SAVE_EVERY_MS) return;
  const live = tape.prints.filter((p) => p.live).length;
  if (live < MIN_LIVE) return;
  saving = true;
  try {
    const prints = tape.prints.slice(0, KEEP).map(({ seenAt: _s, ...p }) => {
      void _s;
      return p;
    });
    const seed: SeedFile = {
      capturedAt: Math.floor(Date.now() / 1000),
      source: `Solana mainnet, read through ${tape.via === "solami" ? "Solami" : "a public RPC"} and decoded by Sheaf's /api/tape (rolling seed)`,
      note: "Earlier trades, not live. Each row links to its transaction; times are the block's.",
      prints,
    };
    await putJson(NAME, seed);
    lastSave = Date.now();
    memo = { at: Date.now(), value: seed };
  } catch {
    // A failed write leaves the previous seed in place; try again next window.
    lastSave = Date.now() - SAVE_EVERY_MS / 2;
  } finally {
    saving = false;
  }
}
