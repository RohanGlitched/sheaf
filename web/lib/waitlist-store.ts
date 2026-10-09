import "server-only";
import { randomBytes } from "node:crypto";
import type { MonthlyBand, UsRoute } from "./waitlist-options";

/**
 * The India waitlist, kept in a private Google Cloud Storage bucket and reached
 * without any key: the function's Vercel OIDC token is exchanged at Google's STS
 * for a short-lived access token on the bucket (workload identity federation).
 * The same approach as Routed's lib/storage.ts.
 *
 * Configured by two environment variables:
 *   WAITLIST_GCS_BUCKET    the bucket, e.g. sheaf-waitlist-a1ae9591
 *   WAITLIST_WIF_AUDIENCE  //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
 * With either missing, the waitlist reports itself closed and nothing is stored.
 *
 * Each answer is its own small object, so two submissions never contend for
 * one file, and the count is a listing of the prefix. Nothing about the person
 * is kept beyond the three answers and the day they gave them: no IP address,
 * no user agent, no wallet.
 */

export type WaitlistEntry = {
  band: MonthlyBand;
  route: UsRoute;
  /** An email or Telegram handle, or "" when none was given. */
  contact: string;
  /** The day the answer arrived, YYYY-MM-DD (UTC). */
  day: string;
};

const PREFIX = "india/";
const COUNT_TTL_MS = 30_000;
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export function waitlistConfigured(): boolean {
  return Boolean(process.env.WAITLIST_GCS_BUCKET && process.env.WAITLIST_WIF_AUDIENCE);
}

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

let counted: { n: number; at: number } | null = null;

/** How many answers the waitlist holds, read from the bucket at most every 30 seconds per instance. */
export async function waitlistCount(oidc: string | null): Promise<number> {
  if (counted && Date.now() - counted.at < COUNT_TTL_MS) return counted.n;
  const auth = { authorization: `Bearer ${await accessToken(oidc)}` };
  let n = 0;
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ prefix: PREFIX, maxResults: "1000", fields: "items(name),nextPageToken" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket()}/o?${q}`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Waitlist count: HTTP ${r.status}`);
    const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
    n += j.items?.length ?? 0;
    pageToken = j.nextPageToken;
  } while (pageToken && n < 50_000);
  counted = { n, at: Date.now() };
  return n;
}

/** Stores one answer as its own object; ifGenerationMatch=0 means it can never overwrite another. */
export async function addToWaitlist(entry: WaitlistEntry, oidc: string | null): Promise<void> {
  const name = `${PREFIX}${entry.day}/${Date.now()}-${randomBytes(6).toString("hex")}.json`;
  const q = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0" });
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket()}/o?${q}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken(oidc)}`, "content-type": "application/json" },
    body: JSON.stringify(entry),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Waitlist write: HTTP ${r.status}`);
  if (counted) counted = { n: counted.n + 1, at: counted.at };
}
