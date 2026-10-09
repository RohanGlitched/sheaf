import { NextResponse, after, type NextRequest } from "next/server";
import { readTape } from "@/lib/tape-server";
import { rememberOidc } from "@/lib/gcs-store";
import { maybeSaveSeed } from "@/lib/tape-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/tape -> the newest tokenized-stock trades on Solana mainnet.
 *
 * Two seconds of shared CDN cache, ten of stale-while-revalidate: however many
 * tabs are open, the edge sends a poll through at most every couple of seconds,
 * which keeps every instance together inside Solami's five requests a second.
 * A failed poll answers with the last good tape (marked `stale`), so a blip
 * upstream never blanks the page.
 *
 * When the cached tape is a few seconds old it answers at once and the next
 * poll runs in `after()`, which on Vercel keeps the function alive until the
 * poll finishes (an un-awaited promise would be frozen with the response).
 *
 * A cold instance answers within about four seconds: with its backfill if that
 * finished, otherwise an empty tape marked `warming` while it finishes in
 * `after()`.
 *
 * After answering, a tape with 20 or more live rows refreshes the rolling
 * "earlier trades" seed in GCS (lib/tape-store.ts, served by /api/tape/seed).
 *
 * `?depth=60` returns up to 60 prints instead of 30 (used by scripts/tape-seed.mjs).
 */
export async function GET(req: NextRequest) {
  const depth = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("depth")) || 30));
  rememberOidc(req);
  try {
    const tape = await readTape((task) => after(task));
    // With 20+ live rows, refresh the rolling seed in GCS (throttled to every 10 min per instance).
    after(() => maybeSaveSeed(tape));
    return NextResponse.json(
      { ...tape, prints: tape.prints.slice(0, depth) },
      {
        headers: {
          // A warming answer (cold instance, backfill still running) must not be cached.
          "cache-control": tape.warming ? "no-store" : "public, s-maxage=2, stale-while-revalidate=10",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3" } },
    );
  }
}
