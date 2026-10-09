import { BasketSkeleton } from "@/components/skeletons";

/** Shown while the server reads the basket, in the shape of the page that is coming. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <BasketSkeleton />
    </div>
  );
}
