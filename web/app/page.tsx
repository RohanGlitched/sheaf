import Link from "next/link";
import { ComposeCta } from "@/components/home-mosaic";
import { HomeSheaf } from "@/components/home-sheaf";
import { HomeBeside } from "@/components/home-beside";
import { HERO_BASKET } from "@/lib/hero";
import { basketToJson, fetchBasketAt, type BasketJson } from "@/lib/sheaf";
import { lastGood } from "@/lib/price-snapshot";
import type { MarketSnapshot } from "@/lib/market";
import { HomePlans } from "@/components/home-plans";
import { FeaturedBaskets } from "@/components/featured-baskets";
import { HomeNav } from "@/components/home-nav";

/**
 * The hero basket: the Magnificent Seven, seven listed megacaps with dividends
 * inside. It was created after the protocol fee, so every share created in it
 * carries Sheaf's 0.10%. The Big Five, from before the fee, is taken apart
 * further down and listed beside it.
 */
const HERO = HERO_BASKET;

/**
 * The share's life in four steps: make it, buy it, keep buying it, leave. The
 * launch market and the weekly question that sit beside a basket, and each step
 * beside the transaction that proves it, are on /method.
 */
const LIFE = [
  {
    n: "1",
    title: "Write the recipe",
    on: "One transaction",
    href: "/compose",
    body: "Pick up to eight tokenized stocks, such as Apple, NVIDIA and Tesla as xStocks, and set the weights. The program stores the exact units behind one share and can never change them.",
  },
  {
    n: "2",
    title: "Buy in kind or with dollars",
    on: "Onchain vault",
    href: `/basket/${HERO}`,
    body: "Deposit exactly what the recipe names, or escrow dollars and let fillers race to deliver the stocks within ninety seconds. Either way the vault receives the real stocks; no unbacked share can exist.",
  },
  {
    n: "3",
    title: "Then every month",
    on: "Monthly plan",
    href: "#plans",
    body: "Set a monthly amount and the plan places that order on schedule, inside limits you sign once. The habit behind India's SIPs, onchain, for Indians abroad first.",
  },
  {
    n: "4",
    title: "Redeem or sell, any time",
    on: "Two ways out",
    href: "/method#sell",
    body: "Hand a share back for the stocks themselves, free, or sell it for dollars by the same auction reversed. No protocol fee to hold or to leave.",
  },
];

/** Rebuilt at most every five minutes, so the hero sheaf starts from a recent read. */
export const revalidate = 300;

/** Everything that used to stand on this page, one click away on the page it belongs to. */
const MORE = [
  { href: "/method", title: "How it works", body: "Every step beside its transaction, what is inside a share, and who holds which key.", cta: "Read it" },
  { href: "/business", title: "How Sheaf earns", body: "The 0.10% fee, where $1,000 goes, break-even and the comparison with other basket products.", cta: "See the numbers" },
  { href: "/live", title: "Live market", body: "Tokenized-stock trades on Solana mainnet, premiums, dividends and the exchange clock.", cta: "Watch it" },
  { href: "/explore", title: "Baskets and launches", body: "Every basket, and the launch markets that trade beside them on Meteora.", cta: "Explore" },
  { href: "/chains", title: "Other chains", body: "The same vault on Robinhood Chain, Tempo, Ethereum, Arbitrum and Base.", cta: "Open the chains" },
];

/** The hero basket (one account read, given 4 s) and the last market snapshot (1.5 s), so the hero's first paint is the real sheaf. */
async function heroData(): Promise<{ basket: BasketJson | null; snapshot: MarketSnapshot | null }> {
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
  const [basket, snapshot] = await Promise.all([
    within(fetchBasketAt(HERO_BASKET), 4000).catch(() => null),
    within(lastGood(), 1500).catch(() => null),
  ]);
  return { basket: basket ? basketToJson(basket) : null, snapshot };
}

export default async function Home() {
  const hero = await heroData();
  return (
    <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
      {/* ------------------------------------------------------------- hero */}
      {/* One person, one promise: a share that is always backed by the stocks in
          its vault and redeemable for them, bought in kind, with dollars or every month. */}
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
            Baskets of tokenized stocks. One share holds a fixed recipe, kept in
            its own onchain vault. It is always backed by those stocks, and anyone can
            redeem it for them. Buy it in kind, with dollars, or a little every
            month.
          </p>
          <div className="rise mt-9 flex flex-wrap items-center gap-3" style={{ "--i": 3 } as React.CSSProperties}>
            <ComposeCta>Create a basket</ComposeCta>
            <Link
              href={`/basket/${HERO}`}
              className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
            >
              Open the Magnificent Seven
            </Link>
          </div>
          <p className="rise mt-8 max-w-[52ch] text-sm leading-relaxed text-ink-3" style={{ "--i": 4 } as React.CSSProperties}>
            A fixed basket, like a unit investment trust: no manager and no
            rebalancing. To change a recipe, create a new basket. The program
            reads no price; it checks backing itself, so the vault can only ever
            hold at least what the shares claim.
          </p>
        </div>

        <div className="self-center">
          <HomeSheaf initialBasket={hero.basket} initialSnapshot={hero.snapshot} />
          <p className="mt-3 text-center text-xs text-ink-3">
            Backed today by devnet mirror tokens; on mainnet, by the real xStocks.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------- lifecycle */}
      <section id="how" className="scroll-mt-24 border-t border-line py-20">
        <h2 className="display text-title max-w-[26ch] text-ink">
          One backed share: in with stocks or dollars, out the same ways, or a little every month.
        </h2>
        <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          walks through all seven steps, including the launch market and the weekly question that sit beside a basket,
          each beside the transaction that proves it. Every creation, order, fill, plan run and sale is on{" "}
          <Link
            href="/ledger"
            className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            the ledger
          </Link>
          .
        </p>
      </section>

      {/* -------------------------------------------------------- baskets */}
      <section id="baskets" className="scroll-mt-24 border-t border-line py-20">
        <FeaturedBaskets />
      </section>

      {/* ----------------------------------------------------------- plans */}
      <section id="plans" className="scroll-mt-24 border-t border-line py-20">
        <HomePlans />
      </section>

      {/* ------------------------------------------------ beside the share */}
      <section id="beside" className="scroll-mt-24 border-t border-line py-20">
        <HomeBeside />
      </section>

      {/* -------------------------------------------------------- go further */}
      <section id="more" className="scroll-mt-24 border-t border-line py-20">
        <h2 className="display text-title text-ink">Go further.</h2>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {MORE.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                className="lift flex h-full flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-6 hover:border-line-strong"
              >
                <span className="display text-lg text-ink">{m.title}</span>
                <span className="mt-2 block text-sm leading-relaxed text-ink-2">{m.body}</span>
                <span className="mt-auto pt-4 text-sm text-bind">{m.cta} →</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <HomeNav />
    </div>
  );
}
