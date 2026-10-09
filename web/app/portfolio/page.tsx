import type { Metadata } from "next";
import { Portfolio } from "@/components/portfolio";

export const metadata: Metadata = {
  title: "Everything you own, unwrapped",
  description:
    "Your baskets valued at live prices, looked through to the companies you actually own.",
};

export default function PortfolioPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <Portfolio />
    </div>
  );
}
