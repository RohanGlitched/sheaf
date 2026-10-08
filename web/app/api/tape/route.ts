import { NextResponse } from "next/server";
import { readTape } from "@/lib/tape-server";

export const dynamic = "force-dynamic";

/** GET /api/tape -> the newest tokenized-stock trades on Solana mainnet. */
export async function GET() {
  try {
    const tape = await readTape();
    return NextResponse.json(tape, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
