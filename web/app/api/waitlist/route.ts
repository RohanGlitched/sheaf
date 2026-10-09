import { after } from "next/server";
import { AlreadyAnsweredToday, AlreadyListed, addToWaitlist, waitlistConfigured, waitlistCounts } from "@/lib/waitlist-store";
import { cleanContact, isBand, isHome, isRoute } from "@/lib/waitlist-options";
import { originAllowed } from "@/lib/server-origin";
import { cleanRef } from "@/lib/invite-ref";

export const dynamic = "force-dynamic";

/**
 * GET /api/waitlist: counts only: { open, count, withContact, byHome }. Never an entry.
 *   Every number counts only answers that left a contact, each contact once
 *   (`count` === `withContact`). Answers without a contact are kept, never counted.
 * POST /api/waitlist: { band, route, home, contact?, ref? } adds one answer. Only from this
 * site's own pages (exact origins, lib/server-origin.ts; a missing Origin is refused),
 * one answer per contact, and one answer without a contact per address per day.
 * `ref` is the invite code the person arrived with (lib/invite-ref.ts), kept with the answer.
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

/**
 * The last counts this instance read. A count is a listing of the bucket, which
 * has taken up to 19 s; a reader never waits more than READ_WAIT_MS for it. Past
 * that it gets the last counts marked `stale` (or a closed answer, which hides the
 * count, if there are none yet), and the listing finishes in after() for the next.
 */
const READ_WAIT_MS = 2_500;
let lastCounts: { at: number; counts: Awaited<ReturnType<typeof waitlistCounts>> } | null = null;

export async function GET(request: Request) {
  // A closed waitlist is an ordinary answer for the page, not an error, so the count simply stays hidden.
  if (!waitlistConfigured()) return Response.json({ open: false, message: CLOSED }, { headers: NO_STORE });
  const read = waitlistCounts(oidcOf(request)).then((counts) => {
    lastCounts = { at: Date.now(), counts };
    return counts;
  });
  try {
    const counts = await Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), READ_WAIT_MS))]);
    if (counts) return Response.json({ open: true, ...counts }, { headers: NO_STORE });
    after(() => read.catch(() => undefined));
    if (lastCounts) return Response.json({ open: true, ...lastCounts.counts, stale: true, ageMs: Date.now() - lastCounts.at }, { headers: NO_STORE });
    return Response.json({ open: false, message: CLOSED, pending: true }, { headers: NO_STORE });
  } catch {
    if (lastCounts) return Response.json({ open: true, ...lastCounts.counts, stale: true, ageMs: Date.now() - lastCounts.at }, { headers: NO_STORE });
    return Response.json({ open: false, message: CLOSED }, { headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  // Answers come from this site's own form: a browser always sends Origin on a POST, so none means a script.
  if (!originAllowed(request)) return Response.json({ error: "Send this from the Sheaf site." }, { status: 403, headers: NO_STORE });
  if (!waitlistConfigured()) return Response.json({ error: CLOSED }, { status: 503, headers: NO_STORE });

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
  if (!isHome(body.home)) return Response.json({ error: "Choose where you live." }, { status: 400, headers: NO_STORE });
  const contact = cleanContact(body.contact);
  if (contact == null) return Response.json({ error: "That isn't an email address or a Telegram handle. Leave it empty if you'd rather not say." }, { status: 400, headers: NO_STORE });

  if (!allow(ipOf(request))) return Response.json({ error: "You've just answered. Try again in a few minutes." }, { status: 429, headers: NO_STORE });

  try {
    const oidc = oidcOf(request);
    const ref = cleanRef(body.ref);
    await addToWaitlist({ band: body.band, route: body.route, home: body.home, contact, day: new Date().toISOString().slice(0, 10), ref }, oidc, { ip: ipOf(request) });
    const counts = await waitlistCounts(oidc).catch(() => null);
    return Response.json({ ok: true, counts }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AlreadyAnsweredToday)
      return Response.json({ error: "This connection already answered today without a contact. Add an email or Telegram handle, or come back tomorrow." }, { status: 409, headers: NO_STORE });
    if (err instanceof AlreadyListed) return Response.json({ error: "That contact is already on the list. One answer each is enough." }, { status: 409, headers: NO_STORE });
    return Response.json({ error: "We couldn't save that just now. Try again in a minute." }, { status: 502, headers: NO_STORE });
  }
}
