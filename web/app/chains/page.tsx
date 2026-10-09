import type { Metadata } from "next";
import Link from "next/link";
import { ChainsBoard } from "@/components/chains-board";
import { DEPLOYED, basketHref, type Deployment } from "@/lib/chains";
import { shortAddress } from "@/lib/format";

export const metadata: Metadata = {
  title: "Chains",
  description:
    "Sheaf goes where the stocks are: Solana, Robinhood Chain's real stock tokens, Tempo's access-key monthly plans, and the same contracts on Ethereum, Arbitrum and Base.",
};

type Extra = Deployment & {
  verified?: { via?: string; contracts?: Record<string, boolean> };
  smoke?: { passedAt?: string; txs?: Record<string, string> };
};

const RULES = [
  {
    title: "A recipe that cannot change",
    body: "Written once in the Basket constructor, with no setter, no owner, no pause and no upgrade path.",
    fn: "components()",
  },
  {
    title: "A vault only a redemption empties",
    body: "Nothing leaves except through a redemption, and deposits round up while payouts round down.",
    fn: "vaultBalances() ≥ owed",
  },
  {
    title: "Shares in kind, both ways",
    body: "Deposit the recipe and receive a share; burn a share and receive the recipe. No price is ever read.",
    fn: "mint() · redeem()",
  },
  {
    title: "A desk that turns dollars into shares",
    body: "A buyer escrows dollars; any participant who delivers the components collects them, and the shares go to the buyer.",
    fn: "placeAuction() · fill()",
  },
];

const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";

/** The v2 deployment block written by the deploy script: the fee-carrying desks. */
type V2 = {
  desk: string;
  planDesk?: string;
  verified?: { contracts?: Record<string, boolean> };
  smoke?: { passedAt?: string; txs?: Record<string, string> };
};

