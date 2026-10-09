import Link from "next/link";
import feeReceipts from "@/lib/fee-receipts.json";
import { MAX_CREATOR_FEE_BPS, SHARE_DECIMALS, SITE_URL, explorerTx } from "@/lib/config";
import { getInrRate, fxNote, rupees } from "@/lib/fx";
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
 * Server-only: some parts read the site's API and a local receipts file, so import
 * it from server components (pages), never from a "use client" file.
 */

/* ------------------------------------------------------------------ rates -- */

/** Protocol fee: share of every creation, minted to the treasury. Fixed per basket at creation. */
export const PROTOCOL_FEE_BPS = 10;
/** The day the program started writing the protocol fee into new baskets (devnet upgrade). */
export const PROTOCOL_FEE_SINCE = "9 Oct 2026";
/** The composer's default creator fee. The creator can pick anything from 0 to the ceiling. */
export const DEFAULT_CREATOR_FEE_BPS = 25;
/** The house filler aims to fill at this much over fair. A policy of Sheaf's filler, not a program rule. */
export const HOUSE_FILLER_MARGIN_BPS = 15;
/** Nor does it ever fill more than this over fair (or under fair, buying a sale): past it the order runs out and the money goes back. */
export const HOUSE_MAX_OVER_FAIR_BPS = 100;
/** A dollar order's auction runs from this far above the fair share count to this far below it. So does a sell order's, in dollars. */
export const AUCTION_BAND_BPS = 200;
/**
 * A plan run's band, by cadence, around the plan's last fill, and the owner's
 * hard limits around the price when the plan was opened, which no run may pass.
 * The same numbers as CADENCE in components/plan-form.tsx (a client file, so
 * they are repeated here rather than imported into server components).
 */
export const PLAN_BANDS = [
  { cadence: "monthly", bandBps: 1500, hardBps: 2500 },
  { cadence: "weekly", bandBps: 1000, hardBps: 1500 },
  { cadence: "demo pace", bandBps: 200, hardBps: 1000 },
] as const;
/** What a lone filler that waits for the floor of a monthly run takes over the plan's last fill: 1 / (1 - 15%) - 1. */
export const MONTHLY_WORST_CASE_PCT = (1 / (1 - PLAN_BANDS[0].bandBps / 1e4) - 1) * 100;
/**
 * The house filler's margin as measured before the timing fix of 10 Oct 2026:
 * the median of the fills its log recorded, and how many house fills the ledger
 * had then. The log was added late in the build, and the chain records the
 * trade, not the filler's price, so the fills before it carry no figure.
 */
export const MEASURED_BEFORE_FIX = { bps: 23, fills: 8, houseFills: 88, date: "10 Oct 2026" } as const;
/** The house filler leaves orders and plan runs below this many dollars to other fillers. */
export const HOUSE_MIN_DOLLARS = 5;
/** Meteora's cut of every launch-curve and graduated-pool trading fee, then the split of what is left. */
export const METEORA_PROTOCOL_SHARE = 20;
export const TREASURY_CURVE_SHARE = 40;
export const CREATOR_CURVE_SHARE = 40;

/** The date every outside figure on the business page was read. */
export const CHECKED = "9 Oct 2026";

