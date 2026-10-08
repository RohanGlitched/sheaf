import type { Metadata } from "next";
import { PlansBoard } from "@/components/plans-board";

export const metadata: Metadata = {
  title: "Plans",
  description: "Monthly plans into Sheaf baskets: a fixed amount on a schedule, run by anyone, each run filled by a filler auction.",
};

export default function PlansPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <section className="max-w-[46rem] pt-16 pb-12">
        <h1 className="display text-hero text-ink">A little, every month.</h1>
        <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-ink-2">
          Indian investors run about 100 million monthly plans into mutual funds, the habit called a SIP. A Sheaf plan does the same onchain: a
          fixed amount of dollars into a basket on a schedule. Each run places a cash order that fillers compete to
          fill, and every fill moves the plan&apos;s reference price to where the market cleared, so no oracle is ever
          read.
        </p>
      </section>
      <PlansBoard />
    </div>
  );
}
