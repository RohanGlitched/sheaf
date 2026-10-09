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
  title: {
    default: "Sheaf: index funds of tokenized stocks",
    template: "%s | Sheaf",
  },
  description:
    "Bind up to eight tokenized stocks into one share, backed by the real stocks in an onchain vault and redeemable for them any time. On Solana, with vaults on every chain where stocks are tokenized.",
  openGraph: {
    title: "Sheaf",
    description:
      "Fixed baskets of tokenized stocks: one share, backed by the stocks in its vault, redeemable for them any time.",
    type: "website",
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