/** 10 → "0.10%", 100 → "1%". */
export const pct = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2)}%`;

/** "±15% monthly, ±10% weekly, ±2% at demo pace": a plan run's band, or the owner's hard limits. */
export const planBandsText = (key: "bandBps" | "hardBps") =>
  PLAN_BANDS.map((b) => `±${pct(b[key])} ${b.cadence === "demo pace" ? "at demo pace" : b.cadence}`).join(", ");

/** One date format for the page: "9 Oct 2026, 10:39 UTC". */
export function utcStamp(d: Date, withTime = true): string {
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (!withTime) return day;
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/* ---------------------------------------------------------------- sources -- */

export const SOURCES = {
  rwa: { label: "rwa.xyz, tokenized stocks", href: "https://app.rwa.xyz/stocks" },
  coindesk: {
    label: "CoinDesk, stablecoins and tokenized assets, October 2026",
    href: "https://www.coindesk.com/research/stablecoins-and-tokenized-assets-report-october-2026",
  },
  forkast: { label: "Forkast, September tokenized-equity volume by venue", href: "https://forkast.news/?p=131481" },
  solVolume: {
    label: "Pluang, citing Coincu: Solana tokenized-stock volume in September",
    href: "https://pluang.com/en/news-feed/volume-perdagangan-saham-token-solana-capai-rekor-44-miliar",
  },
  solSupply: {
    label: "Solana Compass, Solana tokenized equity at $684M",
    href: "https://solanacompass.com/news/solana-tokenized-equity-wallets-pass-900000-as-supply-reaches-684m-all-time-high",
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
  fx: { label: "open.er-api.com, USD/INR", href: "https://open.er-api.com/v6/latest/USD" },
  smallcaseFees: {
    label: "smallcase, fees and charges",
    href: "https://www.smallcase.com/learn/smallcase-fees-and-charges/",
  },
  arkk: { label: "Pensions & Investments, ARKK", href: "https://etf.pionline.com/fund/ARKK" },
  botz: { label: "Global X, BOTZ", href: "https://www.globalxetfs.com/funds/botz/" },
  ici: {
    label: "ICI, fund fees in 2025",
    href: "https://www.ici.org/news-release/mutual-fund-and-etf-fees-remained-near-historic-lows-in-2025",
  },
  // Jupiter's current DCA (the Recurring API is deprecated): "Each round worth >= $10, currently", at least 2 rounds;
  // transfer-fee or transfer-hook mints rejected unless whitelisted. Read 10 Oct 2026.
  jupDca: { label: "Jupiter, DCA", href: "https://developers.jup.ag/docs/trigger/dca" },
  // "Limit orders and recurring orders each carry a 0.1% flat fee." Read 10 Oct 2026.
  jupFees: { label: "Jupiter, fees on recurring orders", href: "https://docs.jup.ag/user-docs/global/mobile/fees" },
  jupIntegrator: { label: "Jupiter, adding integrator fees", href: "https://developers.jup.ag/docs/ultra/add-fees-to-ultra" },
  krakenBundles: { label: "Kraken, Crypto + xStocks Bundles", href: "https://blog.kraken.com/product/bundles/introducing-crypto-xstocks-bundles" },
  bitgetBasket: { label: "Bitget Wallet, Basket", href: "https://web3.bitget.com/wallet/basket-wallet" },
  weave: { label: "HackQuest, Weave", href: "https://hackquest.io/projects/Weave" },
  basketSol: { label: "Basket", href: "https://basketsolana.xyz/" },
  indexa: { label: "Indexa", href: "https://indexafund.com/" },
  // Glider: $4M led by a16z CSX (BusinessWire, Apr 2025); with Ondo, custom tokenized-stock portfolios rebalanced
  // automatically (Cointelegraph, 23 Mar 2026); "$1" stock investments on BNB and Solana, 0.30% automated fee on
  // traded volume (Glider blog, 23 Jun 2026). Checked 10 Oct 2026.
  glider: { label: "Glider, investing in US stocks from India", href: "https://blog.glider.fi/how-to-invest-in-us-stocks-from-india/" },
  gliderOndo: {
    label: "Cointelegraph, Glider and Ondo launch custom tokenized-stock portfolios",
    href: "https://cointelegraph.com/news/glider-ondo-launch-platform-for-custom-tokenized-stock-portfolios",
  },
  gliderA16z: {
    label: "BusinessWire, Glider raises $4M led by a16z CSX",
    href: "https://www.businesswire.com/news/home/20250415391753/en/Glider-Raises-%244-Million-Strategic-Funding-Round-Led-by-a16z-CSX-to-Transform-Crypto-Portfolio-Management",
  },
  // Securitize Stocks on Solana, announced 8 Oct 2026: 12 US equities as UCC Article 8 security entitlements,
  // onboarding and KYC/AML checks, eligible investors only, USDC settlement. Checked 10 Oct 2026.
  securitize: {
    label: "Solana Compass, Securitize Stocks on Solana",
    href: "https://solanacompass.com/news/securitize-launches-securitize-stocks-on-solana-12-us-equities-as-11-backed-security-entitlements",
  },
  // Portfi, "The S&P 500 of Solana": onchain baskets of tokenized stocks, gold and crypto into the user's wallet,
  // $10 packs; accepted to MagicBlock Founders Camp (KuCoin, 14 Sep 2026). Checked 10 Oct 2026.
  portfi: { label: "KuCoin, Portfi joins MagicBlock Founders Camp", href: "https://www.kucoin.com/news/trends/SOL/6aa80f397d10fa0007cd76d9" },
  backpackSec: { label: "Crypto Briefing, Backpack's tokenized stocks on Solana", href: "https://cryptobriefing.com/backpack-tokenized-blackrock-blk-solana/" },
  stockLaunch: {
    label: "Solana Compass, Meteora StockLaunch",
    href: "https://solanacompass.com/news/meteora-opens-token-launches-paired-with-backpack-issued-stocks-via-stocklaunch",
  },
  founder: { label: "GitHub, RohanGlitched", href: "https://github.com/RohanGlitched" },
  jupStocks: { label: "Jupiter, tokenized stocks", href: "https://docs.jup.ag/user-docs/trade/spot/tokenized-stocks" },
  phantom: {
    label: "Altcoin Buzz, Phantom adds xStocks",
    href: "https://www.altcoinbuzz.io/cryptocurrency-news/phantom-wallet-integrates-xstocksfi-for-stock-trading/",
  },
  solflare: {
    label: "Solflare, SPYx",
    href: "https://www.solflare.com/stocks/sp500-xstock/XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W/",
  },
  bstocks: {
    label: "The Defiant, bStocks on BNB Chain",
    href: "https://thedefiant.io/news/tradfi-and-fintech/binance-launches-bstocks-tokenized-us-equities-24-7-onchain-trading",
  },
  mudrex: { label: "Mudrex, AMDB issued under bStocks", href: "https://mudrex.com/learn/how-to-buy-amd-stock-in-india/" },
  vdaTax: {
    label: "Decrypt, India keeps its crypto tax",
    href: "https://decrypt.co/356601/no-relief-for-crypto-investors-as-india-retains-current-crypto-tax-in-budget-2026",
  },
  usTax: {
    label: "Motilal Oswal, tax on US stocks for Indian investors",
    href: "https://www.motilaloswal.com/learning-centre/2026/8/tax-on-us-stocks-for-indian-investors-a-complete-guide-to-capital-gains-tcs-dtaa-and-ftc",
  },
  symmetry: { label: "Symmetry, fees", href: "https://docs.symmetry.fi/concepts/fees-and-oracles" },
  meteora: { label: "Meteora, DBC fees", href: "https://docs.meteora.ag/core-products/dbc/fees/overview" },
  meteoraReceipts: {
    label: "Sheaf, the Meteora lifecycle on devnet",
    href: "https://github.com/RohanGlitched/sheaf/blob/main/docs/meteora.md",
  },
  kraken: { label: "Kraken, xStocks availability", href: "https://support.kraken.com/articles/xstocks-availability" },
} as const;

type SourceKey = keyof typeof SOURCES;

const linkClass = "text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink";

/** A short "Sources:" line under a table or a block. */
export function Sources({ keys, note }: { keys: SourceKey[]; note?: React.ReactNode }) {
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
    { value: pct(PROTOCOL_FEE_BPS), label: "of every share created, to Sheaf", note: `Solana baskets created since ${PROTOCOL_FEE_SINCE}, and dollar fills on the EVM v3 desks, paid to a separate treasury key` },
    { value: `0–${pct(MAX_CREATOR_FEE_BPS)}`, label: "to the basket's creator", note: `the composer suggests ${pct(DEFAULT_CREATOR_FEE_BPS)}` },
    {
      value: pct(HOUSE_FILLER_MARGIN_BPS),
      label: "what Sheaf's filler aims for",
      note: `never more than ${pct(HOUSE_MAX_OVER_FAIR_BPS)}; any filler may fill anywhere inside the band the buyer signs: ±${pct(AUCTION_BAND_BPS)} on a dollar order, ${planBandsText("bandBps")} on a plan run`,
    },
    { value: "0%", label: "protocol fee to hold, redeem or sell", note: "no yearly fee; redeem for the stocks or sell for dollars" },
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

/**
 * The class that stretches the last cell of a gap-px grid across whatever is
 * left of its row, so an odd count never leaves a grey empty cell. Literal class
 * names, so Tailwind keeps them.
 */
const SPAN_BASE: Record<number, string> = { 1: "", 2: "col-span-2", 3: "col-span-3" };
const SPAN_SM: Record<number, string> = { 1: "sm:col-span-1", 2: "sm:col-span-2", 3: "sm:col-span-3" };
const SPAN_LG: Record<number, string> = { 1: "lg:col-span-1", 2: "lg:col-span-2", 3: "lg:col-span-3", 4: "lg:col-span-4", 5: "lg:col-span-5" };
function fillRow(i: number, n: number, cols: { base?: number; sm?: number; lg?: number }): string {
  if (i !== n - 1) return "";
  const left = (c: number) => c - ((n - 1) % c);
  return [
    cols.base ? SPAN_BASE[left(cols.base)] : "",
    cols.sm ? SPAN_SM[left(cols.sm)] : "",
    cols.lg ? SPAN_LG[left(cols.lg)] : "",
  ]
    .filter(Boolean)
    .join(" ");
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
    how: "Minted as new shares and accrued in the basket; anyone can send the claim, which pays only the treasury. The vault still receives the full recipe, so what a share redeems for is unchanged. Written into the basket when it is created and can never change.",
    status: `Live on devnet since ${PROTOCOL_FEE_SINCE} for Solana baskets created from then on; baskets created before it carry none, for good. On EVM, dollar orders and plan runs through the v3 desks pay 0.10% to a separate treasury key the server does not hold (the earlier v2 desks paid it to the house key); in-kind EVM mints carry none, because the v1 baskets are immutable.`,
  },
  {
    line: "Creator fee",
    rate: `0 to ${pct(MAX_CREATOR_FEE_BPS)} of shares created`,
    payer: "Whoever creates shares in that basket",
    receiver: "The basket's creator",
    how: `Chosen once when the basket is created (the composer suggests ${pct(DEFAULT_CREATOR_FEE_BPS)}) and paid in new shares, never out of the vault.`,
    status: "Live on devnet and on the five EVM testnets. Sheaf earns it only on the baskets it creates itself.",
  },
  {
    line: "Filler margin",
    rate: `Any filler: anywhere inside the band the buyer signed: ±${pct(AUCTION_BAND_BPS)} around fair on a dollar order; on a plan run ${planBandsText("bandBps")} around the plan's last fill. Sheaf's filler: ${pct(HOUSE_FILLER_MARGIN_BPS)} over fair, never more than ${pct(HOUSE_MAX_OVER_FAIR_BPS)}.`,
    payer: "The buyer of a dollar order or a plan run",
    receiver: "Whichever filler delivers the stocks first",
    how: `A dollar order's auction offers a share count that starts ${pct(AUCTION_BAND_BPS)} above fair and falls to the buyer's floor, ${pct(AUCTION_BAND_BPS)} below it, over 90 seconds. A plan run's starts its band above the plan's last fill and falls to its band below over 30 minutes (4 at demo pace), never past the owner's hard limits (${planBandsText("hardBps")}). Sheaf's filler fills at the second the dollars cover the stocks at fair plus ${pct(HOUSE_FILLER_MARGIN_BPS)}, and never more than ${pct(HOUSE_MAX_OVER_FAIR_BPS)} over fair: past that it lets the order run out and the dollars go back. Another filler can fill earlier for less, and the buyer gets that better count; one that waits longer earns more, up to the floor the buyer signed. With no other filler, one that waits for the floor of a monthly run takes up to ${MONTHLY_WORST_CASE_PCT.toFixed(1)}% over the last fill; the plan form says so.`,
    status: `Sheaf's ${pct(HOUSE_FILLER_MARGIN_BPS)} and its ${pct(HOUSE_MAX_OVER_FAIR_BPS)} cap are policies of its filler, not program rules. It leaves orders under $${HOUSE_MIN_DOLLARS} to others and fills on live Jupiter prices only, never on a fallback or stale one. Measured before the ${MEASURED_BEFORE_FIX.date} timing fix: a median ${pct(MEASURED_BEFORE_FIX.bps)} over ${MEASURED_BEFORE_FIX.fills} fills. Anyone can run a filler; the reference code is in the repository.`,
  },
  {
    line: "Launch markets",
    rate: `${TREASURY_CURVE_SHARE}% of curve and graduated-pool fees, 1% at graduation, 1% of supply`,
    payer: "Traders of a basket's launch token on Meteora",
    receiver: `Sheaf's treasury; the creator gets another ${CREATOR_CURVE_SHARE}% and Meteora keeps ${METEORA_PROTOCOL_SHARE}%`,
    how: "Meteora takes its share of every trading fee first and the rest is split evenly, on the curve and in the permanently locked pool it graduates into. At graduation the treasury also takes a 1% migration fee and 1% of the token's supply.",
    status: "Live on devnet. A launch token is its own market and is not a basket share.",
  },
  {
    line: "Monthly plans",
    rate: "Free to open and to run",
    payer: "Nobody, beyond each run's own dollar order",
    receiver: "—",
    how: "Each run is a dollar order inside the plan's own band (see the filler margin above), so the protocol fee, the creator fee and the filler's margin apply to every run exactly as to any other order. Whoever sends a due run gets back the small account deposit it paid to place the order.",
    status: "Live on devnet.",
  },
  {
    line: "Holding and redeeming",
    rate: "Free",
    payer: "—",
    receiver: "—",
    how: "No yearly fee and no exit fee. Redeeming burns shares and returns the stocks themselves, rounded down, for Solana's network fee.",
    status: "Live. No yearly fee will be added without legal advice first.",
  },
  {
    line: "Selling for dollars",
    rate: `No protocol fee. Any filler: anywhere inside the seller's ±${pct(AUCTION_BAND_BPS)} band. Sheaf's filler pays fair less ${pct(HOUSE_FILLER_MARGIN_BPS)}, never less than fair less ${pct(HOUSE_MAX_OVER_FAIR_BPS)}.`,
    payer: "The seller, through the auction",
    receiver: "Whichever filler takes the shares first",
    how: `A sell order is the dollar order run backwards: the dollars offered start ${pct(AUCTION_BAND_BPS)} above fair and fall to the seller's floor over 90 seconds. The filler redeems the shares for the stocks and sells them.`,
    status: "Live on devnet since 9 Oct 2026.",
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
                <td className="tnum max-w-[22ch] px-4 py-4 text-bind">{row.rate}</td>
                <td className="px-4 py-4 text-ink-2">{row.payer}</td>
                <td className="px-4 py-4 text-ink-2">{row.receiver}</td>
                <td className="max-w-[38ch] px-4 py-4 text-ink-2">{row.how}</td>
                <td className="max-w-[28ch] px-4 py-4 text-ink-3">{row.status}</td>
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

/** Rounds parts to cents so they add up to exactly `total` (largest remainder). */
function centsThatSum(parts: number[], total: number): number[] {
  const want = Math.round(total * 100);
  const raw = parts.map((p) => p * 100);
  const floors = raw.map(Math.floor);
  let left = want - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map((c) => c / 100);
}

/**
 * One dollar order into a basket with the suggested creator fee, filled by Sheaf's
 * own filler at its margin. Same arithmetic as the program: the stocks delivered
 * are worth the dollars less the filler's margin; the shares they create are split
 * once, with creator and protocol fees floored together and the protocol's part
 * floored on its own (fee_split). Shown to the cent, rounded so the parts add up.
 */
export function OrderSplit({ order = 1000, creatorBps = DEFAULT_CREATOR_FEE_BPS }: { order?: number; creatorBps?: number }) {
  const atFair = order / (1 + HOUSE_FILLER_MARGIN_BPS / 1e4);
  const feesTogether = atFair * ((creatorBps + PROTOCOL_FEE_BPS) / 1e4);
  const protocolExact = atFair * (PROTOCOL_FEE_BPS / 1e4);
  const [buyer, creator, protocol, filler] = centsThatSum(
    [atFair - feesTogether, feesTogether - protocolExact, protocolExact, order - atFair],
    order,
  );
  const routeCost = Math.round(atFair * (MEASURED_ROUTE[1].roundTripBps / 2 / 1e4) * 100) / 100;
  const fees = [
    { label: "Creator", value: creator, color: "var(--color-gain)" },
    { label: "Filler", value: filler, color: "var(--color-ink-3)" },
    { label: "Sheaf", value: protocol, color: "var(--color-bind)" },
  ];
  const feeTotal = Math.round((creator + filler + protocol) * 100) / 100;
  const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-7">
      <p className="text-sm text-ink-2">
        A {usd(order)} dollar order into a basket with a {pct(creatorBps)} creator fee, filled by Sheaf&rsquo;s filler
      </p>
      <div className="mt-5 flex h-12 overflow-hidden rounded-[var(--radius-control)]" aria-hidden>
        <div className="flex items-center bg-vault px-4 text-sm text-vault-ink" style={{ width: `${(buyer / order) * 100}%` }}>
          <span className="tnum">{usd(buyer)} of backed shares to the buyer</span>
        </div>
        <div className="flex-1 bg-bind" />
      </div>
      <p className="mt-6 text-xs text-ink-3">
        The other {usd(feeTotal)}, drawn {Math.round(order / feeTotal)} times larger
      </p>
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
      <p className="tnum mt-4 text-xs text-ink-3">
        {usd(buyer)} + {usd(creator)} + {usd(filler)} + {usd(protocol)} = {usd(buyer + creator + filler + protocol)}
      </p>
      <figcaption className="mt-4 text-xs leading-relaxed text-ink-3">
        To the cent, rounded so the parts add up. The filler&rsquo;s {usd(filler)} is gross: buying five big US stocks through
        Jupiter cost about {usd(routeCost)} at this size when we measured it, so it keeps about {usd(filler - routeCost)} before
        Solana&rsquo;s network fees. In a basket with no creator fee the buyer keeps {usd(buyer + creator)}.
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
      <p className="border-b border-line px-5 py-4 text-sm text-ink-2">What a filler pays to buy the stocks, measured</p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="px-3 py-3 font-normal sm:px-5">Order</th>
            <th className="px-3 py-3 text-right font-normal sm:px-5">Round trip</th>
            <th className="hidden px-5 py-3 text-right font-normal sm:table-cell">One way, about</th>
            <th className="px-3 py-3 text-right font-normal sm:px-5">Left of {pct(HOUSE_FILLER_MARGIN_BPS)}</th>
          </tr>
        </thead>
        <tbody>
          {MEASURED_ROUTE.map((r) => (
            <tr key={r.size} className="border-t border-line">
              <td className="tnum px-3 py-3 text-ink sm:px-5">${r.size.toLocaleString("en-US")}</td>
              <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-5">{(r.roundTripBps / 100).toFixed(3)}%</td>
              <td className="tnum hidden px-5 py-3 text-right text-ink-2 sm:table-cell">{(r.roundTripBps / 200).toFixed(3)}%</td>
              <td className="tnum px-3 py-3 text-right text-ink sm:px-5">{((HOUSE_FILLER_MARGIN_BPS - r.roundTripBps / 2) / 100).toFixed(3)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-5 py-4 text-xs leading-relaxed text-ink-3">
        An equal-weight basket of Apple, Microsoft, NVIDIA, Alphabet and Amazon xStocks on Solana mainnet. Each leg was quoted
        through Jupiter with USDC in and straight back out, through this site&rsquo;s fill-cost endpoint; nothing was
        executed. Read {CHECKED}. Thin pre-IPO tokens cost far more to route.
      </p>
    </div>
  );
}

/* ------------------------------------------------------- holder's cost -- */

type CostRow = { route: string; each: string; yearly: string; note: string; ours?: boolean };

const SHEAF_ALL_IN = PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS + HOUSE_FILLER_MARGIN_BPS;
const SMALLCASE_SIP_FEE = 10;
const SMALLCASE_LUMP_FEE = 100;
const SMALLCASE_CAP = 0.015;
const GST = 0.18;

/** smallcase's fee on one buy: the flat fee or 1.5% of the amount, whichever is lower, plus 18% GST. */
const smallcaseFee = (amount: number, flat: number) => Math.min(flat, amount * SMALLCASE_CAP) * (1 + GST);
/** The SIP size above which smallcase's flat fee is cheaper than Sheaf's per-run fee (`bps`). */
const crossover = (bps: number) => (SMALLCASE_SIP_FEE * (1 + GST)) / (bps / 1e4);

/** What a holder pays on Sheaf, beside the routes they would otherwise take. Per buy and per year, never "once". */
export async function HolderCost() {
  const fx = await getInrRate();
  const lump = 100 * fx.rate;
  const pctOf = (fee: number, amount: number) => `${((fee / amount) * 100).toFixed(2)}%`;
  const rows: CostRow[] = [
    {
      route: "Sheaf, one dollar order",
      each: `about ${pct(SHEAF_ALL_IN)}`,
      yearly: "0%",
      note: `${pct(PROTOCOL_FEE_BPS)} protocol, ${pct(DEFAULT_CREATOR_FEE_BPS)} suggested creator fee, and the ${pct(HOUSE_FILLER_MARGIN_BPS)} Sheaf's filler aims for (never more than ${pct(HOUSE_MAX_OVER_FAIR_BPS)}). Before the ${MEASURED_BEFORE_FIX.date} timing fix its fills measured a median ${pct(MEASURED_BEFORE_FIX.bps)}, so ${pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS + MEASURED_BEFORE_FIX.bps)} all in. With no creator fee, about ${pct(PROTOCOL_FEE_BPS + HOUSE_FILLER_MARGIN_BPS)}.`,
      ours: true,
    },
    {
      route: "Sheaf, a monthly plan of ₹500 or ₹5,000",
      each: `about ${pct(SHEAF_ALL_IN)} every run`,
      yearly: "0%",
      note: "Every run is a new dollar order, so it pays the same fees every time, at any size.",
      ours: true,
    },
    {
      route: "Sheaf, in kind",
      each: pct(PROTOCOL_FEE_BPS + DEFAULT_CREATOR_FEE_BPS),
      yearly: "0%",
      note: "For someone who already holds the stocks: no filler and no route cost.",
      ours: true,
    },
    {
      route: "Sheaf, selling a share for dollars",
      each: `about ${pct(HOUSE_FILLER_MARGIN_BPS)}`,
      yearly: "0%",
      note: `No protocol fee. Sheaf's filler pays fair less ${pct(HOUSE_FILLER_MARGIN_BPS)}; any filler may pay more. Or redeem for the stocks themselves, free.`,
      ours: true,
    },
    {
      route: "smallcase, a ₹500 SIP",
      each: `${pctOf(smallcaseFee(500, SMALLCASE_SIP_FEE), 500)} every run`,
      yearly: "0%",
      note: `₹10 capped at 1.5% (₹7.50), plus 18% GST: ₹${smallcaseFee(500, SMALLCASE_SIP_FEE).toFixed(2)} a run. Broker charges on top.`,
    },
    {
      route: "smallcase, a ₹5,000 SIP",
      each: `${pctOf(smallcaseFee(5000, SMALLCASE_SIP_FEE), 5000)} every run`,
      yearly: "0%",
      note: "₹10 plus 18% GST, ₹11.80 a run. Broker charges on top. Indian stocks, not US.",
    },
    {
      route: `smallcase, a ${rupees(lump)} ($100) lump sum`,
      each: pctOf(smallcaseFee(lump, SMALLCASE_LUMP_FEE), lump),
      yearly: "0%",
      note: "₹100 per buy order plus 18% GST, capped at 1.5%.",
    },
    {
      route: "A thematic ETF (ARKK, BOTZ)",
      each: "spread + brokerage",
      yearly: "0.68–0.75%",
      note: "Expense ratios charged every year. The fund rebalances for you; a Sheaf basket never does.",
    },
    {
      route: "A broad index ETF, or an issuer token like SPYx",
      each: "spread + brokerage",
      yearly: "0.14% average",
      note: "Cheaper than Sheaf for a broad index. If that is what you want, buy it; a Sheaf basket can hold SPYx too.",
    },
    {
      route: "Five tokens on Jupiter's DCA",
      each: "0.1% of what you spend",
      yearly: "0%",
      note: "Cheaper than Sheaf per run. Each round must be at least $10, and a plan at least two rounds, so five stocks a month start at $50; a Sheaf plan starts at $5, into one token. You hold five positions and keep the weights yourself, and tokens with a transfer fee, such as PreStocks, are refused unless Jupiter whitelists them.",
    },
    {
      route: "Five tokens bought by hand on Jupiter",
      each: `about ${(MEASURED_ROUTE[0].roundTripBps / 200).toFixed(2)}% + network fees`,
      yearly: "0%",
      note: "Cheapest of all. Five positions to keep in balance yourself.",
    },
  ];
  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface lg:hidden">
        {rows.map((row) => (
          <li key={row.route} className={`px-4 py-4 text-sm leading-relaxed ${row.ours ? "bg-raised" : ""}`}>
            <p className={row.ours ? "text-bind" : "text-ink"}>{row.route}</p>
            <p className="tnum mt-1 text-ink">
              {row.each} · {row.yearly} a year
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
              <th className="px-4 py-3 text-right font-normal">Each buy or sale</th>
              <th className="px-4 py-3 text-right font-normal">Each year</th>
              <th className="px-4 py-3 font-normal">What is in it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.route} className={`border-t border-line align-top ${row.ours ? "bg-raised" : ""}`}>
                <th scope="row" className={`px-4 py-3 text-left font-normal ${row.ours ? "text-bind" : "text-ink"}`}>{row.route}</th>
                <td className="tnum px-4 py-3 text-right text-ink">{row.each}</td>
                <td className="tnum px-4 py-3 text-right text-ink-2">{row.yearly}</td>
                <td className="max-w-[56ch] px-4 py-3 text-ink-3">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <p className="max-w-[60ch] text-sm leading-relaxed text-ink-2">
          On a monthly plan, Sheaf is cheaper than smallcase below about {rupees(crossover(SHEAF_ALL_IN))} a run and dearer
          above it ({rupees(crossover(PROTOCOL_FEE_BPS + HOUSE_FILLER_MARGIN_BPS))} in a basket with no creator fee). Both
          charge nothing a year, where a thematic ETF charges every year.
        </p>
        <p className="max-w-[60ch] text-sm leading-relaxed text-ink-2">
          For an Indian resident the larger cost is tax, not fees: tokenized stocks are taxed as crypto at 30% plus 1% TDS,
          against 12.5% on US shares held over two years through the overseas remittance route. Sheaf does not offer this to
          Indian residents today.
        </p>
      </div>
      <Sources
        keys={["smallcaseFees", "arkk", "botz", "ici", "jupDca", "jupFees", "vdaTax", "usTax", "fx"]}
        note={`Rupees at ${fxNote(fx)}. Fees only: none of these counts taxes, the token's premium to the listed share, or a broker's own charges.`}
      />
    </div>
  );
}

/* ---------------------------------------------------- what a share is -- */

/** What a Sheaf share is and is not, before anyone compares it with a fund. */
export function ShareFacts() {
  const facts = [
    ["A fixed basket", "Like a unit investment trust, the recipe is set once and never changes. Nobody rebalances it, adds a name or drops one: you hold exactly what you chose, and nobody trades your holdings."],
    ["Backed in kind", "Every share is backed by the stocks in its own vault, created and redeemed for them by anyone. No price oracle is read."],
    ["Two ways out", "Redeem for the stocks themselves at any time, or sell the share for dollars: a sell order is an auction where the dollars you receive start 2% above fair and fall to your own floor 2% below over 90 seconds, and any filler can take it. No protocol fee on a sale."],
    ["In your own wallet", "A share is a token you hold yourself, not a line in someone's database. That is why it matters to wallets, and much less to a custodial exchange."],
  ];
  return (
    <ul className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
      {facts.map(([title, body], i) => (
        <li key={title} className={`bg-surface p-6 ${fillRow(i, facts.length, { sm: 2, lg: 4 })}`}>
          <h3 className="display text-lg text-ink">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------ unit economics -- */

const PER_MILLION = 1_000_000;

/**
 * What covers a team of four at the fees live today (private model v4, month 36,
 * fixed costs incl. infra and amortised audits; Sheaf's filler working under a
 * licensed partner who keeps half its margin): about $30M of shares created a
 * month. Held in baskets: ~$260M while money still comes in at the base case's pace
 * (creations ~11.6% of assets a month) and ~$1.0B at steady state, when creations
 * only replace the ~3% a month that leaves. From the protocol fee alone: ~$54M a
 * month, ~$1.8B at steady state. Arithmetic, not a forecast.
 */
export const BREAK_EVEN = { flowM: 30, growingM: 260, steadyB: 1.0, protocolOnlyFlowM: 54, protocolOnlySteadyB: 1.8 } as const;
/** Distributed value of xStocks, the one listed-stock issuer the mainnet build accepts, and of all tokenized stocks (rwa.xyz, 9 Oct 2026), $M. */
export const XSTOCKS_SUPPLY_M = 588;
export const TOKENIZED_STOCKS_M = 3240;

/** What Sheaf earns on $1M of shares created, by who created the basket and who filled. */
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
    { name: "Sold back for dollars, Sheaf fills", protocol: 0, filler: fillerNet, creator: 0 },
  ];
  const usd = (v: number) => (v === 0 ? "—" : `$${Math.round(v).toLocaleString("en-US")}`);
  const flows = [1e6, 1e7, 1e8];
  // An illustration, not a forecast: protocol fee on all of it, four in five bought with dollars, Sheaf filling seven in ten of those.
  const blended = protocol + 0.8 * 0.7 * fillerNet;
  // The same, with half the filler margin to a licensed partner of record, as the break-even figure assumes.
  const blendedHalf = protocol + (0.8 * 0.7 * fillerNet) / 2;
  const halfOf = (c: (typeof cases)[number]) => c.protocol + c.filler / 2 + c.creator;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
      <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
        <p className="border-b border-line px-5 py-4 text-sm text-ink-2">Sheaf&rsquo;s take on $1M of shares created, or sold back</p>
        {/* A phone gets one row per path, with the answer first; five columns do not fit at 390 px. */}
        <ul className="divide-y divide-line text-sm sm:hidden">
          {cases.map((c) => (
            <li key={c.name} className="px-5 py-3">
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-ink-2">{c.name}</span>
                <span className="tnum shrink-0 text-ink">{usd(c.protocol + c.filler + c.creator)}</span>
              </p>
              <p className="tnum mt-1 text-xs text-ink-3">
                protocol {usd(c.protocol)} · filler {usd(c.filler)} · creator {usd(c.creator)}
              </p>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto sm:block">
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
          ({(routeOneWay / 100).toFixed(3)}%), before network fees and the cost of holding stock between fills. Creator: Sheaf
          earns the {pct(DEFAULT_CREATOR_FEE_BPS)} only on baskets it creates; on anyone else&rsquo;s it goes to them. The
          protocol fee arrives as basket shares; turning it into dollars means redeeming them and selling the stocks.
          These rows credit Sheaf the whole filler margin. With half of it to a licensed partner of record, as the
          break-even figure beside them assumes, the rows where Sheaf fills come to{" "}
          {cases
            .filter((c) => c.filler > 0)
            .map((c) => usd(halfOf(c)))
            .join(", ")}
          .
        </p>
      </div>
      <div className="space-y-6">
        <div className="rounded-[var(--radius-panel)] border border-line bg-raised p-5 sm:p-6">
          <p className="text-sm text-ink">What covers the costs</p>
          <p className="tnum display mt-3 text-3xl text-ink">about ${BREAK_EVEN.flowM}M</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            of shares created a month pays for a team of four at the fees live today, with Sheaf&rsquo;s filler working under a
            licensed partner who keeps half its margin. From the protocol fee alone it would take about ${BREAK_EVEN.protocolOnlyFlowM}M.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Held in baskets, that is about ${BREAK_EVEN.growingM}M while new money keeps arriving, and about ${BREAK_EVEN.steadyB}B
            once creations only replace holders who leave. All the xStocks in existence today come to ${XSTOCKS_SUPPLY_M}M. So
            Sheaf only works as a standard across several issuers and chains, not on one issuer&rsquo;s catalogue.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ink-3">Arithmetic on fixed rates and a lean cost base, not a forecast.</p>
        </div>
        <div className="rounded-[var(--radius-panel)] border border-line bg-raised p-5 sm:p-6">
          <p className="text-sm text-ink">At different sizes, illustrated</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            Protocol fee on every creation, four in five bought with dollars, and Sheaf filling seven in ten of those. In
            brackets, with half the filler margin to a partner of record, the basis the break-even figure uses.
          </p>
          <dl className="mt-4 divide-y divide-line text-sm">
            {flows.map((f) => (
              <div key={f} className="flex items-baseline justify-between gap-4 py-3">
                <dt className="tnum text-ink-2">${(f / 1e6).toLocaleString("en-US")}M created a month</dt>
                <dd className="tnum text-right text-ink">
                  ${Math.round((f / PER_MILLION) * blended).toLocaleString("en-US")} a month
                  <span className="text-ink-3"> (${Math.round((f / PER_MILLION) * blendedHalf).toLocaleString("en-US")})</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- live numbers -- */

type Json = Record<string, unknown>;

async function getJson(pathname: string, timeoutMs: number): Promise<unknown> {
  const origin = process.env.NODE_ENV === "development" ? "http://localhost:3900" : SITE_URL;
  try {
    const res = await fetch(`${origin}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type FillStats = {
  orders: number | null;
  fills: number | null;
  returned: number | null;
  dollarsFilled: number | null;
  fillRate: number | null;
  medianSecsToFill: number | null;
};

export type LedgerStats = {
  actions: number | null;
  wallets: number | null;
  outsideWallets: number | null;
  outsideActions: number | null;
  baskets: number | null;
  outsideBaskets: number | null;
  plans: number | null;
  outsidePlans: number | null;
  orders: number | null;
  fills: number | null;
  /** Fills delivered by a filler that is not ours. */
  outsideFills: number | null;
  dollarsFilled: number | null;
  returned: number | null;
  fillRate: number | null;
  medianSecsToFill: number | null;
  /** One-off dollar orders and plan runs, separately. */
  dollar: FillStats;
  plan: FillStats;
  /** The same, orders of $5 or more only: the one fill-rate definition the page shows. */
  dollar5: FillStats;
  plan5: FillStats;
  /** Only orders whose buyer is not ours. */
  outsideDollar: FillStats;
  outsidePlan: FillStats;
  /** Who delivered the fills. */
  byFiller: { house: number | null; second: number | null; outside: number | null };
  /** Sell orders for dollars. */
  sells: number | null;
  sellFills: number | null;
  sellFillRate: number | null;
  medianSecsToSell: number | null;
  /** What buyers and sellers actually paid Sheaf's filler over fair: median bps and the number of fills behind it. */
  realizedMarginBps: number | null;
  realizedSellMarginBps: number | null;
  realizedFills: number | null;
  /** Since the timing fix: measured at the second each fill executed. */
  landedMarginBps: number | null;
  landedFills: number | null;
  /** Logged before it, at the filler's own estimate. */
  earlierMarginBps: number | null;
  earlierFills: number | null;
  secondMarginBps: number | null;
  secondFills: number | null;
  /** Orders of $5 or more that filled: the number the target is about. */
  fillRateAtLeast5: number | null;
  fillRateAtLeast5Dollar: number | null;
  fillRateAtLeast5Plan: number | null;
  asOf: number | null;
};

const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const ratio = (v: unknown) => {
  const n = num(v);
  return n != null && n > 1 ? n / 100 : n;
};
const fillStats = (v: unknown): FillStats => {
  const o = obj(v);
  return {
    orders: num(o.orders),
    fills: num(o.fills),
    returned: num(o.returned),
    dollarsFilled: num(o.dollarsFilled),
    fillRate: ratio(o.fillRate),
    medianSecsToFill: num(o.medianSecsToFill),
  };
};

/** Reads `/api/ledger`'s `stats`. Anything missing stays null and renders as a dash. */
export function readLedgerStats(json: unknown): LedgerStats {
  const root = obj(json);
  const s = obj(root.stats);
  const byCause = obj(s.byCause);
  const outside = obj(s.outside);
  const byFiller = obj(s.fillsByFiller);
  return {
    actions: num(s.actions),
    wallets: num(s.wallets),
    outsideWallets: num(s.outsideWallets),
    outsideActions: num(s.outsideActions),
    baskets: num(s.baskets),
    outsideBaskets: num(s.outsideBaskets),
    plans: num(s.plans),
    outsidePlans: num(s.outsidePlans),
    orders: num(s.orders),
    fills: num(s.fills),
    outsideFills: num(s.outsideFills),
    dollarsFilled: num(s.dollarsFilled),
    returned: num(s.returned),
    fillRate: ratio(s.fillRate),
    medianSecsToFill: num(s.medianSecsToFill),
    dollar: fillStats(byCause.dollar),
    plan: fillStats(byCause.plan),
    dollar5: fillStats(obj(s.byCauseAtLeast5).dollar),
    plan5: fillStats(obj(s.byCauseAtLeast5).plan),
    outsideDollar: fillStats(outside.dollar),
    outsidePlan: fillStats(outside.plan),
    byFiller: { house: num(byFiller.house), second: num(byFiller.second), outside: num(byFiller.outside) },
    sells: num(s.sells),
    sellFills: num(s.sellFills),
    sellFillRate: ratio(s.sellFillRate),
    medianSecsToSell: num(s.medianSecsToSell),
    realizedMarginBps: num(obj(obj(s.realizedMarginBps).house).buyMedianBps) ?? num(obj(obj(s.realizedMarginBps).house).medianBps) ?? num(s.realizedMarginBps),
    realizedSellMarginBps: num(obj(obj(s.realizedMarginBps).house).sellMedianBps),
    realizedFills: num(obj(obj(s.realizedMarginBps).house).fills),
    landedMarginBps: num(obj(obj(obj(s.realizedMarginBps).house).landed).medianBps),
    landedFills: num(obj(obj(obj(s.realizedMarginBps).house).landed).fills),
    earlierMarginBps: num(obj(obj(obj(s.realizedMarginBps).house).earlier).medianBps),
    earlierFills: num(obj(obj(obj(s.realizedMarginBps).house).earlier).fills),
    secondMarginBps: num(obj(obj(s.realizedMarginBps).second).medianBps),
    secondFills: num(obj(obj(s.realizedMarginBps).second).fills),
    fillRateAtLeast5: ratio(s.fillRateAtLeast5),
    fillRateAtLeast5Dollar: ratio(obj(s.fillRateAtLeast5ByCause).dollar),
    fillRateAtLeast5Plan: ratio(obj(s.fillRateAtLeast5ByCause).plan),
    asOf: num(root.asOf),
  };
}

export type LaunchStats = {
  onCurve: number;
  graduated: number;
  solIn: number;
  unclaimedTreasurySol: number;
  outsideCreators: number;
  /** Distinct wallets that are not ours that traded a launch, when the feed reports it. */
  outsideTraders: number | null;
} | null;

/** Reads /api/launches, leaving out our QA baskets. A graduated launch counts once, as graduated. */
export function readLaunchStats(json: unknown): LaunchStats {
  const root = (json && typeof json === "object" ? json : {}) as Json;
  const list = Array.isArray(root.launches) ? (root.launches as Json[]) : null;
  if (!list) return null;
  const real = list.filter((l) => {
    const b = (l.basket ?? {}) as { address?: string; name?: string; symbol?: string; creator?: string };
    const live = l.open === true || l.graduated === true || l.migrated === true;
    return live && l.official !== false && l.test !== true && !isTestBasket({ address: b.address ?? "", name: b.name, symbol: b.symbol, creator: b.creator });
  });
  const grad = (l: Json) => l.graduated === true || l.migrated === true;
  const n0 = (v: unknown) => num(v) ?? 0;
  return {
    onCurve: real.filter((l) => !grad(l)).length,
    graduated: real.filter(grad).length,
    solIn: real.filter((l) => l.graduated !== true && l.migrated !== true).reduce((a, l) => a + n0(l.raisedSol ?? l.raised), 0),
    unclaimedTreasurySol: real.reduce((a, l) => a + n0(l.partnerFeesUnclaimedSol ?? l.partnerFeesSol ?? l.treasuryFeesSol), 0),
    outsideCreators:
      num(root.outsideLaunches) ??
      new Set(
        real
          .map((l) => (l.basket as { creator?: string } | undefined)?.creator)
          .filter((c): c is string => typeof c === "string" && !isTeamWallet(c)),
      ).size,
    outsideTraders: num(root.traders),
  };
}

const dash = "—";
const whole = (v: number | null) => (v == null ? dash : Math.round(v).toLocaleString("en-US"));
const secs = (v: number | null) => (v == null ? dash : `${Math.round(v)} s`);
const rate = (v: number | null) => (v == null ? dash : `${(v * 100).toFixed(1)}%`);
/** Finished orders: filled or returned. */
const finished = (f: FillStats) => (f.fills == null || f.returned == null ? dash : whole(f.fills + f.returned));

/**
 * The numbers that have to come from use, read from the site's own API when the
 * page renders (refreshed every two minutes). Anything the API does not answer
 * shows a dash, never a guess.
 */
export async function LiveNumbers() {
  const [ledgerJson, launchJson] = await Promise.all([getJson("/api/ledger", 9000), getJson("/api/launches", 12000)]);
  const l = readLedgerStats(ledgerJson);
  const launches = readLaunchStats(launchJson);
  const asOf = l.asOf ? new Date(l.asOf) : null;

  const fillerTotal = l.byFiller.house != null && l.byFiller.second != null ? l.byFiller.house + l.byFiller.second : null;
  const marginPct = (bps: number | null) => (bps == null ? dash : `${(bps / 100).toFixed(2)}%`);
  const cells: { label: string; value: string; note: string }[] = [
    {
      label: `Orders of $${HOUSE_MIN_DOLLARS} or more filled`,
      value: rate(l.fillRateAtLeast5),
      note: `of every finished order of $${HOUSE_MIN_DOLLARS} or more, one-off and plan runs together; target 95%. Smaller orders are left to other fillers by design.`,
    },
    {
      label: "Plans opened",
      value: whole(l.plans),
      note: "plans on the program, at any cadence",
    },
    {
      label: `One-off dollar orders of $${HOUSE_MIN_DOLLARS} or more`,
      value: rate(l.dollar5.fillRate ?? l.fillRateAtLeast5Dollar),
      note: `filled, ${whole(l.dollar5.fills)} of ${finished(l.dollar5)} finished; median ${secs(l.dollar5.medianSecsToFill)} to fill on a 90-second auction`,
    },
    {
      label: `Plan runs of $${HOUSE_MIN_DOLLARS} or more`,
      value: rate(l.plan5.fillRate ?? l.fillRateAtLeast5Plan),
      note: `filled, ${whole(l.plan5.fills)} of ${finished(l.plan5)} finished; median ${secs(l.plan5.medianSecsToFill)} on a 30-minute auction, by design`,
    },
    {
      label: "Orders filled, by filler",
      value: whole(fillerTotal),
      note: `${whole(l.byFiller.house)} by Sheaf's filler, ${whole(l.byFiller.second)} by our second filler, which runs the published code with its own key; any filler may compete`,
    },
    {
      label: "Sold back for dollars",
      value: rate(l.sellFillRate),
      note: `filled, ${whole(l.sellFills)} of ${whole(l.sells)} sell orders; median ${secs(l.medianSecsToSell)} on a 90-second auction`,
    },
    {
      label: "What buyers paid Sheaf's filler over fair",
      value: (l.landedFills ?? 0) > 0 ? marginPct(l.landedMarginBps) : marginPct(MEASURED_BEFORE_FIX.bps),
      note: `${
        (l.landedFills ?? 0) > 0
          ? `measured median over ${whole(l.landedFills)} ${l.landedFills === 1 ? "fill" : "fills"} since the ${MEASURED_BEFORE_FIX.date} timing fix, each at the second it executed. Before it: ${pct(MEASURED_BEFORE_FIX.bps)} over ${MEASURED_BEFORE_FIX.fills} fills`
          : `measured median over ${MEASURED_BEFORE_FIX.fills} fills before the ${MEASURED_BEFORE_FIX.date} timing fix, which now sends each fill just ahead of its break-even second; no fills measured since yet`
      }. Policy ${pct(HOUSE_FILLER_MARGIN_BPS)}, never more than ${pct(HOUSE_MAX_OVER_FAIR_BPS)}. Only fills the filler logged are measured (before the fix, ${MEASURED_BEFORE_FIX.fills} of the ${MEASURED_BEFORE_FIX.houseFills} it had made): the chain records the trade, not the filler's price, and the log began late${
        l.secondMarginBps != null ? `. Our second filler: ${marginPct(l.secondMarginBps)} over ${whole(l.secondFills)}` : ""
      }`,
    },
    { label: "Actions on the program", value: whole(l.actions), note: "every event the program emitted, as the ledger counts them; test dollars on devnet" },
  ];
  const launchCells: { label: string; value: string }[] = [
    { label: "Launch markets on the curve", value: launches ? String(launches.onCurve) : dash },
    { label: "Graduated to a locked pool", value: launches ? String(launches.graduated) : dash },
    { label: "SOL on open curves", value: launches ? launches.solIn.toFixed(3) : dash },
    { label: "Treasury fees not yet claimed, SOL", value: launches ? launches.unclaimedTreasurySol.toFixed(4) : dash },
  ];

  return (
    <div>
      <ul
        className={`grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line ${
          cells.length === 5 ? "lg:grid-cols-5" : cells.length === 6 ? "lg:grid-cols-3" : "lg:grid-cols-4"
        }`}
      >
        {cells.map((c, i) => (
          <li
            key={c.label}
            className={`p-5 sm:p-6 ${i === 0 ? "bg-surface" : "bg-page"} ${fillRow(i, cells.length, {
              base: 2,
              lg: cells.length === 5 ? 5 : cells.length === 6 ? 3 : 4,
            })}`}
          >
            <p className={`tnum display text-3xl sm:text-4xl ${i === 0 ? "text-bind" : "text-ink"}`}>{c.value}</p>
            <p className="mt-2 text-sm text-ink">{c.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{c.note}</p>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-ink">Launch markets on Meteora</p>
      <dl className={`mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-3 ${launchCells.length > 4 ? "lg:grid-cols-6" : "lg:grid-cols-4"}`}>
        {launchCells.map((c, i) => (
          <div key={c.label} className={`bg-page p-4 ${fillRow(i, launchCells.length, { base: 2, sm: 3, lg: launchCells.length > 4 ? 6 : 4 })}`}>
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
        (decoded from the program&rsquo;s own events) and the launch feed (read from the pool accounts), on devnet with test
        money{asOf ? `, at ${utcStamp(asOf)}` : ""}. Fill rates count finished orders of ${HOUSE_MIN_DOLLARS} or more, the smallest Sheaf&rsquo;s filler takes; smaller test orders are left to other fillers and come back by design. QA baskets are left out of the launch counts. A dash means the number
        could not be read just now. One launch has gone from first buy to a locked pool: on a 1.126 SOL curve the treasury took
        about 0.0206 SOL, near 1.8% of it, plus 1% of the token supply (
        <a href={SOURCES.meteoraReceipts.href} target="_blank" rel="noreferrer" className={linkClass}>
          every signature
        </a>
        ).
      </p>
    </div>
  );
}

/* ----------------------------------------------------- protocol receipts -- */

type FeeReceiptFile = { basket?: string; claims?: { signature: string; shares: number | string; at?: string | number }[] };

/** web/lib/fee-receipts.json, written when the treasury claims and bundled at build time. */
async function readReceipts(): Promise<FeeReceiptFile | null> {
  return feeReceipts as FeeReceiptFile;
}

type BasketRow = { address: string; name?: string; symbol?: string; creator?: string; protocolFeeBps?: number; protocolFeeAccrued?: string };

/**
 * The protocol fee, shown as it happens: which baskets carry it, how many fee
 * shares have accrued unclaimed, and every claim the treasury has made, each
 * linked to its transaction.
 */
export async function ProtocolFeeReceipts() {
  const [basketsJson, receipts] = await Promise.all([getJson("/api/baskets", 9000), readReceipts()]);
  const baskets = Array.isArray(basketsJson) ? (basketsJson as BasketRow[]) : null;
  const carrying = (baskets ?? []).filter((b) => (b.protocolFeeBps ?? 0) > 0 && !isTestBasket({ address: b.address, name: b.name, symbol: b.symbol, creator: b.creator }));
  const accrued = carrying.reduce((a, b) => a + Number(b.protocolFeeAccrued ?? 0), 0) / 10 ** SHARE_DECIMALS;
  const claims = receipts?.claims ?? [];
  const shares = (v: number | string) => {
    const n = typeof v === "string" ? Number(v) : v;
    // Raw units if it is a whole number above one share; otherwise already in shares.
    const s = Number.isInteger(n) && n >= 10 ** SHARE_DECIMALS / 100 ? n / 10 ** SHARE_DECIMALS : n;
    return s.toLocaleString("en-US", { maximumFractionDigits: 6 });
  };
  const when = (at?: string | number) => {
    if (at == null) return "";
    const d = typeof at === "number" ? new Date(at < 1e12 ? at * 1000 : at) : new Date(at);
    return Number.isNaN(d.getTime()) ? "" : utcStamp(d);
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <dl className="grid grid-cols-2 gap-px self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line">
        <div className="bg-surface p-5">
          <dd className="tnum display text-3xl text-bind">{baskets ? carrying.length : dash}</dd>
          <dt className="mt-1.5 text-xs leading-relaxed text-ink-3">
            {baskets && carrying.length === 1 ? "basket carries" : "baskets carry"} the {pct(PROTOCOL_FEE_BPS)} protocol fee
          </dt>
        </div>
        <div className="bg-surface p-5">
          <dd className="tnum display text-3xl text-ink">{baskets ? accrued.toLocaleString("en-US", { maximumFractionDigits: 6 }) : dash}</dd>
          <dt className="mt-1.5 text-xs leading-relaxed text-ink-3">fee shares accrued and not yet claimed</dt>
        </div>
      </dl>
      <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <p className="text-sm text-ink">Claims by the treasury</p>
        {claims.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">— None yet. The first claim will be listed here with its transaction.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line text-sm">
            {claims.map((c) => (
              <li key={c.signature} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5">
                <a href={explorerTx(c.signature)} target="_blank" rel="noreferrer" className={`tnum ${linkClass}`}>
                  {c.signature.slice(0, 8)}…{c.signature.slice(-6)} ↗
                </a>
                <span className="tnum text-ink">{shares(c.shares)} shares</span>
                <span className="text-xs text-ink-3">{when(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          {carrying.length > 0 ? (
            <>
              Carrying it:{" "}
              {carrying.map((b, i) => (
                <span key={b.address}>
                  <Link href={`/basket/${b.address}`} className={linkClass}>
                    {b.symbol ?? b.name ?? b.address.slice(0, 6)}
                  </Link>
                  {i < carrying.length - 1 ? ", " : ". "}
                </span>
              ))}
            </>
          ) : null}
          Baskets created before {PROTOCOL_FEE_SINCE} carry no protocol fee, for good, so the older baskets you see on the site
          pay the creator fee alone. Devnet shares, worth nothing.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- the market -- */

export const MARKET_FACTS: { value: string; label: string; source: SourceKey }[] = [
  { value: "$3.24B", label: "of tokenized stocks held onchain, up 10.7% in 30 days, across 4.33M holders", source: "rwa" },
  { value: "$15.6B", label: "of onchain tokenized-equity trading in September 2026, a record", source: "coindesk" },
  { value: "42%", label: "of that went through Robinhood ($6.57B); bStocks on BNB Chain did $5.42B, xStocks $2.11B", source: "coindesk" },
  { value: "18%", label: "of tokenized stocks held are xStocks ($588M of $3.24B), the one listed-stock issuer Sheaf's mainnet build accepts", source: "rwa" },
  { value: "$684M", label: "of tokenized equity on Solana by mid-September, in more than 900,000 wallets", source: "solSupply" },
  { value: "₹32,297 cr", label: "into Indian SIPs in August 2026, from 10.02 crore accounts: the monthly habit, at scale", source: "sip" },
];

export async function MarketFacts() {
  const fx = await getInrRate();
  const sipUsd = (32_297e7 / fx.rate / 1e9).toFixed(1);
  return (
    <div>
      <ul className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {MARKET_FACTS.map((f, i) => (
          <li key={f.label} className={`bg-surface p-6 ${fillRow(i, MARKET_FACTS.length, { sm: 2, lg: 3 })}`}>
            <p className="tnum display text-3xl text-ink sm:text-4xl">{f.value}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              {f.label}
              {f.source === "sip" ? ` (about $${sipUsd}B)` : ""}
            </p>
            <a href={SOURCES[f.source].href} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2">
              {SOURCES[f.source].label} ↗
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Trading has spread across venues and chains: in September Robinhood did $6.57B, bStocks on BNB Chain $5.42B and
          xStocks, the issuer Sheaf&rsquo;s Solana vaults hold, $2.11B. A basket standard has to sit where the stocks trade, which
          is why the same vault already runs on Robinhood Chain&rsquo;s testnet and four other EVM chains beside the Solana
          program. On Solana, every creation in a basket made since {PROTOCOL_FEE_SINCE} pays the 0.10% protocol fee; on EVM,
          dollar orders and plan runs through the v3 desks pay it to a separate treasury key, and in-kind mints don&rsquo;t.
        </p>
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">
          The SIP figure shows the habit, not a market Sheaf can reach today. India&rsquo;s fund route to US stocks is capped:
          SEBI&rsquo;s $7B overseas limit for mutual funds is nearly used up, and fund houses paused new international SIPs this
          year. Tokenized stocks are no answer for residents yet: they are taxed as crypto, and whether they fit the overseas
          remittance rules is not settled.
        </p>
      </div>
      <Sources
        keys={["cap", "capSize", "fx"]}
        note={`Sources measure differently: rwa.xyz counts tokens distributed onchain, and CoinDesk's wider count puts tokenized stocks at $4.87B. Rupees at ${fxNote(fx)}.`}
      />
    </div>
  );
}

/* -------------------------------------------------------- who pays first -- */

export function Beachhead() {
  const gets = [
    ["Themes its users hold themselves", "It lists single tokens today. With Sheaf it can offer a theme as one backed token in the user's own wallet, created and redeemed onchain, which is the thing a wallet cannot fake with a database row."],
    ["Monthly plans", "A plan into a basket in one approval, run by anyone when due, filled by any filler inside the plan's band. The habit of investing every month, pointed at US stocks."],
    ["A revenue share with no invoice", "It creates the baskets, sets the creator fee (0–1%) and keeps it on every share created in them, paid by the program. A planned integrator fee field adds a fee on its users' orders, 80% to the wallet."],
    ["Fills it doesn't have to run", "Sheaf's filler fills its users' orders aiming for 0.15% over fair and never more than 1%, inside the band each buyer signs. It can run its own filler or bring a market maker instead."],
  ];
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[46ch] space-y-4 text-base leading-relaxed text-ink-2">
        <p>
          The first customer is a non-custodial wallet or onchain front end that already lists xStocks for people outside the
          US. Phantom added xStocks in the wallet, Jupiter lists them on its stocks screen, and Solflare has a page for each
          one. Their users hold the tokens themselves, so a basket has to be a real token in a real vault, which is exactly
          what Sheaf is.
        </p>
        <p>
          A custodial exchange is a weaker fit, and we say so: it can build a basket out of its own ledger without a vault, and
          some already sell themes. Mudrex, for one, sells tokenized US stocks issued as bStocks on BNB Chain, which
          Sheaf&rsquo;s vaults cannot hold today.
        </p>
        <p>
          Sheaf earns the {pct(PROTOCOL_FEE_BPS)} protocol fee on every share created and the filler margin where its filler
          fills. The planned way a wallet earns more is an integrator fee field: the wallet sets its own fee on its users&rsquo;
          orders (our SDK would suggest 0.25%) and keeps 80% of it, and Sheaf keeps 20%, the split Jupiter uses for integrators. A monthly license applies
          only where Sheaf runs the pages and the plan keeper for a partner. Not built yet, and no agreement with any platform
          yet.
        </p>
        <p>
          The issuer is a partner too: every Sheaf share created is demand for the tokens in its vault, bought on the
          issuer&rsquo;s own markets.
        </p>
      </div>
      <div className="space-y-4">
        <ul className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
          {gets.map(([title, body]) => (
            <li key={title} className="bg-surface p-6">
              <h3 className="display text-lg text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
            </li>
          ))}
        </ul>
        <Sources keys={["phantom", "jupStocks", "solflare", "mudrex", "bstocks", "jupIntegrator"]} />
      </div>
    </div>
  );
}

export function CreatorSide() {
  const rows = [
    ["Creator fee", `0–${pct(MAX_CREATOR_FEE_BPS)} of every creation in their basket, in new shares, for as long as it exists`],
    ["Launch market", `${CREATOR_CURVE_SHARE}% of the curve's and the locked pool's trading fees`],
    ["Prediction market", "Creator fees on a \"will it beat SPY this week?\" market on Panta, if they open one"],
    ["What it costs them", "Nothing to create beyond Solana's rent; the recipe is fixed once written"],
  ];
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
      <div className="max-w-[46ch] space-y-4 text-base leading-relaxed text-ink-2">
        <p>
          Creators are the supply side and the cheapest distribution there is: a research community or a newsletter that
          creates a basket earns on what its own audience buys, so it brings them. Sheaf pays nothing to acquire those holders.
        </p>
        <p className="text-sm text-ink-3">
          Honestly, the fee is small: at {pct(DEFAULT_CREATOR_FEE_BPS)}, a creator earns $10,000 on $4M of shares created. And
          where selling a portfolio to the public needs a registration, as it does in India, a paid basket has to come from a
          registered creator or a licensed platform.
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
  { what: "The fee, paid by someone else", target: "Fee shares accrued from wallets outside the team, and a claim of them", how: "The first claim is shown above with its transaction." },
  { what: "People using it", target: "30 wallets outside the team by 18 October; 350 in eight weeks", how: "Counted on the ledger, with every team wallet left out." },
  { what: "They come back", target: "110 wallets with two actions a week apart, in eight weeks", how: "Retention, not sign-ups. A plan with two filled runs counts." },
  { what: "Plans that keep running", target: "50 plans from outside the team with at least two filled runs", how: "Read from plan runs and fills on the ledger." },
  { what: "Fills that land", target: `95% or more of orders of $${HOUSE_MIN_DOLLARS} or more filled; one-off orders in under 60 seconds`, how: "Plan runs are measured separately: their 30-minute auction is slower by design." },
  { what: "The margin, published", target: `What buyers and sellers actually paid Sheaf's filler, near its ${pct(HOUSE_FILLER_MARGIN_BPS)} policy`, how: "Read from the fills against fair at the moment of filling, shown under Numbers so far." },
  { what: "More than one issuer", target: "Ondo and Backpack accepted beside xStocks, so a basket can mix issuers", how: "Today the mainnet build covers about 18% of tokenized stocks held." },
  { what: "One platform", target: "A written reply from a wallet or front end that lists xStocks", how: "Even \"send the SDK\". It is the payer the model depends on." },
  { what: "Fill cost at size, on mainnet prices", target: "Under 0.25% round trip at $5,000 for liquid baskets", how: `Measured today at ${(MEASURED_ROUTE[2].roundTripBps / 100).toFixed(3)}% for five big US names.` },
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

/* ------------------------------------------------------------- founder -- */

/** Who built it. */
export function FounderLine() {
  return (
    <p className="text-sm leading-relaxed text-ink-3">
      Built by Rohan Borade, solo, in India.{" "}
      <a href={SOURCES.founder.href} target="_blank" rel="noreferrer" className={linkClass}>
        GitHub ↗
      </a>
    </p>
  );
}

/* --------------------------------------------------- nearby products -- */

/** Baskets that already exist near Sheaf, from each one's own page, and where Sheaf differs. */
export const NEARBY: { name: string; what: string; differs: string; source: SourceKey; more?: SourceKey[] }[] = [
  {
    name: "Glider, with Ondo",
    what: "Custom portfolios of tokenized US stocks (Ondo's, since March 2026), with weightings kept automatically on a cadence you choose; stock investments from $1 on BNB Chain and Solana, 0.30% of traded volume when automated. Backed by a $4M round led by a16z CSX.",
    differs: "The closest funded rival, and the better retail product today. Glider rebalances a portfolio you hold position by position; a Sheaf share is one backed token for a fixed basket, redeemable by anyone for the stocks, that can be held or routed like any other token, with no rebalancing and no yearly fee.",
    source: "glider",
    more: ["gliderOndo", "gliderA16z"],
  },
  {
    name: "Kraken, Crypto + xStocks Bundles",
    what: "Themes such as Big Tech + Crypto inside Kraken's app, rebalanced automatically, no trading fee for Kraken+ members. Kraken owns Backed, the xStocks issuer.",
    differs: "A Sheaf share is one token in the holder's own wallet, redeemable by anyone for the stocks, across issuers. Kraken and Backed are a natural partner: every Sheaf share created is demand for xStocks.",
    source: "krakenBundles",
  },
  {
    name: "Bitget Wallet, Basket",
    what: "A self-custody basket interface on Solana and Robinhood's chain, with recurring buys; themed memecoin baskets today.",
    differs: "Bitget's basket is a screen over swaps. A Sheaf share is backed in kind in its own vault and can be redeemed or sold for dollars by auction.",
    source: "bitgetBasket",
  },
  {
    name: "Weave",
    what: "Thematic stock baskets on Robinhood Chain's testnet, with creators paid about 80% of a management fee.",
    differs: "Sheaf charges no yearly fee, runs buy and sell auctions and monthly plans, and is live on Solana and five EVM testnets. Weave's recurring creator income is a stronger hook for creators.",
    source: "weave",
  },
  {
    name: "Indexa",
    what: "A single token over a basket of tokenized stocks (MAG7, AI and others), redeemable for the stocks, USDC or SOL; entry and exit fees, a management fee and a protocol token ($INDX). Its site marked the indexes as previews, not yet launched onchain, when we read it.",
    differs: "The closest idea to Sheaf. Sheaf: no yearly fee, no protocol token, dollar entry and exit by auction with no oracle, monthly plans from $5, and vaults on six chains.",
    source: "indexa",
  },
  {
    name: "Portfi",
    what: "Billed as \"the S&P 500 of Solana\": onchain baskets of tokenized stocks, gold and crypto bought into the user's own wallet, sold as $10 packs whose basket is picked by a random roll. Accepted to MagicBlock's Founders Camp in September 2026.",
    differs: "Portfi buys the assets into your wallet one by one; a Sheaf basket is one token backed in its own vault, chosen by you, and redeemable for the stocks.",
    source: "portfi",
  },
  {
    name: "Basket (basketsolana.xyz)",
    what: "One redeemable token over several Solana tokens; the baskets on its page are crypto (AI, DePIN, Solana, memes, staking). A tokenized-stock index has been reported, but we could not find it on its page.",
    differs: "The same primitive. Sheaf applies it to tokenized stocks, checks each issuer's powers, and runs a dollar path that reads no oracle.",
    source: "basketSol",
  },
  {
    name: "Backpack Securities",
    what: "An issuer, not a basket: about 200 tokenized US stocks on Solana, each designed to be redeemable one for one for the share.",
    differs: "A supplier Sheaf could hold, not a rival: once its keys are accepted, a Sheaf basket could mix Backpack stocks with xStocks. Not yet.",
    source: "backpackSec",
  },
  {
    name: "Securitize Stocks",
    what: "An issuer, launched on Solana on 8 Oct 2026: twelve US stocks (Apple, Microsoft, NVIDIA and others), each a security entitlement to a real share, for eligible investors after onboarding and identity checks, settled in USDC.",
    differs: "A supplier, but a permissioned one: a token only checked holders may hold cannot sit in a vault anyone can redeem from. Sheaf cannot hold it as built.",
    source: "securitize",
  },
  {
    name: "Meteora StockLaunch",
    what: "Launch tokens on a bonding curve quoted in a Backpack stock; creators set a 0–50% fee that holders receive in the stock.",
    differs: "Beside Sheaf's launch markets, not its baskets: a StockLaunch token is priced in a stock, a Sheaf launch token from a backed basket's value. Neither token is a backed share.",
    source: "stockLaunch",
  },
];

export function NearbyProducts() {
  return (
    <div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
        {NEARBY.map((n) => (
          <li key={n.name} className="grid gap-2 px-5 py-4 text-sm leading-relaxed lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
            <span>
              <a href={SOURCES[n.source].href} target="_blank" rel="noreferrer" className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2">
                {n.name} ↗
              </a>
              {n.more?.map((k) => (
                <a key={k} href={SOURCES[k].href} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2">
                  {SOURCES[k].label} ↗
                </a>
              ))}
            </span>
            <p className="text-ink-2">{n.what}</p>
            <p className="text-ink-3">{n.differs}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 max-w-[90ch] text-xs leading-relaxed text-ink-3">
        From each product&rsquo;s own page or the coverage linked, read {CHECKED} (Glider, Portfi and Securitize on 10 Oct
        2026). Where Sheaf sits: the self-custody, multi-issuer version, one backed
        token per basket, no yearly fee. Cesto, Peaks, Symmetry and issuer ETF tokens are compared on{" "}
        <Link href="/method#compare" className={linkClass}>
          How it works
        </Link>
        .
      </p>
    </div>
  );
}

/* -------------------------------------------------- trust and regulation -- */

export function TrustStance() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
      <div className="space-y-4">
        <p className="max-w-[64ch] text-base leading-relaxed text-ink-2">
          Sheaf runs on devnet and testnets with test money, and no real token will sit in a vault before an outside audit,
          a multisig upgrade authority and a legal opinion. A token backed by a basket of securities can look like a fund to
          a regulator, so on mainnet Sheaf would serve people outside the US only, through platforms that carry their own
          license and checks, and may limit who can create or hold shares. xStocks are not offered in the US, the UK, Canada
          or Australia, and a basket inherits that. Their issuer keeps the power to pause transfers and move tokens, as
          regulated tokenized stocks do; the program accepts those powers only from known issuers, and if one used them on a
          vault, the shares backed by it would be short.
        </p>
        <p className="max-w-[64ch] text-base leading-relaxed text-ink">
          On mainnet, licensed market makers and partner platforms fill the orders and carry the license. Sheaf runs the
          protocol.
        </p>
        <p className="max-w-[64ch] text-base leading-relaxed text-ink-2">
          A Sheaf share would itself likely be a regulated instrument in the EU and elsewhere. It launches only inside a
          licensed partner&rsquo;s offering, after a legal opinion. Which jurisdiction comes first is still to be decided.
        </p>
        <p className="max-w-[64ch] text-base leading-relaxed text-ink-2">
          Today the mainnet build accepts two issuers&rsquo; keys: xStocks and PreStocks, and PreStocks stay out of a first
          mainnet release. That is about 18% of tokenized stocks held (xStocks, $588M of $3.24B). Ondo, the largest issuer, and
          Backpack are next. Until then, an xStocks freeze would pause redemption of every basket holding the frozen token.
        </p>
        <Sources keys={["kraken", "rwa"]} />
      </div>
      <dl className="divide-y divide-line self-start overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-sm">
        {[
          ["Where it runs", "Devnet and five EVM testnets, at mainnet prices"],
          ["Real money", "None, and none before audit and legal opinion"],
          ["Who, on mainnet", "Non-US users only, through licensed platforms"],
          ["Who fills, on mainnet", "Licensed market makers and partner platforms"],
          ["Price oracle", "None, for creating, redeeming or buying"],
          ["Issuer powers", "Accepted only from known issuers; disclosed"],
          ["Issuers accepted, mainnet build", "xStocks and PreStocks; Ondo and Backpack next"],
          ["Launch jurisdiction", "To be decided, with a licensed partner"],
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
