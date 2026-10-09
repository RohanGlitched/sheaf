import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BasketDetail } from "@/components/basket-detail";
import { stockForWriteMint } from "@/lib/mirror";
import { definitelyMissing, readBasket } from "./read";

export async function generateMetadata({
  params,
}: PageProps<"/basket/[address]">): Promise<Metadata> {
  const { address } = await params;
  const basket = await readBasket(address);
  if (!basket) {
    return {
      title: "Basket",
      description:
        "What one share holds, what it is worth, and proof the vault is covering every share outstanding.",
    };
  }
  const holdings = basket.components
    .map((c) => stockForWriteMint(c.mint)?.base ?? c.mint.slice(0, 4))
    .join(", ");
  const title = `${basket.name} (${basket.symbol})`;
  const description = `One ${basket.symbol} share is a claim on ${holdings}, held in a vault on Solana that anyone can read.`;
  return { title, description, openGraph: { title, description, type: "website" } };
}

export default async function BasketPage({
  params,
}: PageProps<"/basket/[address]">) {
  const { address } = await params;
  // Rendered on the server so a shared link opens on the basket, not a skeleton.
  const basket = await readBasket(address);
  if (!basket && (await definitelyMissing(address))) notFound();
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <BasketDetail address={address} initial={basket} />
    </div>
  );
}
