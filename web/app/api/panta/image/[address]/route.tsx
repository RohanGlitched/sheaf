import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { stockForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { fetchBasketAt } from "@/lib/sheaf";
import { sheafDataUri } from "@/lib/sheaf-svg";

/**
 * GET /api/panta/image/<basket> -> the 1024 x 1024 catalog image Panta asks for
 * when a market is created (`imageUrl`): the basket's sheaf drawing under its
 * question. Weights are the recipe's, so the image never needs a price read.
 */

const SIZE = 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const dir = join(process.cwd(), "app/_og");
  const [funnel, host, basket] = await Promise.all([
    readFile(join(dir, "funnel-500.ttf")),
    readFile(join(dir, "host-400.ttf")),
    fetchBasketAt(address),
  ]);
  const parts = (basket?.components ?? []).map((c, i) => ({
    key: c.mint,
    base: stockForWriteMint(c.mint)?.base ?? c.mint.slice(0, 4),
    color: slotColor(i),
    weight: c.weightBps / 10_000,
  }));
  const sheaf = sheafDataUri(parts.length ? parts : [{ key: "x", weight: 1, color: slotColor(0) }]);
  const name = basket?.name ?? "A Sheaf basket";
  const symbol = basket?.symbol ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#eef1ec",
          padding: "72px 80px",
          fontFamily: "Host",
          color: "#14251c",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="40" height="40" viewBox="0 0 24 24">
              <path d="M12 2.5 V21.5 M6.4 3.6 L15.6 21 M17.6 3.6 L8.4 21" stroke="#14251c" strokeWidth="1.9" strokeLinecap="round" fill="none" />
              <rect x="6.6" y="13" width="10.8" height="4" rx="1.4" fill="#3438c9" />
            </svg>
            <span style={{ fontFamily: "Funnel", fontSize: 40, letterSpacing: -1 }}>sheaf</span>
          </div>
          <span style={{ fontSize: 28, color: "#44544a" }}>vs SPY · one week</span>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sheaf} width={440} height={470} alt="" />
        </div>
        <div style={{ fontFamily: "Funnel", fontSize: name.length > 20 ? 64 : 80, lineHeight: 1, letterSpacing: -3 }}>
          {`Will ${name} beat SPY?`}
        </div>
        <div style={{ display: "flex", gap: 26, marginTop: 28, fontSize: 26, color: "#44544a", flexWrap: "wrap" }}>
          {symbol && <span>{symbol}</span>}
          {parts.slice(0, 5).map((p) => (
            <span key={p.key} style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: p.color }} />
              {`${p.base} ${(p.weight * 100).toFixed(0)}%`}
            </span>
          ))}
        </div>
      </div>
    ),
    {
      width: SIZE,
      height: SIZE,
      fonts: [
        { name: "Funnel", data: funnel, style: "normal", weight: 500 },
        { name: "Host", data: host, style: "normal", weight: 400 },
      ],
      headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    },
  );
}
