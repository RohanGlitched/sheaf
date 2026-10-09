import { Connection, PublicKey } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { clientIp, faucetKeypair } from "@/lib/faucet-server";
import { ALT_MIN_COMPONENTS, altInfo, ensureAlt, findAlt } from "@/lib/alt";
import { fetchBasket } from "@/lib/sheaf";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/alt?basket=<address> → { alt, addresses }
 *
 * The house's address lookup table for a basket of seven or eight components,
 * created and filled on the first request, so a v0 fill, mint or redemption fits
 * in one packet. Smaller baskets need none and get { alt: null, addresses: [] }.
 * Anyone may ask: the table only holds public addresses, and the house makes at
 * most one per basket.
 */

const CREATIONS_PER_HOUR = 6;
const creations = new Map<string, number[]>();

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("basket") ?? "";
  let key: PublicKey;
  try {
    key = new PublicKey(raw);
  } catch {
    return Response.json({ error: "basket must be a basket address." }, { status: 400 });
  }
  const house = faucetKeypair();
  if (!house) return Response.json({ error: "The house key is not configured here." }, { status: 503 });

  const connection = new Connection(WRITE_RPC, "confirmed");
  const basket = await fetchBasket(connection, key).catch(() => null);
  if (!basket) return Response.json({ error: "No Sheaf basket at that address." }, { status: 404 });
  if (basket.components.length < ALT_MIN_COMPONENTS) {
    return Response.json(altInfo(null), { headers: { "cache-control": "public, s-maxage=3600" } });
  }

  try {
    let table = await findAlt(connection, house.publicKey, basket);
    if (!table) {
      const ip = clientIp(request);
      const now = Date.now();
      const recent = (creations.get(ip) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= CREATIONS_PER_HOUR) {
        return Response.json({ error: "Too many new lookup tables from here. Try again later." }, { status: 429 });
      }
      creations.set(ip, [...recent, now]);
    }
    table = await ensureAlt(connection, house, basket);
    return Response.json(altInfo(table), { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=3600" } });
  } catch (err) {
    return Response.json({ error: ((err as Error).message ?? "lookup table failed").split("\n")[0].slice(0, 200) }, { status: 502 });
  }
}
