import "server-only";

/**
 * This site's pages: the request's own host, localhost in development, and the
 * project's Vercel deployments. Requests with no Origin (curl, cron, server-side
 * callers) pass unless `required` is set.
 */
export function originAllowed(request: Request, opts: { required?: boolean } = {}): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return !opts.required;
  try {
    const o = new URL(origin);
    const host = request.headers.get("host");
    return o.host === host || o.hostname === "localhost" || (o.hostname.endsWith(".vercel.app") && o.hostname.startsWith("sheaf"));
  } catch {
    return false;
  }
}
