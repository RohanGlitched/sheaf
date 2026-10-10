import type { Metadata } from "next";
import { HomeStats } from "@/components/home-mosaic";
import { MarketClock } from "@/components/market-clock";
import { Dividends, Premiums } from "@/components/home-market-facts";
import Link from "next/link";
import { LiveTape } from "@/components/live-tape";

export const metadata: Metadata = {
  title: "Live tape",
  description:
    "Tokenized-stock trades on Solana mainnet as they land, read through Solami: side, size, fill against Jupiter and venue, with the reads Solami serves for every basket's value.",
};

const BIG5 = "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";
const DOC = "https://github.com/RohanGlitched/sheaf/blob/main/docs/solami.md";

/** What this page reads through Solami, and where each read ends up. */
const SERVES: { title: string; calls: string; body: string; href: string; link: string }[] = [
  {
    title: "The tape",
    calls: "getSignaturesForAddress, getTransaction, getBlockTime, getSlot",
    body: "The newest signatures on ten xStock mints, two per poll, decoded from token balances into side, size, fill and venue. Paced at 1.5 calls a second per server instance, so three instances together stay under the free key's five.",
    href: "/api/tape",
    link: "/api/tape",
  },
  {
    title: "Every basket's value",
    calls: "getMultipleAccounts over 28 mints",
    body: "Each xStock's Token-2022 ScaledUiAmount multiplier, which carries its dividends, read from the mint itself in one call. It sets the value of every Sheaf basket, on every page.",
    href: "/api/market",
    link: "/api/market (chain.slot, chain.via)",
  },
  {
    title: "Every Panta resolution",
    calls: "the same multiplier read",
    body: "A basket's market resolves from navPerShare.listed at two week-ending closes: adjusted closes times these multipliers. If the mainnet read fails, the answer is a 503, never a guess.",
    href: `/api/nav/${BIG5}`,
    link: "/api/nav/<BIG5> (sources.multipliers)",
  },
];

/**
 * /live: the mainnet tape on its own, full width, with the Solami figures
 * open. The page to show (and record) what Sheaf reads through Solami.
 */
export default function LivePage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <section className="pt-14 pb-10">
        <p className="flex items-center gap-2 text-sm text-bind">
          <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
          Live · Solana mainnet · read through Solami
        </p>
        <h1 className="display mt-3 max-w-[18ch] text-hero leading-[0.95] text-ink">The stock-token tape.</h1>
        <p className="mt-6 max-w-[62ch] text-lg leading-relaxed text-ink-2">
          Every few seconds Sheaf asks mainnet, through Solami&apos;s RPC, for the newest trades in tokenized
          stocks and decodes them on the server. Each row links to its transaction on Solscan. The same
          key reads the dividend multipliers that value every basket and settle every Panta market.
        </p>
      </section>

      {/* The hero above already says what this is, so the tape drops its own heading column
          (hideIntro) and runs full width with its source line, slot included, shown once. */}
      <section className="border-t border-line pt-12">
        <LiveTape openDetails hideIntro />
      </section>

      <section className="mt-20 border-t border-line pt-12">
        <h2 className="display text-title max-w-[22ch] text-ink">What Solami serves here.</h2>
        <div className="mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line md:grid-cols-3">
          {SERVES.map((s) => (
            <div key={s.title} className="min-w-0 bg-surface p-6">
              <p className="text-ink">{s.title}</p>
              <p className="mt-1 font-mono text-[11px] leading-relaxed text-ink-3">{s.calls}</p>
              <p className="mt-4 text-sm leading-relaxed text-ink-2">{s.body}</p>
              <a
                href={s.href}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block break-all font-mono text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink"
              >
                {s.link}
              </a>
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-[70ch] text-sm leading-relaxed text-ink-3">
          Free tier, RPC only: Solami&apos;s gRPC streams and WebSockets are not on the free plan, and its
          Data API needs a permission this key does not have. How each figure is measured, and what
          production showed, is in{" "}
          <a href={DOC} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4">
            docs/solami.md
          </a>
          . The baskets these tokens go into are on{" "}
          <Link href="/explore" className="text-ink underline underline-offset-4">
            Explore
          </Link>
          , and their markets on{" "}
          <Link href="/predict" className="text-ink underline underline-offset-4">
            Predict
          </Link>
          .
        </p>
      </section>

      {/* ------------------------------------------------ the evidence group */}
      <section id="numbers" className="mt-20 scroll-mt-24 border-t border-line pt-12" aria-labelledby="evidence">
        <div className="max-w-[52ch]">
          <h2 id="evidence" className="display text-title text-ink">
            Why the numbers hold up.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            What a basket is made of, read live: the tokens trading on Solana right now, the gap
            between a token and its listed share, dividends that arrive as a multiplier, and a
            market that never closes.
          </p>
        </div>

        <div className="mt-12 border-y border-line py-px">
          <HomeStats />
        </div>

        <div className="pb-4" />

        {/* premiums */}
        <div className="border-t border-line py-16">
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
    </div>
  );
}
