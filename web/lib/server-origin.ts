import "server-only";

/**
 * This site's pages, by exact origin: production, the local dev server, and this
 * project's own Vercel previews (sheaf-<hash>-rohanglitcheds-projects.vercel.app).
 * Anyone can deploy sheaf-anything.vercel.app, so nothing looser is accepted.
 */
const EXACT = new Set(["https://sheaf-index.vercel.app", "http://localhost:3900"]);
const PREVIEW = /^sheaf-[a-z0-9]+-rohanglitcheds-projects\.vercel\.app$/;

export function isSiteOrigin(origin: string): boolean {
  if (EXACT.has(origin)) return true;
  try {
    const o = new URL(origin);
    return o.protocol === "https:" && o.port === "" && PREVIEW.test(o.hostname);
  } catch {
    return false;
  }
}

/**
 * True when the request comes from one of this site's pages. A browser always
 * sends Origin on a POST, so a missing one means a script: refused unless the
 * route is meant for schedulers and terminals too (`allowMissing`).
 */
export function originAllowed(request: Request, opts: { allowMissing?: boolean } = {}): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return !!opts.allowMissing;
  return isSiteOrigin(origin);
}
