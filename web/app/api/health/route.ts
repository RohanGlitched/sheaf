export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/health → { ok, checks: [{ name, path, ok, status, ms, error? }], at }
 *
 * The site's own reads, called the way a visitor's page calls them, each checked
 * for a 200 and a sane shape: baskets, the ledger, a basket's NAV, the tape and
 * the launches. For an uptime scheduler; answers 503 when any check fails, so a
 * plain HTTP probe sees it.
 */

/** The flagship basket, for the NAV check, when the baskets list cannot name it. */
const BIG5_FALLBACK = "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";
const TIMEOUT_MS = 25_000;

type Check = { name: string; path: string; ok: boolean; status: number; ms: number; error?: string };
type Shape = (j: unknown) => string | null;

const isObj = (j: unknown): j is Record<string, unknown> => !!j && typeof j === "object" && !Array.isArray(j);

const SHAPES: Record<string, Shape> = {
  baskets: (j) =>
    !Array.isArray(j) ? "not a list" : j.length === 0 ? "no baskets" : j.every((b) => isObj(b) && typeof b.address === "string" && Array.isArray(b.components)) ? null : "a basket without address or components",
  ledger: (j) =>
    !isObj(j) ? "not an object" : !Array.isArray(j.entries) ? "no entries" : !isObj(j.stats) ? "no stats" : typeof j.total !== "number" ? "no total" : null,
  nav: (j) =>
    !isObj(j) ? "not an object" : !isObj(j.navPerShare) ? "no navPerShare" : typeof j.sharesOutstanding !== "number" ? "no sharesOutstanding" : null,
  tape: (j) => (!isObj(j) ? "not an object" : typeof j.slot !== "number" ? "no slot" : !Array.isArray(j.prints) ? "no prints" : null),
  launches: (j) => (!isObj(j) ? "not an object" : !Array.isArray(j.launches) ? "no launches" : null),
};

async function check(base: string, name: string, path: string): Promise<Check & { body?: unknown }> {
  const t = Date.now();
  try {
    const r = await fetch(`${base}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.json().catch(() => undefined);
    const shape = r.ok ? SHAPES[name](body) : `HTTP ${r.status}`;
    return { name, path, ok: r.ok && shape == null, status: r.status, ms: Date.now() - t, ...(shape ? { error: shape } : {}), body };
  } catch (err) {
    return { name, path, ok: false, status: 0, ms: Date.now() - t, error: ((err as Error).message ?? "failed").slice(0, 120) };
  }
}

export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  const [baskets, ...rest] = await Promise.all([
    check(base, "baskets", "/api/baskets"),
    check(base, "ledger", "/api/ledger?limit=1"),
    check(base, "tape", "/api/tape"),
    check(base, "launches", "/api/launches"),
  ]);
  const list = Array.isArray(baskets.body) ? (baskets.body as { symbol?: string; address?: string }[]) : [];
  const big5 = list.find((b) => b.symbol === "BIG5")?.address ?? BIG5_FALLBACK;
  const nav = await check(base, "nav", `/api/nav/${big5}`);
  const checks: Check[] = [baskets, ...rest, nav].map(({ body: _b, ...c }) => c);
  const ok = checks.every((c) => c.ok);
  return Response.json({ ok, checks, at: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
