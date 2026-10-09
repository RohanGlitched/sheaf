import { NextResponse, after, type NextRequest } from "next/server";
import { readTape } from "@/lib/tape-server";

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
 * `?depth=60` returns up to 60 prints instead of 30 (used by scripts/tape-seed.mjs).
 */
export async function GET(req: NextRequest) {
  const depth = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get("depth")) || 30));
  try {
    const tape = await readTape((task) => after(task));
    return NextResponse.json(
      { ...tape, prints: tape.prints.slice(0, depth) },
      { headers: { "cache-control": "public, s-maxage=2, stale-while-revalidate=10" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3" } },
    );
  }
}
