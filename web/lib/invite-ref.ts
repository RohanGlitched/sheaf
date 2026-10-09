/**
 * Invite codes: a short label in the URL (?ref=) that says which channel brought
 * someone to Sheaf, so the founder can see which posts and groups worked.
 *
 * A code is whatever the person sharing the link chose: a channel name
 * ("telegram-sol-devs"), their own handle, or a wallet address. Nothing else
 * rides along. No cookie is set; the browser keeps only the code itself (see
 * lib/invite-keep.ts), and the voices form and the waitlist pass it on.
 *
 * Shared by the browser and the server, so both clean a code the same way.
 */

export const REF_PARAM = "ref";
export const REF_MAX = 44;

/** Where an invite link may land. Anything else lands on /voices. */
export const INVITE_TARGETS = ["/voices", "/", "/plans", "/explore", "/compose", "/ledger", "/portfolio"] as const;
export type InviteTarget = (typeof INVITE_TARGETS)[number];

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A cleaned invite code, or null when there is nothing usable. A leading @ is
 * dropped; letters, digits, dot, dash and underscore are kept. Wallet addresses
 * keep their case (base58 is case-sensitive); everything else is folded to lower
 * case so "Twitter" and "twitter" count as one channel.
 */
export function cleanRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^@+/, "");
  if (!s || s.length > REF_MAX) return null;
  if (BASE58_KEY.test(s)) return s;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  const lower = s.toLowerCase().replace(/^[._-]+|[._-]+$/g, "");
  return lower || null;
}

export function cleanTarget(raw: unknown): InviteTarget {
  return typeof raw === "string" && (INVITE_TARGETS as readonly string[]).includes(raw) ? (raw as InviteTarget) : "/voices";
}

/** The link to share: it counts one open, then lands on `to` with the code in the URL. */
export function inviteLink(origin: string, ref: string, to: InviteTarget = "/voices"): string {
  const q = new URLSearchParams({ [REF_PARAM]: ref });
  if (to !== "/voices") q.set("to", to);
  return `${origin.replace(/\/$/, "")}/api/invite?${q}`;
}

/** A page path with the code attached, e.g. /voices?ref=telegram. */
export function withRef(path: string, ref: string | null): string {
  if (!ref) return path;
  const [p, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  q.set(REF_PARAM, ref);
  return `${p}?${q}`;
}

/** Counts for one invite code: link opens, and how many people who came with it signed. */
export type InviteCount = { ref: string; opens: number; signed: number };
