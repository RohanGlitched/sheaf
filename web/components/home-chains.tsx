import Link from "next/link";
import { EVM_CHAINS } from "@/lib/chains";

const src = "underline decoration-line-strong underline-offset-4 hover:text-ink-2";

/** Where Sheaf runs, at a glance. The full page reads every vault live. */
export function HomeChains() {
  const rows = [
    { name: "Solana", note: "Home: the program, dollar orders, monthly plans and launch markets", live: true, status: "Devnet" },
    ...EVM_CHAINS.map((c) => ({
      name: c.name,
      note: c.why,
      live: !!c.deployment,
      status: c.deployment ? "Testnet" : "Next",
    })),
  ];
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <div className="self-center">
        <h2 className="display text-title max-w-[16ch] text-ink">Everywhere stocks are tokenized.</h2>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-ink-2">
          Tokenized stocks are spreading across chains, and so is Sheaf: the same recipe that can never change, the
          same vault that pays out only against a burned share, and the same dollar orders, written natively for each one.
        </p>
        <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-ink-3">
          No single chain holds the market. Of the record $15.6 billion in tokenized stocks traded onchain in
          September 2026, Robinhood&rsquo;s tokens took about 42% and Binance&rsquo;s bStocks $5.4 billion (
          <a href="https://forkast.news/?p=131481" target="_blank" rel="noreferrer" className={src}>
            Forkast
          </a>
          ); Solana&rsquo;s exchanges did about $4.4 billion (
          <a
            href="https://www.idnfinancials.com/digital-asset/69848/solana-tokenized-stock-volume-reached-us4-4-billion"
            target="_blank"
            rel="noreferrer"
            className={src}
          >
            Blockworks, via IDN
          </a>
          ). Solana is home, because the program, plans and auctions work best there; the vaults on the other
          chains are the hedge for wherever the stocks end up trading.
        </p>
        <Link href="/chains" className="mt-8 inline-flex rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink hover:border-ink-3">
          See every chain
        </Link>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
        {rows.map((r) => (
          /* On a phone the description takes its own line under the name, so it is never squeezed into a sliver. */
          <li key={r.name} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-5 py-3.5 sm:grid-cols-[auto_9rem_minmax(0,1fr)_auto] sm:gap-x-4">
            <span className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${r.live ? "bg-gain" : "bg-line-strong"}`} aria-hidden />
            <span className="text-ink">{r.name}</span>
            <span className="col-span-3 col-start-1 row-start-2 pl-5 text-sm text-ink-3 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:pl-0">{r.note}</span>
            <span className={`text-xs sm:col-start-4 ${r.live ? "text-gain" : "text-ink-3"}`}>{r.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
