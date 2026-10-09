import "server-only";
import { createHmac } from "node:crypto";
import { HOMES, type Home, type MonthlyBand, type UsRoute, type WaitlistCounts } from "./waitlist-options";

/**
 * The India waitlist, kept in a private Google Cloud Storage bucket and reached
 * without any key: the function's Vercel OIDC token is exchanged at Google's STS
 * for a short-lived access token on the bucket (workload identity federation).
 * The same approach as Routed's lib/storage.ts.
 *
 * Configured by environment variables:
 *   WAITLIST_GCS_BUCKET    the bucket, e.g. sheaf-waitlist-a1ae9591
 *   WAITLIST_WIF_AUDIENCE  //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
 *   WAITLIST_SALT          a random secret for hashing contacts (optional, but set it before answers arrive:
 *                          changing it later stops older contacts from being recognised as repeats)
 * With the first two missing, the waitlist reports itself closed and nothing is stored.
 *
 * Each answer is its own small object, and what the page shows is read from the
 * object names alone, so counting never opens an answer:
 *   india/c/<hash>/<home>.json              an answer that left a contact. <hash> is a salted HMAC of the
 *                                           contact, so one contact can answer once; the contact itself is
 *                                           stored once, inside the object, and nowhere else.
 *   india/n/<day>-<iphash>/<home>.json      an answer without a contact. <iphash> is a salted HMAC of the
 *                                           sender's address and the day, so one address answers without a
 *                                           contact once a day; the address itself is never stored.
 *   india/a/<home>/<day>-<ts>-<rand>.json   an answer without a contact, from before that rule (9 Oct).
 *
 * Public numbers count only answers that left a contact: a contact is de-duplicated, an
 * answer without one is not a person anyone can reach, so it is kept but never headlined.
 * Nothing about the person is kept beyond the answers, the day, the invite code they came
 * with (if any) and those hashes: no IP address, no user agent, no wallet.
 */

export type WaitlistEntry = {
  band: MonthlyBand;
  route: UsRoute;
  home: Home;
  /** An email or Telegram handle, or "" when none was given. */
  contact: string;
  /** The day the answer arrived, YYYY-MM-DD (UTC). */
  day: string;
  /** The invite code the person arrived with (lib/invite-ref.ts), or null. */
  ref: string | null;
};

const PREFIX = "india/";
const COUNT_TTL_MS = 30_000;
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const GCS = "https://storage.googleapis.com/storage/v1/b";
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b";

export function waitlistConfigured(): boolean {
  return Boolean(process.env.WAITLIST_GCS_BUCKET && process.env.WAITLIST_WIF_AUDIENCE);
}

/** Thrown when a contact is already on the list. */
export class AlreadyListed extends Error {}

let token: { value: string; exp: number } | null = null;

/** Exchanges the Vercel OIDC token for a Google access token on the bucket; cached until five minutes before expiry. */
async function accessToken(oidc: string | null): Promise<string> {
  if (token && token.exp - 300 > Date.now() / 1000) return token.value;
  // On Vercel the token arrives on each request (x-vercel-oidc-token); locally, `vercel env pull` writes it to .env.local.
  const subject = oidc || process.env.VERCEL_OIDC_TOKEN;
  if (!subject) throw new Error("No Vercel OIDC token: enable OIDC federation on the Vercel project");
  const r = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: process.env.WAITLIST_WIF_AUDIENCE,
      scope: SCOPE,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: subject,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Waitlist federation: HTTP ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Math.floor(Date.now() / 1000) + j.expires_in };
  return token.value;
}

const bucket = () => encodeURIComponent(process.env.WAITLIST_GCS_BUCKET!);

/** A salted HMAC of a cleaned contact, 128 bits in hex: enough to recognise a repeat, useless for reading it back. */
function contactHash(contact: string): string {
  const salt = process.env.WAITLIST_SALT || "sheaf-waitlist-v1";
  return createHmac("sha256", salt).update(contact).digest("hex").slice(0, 32);
}

/** Object names under a prefix. */
async function names(prefix: string, auth: Record<string, string>, limit = 50_000): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ prefix, maxResults: String(Math.min(1000, limit)), fields: "items(name),nextPageToken" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${GCS}/${bucket()}/o?${q}`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Waitlist list: HTTP ${r.status}`);
    const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
    out.push(...(j.items ?? []).map((i) => i.name));
    pageToken = j.nextPageToken;
  } while (pageToken && out.length < limit);
  return out;
}

const emptyByHome = (): Record<Home, number> => Object.fromEntries(HOMES.map((h) => [h.key, 0])) as Record<Home, number>;
const asHome = (s: string | undefined): Home | null => (HOMES.some((h) => h.key === s) ? (s as Home) : null);

let counted: { c: WaitlistCounts; at: number } | null = null;

/** Answers that left a contact, and where those people live; read at most every 30 s per instance. Answers without a contact are not counted. */
export async function waitlistCounts(oidc: string | null): Promise<WaitlistCounts> {
  if (counted && Date.now() - counted.at < COUNT_TTL_MS) return counted.c;
  const all = await names(`${PREFIX}c/`, { authorization: `Bearer ${await accessToken(oidc)}` });
  const c: WaitlistCounts = { count: 0, withContact: 0, byHome: emptyByHome() };
  for (const name of all) {
    const parts = name.split("/");
    if (parts[1] !== "c") continue;
    c.count++;
    c.withContact++;
    const home = asHome(parts[3]?.replace(/\.json$/, ""));
    if (home) c.byHome[home]++;
  }
  counted = { c, at: Date.now() };
  return c;
}

/** Thrown when this address already answered today without a contact. */
export class AlreadyAnsweredToday extends Error {}

/**
 * Stores one answer as its own object. With a contact, the object is named by the contact's hash and
 * written with ifGenerationMatch=0 after checking the hash isn't already listed, so one contact answers once.
 * Without one, it is named by a hash of the sender's address and the day, so one address answers once a day.
 */
export async function addToWaitlist(entry: WaitlistEntry, oidc: string | null, sender: { ip: string }): Promise<void> {
  const auth = { authorization: `Bearer ${await accessToken(oidc)}` };
  let name: string;
  if (entry.contact) {
    const hash = contactHash(entry.contact);
    if ((await names(`${PREFIX}c/${hash}/`, auth, 1)).length > 0) throw new AlreadyListed();
    name = `${PREFIX}c/${hash}/${entry.home}.json`;
  } else {
    const slot = `${PREFIX}n/${entry.day}-${contactHash(`ip|${sender.ip}|${entry.day}`)}/`;
    if ((await names(slot, auth, 1)).length > 0) throw new AlreadyAnsweredToday();
    name = `${slot}${entry.home}.json`;
  }
  const q = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0" });
  const r = await fetch(`${UPLOAD}/${bucket()}/o?${q}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 412) throw entry.contact ? new AlreadyListed() : new AlreadyAnsweredToday();
  if (!r.ok) throw new Error(`Waitlist write: HTTP ${r.status}`);
  if (counted && entry.contact) {
    const c = counted.c;
    counted = {
      at: counted.at,
      c: { count: c.count + 1, withContact: c.withContact + 1, byHome: { ...c.byHome, [entry.home]: c.byHome[entry.home] + 1 } },
    };
  }
}
