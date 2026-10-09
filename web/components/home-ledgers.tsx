import Link from "next/link";
import { MAX_CREATOR_FEE_BPS, SHEAF_PROGRAM_ID, explorerAddress } from "@/lib/config";
import { TREASURY } from "@/lib/dbc";
import { shortAddress } from "@/lib/format";

/** Money is made where backed shares are made. These two come first. */
const SHARE_FEES = [
  {
    share: `up to ${MAX_CREATOR_FEE_BPS / 100}%`,
    title: "of every creation, to the basket's creator",
    body: "Paid in newly created shares, never out of the vault, so what each share can redeem is unchanged. It is the reason to build a basket and bring holders to it.",
  },
  {
    share: "the spread",
    title: "on every dollar order, to the filler who delivers",
    body: "A dollar order is an auction on share count that falls toward the buyer's floor. The filler keeps the gap between what the auction pays and what the stocks cost. Sheaf runs the house filler; anyone can run another and compete for it.",
  },
];

/** The launch markets pay too, but they sit beside the backed share, not inside it. */
const LAUNCH_FEES = [
  { share: "½", title: "of every launch curve's trading fees", body: "The fee opens at 25% to make sniping expensive and falls to 1% over the first ten minutes (launches on the first curve opened at 4%). The basket's creator earns the other half." },
  { share: "1%", title: "of the SOL raised at graduation", body: "Taken as the migration fee when the curve becomes a permanent Meteora pool." },
  { share: "½", title: "of the graduated pool's fees", body: "Half the migrated liquidity is locked in a position the treasury owns, so it keeps paying." },
];

/** Nothing is charged for a basket, a creation or a redemption. Fees sit where shares are made. */
export function Revenue() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[40ch]">
        <h2 className="display text-title text-ink">Paid where backed shares are made.</h2>
        <p className="mt-5 text-base leading-relaxed text-ink-2">
          Nothing is charged for a basket. Creating one, creating shares in kind and redeeming them cost
          nothing beyond Solana&rsquo;s fee. The money is in making shares: the creator&rsquo;s fee on
          every creation, and the spread a filler earns delivering the stocks for a dollar order or a
          monthly plan. Sheaf runs the house filler, so that spread is its first income.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-ink-3">
          Launch markets add a second, smaller line. Their fees go to the treasury{" "}
          <a href={explorerAddress(TREASURY.toBase58())} target="_blank" rel="noreferrer" className="tnum text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            {shortAddress(TREASURY.toBase58(), 6, 4)}
          </a>
          , which claims fees and does nothing else.
        </p>
      </div>
      <div>
        <ol className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
          {SHARE_FEES.map((r) => (
            <li key={r.title} className="bg-surface p-6 sm:p-7">
              <p className="tnum display text-4xl text-bind sm:text-5xl">{r.share}</p>
              <p className="mt-3 text-sm text-ink">{r.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{r.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm text-ink">Then, from launch markets</p>
        <ol className="mt-3 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-3">
          {LAUNCH_FEES.map((r) => (
            <li key={r.title} className="bg-page p-5">
              <p className="tnum display text-2xl text-ink">{r.share}</p>
              <p className="mt-2 text-sm text-ink-2">{r.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{r.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          A launch token is its own market and is not redeemable for the stocks. Only a basket share is backed.
        </p>
      </div>
    </div>
  );
}

const KEYS: { what: string; who: string; can: string; cannot: string }[] = [
  {
    what: "A basket's recipe",
    who: "Nobody",
    can: "Be read by anyone, on every page load.",
    cannot: "Be edited, paused or drained. No instruction exists for it.",
  },
  {
    what: "A share mint",
    who: "The program, as sole mint authority",
    can: "Mint on a creation, burn on a redemption.",
    cannot: "Freeze a holder: the mint has no freeze authority.",
  },
  {
    what: "The vault's tokens",
    who: "The program",
    can: "Leave only against a burned share, in the recipe's exact units.",
    cannot: "Be priced, lent or moved by any wallet.",
  },
  {
    what: "A launch market's keys",
    who: "Derived from the basket's address, public by design",
    can: "Sign once to create the curve's accounts.",
    cannot: "Own anything afterwards; the launch token is immutable and the migrated liquidity is locked.",
  },
  {
    what: "The house key (B8dL…U1L)",
    who: "Sheaf's server",
    can: "Mint devnet mirror tokens for a visitor, fill dollar orders and plan runs like any other filler, and create shares in the baskets it seeded, which earns those baskets' creator fee.",
    cannot: "Edit a recipe, fill outside an order's auction, take anything out of a vault, or touch anything on mainnet.",
  },
  {
    what: "The treasury key",
    who: "Sheaf",
    can: "Claim the partner fees from launch markets.",
    cannot: "Change a fee, a curve or a basket.",
  },
  {
    what: "The program's upgrade authority",
    who: "The deploy wallet, on devnet",
    can: "Ship a new build while the program is still changing.",
    cannot: "Stay that way on mainnet: it moves to a multisig and is then burned, after an audit.",
  },
];

/** Who holds which key, and what each can and cannot do. */
export function Keys() {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[46ch]">
          <h2 className="display text-title text-ink">Who holds which key.</h2>
          <p className="mt-4 text-base leading-relaxed text-ink-2">
            The whole trust model, in one table. The program never prices anything and nobody can edit a recipe, so there is very little a key could do
            even if it wanted to.
          </p>
        </div>
        <a href={explorerAddress(SHEAF_PROGRAM_ID)} target="_blank" rel="noreferrer" className="tnum text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
          Program {shortAddress(SHEAF_PROGRAM_ID, 6, 4)} on Solana Explorer
        </a>
      </div>
      {/* A phone gets one card per key; four columns of sentences will not fit. */}
      <ul className="mt-8 divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:hidden">
        {KEYS.map((k) => (
          <li key={k.what} className="px-4 py-4 text-sm leading-relaxed">
            <p className="font-medium text-ink">{k.what}</p>
            <p className="mt-1 text-ink-2">
              <span className="text-ink-3">Held by:</span> {k.who}
            </p>
            <p className="mt-2 text-ink-2">
              <span className="text-gain">Can:</span> {k.can}
            </p>
            <p className="mt-1 text-ink-2">
              <span className="text-loss">Cannot:</span> {k.cannot}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-8 hidden overflow-hidden rounded-[var(--radius-panel)] border border-line sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface text-left text-xs text-ink-3">
              <th className="px-4 py-3 font-normal">What</th>
              <th className="px-4 py-3 font-normal">Held by</th>
              <th className="px-4 py-3 font-normal">Can</th>
              <th className="px-4 py-3 font-normal">Cannot</th>
            </tr>
          </thead>
          <tbody>
            {KEYS.map((k) => (
              <tr key={k.what} className="border-t border-line align-top">
                <td className="px-4 py-3 text-ink">{k.what}</td>
                <td className="px-4 py-3 text-ink-2">{k.who}</td>
                <td className="px-4 py-3 text-ink-2">{k.can}</td>
                <td className="px-4 py-3 text-ink-2">{k.cannot}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-3">
        Not yet audited. Sheaf runs on devnet, holds no real assets, and will not hold real tokenized equities before an audit.{" "}
        <Link href="/method#risks" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
          What could still go wrong
        </Link>
      </p>
    </div>
  );
}
