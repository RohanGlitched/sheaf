import { NextResponse, type NextRequest } from "next/server";

/**
 * One address for every page: sheaf.world.
 *
 * The site started on sheaf-index.vercel.app, which still serves the same
 * deployment, so search engines and shared links saw two copies of every page.
 * A page view there (a GET or HEAD that asks for HTML) is sent on to the same
 * path and query on sheaf.world with a permanent redirect (308).
 *
 * Everything else on the old address answers as before: /api/* (the Cloud
 * Scheduler jobs call /api/keeper, /api/evm-keeper and /api/filler2 there),
 * /_next/*, files with an extension, the generated icons and images, the app's
 * own in-page navigation requests (RSC), and every POST.
 */

const OLD_HOST = "sheaf-index.vercel.app";
const HOME = "https://sheaf.world";

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  if (host !== OLD_HOST) return NextResponse.next();
  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next();
  // A page view asks for HTML; the router's own fetches (RSC, prefetch) are left alone.
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html") || request.headers.has("rsc") || request.headers.has("next-router-prefetch")) {
    return NextResponse.next();
  }
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(`${HOME}${pathname}${search}`, 308);
}

export const config = {
  // Never /api, /_next, /_vercel, a file with an extension, or the generated icon and social images.
  matcher: ["/((?!api/|_next/|_vercel/|opengraph-image|twitter-image|icon|apple-icon|.*\\.[A-Za-z0-9]+$).*)"],
};
