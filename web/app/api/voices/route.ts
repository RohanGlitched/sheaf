import { originAllowed } from "@/lib/server-origin";
import { isTeamWallet } from "@/lib/team-wallets";
import { ipOf, limiter } from "@/lib/voices-limit";
import { oidcFrom } from "@/lib/voices-gcs";
import { NotListed, removeVoice, saveVoice, StaleSignature, voicesAnswer, voicesConfigured } from "@/lib/voices-store";
import { decodeAddress, decodeSignature, verifySigned } from "@/lib/voices-verify";
import {
  cleanHandle,
  cleanQuote,
  cleanRef,
  isFresh,
  isPlatform,
  removalMessage,
  voiceMessage,
  type Voice,
  type VoicesAnswer,
} from "@/lib/voices-message";

export const dynamic = "force-dynamic";

/**
 * GET /api/voices → VoicesAnswer
 *   { open, voices: Voice[], ours, refs: [{ ref, opens, signed }], asOf }
 *   Signed entries from wallets that aren't the team's, newest first, each with
 *   the exact message and signature so anyone can check it. `ours` counts the
 *   team's own entries, which are never listed.
 *
 * POST /api/voices
 *   { wallet, platform: "x"|"telegram"|"github", handle, quote?, ref?, date, signature }
 *     → { ok: true, voice, team }
 *   The server rebuilds the message from the cleaned fields (lib/voices-message.ts),
 *   checks the ed25519 signature against the wallet, and stores one entry per wallet.
 *   { action: "remove", wallet, date, signature } → { ok: true } takes it down again.
 *
 * Refused: other sites (exact origin allowlist), more than 5 tries per address per
 * 10 minutes, a date more than 2 days from today (UTC), oversized fields, links in
 * the quote. Until the bucket is configured, GET answers { open: false } and POST 503.
 */

const NO_STORE = { "cache-control": "no-store" };
const CLOSED = "Signing hasn't opened yet.";
const allow = limiter({ windowMs: 10 * 60_000, perIp: 5, perInstance: 200 });

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

const closedAnswer = (): VoicesAnswer => ({ open: false, voices: [], ours: 0, refs: [], asOf: Date.now(), message: CLOSED });

export async function GET(request: Request) {
  if (!voicesConfigured()) return Response.json(closedAnswer(), { headers: NO_STORE });
  oidcFrom(request.headers);
  try {
    return Response.json(await voicesAnswer(), { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch {
    return Response.json({ ...closedAnswer(), open: true, message: "Couldn't read the list just now." }, { status: 502, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  if (!voicesConfigured()) return fail(CLOSED, 503);
  if (!originAllowed(request)) return fail("Sign from the Sheaf site.", 403);
  if (!allow(ipOf(request))) return fail("That's a lot of tries. Wait a few minutes and sign again.", 429);
  oidcFrom(request.headers);

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 2_000) return fail("That is more than the form sends.", 413);
    body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return fail("Expected a JSON body.", 400);
  }

  const publicKey = decodeAddress(body.wallet);
  if (!publicKey) return fail("That isn't a Solana wallet address.", 400);
  const wallet = body.wallet as string;
  const signature = decodeSignature(body.signature);
  if (!signature) return fail("The signature is missing or malformed.", 400);
  if (!isFresh(body.date)) return fail("The signed date must be within two days of today. Sign again.", 400);
  const date = body.date;

  if (body.action === "remove") {
    if (!verifySigned(removalMessage(wallet, date), signature, publicKey)) return fail("The signature doesn't match this wallet.", 401);
    try {
      await removeVoice(wallet, date);
      return Response.json({ ok: true }, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof NotListed) return fail("This wallet isn't on the list.", 404);
      if (err instanceof StaleSignature) return fail("That signature is older than the entry. Sign again.", 409);
      return fail("We couldn't take it down just now. Try again in a minute.", 502);
    }
  }

  if (!isPlatform(body.platform)) return fail("Choose X, Telegram or GitHub.", 400);
  const platform = body.platform;
  const handle = cleanHandle(platform, body.handle);
  if (!handle) return fail("That handle doesn't look right for that platform.", 400);
  const q = cleanQuote(body.quote);
  if ("error" in q) return fail(q.error, 400);
  const ref = body.ref == null || body.ref === "" ? null : cleanRef(body.ref);
  if (body.ref != null && body.ref !== "" && !ref) return fail("That invite code isn't usable. Sign again without it.", 400);

  const fields = { wallet, platform, handle, quote: q.quote, ref, date };
  const message = voiceMessage(fields);
  if (!verifySigned(message, signature, publicKey)) return fail("The signature doesn't match this wallet and message.", 401);

  const voice: Voice = { ...fields, message, signature: body.signature as string, at: new Date().toISOString() };
  try {
    await saveVoice(voice);
  } catch (err) {
    if (err instanceof StaleSignature) return fail("This wallet already signed something newer. Sign again with today's date.", 409);
    return fail("We couldn't save that just now. Try again in a minute.", 502);
  }
  return Response.json({ ok: true, voice, team: isTeamWallet(wallet) }, { headers: NO_STORE });
}
