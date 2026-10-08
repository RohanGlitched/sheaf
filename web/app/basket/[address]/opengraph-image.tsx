import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { fetchMarket } from "@/lib/market";
import { stockForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { fetchBasketAt } from "@/lib/sheaf";
import { squarify } from "@/lib/treemap";

export const alt = "A Sheaf basket: what one share holds and what it is worth";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const MOSAIC = 470;

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const dir = join(process.cwd(), "app/_og");
  const [fraunces, archivo, basket, market] = await Promise.all([
    readFile(join(dir, "fraunces.ttf")),
    readFile(join(dir, "archivo.ttf")),
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
  const tiles = squarify(
    parts.map((p) => ({ key: p.key, value: share(p) })),
    MOSAIC,
    MOSAIC,
    6,
  );
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const name = basket?.name ?? "A Sheaf basket";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#0a1224",
          padding: 72,
          fontFamily: "Archivo",
          color: "#ede6d6",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", width: 560 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="30" height="30" viewBox="0 0 24 24">
              <rect x="0" y="0" width="11" height="11" fill="#b18827" />
              <rect x="13" y="0" width="11" height="6" fill="#ede6d6" opacity="0.55" />
              <rect x="13" y="8" width="11" height="3" fill="#ede6d6" opacity="0.3" />
              <rect x="0" y="13" width="6" height="11" fill="#ede6d6" opacity="0.4" />
              <rect x="8" y="13" width="16" height="11" fill="#ede6d6" opacity="0.22" />
            </svg>
            <span style={{ fontFamily: "Fraunces", fontSize: 30 }}>Sheaf</span>
          </div>
          <div
            style={{
              fontFamily: "Fraunces",
              fontSize: name.length > 18 ? 58 : 76,
              lineHeight: 1.02,
              marginTop: 44,
              letterSpacing: -1,
            }}
          >
            {name}
          </div>
          {basket && (
            <div style={{ fontSize: 24, marginTop: 18, color: "#b3ab9c" }}>
              {`${basket.symbol} · ${parts.length} ${parts.length === 1 ? "holding" : "holdings"} · creator fee ${(basket.creatorFeeBps / 100).toFixed(2)}%`}
            </div>
          )}
          {nav != null && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 40 }}>
              <span style={{ fontFamily: "Fraunces", fontSize: 64 }}>
                {`$${nav.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </span>
              <span style={{ fontSize: 22, color: "#7c8090" }}>one share</span>
              {change != null && (
                <span style={{ fontSize: 24, color: change >= 0 ? "#05aa9e" : "#e46a49" }}>
                  {`${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}% today`}
                </span>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: "auto", fontSize: 20, color: "#7c8090" }}>
            <span style={{ color: "#b18827" }}>Backed share for share on Solana</span>
            <span>·</span>
            <span>sheaf.vercel.app</span>
          </div>
        </div>
        <div style={{ display: "flex", position: "relative", marginLeft: "auto", width: MOSAIC, height: MOSAIC, marginTop: 4 }}>
          {tiles.map((tile) => {
            const p = byKey.get(tile.key)!;
            const roomy = tile.width > 90 && tile.height > 60;
            return (
              <div
                key={tile.key}
                style={{
                  position: "absolute",
                  left: tile.x,
                  top: tile.y,
                  width: tile.width,
                  height: tile.height,
                  background: p.color,
                  display: "flex",
                  flexDirection: "column",
                  padding: 12,
                  color: "#0a1224",
                }}
              >
                {roomy && <span style={{ fontSize: 20, fontWeight: 600 }}>{p.base}</span>}
                {roomy && <span style={{ fontSize: 17, opacity: 0.75 }}>{`${share(p).toFixed(1)}%`}</span>}
              </div>
            );
          })}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Fraunces", data: fraunces, style: "normal", weight: 500 },
        { name: "Archivo", data: archivo, style: "normal", weight: 400 },
      ],
    },
  );
}
