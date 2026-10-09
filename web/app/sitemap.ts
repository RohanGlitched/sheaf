import type { MetadataRoute } from "next";
import { Connection } from "@solana/web3.js";
import { SITE_URL, WRITE_RPC } from "@/lib/config";
import { fetchBaskets } from "@/lib/sheaf";
import { isTestBasket } from "@/lib/hidden";
import { DEPLOYED } from "@/lib/chains";

export const revalidate = 3600;

/** The fixed pages, every basket on the program except our own test baskets, then every EVM basket page. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = ["", "/compose", "/explore", "/plans", "/chains", "/predict", "/portfolio", "/ledger", "/method", "/business", "/voices"].map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "daily" as const,
  }));
  const baskets = await fetchBaskets(new Connection(WRITE_RPC, "confirmed")).catch(() => []);
  // The same pages app/chains/[network]/[basket] builds statically.
  const chains = DEPLOYED.flatMap((c) =>
    c.deployment!.baskets.map((b) => ({
      url: `${SITE_URL}/chains/${c.key}/${b.symbol.toLowerCase()}`,
      changeFrequency: "hourly" as const,
    })),
  );
  return [
    ...pages,
    ...baskets
      .filter((b) => !isTestBasket(b))
      .map((b) => ({ url: `${SITE_URL}/basket/${b.address}`, changeFrequency: "hourly" as const })),
    ...chains,
  ];
}
