import "server-only";

/**
 * Per-address rate limits for /api/voices and /api/invite: a sliding window per
 * IP plus a ceiling for the whole instance. Per instance and deliberately simple,
 * like the waitlist's; the address is held in memory only, never stored.
 */
export function limiter(opts: { windowMs: number; perIp: number; perInstance: number }) {
  const byKey = new Map<string, number[]>();
  let recent: number[] = [];
  return function allow(key: string): boolean {
    const now = Date.now();
    recent = recent.filter((t) => now - t < opts.windowMs);
    const mine = (byKey.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (mine.length >= opts.perIp || recent.length >= opts.perInstance) {
      byKey.set(key, mine);
      return false;
    }
    mine.push(now);
    recent.push(now);
    byKey.set(key, mine);
    if (byKey.size > 5_000) for (const [k, v] of byKey) if (v.every((t) => now - t >= opts.windowMs)) byKey.delete(k);
    return true;
  };
}

export function ipOf(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}
