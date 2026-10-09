import Link from "next/link";
import { MAX_CREATOR_FEE_BPS, SITE_URL } from "@/lib/config";
import { isTestBasket } from "@/lib/hidden";
import { isTeamWallet } from "@/lib/team-wallets";

/**
 * How Sheaf makes money, in pieces other pages can reuse.
 *
 * Every rate here is the one the program or the house filler applies, and every
 * outside figure carries its source and the day it was read. Nothing in this file
 * is a forecast: where a number is an illustration it says so, and where a number
 * has to come from use it is read live from the site's own API and shows "—"
 * when it cannot be read.
 *
 * Server-safe: no hooks, so a server page can import any of it, including the
 * constants.
 */

/* ------------------------------------------------------------------ rates -- */

/** Protocol fee: share of every creation, minted to the treasury. Fixed per basket at creation. */
export const PROTOCOL_FEE_BPS = 10;
/** The composer's default creator fee. The creator can pick anything from 0 to the ceiling. */
export const DEFAULT_CREATOR_FEE_BPS = 25;
/** The house filler waits until the auction pays it this much over fair, never more than the band allows. */
export const HOUSE_FILLER_MARGIN_BPS = 15;
/** A dollar order's auction runs from this far above the fair share count to this far below it. */
export const AUCTION_BAND_BPS = 200;
/** Meteora's cut of every launch-curve trading fee, then the split of what is left. */
export const METEORA_PROTOCOL_SHARE = 20;
export const TREASURY_CURVE_SHARE = 40;
export const CREATOR_CURVE_SHARE = 40;

/** The date every outside figure on the business page was read. */
export const CHECKED = "9 October 2026";

