import type { MetadataRoute } from "next";
import { Connection } from "@solana/web3.js";
import { SITE_URL, WRITE_RPC } from "@/lib/config";
import { fetchBaskets } from "@/lib/sheaf";

export const revalidate = 3600;

/** The fixed pages, then every basket on the program. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = ["", "/compose", "/explore", "/portfolio", "/ledger", "/method"].map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "daily" as const,
  }));
  const baskets = await fetchBaskets(new Connection(WRITE_RPC, "confirmed")).catch(() => []);
  return [
    ...pages,
    ...baskets.map((b) => ({ url: `${SITE_URL}/basket/${b.address}`, changeFrequency: "hourly" as const })),
  ];
}
