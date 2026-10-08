import Link from "next/link";
import { SHEAF_PROGRAM_ID, explorerAddress } from "@/lib/config";
import { TREASURY } from "@/lib/dbc";
import { shortAddress } from "@/lib/format";

const REVENUE = [
  {
    share: "½",
    title: "of every curve's trading fees",
    body: "From the 4% opening fee down to the settled 1%. The basket's creator earns the other half, which is why creators open one.",
  },
  {
    share: "1%",
    title: "of the SOL raised when a curve graduates",
    body: "Taken as the migration fee at the moment the launch market becomes a permanent Meteora pool.",
  },
  {
    share: "½",
    title: "of the graduated pool's fees, for good",
    body: "Half of the migrated liquidity is locked forever in a position the treasury owns, so every basket that trades keeps paying.",
  },
];

/** Nothing is charged for a basket, a creation or a redemption. The launch markets pay for the rest. */
export function Revenue() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[40ch]">
        <h2 className="display text-title text-ink">Nothing is charged for a basket. The markets pay.</h2>
        <p className="mt-5 text-base leading-relaxed text-ink-2">
          Creating a basket, creating shares and redeeming them cost nothing beyond Solana&rsquo;s fee, and the creator fee is the creator&rsquo;s in
          full. Sheaf&rsquo;s treasury is the Meteora partner on every launch curve instead, and is paid for as long as the token trades.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-ink-3">
          Treasury{" "}
          <a href={explorerAddress(TREASURY.toBase58())} target="_blank" rel="noreferrer" className="tnum text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            {shortAddress(TREASURY.toBase58(), 6, 4)}
          </a>
          : it claims fees and does nothing else.
        </p>
      </div>
      <ol className="grid gap-px bg-line sm:grid-cols-3">
        {REVENUE.map((r) => (
          <li key={r.title} className="bg-page p-6">
            <p className="tnum display text-5xl text-bind">{r.share}</p>
            <p className="mt-3 text-sm text-ink">{r.title}</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">{r.body}</p>
          </li>
        ))}
      </ol>
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
    what: "The faucet key",
    who: "Sheaf's server",
    can: "Mint the devnet mirror tokens for a visitor.",
    cannot: "Touch a basket, a vault or anything on mainnet.",
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
      <div className="mt-8 overflow-x-auto border border-line">
        <table className="w-full min-w-[720px] border-collapse text-sm">
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
        Not yet audited. Sheaf runs on devnet, holds no real assets, and will not hold real tokenised equities before an audit.{" "}
        <Link href="/method" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
          How the program is built
        </Link>
      </p>
    </div>
  );
}
