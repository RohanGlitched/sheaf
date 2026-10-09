import type { Metadata } from "next";
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

      <section className="border-t border-line pt-12">
        <LiveTape openDetails />
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
    </div>
  );
}
