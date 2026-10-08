import { Connection } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { basketToJson, fetchBaskets } from "@/lib/sheaf";

/**
 * Every basket, read once for everybody. Listing baskets is a scan of the
 * whole program, the heaviest read the site makes, so it runs here behind a
 * short shared cache instead of in every visitor's browser.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const baskets = await fetchBaskets(new Connection(WRITE_RPC, "confirmed"));
    return Response.json(baskets.map(basketToJson), {
      headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=50" },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "The program could not be read." },
      { status: 502 },
    );
  }
}
