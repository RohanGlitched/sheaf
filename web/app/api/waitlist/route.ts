import { addToWaitlist, waitlistConfigured, waitlistCount } from "@/lib/waitlist-store";
import { cleanContact, isBand, isRoute } from "@/lib/waitlist-options";

export const dynamic = "force-dynamic";

/**
 * GET /api/waitlist: how many people are on the India waitlist (the count only).
 * POST /api/waitlist: { band, route, contact? } adds one answer.
 *
 * Until the bucket and the federation are configured, GET answers { open: false }
 * and POST answers 503 "Waitlist is not open yet."; the page hides the count.
 */

const CLOSED = "Waitlist is not open yet.";
const NO_STORE = { "cache-control": "no-store" };

/** Three answers per address per ten minutes, and a ceiling for the whole instance. Per instance and deliberately simple. */
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 3;
const INSTANCE_MAX = 120;
const byIp = new Map<string, number[]>();
let recent: number[] = [];

function ipOf(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

function allow(ip: string): boolean {
  const now = Date.now();
  recent = recent.filter((t) => now - t < IP_WINDOW_MS);
  const mine = (byIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (mine.length >= IP_MAX || recent.length >= INSTANCE_MAX) {
    byIp.set(ip, mine);
    return false;
  }
  mine.push(now);
  recent.push(now);
  byIp.set(ip, mine);
  // Keep the map from growing without bound on a long-lived instance.
  if (byIp.size > 5_000) for (const [k, v] of byIp) if (v.every((t) => now - t >= IP_WINDOW_MS)) byIp.delete(k);
  return true;
}

const oidcOf = (request: Request) => request.headers.get("x-vercel-oidc-token");

export async function GET(request: Request) {
  // A closed waitlist is an ordinary answer for the page, not an error, so the count simply stays hidden.
  if (!waitlistConfigured()) return Response.json({ open: false, message: CLOSED }, { headers: NO_STORE });
  try {
    const count = await waitlistCount(oidcOf(request));
    return Response.json({ open: true, count }, { headers: NO_STORE });
  } catch {
    return Response.json({ open: false, message: CLOSED }, { headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  if (!waitlistConfigured()) return Response.json({ error: CLOSED }, { status: 503, headers: NO_STORE });

  // Answers come from this site's own form, not from other pages.
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ error: "Send this from the Sheaf site." }, { status: 403, headers: NO_STORE });

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 1_000) return Response.json({ error: "That is more than the form sends." }, { status: 413, headers: NO_STORE });
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400, headers: NO_STORE });
  }

  // A field people never see; anything that fills it is a bot. Answer as if it worked.
  if (typeof body.website === "string" && body.website.trim()) return Response.json({ ok: true }, { headers: NO_STORE });

  if (!isBand(body.band)) return Response.json({ error: "Choose how much you would invest a month." }, { status: 400, headers: NO_STORE });
  if (!isRoute(body.route)) return Response.json({ error: "Choose how you invest in US stocks today." }, { status: 400, headers: NO_STORE });
  const contact = cleanContact(body.contact);
  if (contact == null) return Response.json({ error: "That isn't an email address or a Telegram handle. Leave it empty if you'd rather not say." }, { status: 400, headers: NO_STORE });

  if (!allow(ipOf(request))) return Response.json({ error: "You've just answered. Try again in a few minutes." }, { status: 429, headers: NO_STORE });

  try {
    const oidc = oidcOf(request);
    await addToWaitlist({ band: body.band, route: body.route, contact, day: new Date().toISOString().slice(0, 10) }, oidc);
    const count = await waitlistCount(oidc).catch(() => null);
    return Response.json({ ok: true, count }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "We couldn't save that just now. Try again in a minute." }, { status: 502, headers: NO_STORE });
  }
}
