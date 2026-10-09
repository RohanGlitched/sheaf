import type { Metadata } from "next";
import Link from "next/link";
import {
  AUCTION_BAND_BPS,
  Beachhead,
  CHECKED,
  CreatorSide,
  FeeHeadline,
  FeeTable,
  HOUSE_FILLER_MARGIN_BPS,
  HolderCost,
  LiveNumbers,
  MarketFacts,
  MeasuredRoute,
  OrderSplit,
  PROTOCOL_FEE_BPS,
  ProveNext,
  SOURCES,
  TrustStance,
  UnitEconomics,
  pct,
} from "@/components/business-case";

export const metadata: Metadata = {
  title: "How Sheaf makes money",
  description:
    "Who pays Sheaf, for what and how much: a 0.10% protocol fee when shares are made, the creator's fee, a filler's margin inside the auction band, and launch-market fees. What a holder pays beside the alternatives, the numbers so far, and what still has to be proven.",
};

/** The live block reads the site's own API; two minutes is fresh enough for counts. */
export const revalidate = 120;

const SECTIONS = [
  { id: "fees", title: "Who pays, for what" },
  { id: "holder", title: "What a holder pays" },
  { id: "take", title: "What Sheaf keeps" },
  { id: "who", title: "Who it is for first" },
  { id: "numbers", title: "Numbers so far" },
  { id: "market", title: "The market" },
  { id: "next", title: "What we still have to prove" },
  { id: "trust", title: "Trust and the law" },
];

function Section({
  id,
  kicker,
  title,
  lede,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-16 sm:py-20">
      <div className="max-w-[62ch]">
        <p className="text-xs text-ink-3">{kicker}</p>
        <h2 className="display mt-3 text-title text-ink">{title}</h2>
        {lede ? <div className="mt-5 space-y-4 text-base leading-relaxed text-ink-2">{lede}</div> : null}
      </div>
      <div className="mt-10">{children}</div>
    </section>
  );
}

const link = "text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2";

