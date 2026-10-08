import { SITE_URL } from "@/lib/config";
import { launchName, launchSymbol } from "@/lib/dbc";
import { fetchBasketAt } from "@/lib/sheaf";

/** Token metadata for a basket's launch token, which points its mint's URI here. */
export async function GET(_request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const basket = await fetchBasketAt(address);
  if (!basket) return Response.json({ error: "No basket at that address." }, { status: 404 });

  const page = `${SITE_URL}/basket/${basket.address}`;
  return Response.json(
    {
      name: launchName(basket.name),
      symbol: launchSymbol(basket.symbol),
      description: `Launch token for ${basket.name} (${basket.symbol}), a Sheaf basket of ${basket.components.length} tokenized equities. A separate token on a Meteora bonding curve, not a redemption right into the basket.`,
      image: `${page}/opengraph-image`,
      external_url: page,
    },
    { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}
