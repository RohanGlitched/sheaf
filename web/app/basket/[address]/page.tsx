import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { Connection, PublicKey } from "@solana/web3.js";
import { BasketDetail } from "@/components/basket-detail";
import { SHEAF_PROGRAM_ID, WRITE_RPC } from "@/lib/config";
import { stockForWriteMint } from "@/lib/mirror";
import { fetchBasketAt } from "@/lib/sheaf";

// Read once per request; the metadata and the page both need it.
const readBasket = cache(fetchBasketAt);

/**
 * True only when the chain itself says there is no basket here: the address is
 * not a key, or the account does not exist or belongs to another program. A
 * failed read is not proof of absence, so it leaves the page to retry in the
 * browser rather than answering 404.
 */
async function definitelyMissing(address: string): Promise<boolean> {
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    return true;
  }
  try {
    const info = await new Connection(WRITE_RPC, "confirmed").getAccountInfo(key);
    return !info || info.owner.toBase58() !== SHEAF_PROGRAM_ID;
  } catch {
    return false;
  }
}

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
