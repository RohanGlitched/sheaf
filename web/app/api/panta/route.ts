import { NextResponse } from "next/server";
import { listMarkets, pantaMode, quoteBasketMarket, quoteBuy } from "@/lib/panta-server";
import { SITE_URL } from "@/lib/config";

/**
 * GET  /api/panta                    -> { mode, markets }
 * POST /api/panta { kind: "create", wallet, basket, name, symbol }
 * POST /api/panta { kind: "buy", wallet, marketId, side, amountUsdc }
 *
 * Quotes only. Nothing here signs or spends; a quote is what Panta would charge.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET() {
  const mode = pantaMode();
  if (mode === "off") return NextResponse.json({ mode, markets: [] });
  try {
    const markets = await listMarkets();
    return NextResponse.json(
      { mode, markets },
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
    );
  } catch (err) {
    return NextResponse.json({ mode, markets: [], error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const mode = pantaMode();
  if (mode === "off") return NextResponse.json({ error: "Panta is not configured." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, string> | null;
  if (!body || !BASE58.test(body.wallet ?? "")) {
    return NextResponse.json({ error: "Connect a wallet to get a quote." }, { status: 400 });
  }
  try {
    if (body.kind === "create") {
      if (!BASE58.test(body.basket ?? "")) throw new Error("Unknown basket.");
      const name = String(body.name ?? "").slice(0, 40);
      const symbol = String(body.symbol ?? "").slice(0, 10);
      const q = await quoteBasketMarket({
        wallet: body.wallet,
        basketName: name,
        basketSymbol: symbol,
        navUrl: `${SITE_URL}/basket/${body.basket}`,
      });
      return NextResponse.json({ mode, ...q });
    }
    if (body.kind === "buy") {
      const side = body.side === "no" ? "no" : "yes";
      const amount = Math.max(1, Math.min(1000, Number(body.amountUsdc) || 0)).toFixed(2);
      const q = await quoteBuy({ wallet: body.wallet, marketId: String(body.marketId), side, amountUsdc: amount });
      return NextResponse.json({ mode, ...q });
    }
    return NextResponse.json({ error: "Unknown request." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