export default function BusinessPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <header>
        <div className="max-w-[62ch]">
          <h1 className="display text-hero leading-[0.95] text-ink">How Sheaf makes money</h1>
          <p className="mt-6 text-lg leading-[1.65] text-ink-2">
            Sheaf is paid when a share is made, and never while it is held or when it is redeemed. Every fee is written into a
            basket when the basket is created, so the rate a buyer sees is the rate that basket will charge for as long as it
            exists.
          </p>
          <p className="display mt-8 border-l-2 border-bind pl-5 text-xl leading-snug text-ink sm:text-2xl">
            {pct(PROTOCOL_FEE_BPS)} of every share created goes to Sheaf. The basket&rsquo;s creator sets their own fee. A
            filler earns at most what the buyer&rsquo;s own ±{pct(AUCTION_BAND_BPS)} band allows, and Sheaf&rsquo;s filler
            waits for {pct(HOUSE_FILLER_MARGIN_BPS)}.
          </p>
          <p className="mt-6 text-sm leading-relaxed text-ink-3">
            Everything runs on devnet and testnets with test money today. The rates are real; the revenue is not yet.
          </p>
        </div>
        <div className="mt-12">
          <FeeHeadline />
        </div>
      </header>

      <nav aria-label="Sections" className="mt-12 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-4">
        {SECTIONS.map((s, i) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="flex items-baseline gap-3 bg-page px-4 py-3 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <span className="tnum text-bind">{i + 1}</span>
            {s.title}
          </a>
        ))}
      </nav>

      <div className="mt-6">
        <Section
          id="fees"
          kicker="1 · The fee table"
          title="Who pays, for what, and how much"
          lede={
            <>
              <p>
                Four lines earn money. Two are paid where backed shares are made: the protocol fee to Sheaf and the creator
                fee to whoever published the basket. One is paid to whoever delivers the stocks for a dollar order. The last
                comes from launch markets, which sit beside the backed share rather than inside it.
              </p>
              <p>
                Fees on a creation are paid in newly made shares, so the vault always receives the full recipe and what every
                share can redeem for never changes.
              </p>
            </>
          }
        >
          <FeeTable />
        </Section>

        <section className="grid gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
          <div className="max-w-[44ch] space-y-4 text-base leading-relaxed text-ink-2">
            <h2 className="display text-title text-ink">Where $1,000 goes</h2>
            <p>
              A buyer escrows dollars and names a floor. The auction offers a share count that starts above fair and falls
              toward the floor. Sheaf&rsquo;s filler steps in when the dollars cover the stocks at fair plus{" "}
              {pct(HOUSE_FILLER_MARGIN_BPS)}; anyone faster gives the buyer a better count and keeps less.
            </p>
            <p>
              The shares the stocks create are then split once: most to the buyer, the creator&rsquo;s fee to the creator,{" "}
              {pct(PROTOCOL_FEE_BPS)} to Sheaf. Nothing is taken after that.
            </p>
            <p className="text-sm text-ink-3">
              <Link href="/method#dollars" className={link}>
                How the dollar auction works
              </Link>
            </p>
          </div>
          <OrderSplit />
        </section>

        <Section
          id="holder"
          kicker="2 · Beside the alternatives"
          title="What a holder pays"
          lede={
            <>
              <p>
                A Sheaf basket costs once, when the shares are made, and nothing a year. That is less than a thematic ETF
                charges in its first year, and cheaper than a smallcase lump sum on day one. It is not cheaper than a broad index
                ETF, and it is not cheaper than buying five tokens yourself, if you are happy to hold five tokens and keep the
                weights by hand.
              </p>
              <p>
                What the fee buys is one token that is backed by the stocks, redeemable for them at any time, usable anywhere
                a token is, and buyable every month with one approval.
              </p>
            </>
          }
        >
          <HolderCost />
          <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="max-w-[48ch] space-y-4 text-base leading-relaxed text-ink-2">
              <h3 className="display text-2xl text-ink">Why the filler&rsquo;s margin is not a cost on top</h3>
              <p>
                A filler has to buy every stock in the recipe before it can deliver them. On big US names that route is
                cheap: we measured it through Jupiter for a five-stock basket, and at $1,000 the round trip is under a tenth
                of a percent. One way is about half of that.
              </p>
              <p>
                So {pct(HOUSE_FILLER_MARGIN_BPS)} is enough for Sheaf&rsquo;s filler to cover the route and keep a little,
                and the buyer still pays far less than the {pct(AUCTION_BAND_BPS)} the band allows. Thin markets, like pre-IPO
                tokens, cost more to route; there the filler waits longer in the auction or does not fill, and the dollars
                go back.
              </p>
            </div>
            <MeasuredRoute />
          </div>
        </Section>

        <Section
          id="take"
          kicker="3 · Unit economics"
          title="What Sheaf keeps"
          lede={
            <p>
              On $1M of shares made, Sheaf keeps between $1,000 and about $4,500, depending on whether the buyer paid in
              dollars, whether Sheaf&rsquo;s filler filled it, and whether the basket is one Sheaf published. Redemptions pay
              nothing, so all of it comes from new shares: money coming in, and holders who leave and come back.
            </p>
          }
        >
          <UnitEconomics />
          <p className="mt-6 max-w-[80ch] text-sm leading-relaxed text-ink-3">
            For comparison, Symmetry&rsquo;s documented example vault charges a fixed 0.10% host fee on deposits and another on
            withdrawals, with the creator&rsquo;s fees on top (
            <a href={SOURCES.symmetry.href} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              Symmetry, fees
            </a>
            ). Sheaf charges nothing on the way out.
          </p>
        </Section>

        <Section
          id="who"
          kicker="4 · Distribution"
          title="Who it is for first"
          lede={
            <p>
              Selling a basket token to retail one wallet at a time is slow and expensive, and plenty of basket products have
              tried. So Sheaf starts where the users already are.
            </p>
          }
        >
          <h3 className="display text-2xl text-ink">Platforms that already sell tokenized stocks</h3>
          <div className="mt-6">
            <Beachhead />
          </div>
          <h3 className="display mt-16 text-2xl text-ink">And creators, who bring their own audience</h3>
          <div className="mt-6">
            <CreatorSide />
          </div>
        </Section>

        <Section
          id="numbers"
          kicker="5 · Read live from the site"
          title="Numbers so far"
          lede={
            <p>
              These come from the program&rsquo;s own events and the launch pools, not from a spreadsheet. They are small, and
              they are honest: every wallet the team used is listed and left out of the outside count.
            </p>
          }
        >
          <LiveNumbers />
        </Section>

        <Section
          id="market"
          kicker="6 · Market size"
          title="The market it grows with"
          lede={
            <p>
              Tokenized stocks are a few billion dollars today and growing fast, and Solana carries almost all of the onchain
              spot trading. The larger prize is the habit of investing every month, which India has at enormous scale and a
              closing route to US stocks.
            </p>
          }
        >
          <MarketFacts />
        </Section>

        <Section
          id="next"
          kicker="7 · Honest targets"
          title="What we still have to prove"
          lede={
            <p>
              The program works. What is not proven yet is that people other than us use it, come back, and that a platform
              will put it in front of its users. These are the targets, counted the same way as the numbers above.
            </p>
          }
        >
          <ProveNext />
        </Section>

        <Section id="trust" kicker="8 · Trust model and regulation" title="Trust and the law">
          <TrustStance />
          <p className="mt-8 text-sm text-ink-3">
            <Link href="/method#risks" className={link}>
              Everything that could still go wrong, in plain words
            </Link>
          </p>
        </Section>
      </div>

      <section className="grid gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="max-w-[56ch] space-y-4 text-base leading-relaxed text-ink-2">
          <h2 className="display text-title text-ink">Check it yourself</h2>
          <p>
            Every fee above is either in the program or in the house filler&rsquo;s published policy, and every outside
            figure links to where we read it on {CHECKED}. If a number here is wrong, tell us and we will fix it.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/method" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3">
            How it works
          </Link>
          <Link href="/ledger" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3">
            The ledger
          </Link>
          <Link href="/compose" className="rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep">
            Publish a basket
          </Link>
        </div>
      </section>
    </div>
  );
}
