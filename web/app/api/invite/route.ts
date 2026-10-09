import { cleanRef, cleanTarget, inviteLink, withRef } from "@/lib/invite-ref";
import { ipOf, limiter } from "@/lib/voices-limit";
import { oidcFrom } from "@/lib/voices-gcs";
import { recordOpen, voicesAnswer, voicesConfigured } from "@/lib/voices-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/invite?ref=<code>[&to=/plans]
 *   Counts one open of this invite link, then redirects (302) to the page with
 *   ?ref=<code> in its URL, so the voices form and the waitlist can pass the code
 *   along. No cookie is set and nothing about the visitor is stored: the open is
 *   an empty object named by the code and the day. One address counts at most
 *   once per code per hour, so a reload doesn't inflate a channel,
 *   and link-preview bots aren't counted.
 *   `to` is one of lib/invite-ref.ts INVITE_TARGETS; anything else lands on /voices.
 *
 * GET /api/invite?ref=<code>&format=json
 *   → { ref, link, opens, signed } without counting an open; for the founder's own checks.
 */

const NO_STORE = { "cache-control": "no-store" };
/** Link previews (Telegram, X, Discord, Slack, WhatsApp) fetch a link as soon as it is posted; those aren't people. */
const PREVIEW_BOT = /bot|crawl|spider|preview|facebookexternalhit|embedly|whatsapp|skype|vkshare|curl|wget|python|node-fetch|undici/i;
const counted = limiter({ windowMs: 60 * 60_000, perIp: 1, perInstance: 2_000 });

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ref = cleanRef(url.searchParams.get("ref"));
  const to = cleanTarget(url.searchParams.get("to"));
  oidcFrom(request.headers);

  if (url.searchParams.get("format") === "json") {
    if (!ref) return Response.json({ error: "ref must be 1 to 44 letters, digits, dots, dashes or underscores." }, { status: 400, headers: NO_STORE });
    let opens = 0;
    let signed = 0;
    if (voicesConfigured()) {
      try {
        const row = (await voicesAnswer()).refs.find((r) => r.ref === ref);
        opens = row?.opens ?? 0;
        signed = row?.signed ?? 0;
      } catch {
        /* counts unavailable; the link still works */
      }
    }
    return Response.json({ ref, link: inviteLink(url.origin, ref, to), opens, signed }, { headers: NO_STORE });
  }

  const ua = request.headers.get("user-agent") ?? "";
  if (ref && voicesConfigured() && ua && !PREVIEW_BOT.test(ua) && counted(`${ipOf(request)}|${ref}`)) {
    // Counting is best effort: a storage hiccup must never break the link.
    await recordOpen(ref).catch(() => {});
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE, location: withRef(to, ref) } });
}
