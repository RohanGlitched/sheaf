import type { Metadata } from "next";
import { Explorer } from "@/components/explorer";
import { LaunchMarket } from "@/components/launch-market";

export const metadata: Metadata = {
  title: "Every basket",
  description:
    "Every basket on the program, read straight from the chain, with what a share holds and what it is worth.",
};

export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <Explorer />
      {/* Beside the baskets: a launch market on Meteora, priced from a basket's own value. Moved here from the home page. */}
      <section id="launch" className="mt-20 scroll-mt-24 border-t border-line pt-16">
        <LaunchMarket />
      </section>
    </div>
  );
}