export default function ChainsPage() {
  const deployed = DEPLOYED.map((c) => ({ chain: c, d: c.deployment as Extra }));
  const rh = deployed.find((x) => x.d.network === "robinhoodTestnet");
  const tempo = deployed.find((x) => x.d.network === "tempoTestnet");
  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-24 sm:px-8">
      <section className="max-w-[50rem] pt-16 pb-12">
        <h1 className="display text-hero text-ink">Sheaf goes where the stocks are.</h1>
        <p className="mt-6 max-w-[60ch] text-lg leading-relaxed text-ink-2">
          Each chain is here for a reason about stocks, not prizes. Solana has xStocks and the program. Robinhood Chain has the issuer&apos;s own
          stock tokens. Tempo has recurring payments the chain itself enforces, which is exactly what a monthly plan is. Hyperliquid prices
          stocks around the clock. Everywhere else the same contracts are portable, deployed and working, waiting for an issuer.
        </p>
        <p className="mt-4 text-sm text-ink-3">
          Running on Solana devnet and {DEPLOYED.length} EVM testnets, none on mainnet yet. Connect any EVM wallet on a basket page to get test tokens, create shares in kind, redeem them, or
          buy with dollars on the desk.
        </p>
      </section>

      <ChainsBoard />

      <section className="mt-24 border-t border-line pt-16">
        <h2 className="display text-title max-w-[20ch] text-ink">The same four rules, written natively on each chain</h2>
        <ul className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {RULES.map((r) => (
            <li key={r.title} className="bg-surface p-6">
              <p className="text-base text-ink">{r.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{r.body}</p>
              <p className="tnum mt-4 text-xs text-bind">{r.fn}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-24 grid gap-12 border-t border-line pt-16 lg:grid-cols-2">
        {rh && (
          <div>
            <p className="text-xs text-ink-3">Robinhood Chain</p>
            <h2 className="display mt-2 text-title text-ink">Robinhood&apos;s tokens, bound into one share</h2>
            <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-ink-2">
              Robinhood&apos;s testnet faucet gives anyone five each of TSLA, AMZN, AMD, PLTR and NFLX a day. Those are the tokens the
              Robinhood baskets hold. Connect a wallet on a basket page and it reads what you already have, says how many shares that binds, and
              creates them in kind. Units are shown through each token&apos;s ERC-8056 multiplier, so a split never misstates a holding.
            </p>
            <ul className="mt-6 flex flex-wrap gap-3 text-sm">
              {rh.d.baskets.map((b) => (
                <li key={b.address}>
                  <Link href={basketHref(rh.d.network, b.symbol)} className="inline-flex rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-2 text-ink hover:border-ink-3">
                    {b.name} · {b.symbol}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {tempo && (
          <div>
            <p className="text-xs text-ink-3">Tempo</p>
            <h2 className="display mt-2 text-title text-ink">A monthly plan is an access key</h2>
            <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-ink-2">
              One passkey signature writes the plan on PlanDesk: the amount, the interval and the price cap. A second scopes the keeper to
              AlphaUSD.approve(PlanDesk) and PlanDesk.instalment. Ask for fewer shares and the plan answers FairOutOfBounds, run early and it
              answers TooSoon, call anything else and the chain answers CallNotAllowed. No custody, and gas paid in a dollar.
            </p>
            <Link
              href={`${basketHref(tempo.d.network, tempo.d.baskets[0].symbol)}#sip`}
              className="mt-6 inline-flex rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white hover:bg-bind-deep"
            >
              Run the plan in your browser
            </Link>
          </div>
        )}
      </section>

      <section className="mt-24 border-t border-line pt-16">
        <h2 className="display text-title text-ink">Deployed, verified, smoke-tested</h2>
        <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-ink-2">
          New orders go to the v2 desks, deployed on October 9 with the 0.10% protocol fee: CreationDeskV2 for dollar orders and PlanDesk
          for monthly plans. Each chain ran the same end-to-end test on them after deployment: approvals, a dollar order and its fill, a plan
          and its first filled installment. The v1 desk each chain started with is listed under the new one.
        </p>
        <div className="mt-8 min-w-0 overflow-x-auto border border-line">
          <table className="w-full border-collapse text-sm sm:min-w-[60rem]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-normal">Chain</th>
                <th className="px-4 py-3 font-normal">Factory</th>
                <th className="px-4 py-3 font-normal">Dollar desk (v2)</th>
                <th className="px-4 py-3 font-normal">Plan desk</th>
                <th className="px-4 py-3 font-normal">Stocks</th>
                <th className="px-4 py-3 font-normal">Verified</th>
                <th className="px-4 py-3 font-normal">Smoke test</th>
              </tr>
            </thead>
            <tbody>
              {deployed.map(({ chain, d }) => {
                const v2 = (d as unknown as { v2?: V2 }).v2;
                const v = [
                  ...(d.verified?.contracts ? Object.values(d.verified.contracts) : []),
                  ...(v2?.verified?.contracts ? Object.values(v2.verified.contracts) : []),
                ];
                const fill = v2?.smoke?.txs?.plan_fill ?? v2?.smoke?.txs?.auction_fill ?? d.smoke?.txs?.fill;
                const passedAt = v2?.smoke?.passedAt ?? d.smoke?.passedAt;
                return (
                  <tr key={d.network} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-3 text-ink">
                      {chain.name}
                      <span className="block text-xs text-ink-3">{d.label}</span>
                    </td>
                    <td className="tnum px-4 py-3">
                      <a href={`${d.explorer}/address/${d.factory}`} target="_blank" rel="noreferrer" className={`text-ink-2 ${link}`}>
                        {shortAddress(d.factory, 6, 4)}
                      </a>
                    </td>
                    <td className="tnum px-4 py-3">
                      {v2 ? (
                        <a href={`${d.explorer}/address/${v2.desk}`} target="_blank" rel="noreferrer" className={`text-ink-2 ${link}`}>
                          {shortAddress(v2.desk, 6, 4)}
                        </a>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                      <span className="mt-0.5 block text-xs text-ink-3">
                        v1{" "}
                        <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className={link}>
                          {shortAddress(d.desk, 6, 4)}
                        </a>
                      </span>
                    </td>
                    <td className="tnum px-4 py-3">
                      {v2?.planDesk ? (
                        <a href={`${d.explorer}/address/${v2.planDesk}`} target="_blank" rel="noreferrer" className={`text-ink-2 ${link}`}>
                          {shortAddress(v2.planDesk, 6, 4)}
                        </a>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{d.tokenSource === "real" ? "Robinhood's own" : "Labeled mirrors"}</td>
                    <td className="tnum px-4 py-3 text-ink-2">{v.length ? `${v.filter(Boolean).length} of ${v.length}` : "—"}</td>
                    <td className="tnum px-4 py-3">
                      {fill ? (
                        <a href={`${d.explorer}/tx/${fill}`} target="_blank" rel="noreferrer" className={`text-gain ${link}`}>
                          passed {passedAt?.slice(0, 10)}
                        </a>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-sm text-ink-2">
          Solana&apos;s program, tests and ledger live on <Link href="/method" className={link}>the method page</Link> and{" "}
          <Link href="/ledger" className={link}>the ledger</Link>.
        </p>
      </section>
    </div>
  );
}
