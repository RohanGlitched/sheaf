import Link from "next/link";
import { HomeStats, ComposeCta } from "@/components/home-mosaic";
import { HomeSheaf } from "@/components/home-sheaf";
import { LiveTape } from "@/components/live-tape";
import { HomePlans } from "@/components/home-plans";
import { HomeChains } from "@/components/home-chains";
import { HomePredict } from "@/components/home-predict";
import { MarketClock } from "@/components/market-clock";
import { FeaturedBaskets } from "@/components/featured-baskets";
import { LaunchMarket } from "@/components/launch-market";
import { Anatomy } from "@/components/home-anatomy";
import { Dividends, Premiums } from "@/components/home-market-facts";
import { Keys, Revenue } from "@/components/home-ledgers";

/** The story in the order it happens to a basket, and the order the page tells it in. */
const LIFE = [
  {
    n: "1",
    title: "Write the recipe",
    on: "One transaction",
    href: "/compose",
    body: "Pick up to eight tokenized stocks, xStocks or PreStocks over OpenAI, Anthropic and SpaceX, and set the weights. The program stores the exact units behind one share and gives up the power to change them.",
  },
  {
    n: "2",
    title: "Create shares in kind",
    on: "Onchain vault",
    href: "#anatomy",
    body: "A share is created by depositing exactly what the recipe names and redeemed by taking exactly that back. No oracle prices it, so there is no price to push and no way to create an unbacked share.",
  },
  {
    n: "3",
    title: "Or buy with dollars",
    on: "Dollar order",
    href: "/basket/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ",
    body: "Escrow dollars for a number of shares that falls over ninety seconds. The first filler to deliver the stocks gets paid. Competition sets the price, and the vault still receives the real stocks.",
  },
  {
    n: "4",
    title: "Then every month",
    on: "Monthly plan",
    href: "#plans",
    body: "Set a monthly amount and the plan places that dollar order on schedule. Anyone can run it when it is due, and each fill resets its reference price. The habit behind India's SIPs, onchain.",
  },
  {
    n: "5",
    title: "Trade it before it exists",
    on: "Launch market",
    href: "/basket/FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8#launch",
    body: "A new basket can open a Meteora bonding curve priced from its own value, so people can buy in before anyone assembles the first share. Bitcoin, by proxy has one open on the current curve. The launch token is its own market, separate from the backed share.",
  },
  {
    n: "6",
    title: "Bet on it",
    on: "Prediction market",
    href: "#predict",
    body: "Ask whether a basket beats SPY this week. Its value is read from the vault, so the market settles without trusting anyone's price. Panta runs the market on Solana.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
      {/* ------------------------------------------------------------- hero */}
      <section className="grid gap-12 pt-14 pb-16 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14 lg:pt-20">
        <div className="max-w-[34rem] self-center">
          <Link
            href="/ledger"
            className="rise mb-8 inline-flex items-center gap-2.5 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-bind hover:text-ink"
          >
            <span className="live-dot size-1.5 shrink-0 rounded-full bg-gain" aria-hidden />
            Live on Solana devnet · priced from mainnet
          </Link>
          <h1 className="rise display text-hero text-ink" style={{ "--i": 1 } as React.CSSProperties}>
            Bind up to eight stocks into one share.
          </h1>
          <p className="rise mt-7 max-w-[44ch] text-lg leading-relaxed text-ink-2" style={{ "--i": 2 } as React.CSSProperties}>
            Your own index fund, made of tokenized stocks. Pick up to eight
            companies and set the weights. Every share is backed by the real
            stocks in an onchain vault, and redeeming one hands you the stocks
            back.
          </p>
          <div className="rise mt-9 flex flex-wrap items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
            <ComposeCta>Create a basket</ComposeCta>
            <Link
              href="/explore"
              className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
            >
              Browse baskets
            </Link>
          </div>
          <p className="rise mt-8 max-w-[52ch] text-sm leading-relaxed text-ink-3" style={{ "--i": 4 } as React.CSSProperties}>
            No oracle prices a share. It is created by depositing the exact stocks
            its recipe names and redeemed by withdrawing them, so the vault can
            only ever hold more than the shares claim.
          </p>
        </div>

        <div className="self-center">
          <HomeSheaf />
        </div>
      </section>

      {/* ------------------------------------------------------------ stats */}
      <section className="border-y border-line py-px">
        <HomeStats />
      </section>

      {/* ------------------------------------------------------------ tape */}
      <section className="py-20">
        <LiveTape />
      </section>

      {/* ------------------------------------------------------- lifecycle */}
      <section className="py-20">
        <h2 className="display text-title max-w-[26ch] text-ink">
          From a recipe to a market of its own, and none of it asks you to trust us.
        </h2>
        <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LIFE.map((step) => (
            <li key={step.title}>
              <Link
                href={step.href}
                className="lift flex h-full flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-7 hover:border-line-strong"
              >
                <span className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="tnum text-bind">{step.n}</span>
                  <span className="text-ink-3">{step.on}</span>
                </span>
                <span className="display mt-3 block text-xl text-ink">{step.title}</span>
                <span className="mt-3 block text-sm leading-relaxed text-ink-2">{step.body}</span>
              </Link>
            </li>
          ))}
        </ol>
        <p className="mt-8 max-w-[62ch] text-sm leading-relaxed text-ink-3">
          <Link
            href="/method"
            className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            How it works
          </Link>{" "}
          walks through each step beside the transaction that proves it, and every
          creation and redemption the program has settled is on{" "}
          <Link
            href="/ledger"
            className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            the ledger
          </Link>
          .
        </p>
      </section>

      {/* --------------------------------------------------------- anatomy */}
      <section id="anatomy" className="scroll-mt-24 border-t border-line py-20">
        <Anatomy />
      </section>

      {/* ----------------------------------------------------------- plans */}
      <section id="plans" className="scroll-mt-24 border-t border-line py-20">
        <HomePlans />
      </section>

      {/* ---------------------------------------------------------- launch */}
      <section id="launch" className="scroll-mt-24 border-t border-line py-20">
        <LaunchMarket />
      </section>

      {/* ------------------------------------------------------ prediction */}
      <section id="predict" className="scroll-mt-24 border-t border-line py-20">
        <HomePredict />
      </section>

      {/* ---------------------------------------------------------- chains */}
      <section className="border-t border-line py-20">
        <HomeChains />
      </section>

      {/* ------------------------------------------------ the evidence group */}
      <section className="border-t border-line pt-20" aria-labelledby="evidence">
        <div className="max-w-[52ch]">
          <h2 id="evidence" className="display text-title text-ink">
            Why the numbers hold up.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            Three things about tokenized stocks that a basket has to get right:
            the gap between a token and its listed share, dividends that arrive as
            a multiplier, and a market that never closes.
          </p>
        </div>

        {/* premiums */}
        <div className="py-16">
          <div className="max-w-[46ch]">
            <h3 className="display text-2xl text-ink sm:text-3xl">Two prices for one company.</h3>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              Every token here has the price it trades at on Solana and the price of the listed share
              behind it. The gap between them is the premium. A basket cannot wish it away, so Sheaf
              shows it on every component and values a share both ways.
            </p>
          </div>
          <div className="mt-10">
            <Premiums />
          </div>
        </div>

        {/* dividends */}
        <div className="border-t border-line py-16">
          <div className="max-w-[46ch]">
            <h3 className="display text-2xl text-ink sm:text-3xl">A dividend is a number going up.</h3>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              Tokenized stocks pay dividends by raising a multiplier on the mint, not by sending
              anything. A recipe written in displayed balances would come up short by exactly the
              dividends already paid. Sheaf stores recipes in raw units and applies the live
              multiplier when it prices a share, so a share redeems for the same units before and after
              a dividend, and is worth more after.
            </p>
          </div>
          <div className="mt-10">
            <Dividends />
          </div>
        </div>

        {/* two clocks */}
        <div className="grid gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="max-w-[38ch] self-center">
            <h3 className="display text-2xl text-ink sm:text-3xl">
              The exchange keeps hours. Your basket does not.
            </h3>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              A tokenized share trades every minute of every day, including the
              hours when the listing behind it is dark. That is where the gap between
              token and share opens up, and it is why Sheaf shows you both prices
              rather than one.
            </p>
            <p className="mt-4 text-sm leading-relaxed text-ink-3">
              The exchange calendar here is the one Pyth publishes for each listing,
              holidays and shortened sessions included.
            </p>
          </div>
          <div className="self-center">
            <MarketClock />
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- revenue */}
      <section className="border-t border-line py-20">
        <Revenue />
      </section>

      {/* ------------------------------------------------------------ keys */}
      <section className="border-t border-line py-20">
        <Keys />
      </section>

      {/* -------------------------------------------------------- baskets */}
      <section className="border-t border-line py-20">
        <FeaturedBaskets />
      </section>
    </div>
  );
}
