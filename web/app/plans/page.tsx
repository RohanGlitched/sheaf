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
          Indian investors run about 100 million monthly plans into mutual funds, the habit called a SIP. A Sheaf monthly plan does the same onchain: a
          fixed amount of dollars into a basket on a schedule. Each run places a cash order that fillers compete to
          fill, and every fill moves the plan&apos;s reference price to where the market cleared, so no oracle is ever
          read.
        </p>
      </section>
      <PlansBoard />

      <section className="mt-24 grid gap-10 border-t border-line pt-16 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div>
          <h2 className="display text-title max-w-[18ch] text-ink">Why a monthly plan, and why India.</h2>
          <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
            India already invests by monthly plan. What its savers cannot easily do any more is put that plan into US
            companies: the regulator caps how much Indian mutual funds may hold abroad, the cap is full, and fund
            houses have stopped taking new international SIPs. A Sheaf plan is the same habit pointed at a basket of
            tokenized stocks.
          </p>
          <p className="mt-4 max-w-[48ch] text-sm leading-relaxed text-ink-3">
            Sheaf runs on devnet with test dollars. Whether buying tokenized stocks onchain counts as a permitted
            remittance for an Indian resident is not settled, and the token issuers set their own eligibility rules.
            Nothing here is an offer or advice.
          </p>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
          {[
            { k: "₹32,297 crore", v: "Indians put into mutual funds by monthly plan in August 2026, a record.", s: "AMFI, August 2026 (as reported)" },
            { k: "10 crore", v: "Contributing monthly-plan accounts, crossing 100 million for the first time.", s: "AMFI, August 2026 (as reported)" },
            { k: "$7 billion", v: "The cap on what all Indian mutual funds together may invest overseas, $1 billion per fund house.", s: "SEBI limit" },
            { k: "−₹72 crore", v: "Net outflow from India's overseas funds of funds in August 2026, with fresh international SIPs suspended.", s: "AMFI monthly report, August 2026" },
          ].map((x) => (
            <div key={x.k} className="bg-surface p-6">
              <dt className="display tnum text-3xl text-ink">{x.k}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-ink-2">{x.v}</dd>
              <dd className="mt-3 text-xs text-ink-3">{x.s}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
