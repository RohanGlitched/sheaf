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
  { k: "10.02 crore", v: "SIP accounts that paid in during August 2026, past 10 crore (100 million) for the first time.", sources: SIP_SOURCES },
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

const XSTOCKS_WHERE: Source = { label: "Kraken, xStocks availability, 18 Jun 2026", href: "https://support.kraken.com/gb/articles/xstocks-availability" };
const XSTOCKS_UAE: Source = { label: "Aletihad, 8 Jun 2026", href: "https://en.aletihad.ae/news/business/4671033/bybit-brings-tokenised-spacex-ipo-to-uae-investors" };

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
          In August 2026, 10 crore (100 million) Indian SIP accounts paid a fixed amount into mutual funds, as they do every
          month. A Sheaf monthly plan is the same habit onchain: a fixed amount of dollars into a basket of tokenized US
          stocks on a schedule. Each run places a dollar order that fillers compete to fill, and every fill moves the
          plan&apos;s reference price to where the market cleared, so the program never reads a price.
        </p>
        <p className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <a href="#india" className="text-bind underline decoration-bind/40 underline-offset-4">
            Why India
          </a>
          <a href="#waitlist" className="text-bind underline decoration-bind/40 underline-offset-4">
            Join the waitlist
          </a>
        </p>
      </section>
      <PlansBoard />

      <section id="india" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div>
            <h2 className="display text-title max-w-[18ch] text-ink">Why a monthly plan, and why India.</h2>
            <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
              India already invests by monthly plan, and its savers want US companies in it. The regulator caps what Indian
              mutual funds may hold abroad, and in July 2026 Edelweiss, PGIM India and Franklin Templeton stopped taking fresh
              SIPs into some of their international funds because of it.
            </p>
            <p className="mt-3 text-xs text-ink-3">
              <SourceLinks sources={[SUSPENDED]} />
            </p>
            <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
              Those 10 crore accounts are the habit and the evidence of demand, not Sheaf&apos;s market today. A resident buying
              tokenized stocks onchain meets the 30% crypto tax and 1% TDS, and FEMA hasn&apos;t settled whether it is allowed.
              So the path runs in three steps:
            </p>
            <ol className="mt-5 max-w-[52ch] space-y-4">
              {[
                {
                  n: "1",
                  t: "Indians abroad, where xStocks are sold.",
                  d: "xStocks aren't offered in the US, UK, Canada or Australia. Elsewhere they already reach retail investors: in June 2026 Bybit opened xStocks-backed SpaceX IPO shares to investors in the UAE.",
                  s: [XSTOCKS_WHERE, XSTOCKS_UAE],
                },
                { n: "2", t: "Platforms that already serve them.", d: "Sheaf's monthly plan offered inside an app that already does the KYC and holds the license.", s: [] },
                { n: "3", t: "Residents of India, once FEMA and tax treatment are clear.", d: "Not before. The rules below say why.", s: [] },
              ].map((x) => (
                <li key={x.n} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
                  <span className="display tnum grid size-7 place-items-center rounded-full bg-bind-wash text-sm text-bind">{x.n}</span>
                  <div>
                    <p className="text-base text-ink">{x.t}</p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-2">{x.d}</p>
                    {x.s.length > 0 && (
                      <p className="mt-2 text-xs text-ink-3">
                        <SourceLinks sources={x.s} />
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
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

        <IndiaTraction />

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
