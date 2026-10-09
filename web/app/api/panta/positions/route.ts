import { NextResponse } from "next/server";
import { getMarket, isFixture, pantaMode, positions, type PantaMarket } from "@/lib/panta-server";
import { clientIp, throttle } from "@/lib/panta-throttle";

/**
 * GET /api/panta/positions?wallet=<base58>
 *
 * The wallet's Panta holdings (GET /positions/), each valued the way Panta's
 * docs describe: shares times the side's spot price while the market is open,
 * about $1 a share for a resolved winner, $0 for a loser. Market details come
 * from GET /markets/{id}/, read once per distinct market.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const mode = pantaMode();
  if (mode === "off") return NextResponse.json({ mode, positions: [] });
  const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
  if (!BASE58.test(wallet)) return NextResponse.json({ error: "Connect a wallet first." }, { status: 400 });
  const wait = throttle(clientIp(req), "read");
  if (wait != null) {
    return NextResponse.json({ error: `Too many requests. Try again in ${wait}s.` }, { status: 429 });
  }
  try {
    const held = await positions(wallet);
    const ids = [...new Set((held.positions ?? []).map((p) => p.marketId))].slice(0, 20);
    const markets = new Map<string, PantaMarket>();
    for (const id of ids) {
      const m = await getMarket(id).catch(() => null);
      if (m) markets.set(id, m);
    }
    const rows = (held.positions ?? []).map((p) => {
      const m = markets.get(p.marketId);
      const shares = Number(p.shares) || 0;
      const resolved = p.outcome != null || p.phase === "resolved";
      const spot = m ? Number(p.side === "yes" ? m.yesPrice : m.noPrice) : NaN;
      const valueUsdc = resolved
        ? p.side === p.outcome
          ? shares
          : 0
        : Number.isFinite(spot)
          ? shares * spot
          : null;
      return { ...p, title: m?.title ?? null, spot: Number.isFinite(spot) ? spot : null, valueUsdc };
    });
    return NextResponse.json(
      { mode, fixture: isFixture(held), wallet, positions: rows },
      { headers: { "cache-control": "private, max-age=10" } },
    );
  } catch (err) {
    return NextResponse.json({ mode, error: (err as Error).message }, { status: 502 });
  }
}
