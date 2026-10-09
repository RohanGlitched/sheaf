import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EvmBasket } from "@/components/evm-basket";
import { DEPLOYED, findBasket } from "@/lib/chains";
import { fetchRobinhoodPrices } from "@/lib/evm";

type Params = { network: string; basket: string };

export const revalidate = 60;

export function generateStaticParams(): Params[] {
  return DEPLOYED.flatMap((c) => c.deployment!.baskets.map((b) => ({ network: c.key, basket: b.symbol.toLowerCase() })));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { network, basket } = await params;
  const found = findBasket(network, basket);
  if (!found) return { title: "Basket" };
  const { chain, basket: b } = found;
  const title = `${b.name} (${b.symbol}) on ${chain.name}`;
  const description = `One ${b.symbol} share is a claim on ${b.components.map((c) => c.symbol).join(", ")}, held in a contract on ${chain.name} that anyone can read, create into and redeem from.`;
  return { title, description, openGraph: { title, description, type: "website" } };
}

export default async function EvmBasketPage({ params }: { params: Promise<Params> }) {
  const { network, basket } = await params;
  const found = findBasket(network, basket);
  if (!found) notFound();
  const { chain, deployment, basket: b } = found;

  // Robinhood's Stock Token quotes for the underlying stock, the same source the recipe was sized from.
  const live = await fetchRobinhoodPrices(b.components.map((c) => c.symbol));
  const pricedLive = b.components.every((c) => live[c.symbol] != null);
  const prices = pricedLive ? live : { ...(b.pricedAt ?? {}), ...live };

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <EvmBasket chain={chain} deployment={deployment} basket={b} prices={prices} pricedLive={pricedLive} />
    </div>
  );
}
