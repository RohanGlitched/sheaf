import type { Metadata } from "next";
import { Funnel_Display, Host_Grotesk } from "next/font/google";
import "./globals.css";
import { DevnetNotice } from "@/components/devnet-notice";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { WalletProvider } from "@/components/wallet-provider";
import { VoicesRefKeeper } from "@/components/voices-ref-keeper";
import { MarketProvider } from "@/components/market-provider";
import { SITE_URL } from "@/lib/config";

/**
 * Funnel Display for anything that speaks, Host Grotesk for anything that counts.
 * Host Grotesk has real tabular figures, which every price in the product needs.
 */
const funnel = Funnel_Display({
  variable: "--font-funnel",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const host = Host_Grotesk({
  variable: "--font-host",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // "./" is each page's own path on sheaf.world, so the old Vercel address and any
  // ?ref= or other query never count as a second copy of a page.
  alternates: { canonical: "./" },
  title: {
    default: "Sheaf: baskets of tokenized stocks",
    template: "%s | Sheaf",
  },
  description:
    "Baskets of tokenized stocks, like a unit investment trust: up to eight stocks bound into one share, backed by the stocks in an onchain vault and redeemable for them any time. On Solana devnet, with vaults on five EVM testnets.",
  openGraph: {
    title: "Sheaf",
    description:
      "Fixed baskets of tokenized stocks: one share, backed by the stocks in its vault, redeemable for them any time.",
    type: "website",
    url: "./",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${funnel.variable} ${host.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-page">
        <WalletProvider>
          <VoicesRefKeeper />
          <MarketProvider>
            <SiteHeader />
            <DevnetNotice />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </MarketProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
