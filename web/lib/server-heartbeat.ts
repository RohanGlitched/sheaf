import "server-only";

/**
 * When each keeper last finished a run, in this instance's memory. The heartbeat
 * route falls back to the chain for the Solana keeper, since a different
 * instance may have served the run.
 */
type Beats = { keeper: number | null; evmKeeper: number | null; keeperReport: unknown; evmKeeperResults: number | null };

const g = globalThis as unknown as { __sheafBeats?: Beats };
const beats: Beats = (g.__sheafBeats ??= { keeper: null, evmKeeper: null, keeperReport: null, evmKeeperResults: null });

export function beat(which: "keeper", report: unknown): void;
export function beat(which: "evmKeeper", results: number): void;
export function beat(which: "keeper" | "evmKeeper", detail: unknown) {
  if (which === "keeper") {
    beats.keeper = Date.now();
    beats.keeperReport = detail;
  } else {
    beats.evmKeeper = Date.now();
    beats.evmKeeperResults = detail as number;
  }
}

export const lastBeats = (): Readonly<Beats> => beats;
