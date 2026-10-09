import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { sheafDataUri } from "@/lib/sheaf-svg";
import { slotColor } from "@/lib/palette";

export const alt = "Sheaf: bind up to eight stocks into one share";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Where a Sheaf vault is deployed today. Keep in step with /chains. */
const CHAINS = ["Solana", "Robinhood Chain", "Tempo", "Ethereum", "Arbitrum", "Base"];

const RECIPE = [
  { t: "NVDA", w: 0.26 },
  { t: "AAPL", w: 0.2 },
  { t: "MSFT", w: 0.18 },
  { t: "GOOGL", w: 0.14 },
  { t: "AMZN", w: 0.12 },
  { t: "META", w: 0.1 },
];

export default async function Image() {
  const dir = join(process.cwd(), "app/_og");
  const [funnel, host] = await Promise.all([
    readFile(join(dir, "funnel-500.ttf")),
    readFile(join(dir, "host-400.ttf")),
  ]);
  const sheaf = sheafDataUri(RECIPE.map((r, i) => ({ key: r.t, weight: r.w, color: slotColor(i) })));

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#eef1ec", padding: "64px 72px", fontFamily: "Host", color: "#14251c" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 600 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="40" height="40" viewBox="0 0 24 24">
              <path d="M12 2.5 V21.5 M6.4 3.6 L15.6 21 M17.6 3.6 L8.4 21" stroke="#14251c" strokeWidth="1.9" strokeLinecap="round" fill="none" />
              <rect x="6.6" y="13" width="10.8" height="4" rx="1.4" fill="#3438c9" />
            </svg>
            <span style={{ fontFamily: "Funnel", fontSize: 42, letterSpacing: -1.5 }}>sheaf</span>
          </div>
          <div style={{ fontFamily: "Funnel", fontSize: 68, lineHeight: 0.98, letterSpacing: -2.6, marginTop: 48 }}>
            Bind up to eight stocks into one share.
          </div>
          <div style={{ fontSize: 26, lineHeight: 1.4, color: "#44544a", marginTop: 30, maxWidth: 540 }}>
            Baskets of tokenized stocks, backed by the stocks in an onchain vault.
          </div>
          <div style={{ display: "flex", marginTop: "auto", fontSize: 18, color: "#56635b", gap: 8 }}>
            {CHAINS.map((c, i) => (
              <span key={c} style={{ display: "flex", gap: 8 }}>
                {i > 0 && <span>·</span>}
                <span>{c}</span>
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sheaf} width={440} height={471} alt="" />
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
