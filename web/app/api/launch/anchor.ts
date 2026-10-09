import type { Connection } from "@solana/web3.js";
import type { DbcState } from "@/lib/dbc";
import { LAUNCH_METADATA_SITE, OPEN_MULTIPLE } from "@/lib/launch";

/**
 * Whether a launch really opened at half its basket's NAV, from sources the
 * creator does not control. Nothing the creator wrote is trusted:
 *   - the open time is the pool's own `activation_point` (unix seconds on v2,
 *     a slot turned into its block time on v1);
 *   - the NAV the curve was anchored to is read back off the curve itself:
 *     opening market cap / 0.5, in SOL;
 *   - SOL's dollar price in that hour comes from Coinbase's public candles
 *     (Kraken's if Coinbase does not answer);
 *   - the basket's dollar NAV is /api/nav/<basket>?at=<open time>: the
 *     recipe at the last US close at or before the open.
 * The two dollar figures are compared. Live token prices at open and the last
 * close differ by a few percent, so the tolerance is 20%: wide enough for that
 * drift, narrow enough that a curve opened at 2x or 0.1x NAV fails. Baskets
 * with a pre-IPO component have no listed close, so their anchor cannot be
 * checked and says so.
 */
export const ANCHOR_TOLERANCE = 0.2;

export type Anchor = {
  status: "verified" | "mismatch" | "unverifiable";
  reason: string | null;
  openedAt: number | null;
  navSolAtOpen: number;
  solUsdAtOpen: number | null;
  navUsdImplied: number | null;
  navUsdAtClose: number | null;
  closeDay: string | null;
  deviationPct: number | null;
  navProof: string | null;
};

const cache = new Map<string, { at: number; value: Anchor }>();
const MAX_CACHE = 200;
/**
 * One check at a time: the NAV endpoint reads a year of daily closes, and
 * several cold reads at once come back without history. A check that could
 * not be made is retried after two minutes; a verdict is kept for a day.
 */
let queue: Promise<unknown> = Promise.resolve();

/** SOL in dollars during the hour that holds `t`. */
async function solUsdAt(t: number): Promise<number | null> {
  const hour = Math.floor(t / 3600) * 3600;
  try {
    const url = `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${new Date((hour - 3600) * 1000).toISOString()}&end=${new Date((hour + 3600) * 1000).toISOString()}`;
    const rows: number[][] = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": "sheaf-index" } }).then((r) =>
      r.ok ? r.json() : [],
    );
    // [time, low, high, open, close, volume]
    const row = rows.find((r) => r[0] === hour);
    if (row) return (row[3] + row[4]) / 2;
  } catch {}
  try {
    const body = await fetch(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=60&since=${hour - 3600}`, {
      signal: AbortSignal.timeout(8_000),
    }).then((r) => r.json());
    const rows: (string | number)[][] = Object.entries(body?.result ?? {}).find(([k]) => k !== "last")?.[1] as never;
    // [time, open, high, low, close, vwap, volume, count]
    const row = rows?.find((r) => Number(r[0]) === hour);
    if (row) return Number(row[5]);
  } catch {}
  return null;
}

/** The time the pool opened, from its own activation point. */
async function openedAt(connection: Connection, state: DbcState): Promise<number | null> {
  if (state.activation === "timestamp") return state.activationPoint;
  return connection.getBlockTime(state.activationPoint).catch(() => null);
}

export async function anchorFor(params: {
  connection: Connection;
  origin: string;
  basket: string;
  pool: string;
  state: DbcState;
}): Promise<Anchor> {
  const hit = cache.get(params.pool);
  if (hit && Date.now() - hit.at < (hit.value.status === "unverifiable" ? 2 * 60_000 : 24 * 3600_000)) return hit.value;
  const run = queue.then(() => check(params));
  queue = run.catch(() => null);
  return run;
}

async function check(params: {
  connection: Connection;
  origin: string;
  basket: string;
  pool: string;
  state: DbcState;
}): Promise<Anchor> {
  const { connection, origin, basket, pool, state } = params;
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < (hit.value.status === "unverifiable" ? 2 * 60_000 : 24 * 3600_000)) return hit.value;

  const navSolAtOpen = state.openCap / OPEN_MULTIPLE;
  const base: Anchor = {
    status: "unverifiable",
    reason: null,
    openedAt: null,
    navSolAtOpen,
    solUsdAtOpen: null,
    navUsdImplied: null,
    navUsdAtClose: null,
    closeDay: null,
    deviationPct: null,
    navProof: null,
  };
  const value = await (async (): Promise<Anchor> => {
    const t = await openedAt(connection, state);
    if (t == null) return { ...base, reason: "The open time could not be read." };
    // Read from this deployment; published as the production URL anyone can check.
    const navRead = `${origin}/api/nav/${basket}?at=${t}`;
    const navProof = `${LAUNCH_METADATA_SITE}/api/nav/${basket}?at=${t}`;
    const [sol, nav] = await Promise.all([
      solUsdAt(t),
      fetch(navRead, { signal: AbortSignal.timeout(30_000) })
        .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) }))
        .catch(() => null),
    ]);
    const withTime = { ...base, openedAt: t, navProof };
    if (sol == null) return { ...withTime, reason: "SOL's price in the hour of the open could not be read." };
    const implied = navSolAtOpen * sol;
    const listed: number | null = nav?.ok ? (nav.body?.navPerShare?.listed ?? null) : null;
    const filled = { ...withTime, solUsdAtOpen: sol, navUsdImplied: implied, closeDay: nav?.body?.closeDay ?? null };
    if (listed == null || !(listed > 0)) {
      return {
        ...filled,
        reason: nav?.body?.unavailable ?? nav?.body?.error ?? "The basket's NAV at the open could not be read.",
      };
    }
    const deviation = implied / listed - 1;
    const within = Math.abs(deviation) <= ANCHOR_TOLERANCE;
    return {
      ...filled,
      navUsdAtClose: listed,
      deviationPct: Number((deviation * 100).toFixed(2)),
      status: within ? "verified" : "mismatch",
      reason: within
        ? null
        : `The curve opened at ${(OPEN_MULTIPLE * (1 + deviation)).toFixed(2)}x the basket's NAV, not ${OPEN_MULTIPLE}x.`,
    };
  })();
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(pool, { at: Date.now(), value });
  return value;
}
