import "server-only";
import { gcsConfigured, getJson, putJson } from "./gcs-store";

/**
 * When each keeper last finished a run. Kept in this instance's memory and, when
 * the project's bucket is configured, in heartbeat/<keeper>.json there, so the
 * heartbeat route answers the same whichever instance serves it. One object per
 * keeper, so the two never contend for a write.
 */
export type Beat = { at: number; detail: unknown };
type Which = "keeper" | "evmKeeper";

const OBJECT: Record<Which, string> = { keeper: "heartbeat/keeper.json", evmKeeper: "heartbeat/evm-keeper.json" };

const g = globalThis as unknown as { __sheafBeats?: Partial<Record<Which, Beat>> };
const beats: Partial<Record<Which, Beat>> = (g.__sheafBeats ??= {});

/** Records a finished run; the bucket write never fails the run. */
export async function beat(which: Which, detail: unknown): Promise<void> {
  const b = { at: Date.now(), detail };
  beats[which] = b;
  if (gcsConfigured()) await putJson(OBJECT[which], b).catch(() => undefined);
}

let read: { at: number; beats: Partial<Record<Which, Beat>> } | null = null;

/** The latest run of each keeper, from memory or the bucket, whichever is newer. */
export async function lastBeats(): Promise<Partial<Record<Which, Beat>>> {
  if (!gcsConfigured()) return beats;
  if (!read || Date.now() - read.at > 15_000) {
    const [k, e] = await Promise.all(
      (["keeper", "evmKeeper"] as const).map((w) => getJson<Beat>(OBJECT[w]).then((d) => d?.data ?? null).catch(() => null)),
    );
    read = { at: Date.now(), beats: { ...(k ? { keeper: k } : {}), ...(e ? { evmKeeper: e } : {}) } };
  }
  const newer = (w: Which) => {
    const a = beats[w];
    const b = read!.beats[w];
    return !a ? b : !b ? a : a.at >= b.at ? a : b;
  };
  return { keeper: newer("keeper"), evmKeeper: newer("evmKeeper") };
}
