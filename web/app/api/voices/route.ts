import { after } from "next/server";
import { originAllowed } from "@/lib/server-origin";
import { isTeamWallet } from "@/lib/team-wallets";
import { ipOf, limiter } from "@/lib/voices-limit";
import { oidcFrom } from "@/lib/voices-gcs";
import { checkGist, gistId } from "@/lib/voices-github";
import {
  getVoice,
  NotListed,
  recheck,
  recheckWaiting,
  removeVoice,
  saveVoice,
  StaleSignature,
  statusOf,
  updateVoice,
  voicesAnswer,
  voicesConfigured,
} from "@/lib/voices-store";
import { decodeAddress, decodeSignature, verifySigned } from "@/lib/voices-verify";
import { evmAddress, verifyEvmSigned } from "@/lib/voices-evm";
import {
  cleanHandle,
  cleanQuote,
  cleanRef,
  isFresh,
  isPlatform,
  isWalletKind,
  removalMessage,
  voiceMessage,
  type Voice,
  type VoicesAnswer,
} from "@/lib/voices-message";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/voices → VoicesAnswer
 *   { open, voices: Voice[], waiting, ours, refs: [{ ref, opens, signed }], asOf }
 *   Signed entries from wallets that aren't the team's AND have done something on
 *   Sheaf (voice.proof: a Sheaf program event, or a swap the wallet paid for on an
 *   official launch pool), newest first, each with the exact message and signature
 *   so anyone can check it. `waiting` counts outside signers with no action yet
 *   (not listed, handle not shown); `ours` counts the team's entries, never listed.
 * GET /api/voices?wallet=<address> → { status: "listed"|"waiting"|"team"|null, voice }
 *   One wallet's own entry, for the signer's form.
 *
 * Solana wallets sign with ed25519 (signMessage, base58 signature); EVM wallets
 * sign the same text with EIP-191 personal_sign (0x… address, 0x… signature),
 * checked with viem's verifyMessage. EVM proof of use: a plan, a dollar order
 * (desk v1, v2 or v3) or an in-kind creation on any deployed testnet (lib/voices-evm.ts).
 *
 * POST /api/voices
 *   { wallet, walletKind: "browser"|"app", platform: "x"|"telegram"|"github", handle, quote?, ref?, date, signature }
 *     → { ok: true, voice, status, team }
 *   The server rebuilds the message from the cleaned fields (lib/voices-message.ts),
 *   checks the ed25519 signature against the wallet, stores one entry per wallet,
 *   then reads the wallet's own transactions for a first Sheaf action.
 *   { action: "remove", wallet, date, signature } → { ok: true } takes it down again.
 *   { action: "recheck", wallet } → { ok, voice, status } reads the chain again (at most every 30 s).
 *   { action: "github", wallet, gist } → { ok, voice, status } marks a GitHub handle verified
 *     when the public gist is owned by that handle and contains the exact signed message.
 *
 * Refused: other sites (exact origin allowlist), more than 5 signatures per address
 * per 10 minutes (12 rechecks or gist checks), a date more than 2 days from today
 * (UTC), oversized fields, links in the quote. Until the bucket is configured, GET
 * answers { open: false } and POST 503.
 */

const NO_STORE = { "cache-control": "no-store" };
const CLOSED = "Signing hasn't opened yet.";
const allow = limiter({ windowMs: 10 * 60_000, perIp: 5, perInstance: 200 });
/** Rechecks and gist checks only read; they get their own, looser budget. */
const allowRead = limiter({ windowMs: 10 * 60_000, perIp: 12, perInstance: 300 });

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: NO_STORE });

const closedAnswer = (): VoicesAnswer => ({ open: false, voices: [], waiting: 0, ours: 0, refs: [], asOf: Date.now(), message: CLOSED });

