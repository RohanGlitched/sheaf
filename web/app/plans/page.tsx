import type { Metadata } from "next";
import { PlansBoard } from "@/components/plans-board";
import { IndiaTraction } from "@/components/india-traction";
import { IndiaRules } from "@/components/india-rules";
import { IndiaWaitlist } from "@/components/india-waitlist";

export const metadata: Metadata = {
  title: "Plans",
  description: "Monthly plans into Sheaf baskets: a fixed amount on a schedule, run by anyone, each run filled by a filler auction. India's SIP habit, onchain.",
};

type Source = { label: string; href: string };

/** Every figure links to where it comes from; all were read on 9 October 2026. */
const SIP_SOURCES: Source[] = [
  { label: "AMFI data, via Cafemutual, 11 Sep 2026", href: "https://cafemutual.com/news/industry/38772-amfi-monthly-mf-aum-scales-to-rs-8708-lakh-crore-sip-inflows-hit-rs-32297-crore-in-august" },
  { label: "Angel One", href: "https://www.angelone.in/news/mutual-funds/sip-inflows-hit-record-32-297-crore-in-august-contributing-accounts-cross-10-crore" },
];

const STATS: { k: string; v: string; sources: Source[] }[] = [
  { k: "₹32,297 crore", v: "Put into mutual funds through SIPs in August 2026, a record month.", sources: SIP_SOURCES },
  { k: "10.02 crore", v: "SIP accounts that paid in during August 2026, past 10 crore for the first time.", sources: SIP_SOURCES },
  {
    k: "$7 billion",
    v: "The cap on what all Indian mutual funds together may invest overseas, with at most $1 billion per fund house.",
    sources: [
      { label: "SEBI circular, 3 Jun 2021", href: "https://www.sebi.gov.in/legal/circulars/jun-2021/circular-on-enhancement-of-overseas-investment-limits_50415.html" },
      { label: "Business Today", href: "https://businesstoday.in/money/mutual-fund/sebi-raises-overseas-investment-limit-for-mutual-fund-houses-to-1-billion/story/440788.html" },
    ],
  },
  {
    k: "−₹72 crore",
    v: "Net outflow from India's overseas funds of funds in August 2026, which hold ₹48,548 crore in all.",
    sources: [{ label: "AMFI monthly report, Aug 2026 (PDF)", href: "https://portal.amfiindia.com/spages/amaug2026repo.pdf" }],
  },
];

const SUSPENDED: Source = {
  label: "Business Today, 18 Jul 2026",
  href: "https://www.businesstoday.in/mutual-funds/story/why-are-mutual-funds-stopping-international-sips-heres-how-sebis-overseas-investment-cap-works-543752-2026-07-18",
};

function SourceLinks({ sources }: { sources: Source[] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {sources.map((s) => (
        <a key={s.href} href={s.href} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink-2">
          {s.label}
        </a>
      ))}
    </span>
  );
}

export default function PlansPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <section className="max-w-[46rem] pt-16 pb-12">
        <h1 className="display text-hero text-ink">A little, every month.</h1>
        <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-ink-2">
          In August 2026, 10 crore Indian SIP accounts paid a fixed amount into mutual funds, as they do every month. A Sheaf
          monthly plan does the same onchain: a fixed amount of dollars into a basket on a schedule. Each run places a cash
          order that fillers compete to fill, and every fill moves the plan&apos;s reference price to where the market
          cleared, so no oracle is ever read.
        </p>
        <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <a href="#india" className="text-bind underline decoration-bind/40 underline-offset-4">
            Why India
          </a>
          <a href="#waitlist" className="text-bind underline decoration-bind/40 underline-offset-4">
            Join the India waitlist
          </a>
        </p>
      </section>
      <PlansBoard />

      <section id="india" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <h2 className="display text-title max-w-[18ch] text-ink">Why a monthly plan, and why India.</h2>
            <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
              India already invests by monthly plan. What its savers can&apos;t easily do is point that plan at US companies.
              The regulator caps how much Indian mutual funds may hold abroad, and in July 2026 Edelweiss, PGIM India and
              Franklin Templeton stopped taking fresh SIPs into some of their international funds because of it.
            </p>
            <p className="mt-3 text-xs text-ink-3">
              <SourceLinks sources={[SUSPENDED]} />
            </p>
            <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
              A Sheaf plan is the same habit pointed at a basket of tokenized US stocks. Below is what it measures today, the
              rules that stand in the way for residents, and a waitlist for when that changes.
            </p>
          </div>
          <dl className="grid gap-px self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
            {STATS.map((x) => (
              <div key={x.k} className="bg-surface p-6">
                <dt className="display tnum text-3xl text-ink">{x.k}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-ink-2">{x.v}</dd>
                <dd className="mt-3 text-xs text-ink-3">
                  <SourceLinks sources={x.sources} />
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-20">
          <h2 className="display text-title max-w-[22ch] text-ink">What Sheaf can show from India today</h2>
          <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink-2">
            Two numbers we can measure before any launch: how much running plans commit each month, and how many people ask
            to be told when Sheaf opens in India.
          </p>
          <div className="mt-8">
            <IndiaTraction />
          </div>
        </div>

        <div className="mt-20 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <IndiaRules />
          <div className="lg:sticky lg:top-24 lg:self-start">
            <IndiaWaitlist />
          </div>
        </div>
      </section>
    </div>
  );
}
