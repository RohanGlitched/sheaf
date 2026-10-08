import Link from "next/link";
import { HomeMosaic, HomeStats, ComposeCta } from "@/components/home-mosaic";
import { HomeSheaf } from "@/components/home-sheaf";
import { LiveTape } from "@/components/live-tape";
import { MarketClock } from "@/components/market-clock";
import { FeaturedBaskets } from "@/components/featured-baskets";
import { LaunchMarket } from "@/components/launch-market";
import { Anatomy } from "@/components/home-anatomy";
import { Dividends, Premiums } from "@/components/home-market-facts";
import { Keys, Revenue } from "@/components/home-ledgers";

const LIFE = [
  {
    n: "1",
    title: "Write the recipe",
    on: "One transaction",
    body: "Pick up to eight tokenized stocks, xStocks or PreStocks over OpenAI, Anthropic and SpaceX, and set the weights. The program stores the exact units behind one share and gives up the power to change them.",
  },
  {
    n: "2",
    title: "Bind shares in kind",
    on: "Onchain vault",
    body: "A share is created by depositing exactly what the recipe names and redeemed by taking exactly that back. Nothing is priced by an oracle, so there is no price to push and no way to mint an unbacked share.",
  },
  {
    n: "3",
    title: "Or pay in dollars",
    on: "Filler auction",
    body: "Escrow dollars for a number of shares that falls over a few minutes. The first filler who delivers the stocks gets paid. Competition sets the price, the vault still receives the real stocks.",
  },
  {
    n: "4",
    title: "Then every month",
    on: "SIP plans",
    body: "Set a monthly amount and the plan places that order on schedule, anyone can run it, and each fill resets its reference price. The habit behind India's index-fund boom, onchain.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
      {/* ------------------------------------------------------------- hero */}
      <section className="grid gap-12 pt-14 pb-16 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14 lg:pt-20">
        <div className="max-w-[34rem] self-center">
          <Link
            href="#launch"
            className="rise mb-8 inline-flex items-center gap-2.5 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-bind hover:text-ink"
          >
            <span className="live-dot size-1.5 shrink-0 rounded-full bg-gain" aria-hidden />
            A basket is trading on a Meteora curve right now
          </Link>
          <h1 className="rise display text-hero text-ink" style={{ "--i": 1 } as React.CSSProperties}>
            Bind any eight stocks into one share.
          </h1>
          <p className="rise mt-7 max-w-[44ch] text-lg leading-relaxed text-ink-2" style={{ "--i": 2 } as React.CSSProperties}>
            Sheaf turns tokenized stocks into index funds anyone can launch. Pick
            up to eight companies and set the weights. Every share is backed by the
            real stocks in an onchain vault, and redeeming one hands you the stocks
            back.
          </p>
          <div className="rise mt-9 flex flex-wrap items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
            <ComposeCta>Launch a basket</ComposeCta>
            <Link
              href="/explore"
              className="rounded-[10px] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
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
      <section className="reveal border-y border-line py-px">
        <HomeStats />
      </section>

      {/* ------------------------------------------------------------ tape */}
      <section className="py-20">
        <LiveTape />
      </section>

      {/* ------------------------------------------------------- lifecycle */}
      <section className="reveal py-20">
        <h2 className="display text-title max-w-[26ch] text-ink">
          From a recipe to a monthly habit, and none of it trusts us.
        </h2>
        <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {LIFE.map((step) => (
            <li key={step.title} className="flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-7">
              <p className="flex items-baseline justify-between gap-3 text-xs">
                <span className="tnum text-bind">{step.n}</span>
                <span className="text-ink-3">{step.on}</span>
              </p>
              <h3 className="display mt-3 text-xl text-ink">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 max-w-[62ch] text-sm leading-relaxed text-ink-3">
          Deposits round up and redemptions round down, so every rounding remainder
          stays in the vault. The vault can therefore only ever hold more than the
          outstanding shares claim, never less.{" "}
          <Link
            href="/method"
            className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            How the program is built
          </Link>
          {" "}· every creation and redemption it has ever settled is on{" "}
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
      <section className="reveal py-20">
        <Anatomy />
      </section>

      {/* ---------------------------------------------------------- launch */}
      <section id="launch" className="reveal scroll-mt-24 border-t border-line py-20">
        <LaunchMarket />
      </section>

      {/* -------------------------------------------------------- premiums */}
      <section className="reveal py-20">
        <div className="max-w-[46ch]">
          <h2 className="display text-title text-ink">Two prices for one company.</h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            Every token here has the price it trades at on Solana and the price of the listed share
            behind it. The gap between them is the premium. A basket cannot wish it away, so Sheaf
            shows it on every component and values a share both ways.
          </p>
        </div>
        <div className="mt-10">
          <Premiums />
        </div>
      </section>

      {/* ------------------------------------------------------- dividends */}
      <section className="reveal border-t border-line py-20">
        <div className="max-w-[46ch]">
          <h2 className="display text-title text-ink">A dividend is a number going up.</h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            Tokenized equities pay dividends by raising a multiplier on the mint, not by sending
            anything. A recipe written in displayed balances would come up short by exactly the
            dividends already paid. Sheaf stores recipes in raw units and applies the live
            multiplier when it prices a share, so a share redeems for the same units before and after
            a dividend, and is worth more after.
          </p>
        </div>
        <div className="mt-10">
          <Dividends />
        </div>
      </section>

      {/* ------------------------------------------------------- two clocks */}
      <section className="reveal grid gap-10 border-t border-line py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="max-w-[38ch] self-center">
          <h2 className="display text-title text-ink">
            The exchange keeps hours. Your basket does not.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
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
      </section>

      {/* --------------------------------------------------------- revenue */}
      <section className="reveal py-20">
        <Revenue />
      </section>

      {/* ------------------------------------------------------------ keys */}
      <section className="reveal border-t border-line py-20">
        <Keys />
      </section>

      {/* -------------------------------------------------------- baskets */}
      <section className="reveal py-20">
        <FeaturedBaskets />
      </section>
    </div>
  );
}