/** 10 → "0.10%", 100 → "1%". */
export const pct = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2)}%`;

/* ---------------------------------------------------------------- sources -- */

export const SOURCES = {
  rwa: { label: "rwa.xyz, tokenized stocks", href: "https://app.rwa.xyz/stocks" },
  coindesk: {
    label: "CoinDesk, stablecoins and tokenized assets, October 2026",
    href: "https://www.coindesk.com/research/stablecoins-and-tokenized-assets-report-october-2026",
  },
  solValue: {
    label: "Solana Compass / Token Terminal, Solana tokenized equity value",
    href: "https://solanacompass.com/news/solana-tokenized-equity-value-hits-535m-all-time-high-as-jupiter-lend-crosses-20m-in-xstocks-deposits",
  },
  solShare: {
    label: "Solana Compass, Solana's share of tokenized-equity spot volume",
    href: "https://solanacompass.com/news/solana-claims-97-of-tokenized-equity-spot-volume-as-holder-count-hits-200k",
  },
  sip: {
    label: "Angel One, AMFI August 2026 SIP data",
    href: "https://www.angelone.in/news/mutual-funds/sip-inflows-hit-record-32-297-crore-in-august-contributing-accounts-cross-10-crore",
  },
  cap: {
    label: "Business Today, why mutual funds are stopping international SIPs",
    href: "https://www.businesstoday.in/mutual-funds/story/why-are-mutual-funds-stopping-international-sips-heres-how-sebis-overseas-investment-cap-works-543752-2026-07-18",
  },
  capSize: {
    label: "Vested, SEBI limits on overseas investment by mutual funds",
    href: "https://vestedfinance.com/sebi-limits-on-overseas-investment-by-mutual-funds/",
  },
  fx: {
    label: "HDFC Sky, rupee closes at 95.46 to the dollar",
    href: "https://hdfcsky.com/news/rupee-rises-24-paise-to-close-at-95-46-against-us-dollar",
  },
  smallcaseFees: {
    label: "smallcase, fees and charges",
    href: "https://www.smallcase.com/learn/smallcase-fees-and-charges/",
  },
  smallcaseScale: {
    label: "Angel One, smallcase FY25 revenue",
    href: "https://www.angelone.in/news/market-updates/smallcase-surpasses-100-crore-revenue-milestone-in-fy25-with-strong-growth",
  },
  arkk: { label: "Pensions & Investments, ARKK", href: "https://etf.pionline.com/fund/ARKK" },
  botz: { label: "Global X, BOTZ", href: "https://www.globalxetfs.com/funds/botz/" },
  ici: {
    label: "ICI, fund fees in 2025",
    href: "https://www.ici.org/news-release/mutual-fund-and-etf-fees-remained-near-historic-lows-in-2025",
  },
  jupRecurring: { label: "Jupiter, recurring orders", href: "https://developers.jup.ag/docs/recurring" },
  symmetry: { label: "Symmetry, fees", href: "https://docs.symmetry.fi/concepts/fees-and-oracles" },
  meteora: { label: "Meteora, DBC fees", href: "https://docs.meteora.ag/core-products/dbc/fees/overview" },
  meteoraReceipts: {
    label: "Sheaf, the Meteora lifecycle on devnet",
    href: "https://github.com/RohanGlitched/sheaf/blob/main/docs/meteora.md",
  },
  mudrex: { label: "Mudrex, buying US stocks from India", href: "https://mudrex.com/learn/how-to-buy-us-stocks-from-india/" },
  kraken: { label: "Kraken, xStocks availability", href: "https://support.kraken.com/in/articles/xstocks-availability" },
} as const;

type SourceKey = keyof typeof SOURCES;

const linkClass = "text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink";

/** A short "Sources:" line under a table or a block. */
export function Sources({ keys, note }: { keys: SourceKey[]; note?: string }) {
  return (
    <p className="mt-4 max-w-[90ch] text-xs leading-relaxed text-ink-3">
      {note ? <>{note} </> : null}
      Sources, read {CHECKED}:{" "}
      {keys.map((k, i) => (
        <span key={k}>
          <a href={SOURCES[k].href} target="_blank" rel="noreferrer" className={linkClass}>
            {SOURCES[k].label}
          </a>
          {i < keys.length - 1 ? "; " : "."}
        </span>
      ))}
    </p>
  );
}

/* --------------------------------------------------------------- headline -- */

/** Four numbers that say the whole model. */
export function FeeHeadline() {
  const items = [
    { value: pct(PROTOCOL_FEE_BPS), label: "of every share created, to Sheaf", note: "fixed in each basket at creation" },
    { value: `0–${pct(MAX_CREATOR_FEE_BPS)}`, label: "to the basket's creator", note: `the composer suggests ${pct(DEFAULT_CREATOR_FEE_BPS)}` },
    { value: `≤${pct(HOUSE_FILLER_MARGIN_BPS)}`, label: "to whoever fills a dollar order", note: `inside the ±${pct(AUCTION_BAND_BPS)} band the buyer signs` },
    { value: "0%", label: "to hold or redeem", note: "no yearly fee, no exit fee" },
  ];
  return (
    <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-4">
      {items.map((item) => (
        <li key={item.label} className="bg-surface p-5 sm:p-7">
          <p className="tnum display text-4xl text-bind sm:text-5xl">{item.value}</p>
          <p className="mt-3 text-sm text-ink">{item.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">{item.note}</p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- fee table -- */

type FeeRow = {
  line: string;
  rate: string;
  payer: string;
  receiver: string;
  how: string;
  status: string;
};

export const FEE_ROWS: FeeRow[] = [
  {
    line: "Protocol fee",
    rate: `${pct(PROTOCOL_FEE_BPS)} of shares created`,
    payer: "Whoever creates shares: in kind, by dollar order or by a plan run",
    receiver: "Sheaf's treasury",
    how: "Minted as new shares, accrued and claimable. The vault still receives the full recipe, so what a share redeems for is unchanged. Written into the basket when it is created and can never change.",
    status: "Being added to the program now. Baskets created before it carry no protocol fee, for good.",
  },
  {
    line: "Creator fee",
    rate: `0 to ${pct(MAX_CREATOR_FEE_BPS)} of shares created`,
    payer: "Whoever creates shares in that basket",
    receiver: "The basket's creator",
    how: `Chosen once when the basket is created (the composer suggests ${pct(DEFAULT_CREATOR_FEE_BPS)}) and paid in new shares, never out of the vault.`,
    status: "Live on devnet and on the EVM testnets. Sheaf earns it only on the baskets it publishes itself.",
  },
  {
    line: "Filler margin",
    rate: `Up to ${pct(HOUSE_FILLER_MARGIN_BPS)} under the fair share count, for Sheaf's own filler`,
    payer: "The buyer of a dollar order or a plan run",
    receiver: "Whichever filler delivers the stocks first",
    how: `The auction offers a share count from ${pct(AUCTION_BAND_BPS)} above fair to the buyer's floor ${pct(AUCTION_BAND_BPS)} below it. Sheaf's house filler fills once the auction pays it ${pct(HOUSE_FILLER_MARGIN_BPS)} over fair. Any other filler can fill earlier for less, and the buyer gets that better count.`,
    status: "Live as a policy of the house filler. Anyone can run a filler; the script is in the repository.",
  },
  {
    line: "Launch markets",
    rate: `${TREASURY_CURVE_SHARE}% of curve fees, 1% at graduation, 1% of supply, ½ of locked-pool fees`,
    payer: "Traders of a basket's launch token on Meteora",
    receiver: `Sheaf's treasury; the creator gets another ${CREATOR_CURVE_SHARE}% of curve fees and Meteora keeps ${METEORA_PROTOCOL_SHARE}%`,
    how: "Meteora takes its share of every curve trading fee first and the rest is split evenly. At graduation the treasury takes a 1% migration fee and 1% of the token's supply, and owns half of the permanently locked pool's fees.",
    status: "Live on devnet. A launch token is its own market and is not a basket share.",
  },
  {
    line: "Monthly plans",
    rate: "Free to open and to run",
    payer: "Nobody, beyond the run's own dollar order",
    receiver: "—",
    how: "Each run is a dollar order, so the protocol fee, the creator fee and the filler's margin apply to it exactly as to any other. Whoever sends a due run is repaid its rent.",
    status: "Live on devnet.",
  },
  {
    line: "Holding and redeeming",
    rate: "Free",
    payer: "—",
    receiver: "—",
    how: "No yearly fee, no exit fee. Redeeming burns shares and returns the stocks, rounded down, for Solana's network fee alone.",
    status: "Live. No yearly fee will be added without legal advice first.",
  },
];

