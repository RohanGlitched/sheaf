import { cleanRef } from "./invite-ref";

/**
 * The message a tester signs to put their name on /voices, and the rules for
 * every field in it. Shared by the browser and the server: the browser builds
 * the text the wallet signs, the server rebuilds it from the same cleaned fields
 * and checks the signature against that, so nothing can be swapped in between.
 */

export const PLATFORMS = {
  x: { label: "X", pattern: /^[A-Za-z0-9_]{1,15}$/, hint: "1 to 15 letters, digits or _", url: (h: string) => `https://x.com/${h}`, at: true },
  telegram: { label: "Telegram", pattern: /^[A-Za-z][A-Za-z0-9_]{4,31}$/, hint: "5 to 32 letters, digits or _", url: (h: string) => `https://t.me/${h}`, at: true },
  github: { label: "GitHub", pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, hint: "up to 39 letters, digits or -", url: (h: string) => `https://github.com/${h}`, at: false },
} as const;

export type Platform = keyof typeof PLATFORMS;

export const QUOTE_MAX = 200;
/** A signature is fresh when its date is at most this many days from today (UTC). */
export const FRESH_DAYS = 2;
export const SITE_LINE = "sheaf-index.vercel.app/voices";

export type VoiceFields = {
  wallet: string;
  platform: Platform;
  handle: string;
  quote: string;
  ref: string | null;
  /** YYYY-MM-DD, UTC. */
  date: string;
};

/** One stored, signed entry, as /api/voices serves it. */
export type Voice = VoiceFields & {
  /** The exact text the wallet signed. */
  message: string;
  /** The ed25519 signature over `message`, base58. */
  signature: string;
  /** When the server received it, ISO 8601. */
  at: string;
};

export const isPlatform = (p: unknown): p is Platform => typeof p === "string" && Object.hasOwn(PLATFORMS, p);

/** A handle without its @ or profile URL, or null when it doesn't fit the platform's rules. */
export function cleanHandle(platform: Platform, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  // Accept a pasted profile link and keep only the name.
  s = s.replace(/^https?:\/\/(www\.)?(x\.com|twitter\.com|t\.me|telegram\.me|github\.com)\//i, "").replace(/[/?#].*$/, "");
  s = s.replace(/^@+/, "");
  return PLATFORMS[platform].pattern.test(s) ? s : null;
}

/** How a handle reads on the page and in the message: "@name" on X and Telegram, "name" on GitHub. */
export function handleText(platform: Platform, handle: string): string {
  return PLATFORMS[platform].at ? `@${handle}` : handle;
}

export function profileUrl(platform: Platform, handle: string): string {
  return PLATFORMS[platform].url(handle);
}

export type QuoteCheck = { quote: string } | { error: string };

/**
 * A quote as plain text: tags and control characters removed, whitespace run
 * together, at most 200 characters. Links are refused rather than stripped, so a
 * quote can never carry one and nobody's words are silently changed.
 */
export function cleanQuote(raw: unknown): QuoteCheck {
  if (raw == null || raw === "") return { quote: "" };
  if (typeof raw !== "string") return { error: "The quote must be text." };
  const s = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    // Control and invisible formatting characters (including bidi overrides).
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > QUOTE_MAX) return { error: `Keep the quote to ${QUOTE_MAX} characters.` };
  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|app|net|org|me|gg|fun|sol)\b)/i.test(s)) return { error: "Leave links out of the quote; your handle is linked already." };
  return { quote: s };
}

export { cleanRef };

/** Today in UTC, YYYY-MM-DD. */
export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** True when `date` is a real YYYY-MM-DD within FRESH_DAYS of today (UTC). */
export function isFresh(date: unknown, now = Date.now()): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t) || todayUtc(t) !== date) return false;
  const today = Date.parse(`${todayUtc(now)}T00:00:00Z`);
  return Math.abs(today - t) <= FRESH_DAYS * 86_400_000;
}

/** The exact text the wallet signs. Every line comes from a cleaned field. */
export function voiceMessage(f: VoiceFields): string {
  return [
    "Sheaf: people who tried it",
    "",
    "I used Sheaf with this wallet, and I'm happy for that to be public.",
    "",
    `Wallet: ${f.wallet}`,
    `Handle: ${PLATFORMS[f.platform].label} ${handleText(f.platform, f.handle)}`,
    `Quote: ${f.quote || "(none)"}`,
    `Invited via: ${f.ref || "(none)"}`,
    `Date: ${f.date}`,
    `Site: ${SITE_LINE}`,
    "",
    "This is a signature, not a transaction. It costs nothing and moves nothing.",
  ].join("\n");
}

/** The text a wallet signs to take its entry down again. */
export function removalMessage(wallet: string, date: string): string {
  return ["Sheaf: remove my name", "", `Wallet: ${wallet}`, `Date: ${date}`, `Site: ${SITE_LINE}`].join("\n");
}

/** What GET /api/voices answers. */
export type VoicesAnswer = {
  /** False until storage is configured; the page then says signing hasn't opened. */
  open: boolean;
  /** Signed entries from wallets that aren't the team's, newest first. */
  voices: Voice[];
  /** How many signed entries came from the team's own wallets (not listed). */
  ours: number;
  /** Per invite code: link opens and signatures. */
  refs: { ref: string; opens: number; signed: number }[];
  asOf: number;
  message?: string;
};