export async function GET(request: Request) {
  if (!voicesConfigured()) return Response.json(closedAnswer(), { headers: NO_STORE });
  oidcFrom(request.headers);
  const one = new URL(request.url).searchParams.get("wallet");
  if (one != null) {
    const key = evmAddress(one) ?? (decodeAddress(one) ? one : null);
    if (!key) return fail("That isn't a Solana or EVM wallet address.", 400);
    try {
      const voice = await getVoice(key);
      return Response.json({ status: voice ? statusOf(voice) : null, voice }, { headers: NO_STORE });
    } catch {
      return fail("Couldn't read that just now.", 502);
    }
  }
  try {
    const answer = await voicesAnswer();
    // Waiting wallets get another look at the chain after the answer has gone out.
    if (answer.waiting > 0) after(() => recheckWaiting(2));
    return Response.json(answer, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch {
    return Response.json({ ...closedAnswer(), open: true, message: "Couldn't read the list just now." }, { status: 502, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  if (!voicesConfigured()) return fail(CLOSED, 503);
  if (!originAllowed(request)) return fail("Sign from the Sheaf site.", 403);
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

  const reading = body.action === "recheck" || body.action === "github";
  if (!(reading ? allowRead : allow)(ipOf(request))) return fail("That's a lot of tries. Wait a few minutes and try again.", 429);

  // A Solana key (base58) or an EVM address (0x…, stored checksummed).
  const evm = evmAddress(body.wallet);
  const publicKey = evm ? null : decodeAddress(body.wallet);
  if (!evm && !publicKey) return fail("That isn't a Solana or EVM wallet address.", 400);
  const wallet = evm ?? (body.wallet as string);
  const signature = evm ? null : decodeSignature(body.signature);
  /** Checks a signature over `message` by this wallet, whichever chain it is on. */
  const signedBy = async (message: string) =>
    evm ? verifyEvmSigned(message, body.signature, evm) : !!signature && verifySigned(message, signature, publicKey!);

  if (body.action === "recheck") {
    try {
      const voice = await recheck(wallet, { force: true });
      if (!voice) return fail("This wallet hasn't signed.", 404);
      return Response.json({ ok: true, voice, status: statusOf(voice) }, { headers: NO_STORE });
    } catch {
      return fail("Couldn't read the chain just now. Try again in a minute.", 502);
    }
  }

  if (body.action === "github") {
    const id = gistId(body.gist);
    if (!id) return fail("Paste the gist's link, like https://gist.github.com/you/1a2b3c…", 400);
    try {
      const voice = await getVoice(wallet);
      if (!voice) return fail("This wallet hasn't signed.", 404);
      if (voice.platform !== "github") return fail("Only GitHub handles can be verified this way.", 400);
      const check = await checkGist(id, voice.handle, voice.message);
      if (!check.ok) return fail(check.error, 400);
      const saved = await updateVoice(wallet, (cur) => (cur.message === voice.message ? { ...cur, github: check.proof } : cur));
      if (!saved?.github) return fail("The entry changed while checking. Try again.", 409);
      return Response.json({ ok: true, voice: saved, status: statusOf(saved) }, { headers: NO_STORE });
    } catch {
      return fail("Couldn't check that just now. Try again in a minute.", 502);
    }
  }

  if (!evm && !signature) return fail("The signature is missing or malformed.", 400);
  if (evm && !(typeof body.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(body.signature))) return fail("The signature is missing or malformed.", 400);
  if (!isFresh(body.date)) return fail("The signed date must be within two days of today. Sign again.", 400);
  const date = body.date;

  if (body.action === "remove") {
    if (!(await signedBy(removalMessage(wallet, date)))) return fail("The signature doesn't match this wallet.", 401);
    try {
      await removeVoice(wallet, date);
      return Response.json({ ok: true }, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof NotListed) return fail("This wallet isn't on the list.", 404);
      if (err instanceof StaleSignature) return fail("That signature is older than the entry. Sign again.", 409);
      return fail("We couldn't take it down just now. Try again in a minute.", 502);
    }
  }

  if (!isWalletKind(body.walletKind)) return fail("Sign again from the Sheaf site.", 400);
  const walletKind = body.walletKind;
  if (!isPlatform(body.platform)) return fail("Choose X, Telegram or GitHub.", 400);
  const platform = body.platform;
  const handle = cleanHandle(platform, body.handle);
  if (!handle) return fail("That handle doesn't look right for that platform.", 400);
  const q = cleanQuote(body.quote);
  if ("error" in q) return fail(q.error, 400);
  const ref = body.ref == null || body.ref === "" ? null : cleanRef(body.ref);
  if (body.ref != null && body.ref !== "" && !ref) return fail("That invite code isn't usable. Sign again without it.", 400);

  const fields = { wallet, walletKind, platform, handle, quote: q.quote, ref, date };
  const message = voiceMessage(fields);
  if (!(await signedBy(message))) return fail("The signature doesn't match this wallet and message.", 401);

  let voice: Voice = { ...fields, message, signature: body.signature as string, at: new Date().toISOString(), proof: null, github: null };
  try {
    voice = await saveVoice(voice);
  } catch (err) {
    if (err instanceof StaleSignature) return fail("This wallet already signed something newer. Sign again with today's date.", 409);
    return fail("We couldn't save that just now. Try again in a minute.", 502);
  }
  // Look for the wallet's first Sheaf action now, so the signer learns at once whether they're listed.
  if (!voice.proof && !isTeamWallet(wallet)) voice = (await recheck(wallet, { force: true }).catch(() => null)) ?? voice;
  return Response.json({ ok: true, voice, status: statusOf(voice), team: isTeamWallet(wallet) }, { headers: NO_STORE });
}
