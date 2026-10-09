import "server-only";

/**
 * A small client for the project's private Google Cloud Storage bucket, reached
 * without any key, as lib/waitlist-store.ts does: the function's Vercel OIDC
 * token is exchanged at Google's STS for a short-lived access token on the
 * bucket (workload identity federation). Configured by WAITLIST_GCS_BUCKET and
 * WAITLIST_WIF_AUDIENCE; with either missing, voicesConfigured() is false.
 *
 * Kept separate from lib/gcs-store.ts because voices also need to list objects.
 */

const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";
const GCS = "https://storage.googleapis.com/storage/v1/b";
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b";

export class Conflict extends Error {}

export function voicesConfigured(): boolean {
  return Boolean(process.env.WAITLIST_GCS_BUCKET && process.env.WAITLIST_WIF_AUDIENCE);
}

let token: { value: string; exp: number } | null = null;
let lastOidc: string | null = null;

/** On Vercel the OIDC token arrives on each request; locally `vercel env pull` writes it to .env.local. */
export function oidcFrom(headers: Headers) {
  const t = headers.get("x-vercel-oidc-token");
  if (t) lastOidc = t;
}

async function auth(): Promise<Record<string, string>> {
  if (!token || token.exp - 300 <= Date.now() / 1000) {
    const subject = lastOidc || process.env.VERCEL_OIDC_TOKEN;
    if (!subject) throw new Error("No Vercel OIDC token");
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
    if (!r.ok) throw new Error(`Voices federation: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: Math.floor(Date.now() / 1000) + j.expires_in };
  }
  return { authorization: `Bearer ${token.value}` };
}

const bucket = () => encodeURIComponent(process.env.WAITLIST_GCS_BUCKET!);

/** Object names under a prefix, up to `limit`. */
export async function listNames(prefix: string, limit = 20_000): Promise<string[]> {
  const headers = await auth();
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ prefix, maxResults: String(Math.min(1000, limit)), fields: "items(name),nextPageToken" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await fetch(`${GCS}/${bucket()}/o?${q}`, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Voices list: HTTP ${r.status}`);
    const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
    out.push(...(j.items ?? []).map((i) => i.name));
    pageToken = j.nextPageToken;
  } while (pageToken && out.length < limit);
  return out;
}

/** A JSON object and its generation, or null when it doesn't exist. */
export async function readJson<T>(name: string): Promise<{ data: T; generation: string } | null> {
  const r = await fetch(`${GCS}/${bucket()}/o/${encodeURIComponent(name)}?alt=media`, {
    headers: await auth(),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Voices read: HTTP ${r.status}`);
  return { data: (await r.json()) as T, generation: r.headers.get("x-goog-generation") ?? "0" };
}

/** Writes a JSON object; `ifGenerationMatch` "0" means only if new, a generation means only if unchanged since. */
export async function writeJson(name: string, data: unknown, ifGenerationMatch?: string): Promise<void> {
  const q = new URLSearchParams({ uploadType: "media", name });
  if (ifGenerationMatch != null) q.set("ifGenerationMatch", ifGenerationMatch);
  const r = await fetch(`${UPLOAD}/${bucket()}/o?${q}`, {
    method: "POST",
    headers: { ...(await auth()), "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 412) throw new Conflict();
  if (!r.ok) throw new Error(`Voices write: HTTP ${r.status}`);
}

/**
 * An entry taken down is overwritten with a tombstone rather than deleted: the
 * Vercel principal may create and overwrite objects, and the tombstone's date
 * stops an older signature from being replayed to bring the entry back.
 */
export type Tombstone = { removed: true; date: string; at: string };
