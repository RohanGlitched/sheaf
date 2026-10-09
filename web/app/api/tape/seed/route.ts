import { NextResponse } from "next/server";
import { rememberOidc } from "@/lib/gcs-store";
import { readSeed } from "@/lib/tape-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/tape/seed -> the rolling "earlier trades" seed from GCS (see
 * lib/tape-store.ts), or 204 when there is none, in which case the page falls
 * back to the committed /tape.seed.json.
 */
export async function GET(req: Request) {
  rememberOidc(req);
  const seed = await readSeed();
  if (!seed) return new NextResponse(null, { status: 204, headers: { "cache-control": "public, s-maxage=60" } });
  return NextResponse.json(seed, { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=600" } });
}
