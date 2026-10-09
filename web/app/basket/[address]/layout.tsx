import { notFound } from "next/navigation";
import { definitelyMissing, readBasket } from "./read";

/**
 * Decides 404 before anything streams. The page has a loading skeleton, and once
 * that boundary starts streaming the status is already 200, so a missing basket
 * has to be refused here, above it.
 */
export default async function BasketLayout({ children, params }: LayoutProps<"/basket/[address]">) {
  const { address } = await params;
  const basket = await readBasket(address);
  if (!basket && (await definitelyMissing(address))) notFound();
  return children;
}
