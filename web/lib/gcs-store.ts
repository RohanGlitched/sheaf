import "server-only";

/**
 * Small JSON documents in the project's private Google Cloud Storage bucket,
 * reached without any key: the function's Vercel OIDC token is exchanged at
 * Google's STS for a short-lived access token (workload identity federation),
 * as lib/waitlist-store.ts does.
 *
 * Configured by WAITLIST_GCS_BUCKET and WAITLIST_WIF_AUDIENCE; with either
 * missing, gcsConfigured() is false and callers keep their state in memory.
 *
 * Writes can carry a generation precondition, so two instances updating one
 * document never silently drop each other's work: a lost race throws
 * GcsConflict, and the caller reloads, merges and tries again.
 */

const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export class GcsConflict extends Error {}

export function gcsConfigured(): boolean {
  return Boolean(process.env.WAITLIST_GCS_BUCKET && process.env.WAITLIST_WIF_AUDIENCE);
}

/**
 * On Vercel the OIDC token arrives on each request (x-vercel-oidc-token). Routes
 * hand it over here, so work that outlives the request, or code with no request
 * at hand, can still authenticate. Locally `vercel env pull` writes it to
 * .env.local as VERCEL_OIDC_TOKEN.
 */
let lastOidc: string | null = null;
export function rememberOidc(request: Request) {
  const t = request.headers.get("x-vercel-oidc-token");
  if (t) lastOidc = t;
}

let token: { value: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.exp - 300 > Date.now() / 1000) return token.value;
  const subject = lastOidc || process.env.VERCEL_OIDC_TOKEN;
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
  if (!r.ok) throw new Error(`GCS federation: HTTP ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Math.floor(Date.now() / 1000) + j.expires_in };
  return token.value;
}

const bucket = () => encodeURIComponent(process.env.WAITLIST_GCS_BUCKET!);

/** A document and its generation, or null when it does not exist yet. */
export async function getJson<T>(name: string): Promise<{ data: T; generation: string } | null> {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket()}/o/${encodeURIComponent(name)}?alt=media`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GCS read ${name}: HTTP ${r.status}`);
  const generation = r.headers.get("x-goog-generation") ?? "0";
  return { data: (await r.json()) as T, generation };
}

/**
 * Writes a document and returns its new generation. `ifGenerationMatch` makes the
 * write conditional: "0" means only if it does not exist, a generation means
 * only if nobody has written since that read. A lost race throws GcsConflict.
 */
export async function putJson(name: string, data: unknown, opts: { ifGenerationMatch?: string } = {}): Promise<string> {
  const q = new URLSearchParams({ uploadType: "media", name });
  if (opts.ifGenerationMatch != null) q.set("ifGenerationMatch", opts.ifGenerationMatch);
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket()}/o?${q}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 412) throw new GcsConflict(`GCS write ${name}: someone wrote it first`);
  if (!r.ok) throw new Error(`GCS write ${name}: HTTP ${r.status}`);
  const j = (await r.json()) as { generation?: string };
  return j.generation ?? "0";
}
