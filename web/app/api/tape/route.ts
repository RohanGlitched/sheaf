import { NextResponse } from "next/server";
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
 */
export async function GET() {
  try {
    const tape = await readTape();
    return NextResponse.json(tape, {
      headers: { "cache-control": "public, s-maxage=2, stale-while-revalidate=10" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3" } },
    );
  }
}
