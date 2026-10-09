import "server-only";

/**
 * Small in-memory throttles in front of Panta.
 *
 * Panta allows about 30 quotes and 20 builds a minute per account, and every
 * visitor shares Sheaf's one key, so a crawler or a stuck button could use the
 * budget up during judging. Two limits apply: per IP (so one visitor cannot
 * starve the rest) and per kind of call across the whole instance (so the
 * account stays under Panta's own limits). Both are per server instance, which
 * is enough to stop runaway clients; they are not a security boundary.
 */

type Window = { hits: number[] };
const windows = new Map<string, Window>();

function take(key: string, limit: number, perMs: number): number | null {
  const now = Date.now();
  const w = windows.get(key) ?? { hits: [] };
  w.hits = w.hits.filter((t) => now - t < perMs);
  if (w.hits.length >= limit) {
    windows.set(key, w);
    return Math.ceil((perMs - (now - w.hits[0])) / 1000);
  }
  w.hits.push(now);
  windows.set(key, w);
  if (windows.size > 5_000) {
    for (const [k, v] of windows) if (!v.hits.some((t) => now - t < 60_000)) windows.delete(k);
  }
  return null;
}

export type Budget = "quote" | "build" | "report" | "read";

const GLOBAL: Record<Budget, number> = { quote: 24, build: 16, report: 30, read: 90 };
const PER_IP = 20;

/** Seconds to wait, or null when the call may go ahead. */
export function throttle(ip: string, budget: Budget): number | null {
  return take(`ip:${ip}`, PER_IP, 60_000) ?? take(`all:${budget}`, GLOBAL[budget], 60_000);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}