/** Who pays whom, how much, and for what. The whole model in one table. */
export function FeeTable() {
  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface lg:hidden">
        {FEE_ROWS.map((row) => (
          <li key={row.line} className="px-4 py-5 text-sm leading-relaxed">
            <p className="display text-lg text-ink">{row.line}</p>
            <p className="tnum mt-1 text-bind">{row.rate}</p>
            <dl className="mt-3 space-y-2">
              {[
                ["Paid by", row.payer],
                ["Paid to", row.receiver],
                ["How", row.how],
                ["Status", row.status],
              ].map(([term, value]) => (
                <div key={term} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
                  <dt className="text-xs text-ink-3">{term}</dt>
                  <dd className="text-ink-2">{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-[var(--radius-panel)] border border-line lg:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface text-left text-xs text-ink-3">
              <th className="px-4 py-3 font-normal">Line</th>
              <th className="px-4 py-3 font-normal">Rate</th>
              <th className="px-4 py-3 font-normal">Paid by</th>
              <th className="px-4 py-3 font-normal">Paid to</th>
              <th className="px-4 py-3 font-normal">How it works</th>
              <th className="px-4 py-3 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {FEE_ROWS.map((row) => (
              <tr key={row.line} className="border-t border-line align-top">
                <th scope="row" className="px-4 py-4 text-left font-normal text-ink">{row.line}</th>
                <td className="tnum px-4 py-4 text-bind">{row.rate}</td>
                <td className="px-4 py-4 text-ink-2">{row.payer}</td>
                <td className="px-4 py-4 text-ink-2">{row.receiver}</td>
                <td className="max-w-[38ch] px-4 py-4 text-ink-2">{row.how}</td>
                <td className="max-w-[26ch] px-4 py-4 text-ink-3">{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sources keys={["meteora", "meteoraReceipts"]} note="There is no management fee and no fee switch: each basket's fees are part of its account and no instruction edits them." />
    </div>
  );
}

/* --------------------------------------------------- where $1,000 goes -- */

/**
 * One $1,000 dollar order into a basket with the suggested creator fee, filled
 * by Sheaf's own filler at its margin. Route cost is the measured one-way cost
 * at $1,000 (half the measured round trip below).
 */
export function OrderSplit({ order = 1000, creatorBps = DEFAULT_CREATOR_FEE_BPS }: { order?: number; creatorBps?: number }) {
  const fair = order / (1 + HOUSE_FILLER_MARGIN_BPS / 1e4);
  const filler = order - fair;
  const creator = fair * (creatorBps / 1e4);
  const protocol = fair * (PROTOCOL_FEE_BPS / 1e4);
  const buyer = fair - creator - protocol;
  const routeCost = fair * (MEASURED_ROUTE[1].roundTripBps / 2 / 1e4);
  const fees = [
    { label: "Creator", value: creator, color: "var(--color-gain)" },
    { label: "Filler", value: filler, color: "var(--color-ink-3)" },
    { label: "Sheaf", value: protocol, color: "var(--color-bind)" },
  ];
  const feeTotal = creator + filler + protocol;
  const usd = (v: number) => `$${v.toFixed(2)}`;
  return (
    <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-7">
      <p className="text-sm text-ink-2">
        A ${order.toLocaleString("en-US")} dollar order into a basket with a {pct(creatorBps)} creator fee, filled by Sheaf&rsquo;s filler
      </p>
      <div className="mt-5 flex h-12 overflow-hidden rounded-[var(--radius-control)]" aria-hidden>
        <div className="flex items-center bg-vault px-4 text-sm text-vault-ink" style={{ width: `${(buyer / order) * 100}%` }}>
          <span className="tnum">{usd(buyer)} of backed shares to the buyer</span>
        </div>
        <div className="flex-1 bg-bind" />
      </div>
      <p className="mt-6 text-xs text-ink-3">The last {usd(feeTotal)}, drawn {Math.round(order / feeTotal)} times larger</p>
      <div className="mt-2 flex h-10 overflow-hidden rounded-[var(--radius-control)]" aria-hidden>
        {fees.map((f) => (
          <div key={f.label} style={{ width: `${(f.value / feeTotal) * 100}%`, background: f.color }} />
        ))}
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        {fees.map((f) => (
          <div key={f.label} className="flex items-baseline gap-2.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: f.color }} aria-hidden />
            <dt className="text-ink-2">{f.label}</dt>
            <dd className="tnum ml-auto text-ink sm:ml-0">{usd(f.value)}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="mt-5 text-xs leading-relaxed text-ink-3">
        The filler&rsquo;s {usd(filler)} is gross. Buying the five stocks through Jupiter cost about {usd(routeCost)} at this
        size when we measured it, so the filler keeps about {usd(filler - routeCost)} before Solana&rsquo;s network fees. In a
        basket with no creator fee the buyer keeps {usd(buyer + creator)}. Redeeming later costs nothing.
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------ measured route -- */

/**
 * The Jupiter round trip for an equal-weight basket of Apple, Microsoft, NVIDIA,
 * Alphabet and Amazon xStocks, quoted through this site's /api/fill-cost (which
 * asks Jupiter to buy each leg with USDC and sell it straight back). Nothing was
 * executed. Measured 9 October 2026.
 */
export const MEASURED_ROUTE = [
  { size: 100, roundTripBps: 5.7 },
  { size: 1000, roundTripBps: 9.2 },
  { size: 5000, roundTripBps: 16.6 },
] as const;

export function MeasuredRoute() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <p className="border-b border-line px-5 py-4 text-sm text-ink-2">
        What a filler pays to buy the stocks, measured
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="px-3 py-3 sm:px-5 font-normal">Order</th>
            <th className="px-3 py-3 sm:px-5 text-right font-normal">Round trip</th>
            <th className="hidden px-3 py-3 sm:px-5 text-right font-normal sm:table-cell">One way, about</th>
            <th className="px-3 py-3 sm:px-5 text-right font-normal">Left of {pct(HOUSE_FILLER_MARGIN_BPS)}</th>
          </tr>
        </thead>
        <tbody>
          {MEASURED_ROUTE.map((r) => (
            <tr key={r.size} className="border-t border-line">
              <td className="tnum px-3 py-3 sm:px-5 text-ink">${r.size.toLocaleString("en-US")}</td>
              <td className="tnum px-3 py-3 sm:px-5 text-right text-ink-2">{(r.roundTripBps / 100).toFixed(3)}%</td>
              <td className="tnum hidden px-3 py-3 sm:px-5 text-right text-ink-2 sm:table-cell">{(r.roundTripBps / 200).toFixed(3)}%</td>
              <td className="tnum px-3 py-3 sm:px-5 text-right text-ink">{((HOUSE_FILLER_MARGIN_BPS - r.roundTripBps / 2) / 100).toFixed(3)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-5 py-4 text-xs leading-relaxed text-ink-3">
        An equal-weight basket of Apple, Microsoft, NVIDIA, Alphabet and Amazon xStocks on Solana mainnet. Each leg was quoted
        through Jupiter with USDC in and straight back out, through this site&rsquo;s fill-cost endpoint; nothing was
        executed. Read {CHECKED}. Every basket page runs the same measurement live.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- holder's cost -- */

const FX = 95.5;

type CostRow = { route: string; once: string; yearly: string; threeYears: string; note: string; ours?: boolean };

export const HOLDER_COST: CostRow[] = [
  {
    route: "A Sheaf basket, by dollar order",
    once: `up to ${pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS + HOUSE_FILLER_MARGIN_BPS)}`,
    yearly: "0%",
    threeYears: `up to ${pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS + HOUSE_FILLER_MARGIN_BPS)}`,
    note: `${pct(PROTOCOL_FEE_BPS)} protocol, ${pct(DEFAULT_CREATOR_FEE_BPS)} suggested creator fee, up to ${pct(HOUSE_FILLER_MARGIN_BPS)} to the filler. In a basket with no creator fee, up to ${pct(PROTOCOL_FEE_BPS + HOUSE_FILLER_MARGIN_BPS)}.`,
    ours: true,
  },
  {
    route: "A Sheaf basket, in kind",
    once: `${pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS)}`,
    yearly: "0%",
    threeYears: `${pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS)}`,
    note: "For someone who already holds the stocks: no filler, no route cost.",
    ours: true,
  },
  {
    route: "smallcase, a ₹9,550 ($100) lump sum",
    once: `${((118 / (100 * FX)) * 100).toFixed(2)}%`,
    yearly: "0%",
    threeYears: `${((118 / (100 * FX)) * 100).toFixed(2)}%`,
    note: "₹100 + 18% GST per buy order, capped at 1.5%; broker charges on top. Indian stocks, not US.",
  },
  {
    route: "smallcase, a ₹5,000 monthly SIP",
    once: `${((11.8 / 5000) * 100).toFixed(2)}% a run`,
    yearly: "0%",
    threeYears: `${((11.8 / 5000) * 100).toFixed(2)}% a run`,
    note: "₹10 + 18% GST per run, capped at 1.5%. A ₹1,000 SIP pays 1.18% a run.",
  },
  {
    route: "A thematic ETF (ARKK, BOTZ)",
    once: "spread + brokerage",
    yearly: "0.68–0.75%",
    threeYears: "about 2.0–2.3%",
    note: "Expense ratios charged every year. The fund rebalances for you, which a fixed Sheaf recipe does not.",
  },
  {
    route: "A broad index ETF, or an issuer token like SPYx",
    once: "spread + brokerage",
    yearly: "0.14% average",
    threeYears: "about 0.42%",
    note: "Cheaper than Sheaf for a broad index. If that is what you want, buy it; a Sheaf basket can hold SPYx too.",
  },
  {
    route: "Five tokens bought by hand on Jupiter",
    once: `about ${(MEASURED_ROUTE[0].roundTripBps / 200).toFixed(2)}% + 5 network fees`,
    yearly: "0%",
    threeYears: "your time",
    note: "Cheapest on paper. You hold five positions, keep the weights yourself, and a monthly plan is five orders a month (Jupiter's recurring orders take 0.1% each).",
  },
];

/** What a holder pays on Sheaf, beside the routes they would otherwise take. */
export function HolderCost() {
  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface lg:hidden">
        {HOLDER_COST.map((row) => (
          <li key={row.route} className={`px-4 py-4 text-sm leading-relaxed ${row.ours ? "bg-raised" : ""}`}>
            <p className={row.ours ? "text-bind" : "text-ink"}>{row.route}</p>
            <p className="tnum mt-1 text-ink">
              {row.once} once · {row.yearly} a year · {row.threeYears} over 3 years
            </p>
            <p className="mt-1 text-xs text-ink-3">{row.note}</p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-hidden rounded-[var(--radius-panel)] border border-line lg:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface text-left text-xs text-ink-3">
              <th className="px-4 py-3 font-normal">Route</th>
              <th className="px-4 py-3 text-right font-normal">To buy</th>
              <th className="px-4 py-3 text-right font-normal">Each year</th>
              <th className="px-4 py-3 text-right font-normal">Over 3 years</th>
              <th className="px-4 py-3 font-normal">What is in it</th>
            </tr>
          </thead>
          <tbody>
            {HOLDER_COST.map((row) => (
              <tr key={row.route} className={`border-t border-line align-top ${row.ours ? "bg-raised" : ""}`}>
                <th scope="row" className={`px-4 py-3 text-left font-normal ${row.ours ? "text-bind" : "text-ink"}`}>{row.route}</th>
                <td className="tnum px-4 py-3 text-right text-ink">{row.once}</td>
                <td className="tnum px-4 py-3 text-right text-ink-2">{row.yearly}</td>
                <td className="tnum px-4 py-3 text-right text-ink-2">{row.threeYears}</td>
                <td className="max-w-[52ch] px-4 py-3 text-ink-3">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sources
        keys={["smallcaseFees", "arkk", "botz", "ici", "jupRecurring", "fx"]}
        note={`Rupee figures at ₹${FX} to the dollar. Fees only: none of these counts taxes, the token's premium to the listed share, or a broker's own charges.`}
      />
    </div>
  );
}

/* ------------------------------------------------------ unit economics -- */

const PER_MILLION = 1_000_000;

/** What Sheaf earns on $1M of share creations, by who published the basket and who filled. */
export function UnitEconomics() {
  const protocol = PER_MILLION * (PROTOCOL_FEE_BPS / 1e4);
  const routeOneWay = MEASURED_ROUTE[1].roundTripBps / 2;
  const fillerNet = PER_MILLION * ((HOUSE_FILLER_MARGIN_BPS - routeOneWay) / 1e4);
  const creator = PER_MILLION * (DEFAULT_CREATOR_FEE_BPS / 1e4);
  const cases = [
    { name: "In kind, any basket", protocol, filler: 0, creator: 0 },
    { name: "Dollars, someone else's basket, another filler", protocol, filler: 0, creator: 0 },
    { name: "Dollars, someone else's basket, Sheaf fills", protocol, filler: fillerNet, creator: 0 },
    { name: "Dollars, Sheaf's own basket, Sheaf fills", protocol, filler: fillerNet, creator },
  ];
  const usd = (v: number) => (v === 0 ? "—" : `$${Math.round(v).toLocaleString("en-US")}`);
  const flows = [1e6, 1e7, 1e8];
  // An illustration, not a forecast: protocol fee on all of it, Sheaf filling 70% of it.
  const blended = protocol + 0.7 * fillerNet;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
      <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
        <p className="border-b border-line px-5 py-4 text-sm text-ink-2">Sheaf&rsquo;s take on $1M of shares created</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-3">
                <th className="px-5 py-3 font-normal">How the shares were made</th>
                <th className="px-4 py-3 text-right font-normal">Protocol</th>
                <th className="px-4 py-3 text-right font-normal">Filler, net</th>
                <th className="px-4 py-3 text-right font-normal">Creator</th>
                <th className="px-5 py-3 text-right font-normal">Sheaf keeps</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.name} className="border-t border-line">
                  <td className="px-5 py-3 text-ink-2">{c.name}</td>
                  <td className="tnum px-4 py-3 text-right text-ink-2">{usd(c.protocol)}</td>
                  <td className="tnum px-4 py-3 text-right text-ink-2">{usd(c.filler)}</td>
                  <td className="tnum px-4 py-3 text-right text-ink-2">{usd(c.creator)}</td>
                  <td className="tnum px-5 py-3 text-right text-ink">{usd(c.protocol + c.filler + c.creator)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-4 text-xs leading-relaxed text-ink-3">
          Filler, net: the {pct(HOUSE_FILLER_MARGIN_BPS)} margin less the measured one-way route cost at $1,000 orders
          ({(routeOneWay / 100).toFixed(3)}%), before network fees and before the cost of holding stock between fills. Creator:
          Sheaf earns the {pct(DEFAULT_CREATOR_FEE_BPS)} only on baskets it publishes; on anyone else&rsquo;s it goes to them.
        </p>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-line bg-raised p-5 sm:p-6">
        <p className="text-sm text-ink">At different sizes, illustrated</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          Protocol fee on every creation, and Sheaf filling seven in ten dollar orders. Not a forecast.
        </p>
        <dl className="mt-5 divide-y divide-line text-sm">
          {flows.map((f) => (
            <div key={f} className="flex items-baseline justify-between gap-4 py-3">
              <dt className="tnum text-ink-2">${(f / 1e6).toLocaleString("en-US")}M created a month</dt>
              <dd className="tnum text-ink">${Math.round((f / PER_MILLION) * blended).toLocaleString("en-US")} a month</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          For scale, smallcase earned about 0.09% of what passed through it in FY25 (₹106 crore on ₹1.2 lakh crore), with
          brokers distributing it.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- live numbers -- */

type Json = Record<string, unknown>;

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The first numeric value under any of these keys, anywhere in the object. */
function findNumber(obj: unknown, keys: string[], depth = 0): number | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  const wanted = new Set(keys.map(norm));
  const entries = Object.entries(obj as Json);
  for (const [k, v] of entries) {
    if (!wanted.has(norm(k))) continue;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === "object") {
      const inner = findNumber(v, ["total", "count", "value", "all"], depth + 1);
      if (inner != null) return inner;
    }
  }
  for (const [, v] of entries) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findNumber(v, keys, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

async function getJson(path: string, timeoutMs: number): Promise<Json | null> {
  const origin = process.env.NODE_ENV === "development" ? "http://localhost:3900" : SITE_URL;
  try {
    const res = await fetch(`${origin}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Json;
  } catch {
    return null;
  }
}

export type LedgerStats = {
  actions: number | null;
  outsideWallets: number | null;
  outsideBaskets: number | null;
  plans: number | null;
  fills: number | null;
  dollarsFilled: number | null;
  fillRate: number | null;
  medianFillSeconds: number | null;
};

/** Reads /api/ledger, whatever shape its counts come in. Missing counts stay null. */
export function readLedgerStats(json: Json | null): LedgerStats {
  const n = (keys: string[]) => findNumber(json, keys);
  const fills = n(["fills", "filled", "fillCount", "ordersFilled", "filledOrders"]);
  const returned = n(["returned", "refunded", "refunds", "expired", "ordersReturned"]);
  let fillRate = n(["fillRate", "fillRatio", "filledShare"]);
  if (fillRate == null && fills != null && returned != null && fills + returned > 0) fillRate = fills / (fills + returned);
  if (fillRate != null && fillRate > 1) fillRate = fillRate / 100;
  return {
    actions: n(["actions", "totalActions", "events", "entries"]),
    outsideWallets: n(["outsideWallets", "walletsNotOurs", "walletsThatArentOurs", "nonTeamWallets", "outside"]),
    outsideBaskets: n(["outsideBaskets", "basketsNotOurs", "nonTeamBaskets"]),
    plans: n(["plans", "plansOpened", "plansOpen", "plansRunning"]),
    fills,
    dollarsFilled: n(["dollarsFilled", "filledUsd", "usdFilled", "cashFilled", "filledDollars", "dollarsIn"]),
    fillRate,
    medianFillSeconds: n(["medianFillSeconds", "medianTimeToFill", "medianSecondsToFill", "medianFillSec", "timeToFillMedian", "medianFill", "medianSecsToFill"]),
  };
}

export type LaunchStats = {
  open: number;
  graduated: number;
  solIn: number;
  unclaimedTreasurySol: number;
  outsideCreators: number;
} | null;

/** Reads /api/launches, leaving out our QA baskets. */
export function readLaunchStats(json: Json | null): LaunchStats {
  const list = Array.isArray(json?.launches) ? (json!.launches as Json[]) : null;
  if (!list) return null;
  const real = list.filter((l) => {
    const b = (l.basket ?? {}) as { address?: string; name?: string; symbol?: string; creator?: string };
    return l.open === true && l.official !== false && l.test !== true && !isTestBasket({ address: b.address ?? "", name: b.name, symbol: b.symbol, creator: b.creator });
  });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    open: real.length,
    graduated: real.filter((l) => l.graduated === true).length,
    solIn: real.reduce((a, l) => a + num(l.raisedSol), 0),
    unclaimedTreasurySol: real.reduce((a, l) => a + num(l.partnerFeesSol), 0),
    outsideCreators: new Set(
      real
        .map((l) => (l.basket as { creator?: string } | undefined)?.creator)
        .filter((c): c is string => typeof c === "string" && !isTeamWallet(c)),
    ).size,
  };
}

const dash = "—";
const whole = (v: number | null) => (v == null ? dash : Math.round(v).toLocaleString("en-US"));

/**
 * The numbers that have to come from use, read from the site's own API when the
 * page renders (refreshed every two minutes). Anything the API does not answer
 * shows a dash, never a guess.
 */
export async function LiveNumbers() {
  const [ledgerJson, launchJson] = await Promise.all([getJson("/api/ledger", 9000), getJson("/api/launches", 12000)]);
  const l = readLedgerStats(ledgerJson);
  const launches = readLaunchStats(launchJson);
  const readAt =
    (typeof ledgerJson?.readAt === "string" && ledgerJson.readAt) ||
    (typeof launchJson?.readAt === "string" && launchJson.readAt) ||
    null;

  const cells: { label: string; value: string; note: string }[] = [
    { label: "Wallets that aren't ours", value: whole(l.outsideWallets), note: "every team and test wallet is listed and left out" },
    { label: "Actions on the program", value: whole(l.actions), note: "creations, redemptions, orders, fills, plan runs" },
    { label: "Plans opened", value: whole(l.plans), note: "monthly plans, any wallet" },
    { label: "Dollar orders filled", value: whole(l.fills), note: "orders and plan runs a filler delivered" },
    {
      label: "Dollars filled",
      value: l.dollarsFilled == null ? dash : `$${Math.round(l.dollarsFilled).toLocaleString("en-US")}`,
      note: "test dollars on devnet",
    },
    { label: "Fill rate", value: l.fillRate == null ? dash : `${(l.fillRate * 100).toFixed(1)}%`, note: "filled, of filled plus returned unfilled" },
    {
      label: "Median time to fill",
      value: l.medianFillSeconds == null ? dash : `${Math.round(l.medianFillSeconds)} s`,
      note: "from the order to the stocks in the vault",
    },
    { label: "Baskets by others", value: whole(l.outsideBaskets), note: "published by a wallet that isn't ours" },
  ];
  const launchCells: { label: string; value: string }[] = [
    { label: "Launch markets open", value: launches ? String(launches.open) : dash },
    { label: "Graduated to a locked pool", value: launches ? String(launches.graduated) : dash },
    { label: "SOL in the curves", value: launches ? launches.solIn.toFixed(3) : dash },
    { label: "Treasury fees not yet claimed, SOL", value: launches ? launches.unclaimedTreasurySol.toFixed(4) : dash },
    { label: "Launches opened by others", value: launches ? String(launches.outsideCreators) : dash },
  ];

  return (
    <div>
      <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-4">
        {cells.map((c, i) => (
          <li key={c.label} className={`p-5 sm:p-6 ${i === 0 ? "bg-surface" : "bg-page"}`}>
            <p className={`tnum display text-3xl sm:text-4xl ${i === 0 ? "text-bind" : "text-ink"}`}>{c.value}</p>
            <p className="mt-2 text-sm text-ink">{c.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{c.note}</p>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-ink">Launch markets on Meteora</p>
      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-5">
        {launchCells.map((c) => (
          <div key={c.label} className="bg-page p-4">
            <dd className="tnum display text-2xl text-ink">{c.value}</dd>
            <dt className="mt-1.5 text-xs leading-relaxed text-ink-3">{c.label}</dt>
          </div>
        ))}
      </dl>
      <p className="mt-4 max-w-[90ch] text-xs leading-relaxed text-ink-3">
        Read from{" "}
        <Link href="/ledger" className={linkClass}>
          the ledger
        </Link>{" "}
        (decoded from the program&rsquo;s own events) and the launch feed (read from the pool accounts), both on devnet with test
        money{readAt ? `, at ${new Date(readAt).toUTCString().replace(/:\d\d GMT$/, " UTC")}` : ""}. Our own QA baskets are
        left out of the launch counts. A dash means the number could not be read just now. One full launch has gone from
        first buy to a locked pool: on a 1.126 SOL curve the treasury took about 0.0206 SOL, near 1.8% of it, plus 1% of the
        token supply (
        <a href={SOURCES.meteoraReceipts.href} target="_blank" rel="noreferrer" className={linkClass}>
          every signature
        </a>
        ).
      </p>
    </div>
  );
}

/* ----------------------------------------------------------- the market -- */

export const MARKET_FACTS: { value: string; label: string; source: SourceKey }[] = [
  { value: "$3.24B", label: "tokenized stocks held onchain, up 10.7% in 30 days, across 4.33M holders", source: "rwa" },
  { value: "$15.6B", label: "of onchain tokenized-equity trading in September 2026, a record", source: "coindesk" },
  { value: "97%", label: "of cumulative tokenized-equity spot volume was on Solana (week to 31 May 2026)", source: "solShare" },
  { value: "$535M", label: "of tokenized equity on Solana at its high on 16 July 2026", source: "solValue" },
  { value: "₹32,297 cr", label: "put into Indian SIPs in August 2026, about $3.4B, from 10.02 crore accounts", source: "sip" },
  { value: "$7B", label: "SEBI's cap on Indian funds' overseas holdings, nearly used up; fund houses paused new international SIPs", source: "cap" },
];

export function MarketFacts() {
  return (
    <div>
      <ul className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {MARKET_FACTS.map((f) => (
          <li key={f.label} className="bg-surface p-6">
            <p className="tnum display text-3xl text-ink sm:text-4xl">{f.value}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">{f.label}</p>
            <a href={SOURCES[f.source].href} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2">
              {SOURCES[f.source].label} ↗
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 max-w-[90ch] text-xs leading-relaxed text-ink-3">
        Sources measure differently: rwa.xyz counts tokens distributed onchain, CoinDesk&rsquo;s wider definition puts
        tokenized stocks at $4.87B. The SIP figure is a habit, not a market Sheaf can reach today: Indian residents face a 30%
        tax and 1% TDS on crypto assets, and whether tokenized stocks fit the overseas remittance rules is not settled.
        Rupees at ₹95.5 to the dollar. Read {CHECKED}; also{" "}
        <a href={SOURCES.capSize.href} target="_blank" rel="noreferrer" className={linkClass}>
          {SOURCES.capSize.label}
        </a>
        .
      </p>
    </div>
  );
}

/* -------------------------------------------------------- who pays first -- */

export function Beachhead() {
  const gets = [
    ["Baskets under its own name", "It publishes the baskets, sets the creator fee (0–1%) and keeps it. That fee is its revenue share, paid by the protocol on every creation, with no invoice."],
    ["Monthly plans", "A plan into a basket in one approval, run by anyone when due, filled by competing fillers. The SIP its users already know, pointed at US stocks."],
    ["A filler it does not have to run", "Sheaf's filler fills its users' orders at up to 0.15% over fair, inside the band each buyer signs. The platform can run its own instead."],
    ["Its users, its checks", "The platform keeps the customer, the KYC and the country checks. The program does not need to know who anyone is."],
  ];
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[46ch] space-y-4 text-base leading-relaxed text-ink-2">
        <p>
          The first customer is not a retail buyer. It is a platform that already sells tokenized stocks to people outside
          the US: an exchange, a broker or a wallet with stock pages. It has the users, the licence and the checks; what it
          lacks is a way to sell a theme as one position, or a monthly plan into one.
        </p>
        <p>
          Sheaf is that, as a module. The platform earns the creator fee on its baskets. Sheaf earns the {pct(PROTOCOL_FEE_BPS)} protocol fee
          on every share created, the filler margin where its filler fills, and a monthly service fee for running the filler,
          the plan keeper and the pages, priced with the first pilot.
        </p>
        <p className="text-sm text-ink-3">
          This is not hypothetical demand: at least one Indian exchange already lists tokenized US stocks on spot (
          <a href={SOURCES.mudrex.href} target="_blank" rel="noreferrer" className={linkClass}>
            Mudrex
          </a>
          ). Sheaf has no agreement with any platform yet.
        </p>
      </div>
      <ul className="grid gap-px self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
        {gets.map(([title, body]) => (
          <li key={title} className="bg-surface p-6">
            <h3 className="display text-lg text-ink">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CreatorSide() {
  const rows = [
    ["Creator fee", `0–${pct(MAX_CREATOR_FEE_BPS)} of every creation in their basket, in new shares, for as long as it exists`],
    ["Launch market", `${CREATOR_CURVE_SHARE}% of the curve's trading fees and half of the locked pool's fees`],
    ["Prediction market", "Creator fees on a \"will it beat SPY this week?\" market on Panta, if they open one"],
    ["What it costs them", "Nothing to publish beyond Solana's rent; the recipe is fixed once written"],
  ];
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[46ch] space-y-4 text-base leading-relaxed text-ink-2">
        <p>
          Creators are the supply side and the cheapest distribution there is: a research community or a newsletter that
          publishes a basket earns on what its own audience buys, so it brings them. Sheaf pays nothing to acquire those holders.
        </p>
        <p className="text-sm text-ink-3">
          Honestly, the fee is small: at {pct(DEFAULT_CREATOR_FEE_BPS)}, a creator earns $10,000 on $4M of shares created. It
          pays a community that already has an audience, not a stranger starting from zero.
        </p>
      </div>
      <dl className="divide-y divide-line self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-1 px-5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-4">
            <dt className="text-ink-3">{term}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ------------------------------------------------- what has to be proven -- */

export const PROVE_NEXT: { what: string; target: string; how: string }[] = [
  { what: "People who aren't us", target: "30 outside wallets by 18 October; 500 in eight weeks", how: "Counted on the ledger, which lists every team and test wallet and leaves them out." },
  { what: "They come back", target: "130 wallets with two actions a week apart, in eight weeks", how: "Retention, not sign-ups. A plan with two filled runs counts." },
  { what: "Plans that keep running", target: "75 plans with at least two filled runs", how: "Read from plan runs and fills on the ledger." },
  { what: "Fills that land", target: "Fill rate of 95% or more, median under 60 seconds", how: "Filled orders over filled plus returned, from the program's events." },
  { what: "Baskets by others", target: "40 baskets published by wallets that aren't ours", how: "Creation events by non-team creators." },
  { what: "One platform", target: "A written pilot with a platform that sells tokenized stocks", how: "Non-binding is fine. It is the payer the model depends on." },
  { what: "Fill cost at size, on mainnet prices", target: "Under 0.25% round trip at $5,000 for liquid baskets", how: `Measured today at ${(MEASURED_ROUTE[2].roundTripBps / 100).toFixed(3)}% for five big US names. Thin pre-IPO tokens will cost far more.` },
  { what: "Safe to hold real money", target: "Audit, multisig upgrade authority, legal opinion", how: "Before any real token sits in a vault. Not before." },
];

export function ProveNext() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line">
      <ul className="divide-y divide-line bg-surface">
        {PROVE_NEXT.map((row, i) => (
          <li key={row.what} className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[2.5rem_14rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-5">
            <span className="tnum text-bind">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-ink">{row.what}</span>
            <span className="tnum text-ink">{row.target}</span>
            <span className="text-ink-3">{row.how}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------- trust and regulation -- */

export function TrustStance() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
      <div>
        <p className="max-w-[64ch] text-base leading-relaxed text-ink-2">
          Sheaf runs on devnet and testnets with test money, and no real token will sit in a vault before an outside audit,
          a multisig upgrade authority and a legal opinion. A token backed by a basket of securities can look like a fund to
          a regulator, so on mainnet Sheaf would serve people outside the US only, through platforms that carry their own
          licence and checks, and may limit who can create or hold shares. xStocks are not offered in the US, the UK, Canada
          or Australia, and a basket inherits that. Their issuer keeps the power to pause transfers and move tokens, as
          regulated tokenized stocks do; the program accepts those powers only from known issuers, and if one used them on a
          vault, the shares backed by it would be short. That risk is written on every page that matters, not hidden in a
          footnote.
        </p>
        <Sources keys={["kraken"]} />
      </div>
      <dl className="divide-y divide-line self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-sm">
        {[
          ["Where it runs", "Devnet and five EVM testnets, at mainnet prices"],
          ["Real money", "None, and none before audit and legal opinion"],
          ["Who, on mainnet", "Non-US users only, through licensed platforms"],
          ["Price oracle", "None, for creating, redeeming or buying"],
          ["Issuer powers", "Accepted only from known issuers; disclosed"],
          ["Fees after creation", "Fixed per basket; no instruction changes them"],
        ].map(([term, value]) => (
          <div key={term} className="grid gap-1 px-5 py-3.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
            <dt className="text-ink-3">{term}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
