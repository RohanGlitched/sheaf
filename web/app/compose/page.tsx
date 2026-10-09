import type { Metadata } from "next";
import { Composer } from "@/components/composer";
import { lastGood } from "@/lib/price-snapshot";
import type { MarketSnapshot } from "@/lib/market";

export const metadata: Metadata = {
  title: "Create a basket",
  description:
    "Choose tokenized equities and weights, and mint the result as one token backed share for share.",
};

/** Rebuilt at most every five minutes, so the market map below starts from a recent snapshot. */
export const revalidate = 300;

/**
 * The server's last whole market snapshot, so the market map draws on first
 * paint instead of waiting for the browser's own price read. Bounded: a slow
 * bucket never holds the page up; it then starts from the skeleton as before.
 */
async function initialSnapshot(): Promise<MarketSnapshot | null> {
  try {
    return await Promise.race([lastGood(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
  } catch {
    return null;
  }
}

export default async function ComposePage() {
  const snapshot = await initialSnapshot();
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <Composer initialSnapshot={snapshot} />
    </div>
  );
}
