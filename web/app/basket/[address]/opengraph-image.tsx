import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { fetchMarket } from "@/lib/market";
import { stockForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { fetchBasketAt } from "@/lib/sheaf";
import { sheafDataUri } from "@/lib/sheaf-svg";

export const alt = "A Sheaf basket: what one share holds and what it is worth";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";


export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const dir = join(process.cwd(), "app/_og");
  const [funnel, host, basket, market] = await Promise.all([
    readFile(join(dir, "funnel-500.ttf")),
    readFile(join(dir, "host-400.ttf")),
    fetchBasketAt(address),
    // Unfurlers give up after a few seconds; better a card without a price than none.
    Promise.race([
      fetchMarket().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3500)),
    ]),
  ]);

  const bySymbol = new Map((market?.quotes ?? []).map((q) => [q.symbol, q]));
  const parts = (basket?.components ?? []).map((c, i) => {
    const stock = stockForWriteMint(c.mint);
    const quote = stock ? bySymbol.get(stock.symbol) : undefined;
    return {
      key: c.mint,
      base: stock?.base ?? c.mint.slice(0, 4),
      color: slotColor(i),
      weightBps: c.weightBps,
      change: quote?.change24h ?? null,
      value: quote
        ? (Number(c.unitsPerShare) * quote.price * quote.multiplier) / 10 ** c.decimals
        : null,
    };
  });
  const priced = parts.length > 0 && parts.every((p) => p.value != null);
  const nav = priced ? parts.reduce((a, p) => a + p.value!, 0) : null;
  const change =
    nav && parts.every((p) => p.change != null)
      ? parts.reduce((a, p) => a + (p.change! * p.value!) / nav, 0)
      : null;
  const share = (p: (typeof parts)[number]) =>
    nav ? (p.value! / nav) * 100 : p.weightBps / 100;
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const name = basket?.name ?? "A Sheaf basket";

  const sheaf = sheafDataUri(parts.map((p) => ({ key: p.key, weight: share(p) / 100, color: p.color })));
  const top = [...parts].sort((x, y) => share(y) - share(x)).slice(0, 5);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#eef1ec", padding: "60px 72px", fontFamily: "Host", color: "#14251c" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 640 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="34" height="34" viewBox="0 0 24 24">
              <path d="M12 2.5 V21.5 M6.4 3.6 L15.6 21 M17.6 3.6 L8.4 21" stroke="#14251c" strokeWidth="1.9" strokeLinecap="round" fill="none" />
              <rect x="6.6" y="13" width="10.8" height="4" rx="1.4" fill="#3438c9" />
            </svg>
            <span style={{ fontFamily: "Funnel", fontSize: 34, letterSpacing: -1 }}>sheaf</span>
          </div>
          <div style={{ fontFamily: "Funnel", fontSize: name.length > 18 ? 66 : 84, lineHeight: 0.98, letterSpacing: -3, marginTop: 44 }}>
            {name}
          </div>
          {basket && (
            <div style={{ fontSize: 24, marginTop: 16, color: "#44544a" }}>
              {`${basket.symbol} · ${parts.length} ${parts.length === 1 ? "holding" : "holdings"} · creator fee ${(basket.creatorFeeBps / 100).toFixed(2)}%`}
            </div>
          )}
          {nav != null && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 34 }}>
              <span style={{ fontFamily: "Funnel", fontSize: 60, letterSpacing: -2 }}>
                {`$${nav.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </span>
              <span style={{ fontSize: 22, color: "#65726a" }}>one share</span>
              {change != null && (
                <span style={{ fontSize: 24, color: change >= 0 ? "#0b7a6b" : "#b8432c" }}>
                  {`${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}% today`}
                </span>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 28, marginTop: "auto", fontSize: 21, color: "#44544a" }}>
            {top.map((p) => (
              <span key={p.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: 6, background: p.color }} />
                {`${p.base} ${share(p).toFixed(0)}%`}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sheaf} width={420} height={450} alt="" />
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Funnel", data: funnel, style: "normal", weight: 500 },
        { name: "Host", data: host, style: "normal", weight: 400 },
      ],
    },
  );
}
