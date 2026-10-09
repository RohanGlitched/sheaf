import Link from "next/link";
import { Mark } from "./mark";
import { WRITE_CLUSTER, SHEAF_PROGRAM_ID, explorerAddress } from "@/lib/config";
import { shortAddress } from "@/lib/format";

export function SiteFooter() {
  return (
    <footer className="mt-14 border-t border-line sm:mt-24">
      <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="max-w-sm">
            <Mark className="size-5 text-ink-2" />
            <p className="mt-4 text-sm leading-relaxed text-ink-2">
              Sheaf binds tokenized stocks into one token, backed share for share
              in a vault anyone can read. Solana baskets settle on {WRITE_CLUSTER},
              priced from Solana mainnet. EVM baskets settle on each chain&rsquo;s
              testnet, priced from Robinhood&rsquo;s stock-token quotes.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm">
            <Link href="/compose" className="text-ink-2 hover:text-ink">
              Create a basket
            </Link>
            <Link href="/explore" className="text-ink-2 hover:text-ink">
              Explore
            </Link>
            <Link href="/plans" className="text-ink-2 hover:text-ink">
              Plans
            </Link>
            <Link href="/predict" className="text-ink-2 hover:text-ink">
              Predict
            </Link>
            <Link href="/chains" className="text-ink-2 hover:text-ink">
              Chains
            </Link>
            <Link href="/portfolio" className="text-ink-2 hover:text-ink">
              Portfolio
            </Link>
            <Link href="/ledger" className="text-ink-2 hover:text-ink">
              Ledger
            </Link>
            <Link href="/method" className="text-ink-2 hover:text-ink">
              How it works
            </Link>
            <Link href="/business" className="text-ink-2 hover:text-ink">
              Business
            </Link>
            <Link href="/voices" className="text-ink-2 hover:text-ink">
              People
            </Link>
            <a
              href="https://github.com/RohanGlitched/sheaf"
              target="_blank"
              rel="noreferrer"
              className="text-ink-2 hover:text-ink"
            >
              Source on GitHub
            </a>
            <a
              href={explorerAddress(SHEAF_PROGRAM_ID)}
              target="_blank"
              rel="noreferrer"
              className="tnum text-ink-3 hover:text-ink"
            >
              Program {shortAddress(SHEAF_PROGRAM_ID)}
            </a>
          </div>
        </div>

        <p className="mt-10 border-t border-line pt-6 text-xs leading-relaxed text-ink-3">
          Not investment advice, and not an offer to sell anything. xStocks are
          issued by Backed Finance, PreStocks by PreStocks and Robinhood&rsquo;s
          stock tokens by Robinhood; Sheaf neither issues nor custodies them
          beyond the vault a basket writes to. Nothing here runs on mainnet yet.
        </p>
      </div>
    </footer>
  );
}
