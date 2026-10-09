import type { Metadata } from "next";
import Link from "next/link";
import {
  AUCTION_BAND_BPS,
  Beachhead,
  CHECKED,
  FounderLine,
  CreatorSide,
  FeeHeadline,
  FeeTable,
  HOUSE_FILLER_MARGIN_BPS,
  HolderCost,
  LiveNumbers,
  MarketFacts,
  MeasuredRoute,
  NearbyProducts,
  OrderSplit,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_SINCE,
  ProtocolFeeReceipts,
  ProveNext,
  SOURCES,
  ShareFacts,
  TrustStance,
  UnitEconomics,
  pct,
} from "@/components/business-case";

export const metadata: Metadata = {
  title: "How Sheaf makes money",
  description:
    "Who pays Sheaf, for what and how much: a 0.10% protocol fee when shares are made, the creator's fee, the filler's margin inside the buyer's auction band, and launch-market fees. What a holder pays beside the alternatives, the numbers so far, and what still has to be proven.",
};

/** The live blocks read the site's own API; two minutes is fresh enough for counts. */
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
  n,
  title,
  lede,
  children,
}: {
  id: string;
  n: number;
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-16 sm:py-20">
      <div className="max-w-[62ch]">
        <p className="tnum text-xs text-bind">{n}</p>
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
            Sheaf&rsquo;s protocol fee is paid when a share is made, never while it is held, redeemed or sold. Sheaf&rsquo;s own
            filler earns its {pct(HOUSE_FILLER_MARGIN_BPS)} on the dollar orders and sales it fills. Every fee is written into a
            basket when the basket is created, so the rate a buyer sees is the rate that basket will charge for as long as it
            exists.
          </p>
          <p className="display mt-8 border-l-2 border-bind pl-5 text-xl leading-snug text-ink sm:text-2xl">
            {pct(PROTOCOL_FEE_BPS)} of every share created goes to Sheaf. The basket&rsquo;s creator sets their own fee. A
            filler earns whatever the buyer&rsquo;s own ±{pct(AUCTION_BAND_BPS)} band leaves it, and Sheaf&rsquo;s filler waits
            for {pct(HOUSE_FILLER_MARGIN_BPS)}.
          </p>
          <p className="mt-6 text-sm leading-relaxed text-ink-3">
            Everything runs on devnet and testnets with test money today. The protocol fee is live on devnet for Solana baskets
            created since {PROTOCOL_FEE_SINCE} and on dollar fills through the EVM v2 and v3 desks, and the treasury has made its first
            claim. The rates are real; the revenue is not yet.
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
          n={1}
          title="Who pays, for what"
          lede={
            <>
              <p>
                Four lines earn money. Two are paid where backed shares are made: the protocol fee to Sheaf and the creator
                fee to whoever created the basket. One is paid to whoever fills a dollar order, buying or selling. The last
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
              {pct(HOUSE_FILLER_MARGIN_BPS)}; a faster filler gives the buyer a better count and keeps less.
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
          n={2}
          title="What a holder pays"
          lede={
            <>
              <p>
                A Sheaf basket costs something each time shares are made, whether by one order or by every run of a plan, and
                nothing a year. Leaving costs no protocol fee: redeem for the stocks, or sell for dollars and pay only the
                filler. Against smallcase that makes small monthly plans cheaper and large ones dearer. It is cheaper than a
                thematic ETF&rsquo;s yearly fee, and dearer than a broad index ETF or five tokens bought by hand.
              </p>
              <p>What the fee buys is one token, backed by the stocks and redeemable for them, held in your own wallet.</p>
            </>
          }
        >
          <HolderCost />
          <div className="mt-14">
            <h3 className="display text-2xl text-ink">What a share is, and is not</h3>
            <div className="mt-6">
              <ShareFacts />
            </div>
          </div>
          <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="max-w-[48ch] space-y-4 text-base leading-relaxed text-ink-2">
              <h3 className="display text-2xl text-ink">Why Sheaf&rsquo;s filler waits for {pct(HOUSE_FILLER_MARGIN_BPS)}</h3>
              <p>
                A filler has to buy every stock in the recipe before it can deliver them. On big US names that route is
                cheap: we measured it through Jupiter for a five-stock basket, and at $1,000 the round trip is under a tenth
                of a percent. One way is about half of that.
              </p>
              <p>
                So {pct(HOUSE_FILLER_MARGIN_BPS)} covers the route with a little left over, and the buyer pays far less than
                the {pct(AUCTION_BAND_BPS)} the band allows. Thin markets, like pre-IPO tokens, cost more to route; there the
                filler waits longer in the auction or does not fill, and the dollars go back.
              </p>
            </div>
            <MeasuredRoute />
          </div>
        </Section>

        <Section
          id="take"
          n={3}
          title="What Sheaf keeps"
          lede={
            <p>
              On $1M of shares made, Sheaf keeps between $1,000 and about $4,500, depending on whether the buyer paid in
              dollars, whether Sheaf&rsquo;s filler filled it, and whether the basket is one Sheaf created. On $1M sold back
              through its filler it keeps about $1,000 more. Redeeming pays nothing, so almost all of it comes from flow: money
              coming in, and holders who leave. We measure it by shares created a month, not by a forecast.
            </p>
          }
        >
          <UnitEconomics />
          <p className="mt-6 max-w-[80ch] text-sm leading-relaxed text-ink-3">
            For comparison, Symmetry&rsquo;s documented example vault charges a 0.10% host fee on deposits and another on
            withdrawals, with the creator&rsquo;s fees on top (
            <a href={SOURCES.symmetry.href} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              Symmetry, fees
            </a>
            ). Sheaf charges no protocol fee on the way out; a seller pays only the filler.
          </p>
        </Section>

        <Section
          id="who"
          n={4}
          title="Who it is for first"
          lede={
            <p>
              Selling a basket token to retail one wallet at a time is slow and expensive, and plenty of basket products have
              tried. So Sheaf starts where people already hold tokenized stocks in their own wallets.
            </p>
          }
        >
          <h3 className="display text-2xl text-ink">Wallets and front ends that already list xStocks</h3>
          <div className="mt-6">
            <Beachhead />
          </div>
          <h3 className="display mt-16 text-2xl text-ink">And creators, who bring their own audience</h3>
          <div className="mt-6">
            <CreatorSide />
          </div>
          <h3 className="display mt-16 text-2xl text-ink">Baskets that already exist</h3>
          <div className="mt-6">
            <NearbyProducts />
          </div>
        </Section>

        <Section
          id="numbers"
          n={5}
          title="Numbers so far"
          lede={
            <p>
              These come from the program&rsquo;s own events, its basket accounts and the launch pools, not from a
              spreadsheet. Every wallet the team uses is listed in the code, and the figures below say whose activity they are.
            </p>
          }
        >
          <h3 className="display text-2xl text-ink">The protocol fee, as it is charged</h3>
          <div className="mt-6">
            <ProtocolFeeReceipts />
          </div>
          <h3 className="display mt-14 text-2xl text-ink">Use</h3>
          <div className="mt-6">
            <LiveNumbers />
          </div>
        </Section>

        <Section
          id="market"
          n={6}
          title="The market"
          lede={
            <p>
              Tokenized stocks are a few billion dollars held and more than fifteen billion traded a month, spread across
              chains. The larger prize is the habit of investing every month, which India shows at enormous scale.
            </p>
          }
        >
          <MarketFacts />
        </Section>

        <Section
          id="next"
          n={7}
          title="What we still have to prove"
          lede={
            <p>
              The program works. What comes next is showing that people use it and come back, that the fee is
              charged and claimed, and that a wallet or front end will put it in front of its users. These are the targets,
              counted the same way as the numbers above.
            </p>
          }
        >
          <ProveNext />
        </Section>

        <Section id="trust" n={8} title="Trust and the law">
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
          <FounderLine />
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/method" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3">
            How it works
          </Link>
          <Link href="/ledger" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3">
            The ledger
          </Link>
          <Link href="/compose" className="rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep">
            Create a basket
          </Link>
        </div>
      </section>
    </div>
  );
}
