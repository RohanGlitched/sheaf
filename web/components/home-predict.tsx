import Link from "next/link";

/** The Big Five, the basket the home page already takes apart. */
const PREDICT_HREF = "/basket/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ#predict";

const RULE = [
  { when: "Monday", what: "One BIG5 share is valued from what its vault holds, at the open." },
  { when: "Friday", what: "It is valued the same way again, at the close." },
  { when: "Settles", what: "Yes if the share rose more than SPY over the same days, no otherwise." },
];

/**
 * The last step of the story, told without a live quote: a basket has a value
 * anyone can read from its vault, so a bet on it can settle without a price feed.
 * The live market and its quotes are on the basket page.
 */
export function HomePredict() {
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <div className="self-center">
        <h2 className="display text-title max-w-[18ch] text-ink">Bet on a basket, settled from its vault.</h2>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-ink-2">
          Every basket can carry a weekly question: will it beat SPY? Its value comes from the stocks
          in its vault and the recipe, both public, so the answer needs nobody&apos;s price. Sheaf
          writes the question and the rule. Panta runs the market on Solana, paid in USDC.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href={PREDICT_HREF}
            className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink transition-colors hover:border-ink-3"
          >
            See the market
          </Link>
          <a
            href="https://panta.market"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            About Panta
          </a>
        </div>
      </div>

      <div className="self-center rounded-[var(--radius-panel)] border border-line bg-surface">
        <div className="border-b border-line p-6 sm:p-7">
          <p className="text-xs text-ink-3">This week&apos;s question</p>
          <p className="display mt-2 text-2xl text-ink sm:text-3xl">Will The Big Five beat SPY this week?</p>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            NVIDIA, Apple, Microsoft, Alphabet and Meta, bound into one share, against the index fund
            most people already own.
          </p>
        </div>
        <ol className="divide-y divide-line">
          {RULE.map((r) => (
            <li key={r.when} className="grid gap-1 px-6 py-4 sm:grid-cols-[6.5rem_1fr] sm:gap-4 sm:px-7">
              <span className="text-sm text-bind">{r.when}</span>
              <span className="text-sm leading-relaxed text-ink-2">{r.what}</span>
            </li>
          ))}
        </ol>
        <p className="border-t border-line px-6 py-4 text-xs leading-relaxed text-ink-3 sm:px-7">
          On Panta&apos;s sandbox while Sheaf is on devnet, so quotes are real answers from its test
          markets and no USDC is spent.
        </p>
      </div>
    </div>
  );
}
