import { PublicKey } from "@solana/web3.js";
import { quoteFill, type FillLegRequest } from "@/lib/fill-cost";
import { fetchMarket } from "@/lib/market";
import { priceMint, stockForWriteMint, symbolForWriteMint } from "@/lib/mirror";
import { fetchBasketAt } from "@/lib/sheaf";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/route-cost?basket=<address> → { basket, bps: { "100": n, "1000": n }, at, ... }
 *
 * What a filler pays to buy a basket's stocks on mainnet's real routes for a $100
 * and a $1,000 order: Jupiter quotes through lib/fill-cost.ts (the same
 * measurement as /api/fill-cost). Two different numbers, never to be read as
 * halves of each other:
 *
 *   bps           buying only: dollars paid over the stocks' value at the prices
 *                 this site shows, so it includes any premium the route pays over
 *                 those prices.
 *   roundTripBps  the route's own spread: USDC in against USDC back, buying each
 *                 leg and selling it straight back. No reference price in it.
 *
 * A dollar order
 * or plan whose one-way cost is above the desk's band cannot be filled at a
 * profit, so the forms read this to say so. Cached for ten minutes per basket.
 * A size that cannot be routed reads null.
 */

const SIZES = [100, 1000] as const;
const TTL_MS = 10 * 60_000;

type Answer = {
  basket: string;
  bps: Record<string, number | null>;
  roundTripBps: Record<string, number | null>;
  unroutable: string[];
  at: string;
};

const cache = new Map<string, { at: number; answer: Answer }>();
const inFlight = new Map<string, Promise<Answer>>();

async function measure(address: string): Promise<Answer | null> {
  const [basket, market] = await Promise.all([fetchBasketAt(address), fetchMarket()]);
  if (!basket) return null;
  const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));
  const parts = basket.components.map((c) => {
    const symbol = symbolForWriteMint(c.mint);
    const stock = stockForWriteMint(c.mint);
    const q = stock ? quotes.get(stock.symbol) : undefined;
    const mint = symbol ? priceMint(symbol) : null;
    const perShareUsd = q ? (Number(c.unitsPerShare) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1) : null;
    return { c, symbol: symbol ?? c.mint.slice(0, 6), mint, perShareUsd };
  });
  const nav = parts.reduce((a, p) => a + (p.perShareUsd ?? NaN), 0);
  const bps: Record<string, number | null> = {};
  const roundTripBps: Record<string, number | null> = {};
  const unroutable = new Set<string>(parts.filter((p) => !p.mint || p.perShareUsd == null).map((p) => p.symbol));
  if (unroutable.size === 0 && nav > 0) {
    // Both sizes at once; each is one buy and one sell quote per component.
    await Promise.all(SIZES.map(async (size) => {
      const shares = size / nav;
      const legs: FillLegRequest[] = parts.map((p) => ({
        mint: p.mint!,
        base: p.symbol,
        units: BigInt(Math.ceil(Number(p.c.unitsPerShare) * shares)).toString(),
        usd: p.perShareUsd! * shares,
      }));
      const cost = await quoteFill(legs, shares, 50, AbortSignal.timeout(20_000));
      cost.unroutable.forEach((u) => unroutable.add(u));
      // One way: dollars spent for the units the recipe needs, over their spot value.
      const spot = legs.reduce((a, l) => a + l.usd, 0);
      const paid = cost.legs.every((l) => l.coverage != null && l.coverage > 0)
        ? cost.legs.reduce((a, l) => a + l.usdcIn / (l.coverage as number), 0)
        : null;
      bps[String(size)] = paid != null && spot > 0 ? Math.round(((paid - spot) / spot) * 10_000) : null;
      roundTripBps[String(size)] = cost.roundTripBps != null ? Math.round(cost.roundTripBps) : null;
    }));
  } else {
    for (const size of SIZES) {
      bps[String(size)] = null;
      roundTripBps[String(size)] = null;
    }
  }
  return { basket: address, bps, roundTripBps, unroutable: [...unroutable], at: new Date().toISOString() };
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("basket") ?? "";
  let address: string;
  try {
    address = new PublicKey(raw).toBase58();
  } catch {
    return Response.json({ error: "basket must be a basket address." }, { status: 400 });
  }
  const headers = { "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" };
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.answer, { headers });
  let job = inFlight.get(address);
  if (!job) {
    job = measure(address)
      .then((a) => {
        if (!a) throw new Error("not a basket");
        return a;
      })
      .finally(() => inFlight.delete(address));
    inFlight.set(address, job);
  }
  try {
    const answer = await job;
    cache.set(address, { at: Date.now(), answer });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return Response.json(answer, { headers });
  } catch (err) {
    if (hit) return Response.json(hit.answer, { headers: { "cache-control": "no-store" } });
    const notBasket = (err as Error).message === "not a basket";
    return Response.json({ error: notBasket ? "No Sheaf basket at that address." : "Could not measure the routes right now." }, { status: notBasket ? 404 : 502 });
  }
}
