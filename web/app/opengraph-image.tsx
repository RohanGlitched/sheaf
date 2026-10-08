import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Sheaf: the ETF launchpad on Solana";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TILES: { x: number; y: number; w: number; h: number; c: string; t?: string }[] = [
  { x: 0, y: 0, w: 250, h: 270, c: "#b18827", t: "SPY" },
  { x: 256, y: 0, w: 194, h: 160, c: "#4f7a2a", t: "NVDA" },
  { x: 256, y: 166, w: 194, h: 104, c: "#08a693", t: "OPENAI" },
  { x: 0, y: 276, w: 150, h: 194, c: "#02769b", t: "AAPL" },
  { x: 156, y: 276, w: 160, h: 110, c: "#7d87d7", t: "MSFT" },
  { x: 156, y: 392, w: 160, h: 78, c: "#8e5192" },
  { x: 322, y: 276, w: 128, h: 120, c: "#cd6e7a", t: "META" },
  { x: 322, y: 402, w: 128, h: 68, c: "#9c5909" },
];

export default async function Image() {
  const dir = join(process.cwd(), "app/_og");
  const [fraunces, archivo] = await Promise.all([
    readFile(join(dir, "fraunces.ttf")),
    readFile(join(dir, "archivo.ttf")),
  ]);

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
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="40" height="40" viewBox="0 0 24 24">
              <rect x="0" y="0" width="11" height="11" fill="#b18827" />
              <rect x="13" y="0" width="11" height="6" fill="#ede6d6" opacity="0.55" />
              <rect x="13" y="8" width="11" height="3" fill="#ede6d6" opacity="0.3" />
              <rect x="0" y="13" width="6" height="11" fill="#ede6d6" opacity="0.4" />
              <rect x="8" y="13" width="16" height="11" fill="#ede6d6" opacity="0.22" />
            </svg>
            <span style={{ fontFamily: "Fraunces", fontSize: 40 }}>Sheaf</span>
          </div>
          <div
            style={{
              fontFamily: "Fraunces",
              fontSize: 62,
              lineHeight: 1.04,
              marginTop: 52,
              letterSpacing: -1,
            }}
          >
            An index fund is a list of companies and a set of weights.
          </div>
          <div style={{ fontSize: 24, lineHeight: 1.45, marginTop: 32, color: "#b3ab9c" }}>
            Tokenised stocks and pre-IPO companies as one fully backed token,
            with a Meteora market from day one.
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: "auto", fontSize: 20, color: "#7c8090" }}>
            <span style={{ color: "#b18827" }}>The ETF launchpad on Solana</span>
            <span>·</span>
            <span>sheaf.vercel.app</span>
          </div>
        </div>
        <div style={{ display: "flex", position: "relative", marginLeft: "auto", width: 450, height: 470, marginTop: 8 }}>
          {TILES.map((tile, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: tile.x,
                top: tile.y,
                width: tile.w,
                height: tile.h,
                background: tile.c,
                display: "flex",
                padding: 12,
                fontSize: 18,
                fontWeight: 600,
                color: "#0a1224",
              }}
            >
              {tile.t}
            </div>
          ))}
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
