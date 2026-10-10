import type { Metadata } from "next";
import Link from "next/link";
import {
  MAX_COMPONENTS,
  MAX_CREATOR_FEE_BPS,
  SHARE_DECIMALS,
  SHEAF_PROGRAM_ID,
  WRITE_CLUSTER,
  explorerAddress,
  explorerTx,
} from "@/lib/config";
import { PlanSheaf } from "@/components/plan-sheaf";
import { FEATURED_LAUNCH, PRESET_URL } from "@/lib/dbc";
import { FeeTable } from "@/components/business-case";
import { fetchBasketAt, type Basket } from "@/lib/sheaf";
import { stockForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { quantity, shortAddress } from "@/lib/format";
import { BasketLaunch } from "@/components/launch-market";
import { Anatomy } from "@/components/home-anatomy";
import { Keys } from "@/components/home-ledgers";
import preset from "@/lib/meteora-preset.json";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Seven steps from a list of companies to a token you can hold, buy or sell for dollars and buy every month, plus the two markets beside it, each linked to the transaction, account or data that proves it.",
};

export const revalidate = 300;

/** The running example: The Big Five, the basket the home page leads with. */
const EXAMPLE = "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";
/** A sale of shares for dollars, filled on devnet. */
const EXAMPLE_SELL_TX =
  "MmvsWDKyrLZzvDEdM7cedYhoM9PEdNyMnyUra8AbEt7aDjJA5DxsbZPJRP181G7hADeXzivh4bCW4diUu8a1Sen";
/** The launch this page shows: the one the home page features (IDXA), on the current curve. */
const LAUNCH_EXAMPLE = FEATURED_LAUNCH.basket;
const LAUNCH_EXAMPLE_POOL = FEATURED_LAUNCH.info.pool;
const GRADUATION = preset.graduationMultipleOfNav;
const FIRST_GRADUATION = preset.previous.graduationMultipleOfNav;
const OPEN_FEE = preset.fees.antiSnipe.startingFeeBps / 100;
const SETTLED_FEE = preset.fees.antiSnipe.endingFeeBps / 100;
const FEE_MINUTES = preset.fees.antiSnipe.totalDurationSeconds / 60;
const FIRST_OPEN_FEE = preset.previous.antiSnipe.startingFeeBps / 100;

/** The Big Five: the basket whose question /predict leads with. */
const PREDICT_EXAMPLE = "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";

const EXAMPLE_MINT_TX =
  "4ej9mpPfVwzWeSDg5Ftf8pDxbmMWhPsYBv7CjhpYGX3WRMm6kWRF9Mxt9WptgW23qzH7rfMsiKNLr4Wyz92DHHeA";

/** The same six steps, in the same words, as the home page's lifecycle. */
const STAGES = [
  { id: "recipe", title: "Write the recipe" },
  { id: "create", title: "Create shares in kind" },
  { id: "dollars", title: "Or buy with dollars" },
  { id: "sell", title: "Sell for dollars" },
  { id: "plans", title: "Then every month" },
  { id: "market", title: "Open a launch market" },
  { id: "predict", title: "Bet on it" },
];

/** Plainly, what the program cannot promise. */
const RISKS = [
  {
    title: "The issuers keep their own powers",
    body: "Real xStocks give their issuer power to pause transfers and to move tokens (a permanent delegate), as any regulated tokenized stock does. Sheaf accepts those powers only when they belong to a known issuer, and refuses them from anyone else, so a basket creator can never add a backdoor. If an issuer paused or took tokens held in a vault, the shares backed by them would be short. The devnet mirrors carry a subset of these extensions; the program's tests run against real xStock mints cloned from mainnet.",
  },
  {
    title: "Not everyone may hold xStocks",
    body: "xStocks are not offered to US persons and are restricted in some other countries, and PreStocks set their own terms. A basket that holds them inherits those limits, so a mainnet Sheaf would have to check where its users are before letting them in.",
  },
  {
    title: "Devnet is a rehearsal",
    body: "Prices, multipliers and liquidity are read from mainnet, but every vault today holds devnet mirrors of the real mints, worth nothing. On mainnet the vaults would hold the real tokens, and dollar orders would need fillers buying real xStocks. Today two fillers run, both ours: Sheaf's house filler, and a second filler running the published reference code with its own key. Both deliver mirrors.",
  },
  {
    title: "The program is not audited",
    body: "The program and the EVM contracts have their own test suites, but nobody outside has reviewed them. The upgrade key is a deploy wallet on devnet. It moves to a multisig before mainnet, so new issuers can be added to the allowlist; it will never be used to move funds.",
  },
  {
    title: "A basket of stocks may be a fund",
    body: "A token backed by a basket of securities can look like a fund or an ETF to a regulator, depending on the country. Sheaf has no license or legal opinion yet. Before mainnet it needs a legal structure or a licensed partner, and may have to limit who can create or hold shares.",
  },
  {
    title: "A launch token is not a share",
    body: "The launch market's token trades on a curve priced from the basket's value, but it is not redeemable for the stocks, and it can trade far above what the basket holds. Only a basket share is backed.",
  },
];

const GUARANTEES = [
  {
    title: "The program reads no price",
    body: "Backing is checked by the program itself: shares are created and redeemed against tokens, never against a price. Prices on this site, the house filler's quotes and Panta's resolution come from Jupiter and listed closes, outside the program.",
  },
  {
    title: "No edit button",
    body: "The recipe is written once: a fixed basket, like a unit investment trust. There is no manager, no rebalancing and no instruction that changes what a share holds. To change a recipe, create a new basket.",
  },
  {
    title: "Rounding favors holders",
    body: "Deposits round up and redemptions round down, so the vault can only ever hold at least what the shares claim.",
  },
  {
    title: "The fee never touches the vault",
    body: `Sheaf's 0.10% and the creator's fee, up to ${MAX_CREATOR_FEE_BPS / 100}%, are paid in new shares on each creation. The vault always receives the full recipe.`,
  },
  {
    title: "Anyone can create and redeem",
    body: "In a traditional fund that right belongs to a few authorized participants. Here it belongs to whoever holds the tokens.",
  },
  {
    title: "Buying with dollars, measured",
    body: "Every basket page measures what buying its stocks through Jupiter costs a filler, one way, for a $100 and a $1,000 order, from live mainnet quotes. Where that cost is above Sheaf's 0.15% margin, its filler waits deeper into the auction.",
  },
  {
    title: "A track record, not a promise",
    body: "Every basket shows what its recipe would have done over the past year against SPY, from the listed shares' own closes, with the deepest fall beside the return.",
  },
  {
    title: "A dollar order is an auction",
    body: "The program never prices it. The buyer sets the floor, fillers decide when to fill from their own quotes (Sheaf's filler uses Jupiter), and the vault still receives the real stocks.",
  },
  {
    title: "A plan can do one thing",
    body: "Opening a plan approves exactly its per-run amount for its runs. Anyone can run it when due; nobody, including Sheaf, can make it spend more or buy anything else.",
  },
  {
    title: "Everything is in the log",
    body: "The program emits an event for every creation, redemption, order, fill and plan run. The site decodes them on its server, at most 30 seconds old, and your browser decodes them itself if that fails. Anyone can run the same decoder against a public RPC.",
  },
  {
    title: "The same rules on every chain",
    body: "On the EVM chains the vault, the recipe and dollar orders are immutable contracts with verified source, holding Robinhood's own stock tokens where they exist.",
  },
  {
    title: "Verify it yourself",
    body: "Under every backing table are the two RPC calls that reproduce it: the share supply and each vault's balance. If the inequality holds, every share is backed.",
  },
];

/**
 * Sheaf beside the nearest products, from each one's own docs (checked 9 October 2026).
 * "Not stated" means we could not find it published, not that it is missing.
 */
const COMPARE_COLUMNS = [
  "Backing",
  "Who can publish a basket",
  "Redeem in kind",
  "How a dollar buy is priced",
  "Recurring plans",
  "Chains",
];

const COMPARE: { name: string; note?: string; href?: string; cells: string[] }[] = [
  {
    name: "Sheaf",
    note: "devnet and testnets",
    cells: [
      "In kind: the exact stocks, in the basket's onchain vault",
      "Anyone",
      "Yes, by anyone, at any time",
      "Fillers bid in an auction on share count; the program reads no price",
      "Yes, from $5 a run, one order for the whole basket",
      "Solana, plus five EVM testnets",
    ],
  },
  {
    name: "Cesto",
    note: "Colosseum Frontier winner",
    href: "https://docs.cesto.co/cesto/faq.md",
    cells: [
      "No basket token: you hold each asset in your own wallet",
      "Anyone can publish an idea; managed baskets go through a creator program",
      "Not needed: you already hold the assets",
      "One swap per asset at quoted prices, not atomic",
      "Not stated",
      "Solana",
    ],
  },
  {
    name: "Peaks",
    note: "Colosseum Frontier winner",
    href: "https://colosseum.com/arena/projects/explore/peaks",
    cells: ["Not stated", "Anyone, as agent-run portfolios", "Not stated", "Not stated", "Not stated", "Not stated"],
  },
  {
    name: "Symmetry",
    href: "https://docs.symmetry.fi/concepts/vaults",
    cells: [
      "In kind: a vault token over the tokens it holds",
      "Anyone; a creator and up to ten managers, who can rebalance",
      "Yes, burn for the underlying tokens",
      "Vault value and keeper auctions start from oracle prices",
      "Not stated",
      "Solana",
    ],
  },
  {
    name: "Kraken bundles",
    note: "Crypto + xStocks, since Apr 30 2026",
    href: "https://support.kraken.com/gb/articles/bundles-faq",
    cells: [
      "Held in your Kraken account, with Kraken as custodian",
      "Kraken only",
      "Unbundle into the holdings inside Kraken",
      "Bought at Kraken's prices; Kraken+ makes conversions fee-free",
      "Not stated; bundles auto-rebalance on Kraken's schedule",
      "Kraken; not offered in the US, UK, EEA, Canada or Australia",
    ],
  },
  {
    name: "Bitget Wallet Basket",
    href: "https://web3.bitget.com/wallet/basket-wallet",
    cells: [
      "Self-custody: you hold each token in your wallet",
      "Curated themes, with community voting",
      "Not needed: you already hold the tokens",
      "Swaps at market prices",
      "Automatic regular investments mentioned, details not stated",
      "Solana and Robinhood Chain; memecoin baskets",
    ],
  },
  {
    name: "Weave",
    note: "hackathon project",
    href: "https://hackquest.io/projects/Weave",
    cells: [
      "Not stated",
      "Creators publish thematic stock baskets",
      "Not stated",
      "Not stated",
      "Not stated",
      "Robinhood Chain, per its listing; deployment not confirmed",
    ],
  },
  {
    name: "Basket",
    note: "basketsolana.xyz",
    href: "https://basketsolana.xyz",
    cells: [
      "In kind: a share token over crypto tokens it holds; no stocks",
      "Not stated",
      "Yes, for your portion of the underlying",
      "Not stated",
      "Not stated",
      "Solana",
    ],
  },
  {
    // Jupiter's DCA, which superseded the deprecated Recurring API: "Each round worth >= $10, currently", at least
    // 2 rounds, transfer-fee or transfer-hook mints rejected unless whitelisted (developers.jup.ag/docs/trigger/dca);
    // "recurring orders each carry a 0.1% flat fee" (docs.jup.ag/user-docs/global/mobile/fees). Checked 10 Oct 2026.
    name: "Jupiter DCA",
    note: "a plan of single-token orders",
    href: "https://developers.jup.ag/docs/trigger/dca",
    cells: [
      "No basket token: each order buys one token into your wallet",
      "You set up your own orders",
      "Not needed: you hold the tokens",
      "Swaps at the route's price; 0.1% per round",
      "Yes, at least $10 a round and 2 rounds: five stocks a month start at $50, as five positions. Mints with a transfer fee or hook, such as PreStocks, are refused unless whitelisted",
      "Solana",
    ],
  },
  {
    // Glider: custom tokenized-stock portfolios with Ondo, weightings kept automatically (Cointelegraph, 23 Mar 2026);
    // "$1" on BNB and Solana, "0.30% automated and 0.50% manual fees" on traded volume (Glider blog, 23 Jun 2026);
    // $4M round led by a16z CSX (BusinessWire, Apr 2025). Checked 10 Oct 2026.
    name: "Glider",
    note: "with Ondo; a16z CSX-backed",
    href: "https://blog.glider.fi/how-to-invest-in-us-stocks-from-india/",
    cells: [
      "No basket token: you hold each stock token, in a portfolio Glider keeps weighted",
      "You build your own portfolio",
      "Not needed: you hold the tokens",
      "Swaps; 0.30% of traded volume automated, 0.50% manual",
      "Automatic rebalancing on a cadence you choose; from $1",
      "BNB Chain and Solana for stocks",
    ],
  },
  {
    // Indexa, read from its site's bundle in round 6 (the page renders client-side); marked as previews then.
    name: "Indexa",
    note: "indexes marked as previews when read",
    href: "https://indexafund.com/",
    cells: [
      "One token over a basket of tokenized stocks (MAG7, AI and others)",
      "Not stated",
      "Yes, for the stocks, USDC or SOL",
      "Entry and exit fees, plus a management fee",
      "Not stated",
      "Not stated; it redeems for SOL",
    ],
  },
  {
    // Portfi, "The S&P 500 of Solana": baskets of tokenized stocks, gold and crypto into the user's wallet, $10 packs
    // with a random roll; MagicBlock Founders Camp (KuCoin, 14 Sep 2026). Checked 10 Oct 2026.
    name: "Portfi",
    note: "MagicBlock Founders Camp",
    href: "https://www.kucoin.com/news/trends/SOL/6aa80f397d10fa0007cd76d9",
    cells: [
      "No basket token: the assets go to your wallet",
      "Portfi's baskets; a $10 pack rolls which one you get",
      "Not needed: you hold the assets",
      "$10 packs; pricing not stated",
      "Not stated",
      "Solana",
    ],
  },
  {
    name: "Issuer ETF tokens",
    note: "e.g. xStocks SPYx, QQQx",
    href: "https://docs.xstocks.fi/docs/issuance-and-redemption",
    cells: [
      "One token per ETF, backed 1:1 by the ETF share in offchain custody",
      "The issuer only",
      "Through the issuer, after KYC, to a whitelisted wallet",
      "Issued at the underlying's market price; otherwise traded on DEXs",
      "Not stated",
      "Ethereum, Solana, BNB Chain, Arbitrum and others",
    ],
  },
];

function Stage({
  n,
  id,
  title,
  on,
  proof,
  visual,
  children,
}: {
  n: number;
  id: string;
  title: string;
  on: string;
  proof?: { label: string; href: string };
  visual: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="grid scroll-mt-24 gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16"
    >
      <div className="max-w-[46ch]">
        <p className="flex items-baseline gap-4">
          <span className="display tnum text-5xl text-bind">{n}</span>
          <span className="text-xs text-ink-3">{on}</span>
        </p>
        <h2 className="display mt-4 text-title text-ink">{title}</h2>
        <div className="mt-5 space-y-4 text-base leading-relaxed text-ink-2">
          {children}
        </div>
        {proof && (
          <a
            href={proof.href}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-block text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            {proof.label} ↗
          </a>
        )}
      </div>
      <div className="min-w-0 self-center">{visual}</div>
    </section>
  );
}

function AuctionVisual({ sell = false }: { sell?: boolean } = {}) {
  // Shares the buyer receives over the auction: from 2% above fair to 2% below.
  const W = 520, H = 260, pad = 36;
  const y = (v: number) => pad + ((1.03 - v) / 0.06) * (H - 2 * pad);
  const x = (t: number) => pad + t * (W - 2 * pad);
  return (
    <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={sell ? "Dollars offered for the shares fall from 2% above fair to 2% below over the auction; a filler takes it near fair" : "Shares offered fall from 2% above fair to 2% below over the auction; a filler takes it near fair"}>
        <line x1={pad} x2={W - pad} y1={y(1)} y2={y(1)} stroke="var(--color-line-strong)" strokeDasharray="4 4" />
        <text x={W - pad} y={y(1) - 8} textAnchor="end" fontSize="13" fill="var(--color-ink-3)">{sell ? "fair value at mainnet prices" : "fair count at mainnet prices"}</text>
        <line x1={x(0)} y1={y(1.02)} x2={x(1)} y2={y(0.98)} stroke="var(--color-bind)" strokeWidth="3" strokeLinecap="round" />
        <circle cx={x(0.55)} cy={y(1.02 - 0.04 * 0.55)} r="7" fill="var(--color-gain)" />
        <text
          x={sell ? x(0.55) - 12 : x(0.55) + 12}
          y={sell ? y(1.02 - 0.04 * 0.55) + 28 : y(1.02 - 0.04 * 0.55) + 22}
          textAnchor={sell ? "end" : "start"}
          fontSize="13"
          fill="var(--color-ink)"
        >
          {sell ? "a filler pays and takes the shares" : "a filler delivers the stocks"}
        </text>
        <text x={x(0)} y={y(1.02) - 12} fontSize="13" fill="var(--color-ink-2)">+2%</text>
        <text x={x(1)} y={y(0.98) + 22} textAnchor="end" fontSize="13" fill="var(--color-ink-2)">{sell ? "−2%, the seller’s floor" : "−2%, the buyer’s floor"}</text>
        <text x={x(0)} y={H - 6} fontSize="12" fill="var(--color-ink-3)">0s</text>
        <text x={x(1)} y={H - 6} textAnchor="end" fontSize="12" fill="var(--color-ink-3)">90s</text>
      </svg>
      <figcaption className="mt-2 text-sm text-ink-3">
        {sell ? "Dollars offered for the same shares, over the auction." : "Shares offered for the same dollars, over the auction."}
      </figcaption>
    </figure>
  );
}

function SellVisual() {
  return <AuctionVisual sell />;
}

function PlanVisual() {
  return (
    <figure className="grid grid-cols-4 gap-3">
      {[1, 3, 6, 12].map((n) => (
        <div key={n} className="flex flex-col items-center rounded-[var(--radius-panel)] border border-line bg-surface p-3">
          <div className="aspect-square w-full">
            <PlanSheaf filled={n} total={12} className="h-full w-full" />
          </div>
          <p className="tnum mt-2 text-xs text-ink-3">{n} of 12</p>
        </div>
      ))}
    </figure>
  );
}

function PredictVisual() {
  const rows: [string, string][] = [
    ["Question", "Will the Big Five (BIG5) beat SPY this week?"],
    ["Yes if", "one share's recipe value rose more than SPY between two week-ending closes"],
    ["Settles from", "/api/nav/FFGg…EfJ, every input listed"],
    ["Market", "Panta, a USDC bonding curve on Solana (sandbox today)"],
  ];
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-raised">
      <dl className="divide-y divide-line text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-1 px-6 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-ink-3">{term}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecipeVisual({ basket }: { basket: Basket }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-raised">
      <p className="border-b border-line px-6 py-4 text-sm text-ink-2">
        One <span className="text-ink">{basket.symbol}</span> share of{" "}
        {basket.name} is exactly
      </p>
      <ul className="divide-y divide-line">
        {basket.components.map((component, i) => {
          const stock = stockForWriteMint(component.mint);
          return (
            <li key={component.mint} className="flex items-center gap-4 px-6 py-3.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: slotColor(i) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {stock?.company ?? shortAddress(component.mint)}
              </span>
              <span className="tnum text-sm text-ink-2">
                {quantity(Number(component.unitsPerShare) / 10 ** component.decimals, 6)}
                <span className="hidden sm:inline"> {stock?.symbol ?? ""}</span>
              </span>
              <span className="tnum w-12 text-right text-xs text-ink-3">
                {(component.weightBps / 100).toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-6 py-4 text-xs text-ink-3">
        Stored as raw units in a program account. No instruction can change it.
      </p>
    </div>
  );
}

function CreateVisual({ basket }: { basket: Basket | null }) {
  const symbols = basket
    ? basket.components.map((c) => stockForWriteMint(c.mint)?.symbol ?? "?")
    : ["AAPLx", "NVDAx", "TSLAx"];
  const share = basket?.symbol ?? "share";
  const fee = basket ? basket.creatorFeeBps / 100 : 0.5;

  const box = "rounded-[var(--radius-control)] border border-line bg-raised px-4 py-4";
  return (
    <div className="space-y-3">
      <div className="grid items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <div className={box}>
          <p className="text-xs text-ink-3">You hand over</p>
          <p className="mt-2 flex flex-wrap gap-1.5">
            {symbols.map((symbol, i) => (
              <span
                key={symbol + i}
                className="tnum border px-1.5 py-0.5 text-xs text-ink rounded-[var(--radius-control)]"
                style={{ borderColor: slotColor(i) }}
              >
                {symbol}
              </span>
            ))}
          </p>
        </div>
        <span className="self-center text-center text-bind" aria-hidden>
          <span className="hidden sm:inline">→</span>
          <span className="sm:hidden">↓</span>
        </span>
        <div className={`${box} border-bind/40`}>
          <p className="text-xs text-ink-3">The vault</p>
          <p className="mt-2 text-sm text-ink">The basket&rsquo;s own token accounts</p>
          <p className="mt-1 text-xs text-ink-3">rounds up on the way in</p>
        </div>
        <span className="self-center text-center text-bind" aria-hidden>
          <span className="hidden sm:inline">→</span>
          <span className="sm:hidden">↓</span>
        </span>
        <div className={box}>
          <p className="text-xs text-ink-3">You receive</p>
          <p className="tnum mt-2 text-sm text-ink">
            {share} shares, less {fee}%
          </p>
          <p className="tnum mt-1 text-xs text-ink-3">
            the {fee}% is minted to the creator
          </p>
        </div>
      </div>
      <p className="border border-dashed border-line-strong/60 px-4 py-3 text-center text-xs text-ink-2 rounded-[var(--radius-control)]">
        Redeeming runs it backwards: burn {share} shares and every component
        comes back, rounded down.
      </p>
    </div>
  );
}

function HoldVisual({ basket }: { basket: Basket | null }) {
  const rows: [string, string][] = [
    ["Standard", "Token-2022, like any other token"],
    ["Mint authority", "the basket's program account, nobody else"],
    ["Freeze authority", "none, the program refuses one"],
    ["Transfers", "any wallet, any program"],
    ["Dividends", "raise the components' multiplier, so the vault grows"],
  ];
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-raised">
      <p className="border-b border-line px-6 py-4 text-sm text-ink-2">
        What a {basket?.symbol ?? "share"} token is
        {basket && (
          <>
            {" · "}
            <a
              href={explorerAddress(basket.shareMint)}
              target="_blank"
              rel="noreferrer"
              className="tnum text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2"
            >
              {shortAddress(basket.shareMint, 6, 6)}
            </a>
          </>
        )}
      </p>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-1 px-6 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
            <dt className="text-ink-3">{term}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default async function MethodPage() {
  const basket = await fetchBasketAt(EXAMPLE);

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
      <header className="max-w-[62ch]">
        <h1 className="display text-hero leading-[0.95] text-ink">How it works</h1>
        <p className="mt-6 text-lg leading-[1.65] text-ink-2">
          Seven steps, the same seven as on the home page, take a list of companies
          to a token you can hold, buy or sell for dollars and buy every month; the
          last two are markets that sit beside it. The first six have already
          happened on {WRITE_CLUSTER} and link to the transaction or account that
          proves them; the seventh runs against Panta&rsquo;s sandbox. The running
          example is{" "}
          <Link
            href={`/basket/${EXAMPLE}`}
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
          >
            {basket?.name ?? "The Big Five"}
          </Link>
          , five listed megacaps in one share.
        </p>
        <p className="display mt-8 border-l-2 border-bind pl-5 text-xl leading-snug text-ink sm:text-2xl">
          The one thing Sheaf does differently: every share is backed by the exact stocks its recipe
          names, held in the basket&rsquo;s own onchain vault, and anyone can redeem it for them at any
          time. The program reads no price: it checks backing itself, whether a share is created,
          redeemed or bought with dollars. Prices on the site, the house filler&rsquo;s quotes and
          Panta&rsquo;s resolution come from Jupiter and listed closes.
        </p>
        <p className="mt-3 text-sm text-ink-3">
          <a href="#compare" className="underline decoration-line-strong underline-offset-4 hover:text-ink-2">
            How that compares with other basket products
          </a>
        </p>
      </header>

      <nav aria-label="Steps" className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((stage, i) => (
          <a
            key={stage.id}
            href={`#${stage.id}`}
            className="flex items-baseline gap-3 bg-page px-4 py-3 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <span className="tnum text-bind">{i + 1}</span>
            {stage.title}
          </a>
        ))}
      </nav>

      <div className="mt-6">
        <Stage
          n={1}
          id="recipe"
          title="Write the recipe"
          on="Sheaf program · create_basket"
          proof={{ label: "The recipe account on Explorer", href: explorerAddress(EXAMPLE) }}
          visual={
            basket ? (
              <RecipeVisual basket={basket} />
            ) : (
              <p className="border border-line px-6 py-10 text-center text-sm text-ink-3 rounded-[var(--radius-control)]">
                The example recipe could not be read right now.
              </p>
            )
          }
        >
          <p>
            Pick up to {MAX_COMPONENTS} tokenized equities: xStocks such as Apple
            and NVIDIA, or PreStocks, which give indirect exposure to OpenAI,
            Anthropic and SpaceX through special-purpose vehicles. Set a weight for
            each.
          </p>
          <p>
            Sheaf turns the weights into an exact number of raw token units per
            share at the prices on screen. The program writes that recipe into an
            account, then takes over the share mint for good.
          </p>
        </Stage>

        <Stage
          n={2}
          id="create"
          title="Create shares in kind"
          on="Token-2022 vault · mint_shares, redeem_shares"
          proof={{ label: "A PreStocks creation, its transfer fee grossed up", href: explorerTx(EXAMPLE_MINT_TX) }}
          visual={
            <div className="space-y-4">
              <CreateVisual basket={basket} />
              <HoldVisual basket={basket} />
            </div>
          }
        >
          <p>
            To create a share you hand the vault exactly what the recipe names. To
            redeem one you take exactly that back. No price is consulted at any
            point.
          </p>
          <p>
            Some PreStocks charge a fee on every transfer. The program reads that
            fee live and grosses the deposit up, so the vault always nets the full
            recipe.
          </p>
          <p>
            What you hold is one token. It sends, sits in any Solana wallet and can
            be sold like any token, and{" "}
            <Link
              href="/portfolio"
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
            >
              Portfolio
            </Link>{" "}
            looks through it to the companies underneath. xStocks pay dividends by
            raising a multiplier on the mint, and the recipe is in raw units, so the
            vault keeps every dividend for the people holding shares.
          </p>
        </Stage>

        <Stage
          n={3}
          id="dollars"
          title="Or buy with dollars"
          on="Dollar order"
          visual={<AuctionVisual />}
        >
          <p>
            Most people do not hold eight stocks. So a buyer can escrow dollars instead, for a number of
            shares that starts a little above the fair count and falls over ninety seconds to a floor the
            buyer chose.
          </p>
          <p>
            Anyone can fill it by delivering the stocks the recipe names at the current count. The vault
            receives them exactly as in a creation, the buyer receives the shares, and the filler takes the
            dollars. The auction caps the price at the buyer&rsquo;s own floor, any filler can compete to fill sooner, and
            the reference filler&rsquo;s code is published; the program reads no price. If
            nobody fills in time, the order can be canceled and the dollars go back to the buyer.
          </p>
        </Stage>

        <Stage
          n={4}
          id="sell"
          title="Sell for dollars"
          on="Sell order"
          proof={{ label: "A sale for dollars on Explorer", href: explorerTx(EXAMPLE_SELL_TX) }}
          visual={<SellVisual />}
        >
          <p>
            The way out is the way in, reversed. A holder escrows shares and asks for dollars that start a
            little above fair value and fall over ninety seconds to a floor the seller chose.
          </p>
          <p>
            Any filler can pay the current amount and take the shares, and can redeem them for the stocks
            whenever it likes. If nobody fills in time, the shares go back to the seller. There is no protocol
            fee on a sale; the filler keeps whatever spread the seller&rsquo;s band allows. Redeeming for the
            stocks themselves is always free.
          </p>
        </Stage>

        <Stage
          n={5}
          id="plans"
          title="Then every month"
          on="Monthly plan"
          visual={<PlanVisual />}
        >
          <p>
            A plan is that dollar order on a schedule: an amount, a period and a number of runs. Opening it
            approves exactly the amount per run for its runs, and nothing else. A plan run is the same auction,
            stretched to 30 minutes so any filler has time (four minutes on the demo pace that runs every five
            minutes), with a band sized to the cadence: ±15% around the last fill for a monthly plan, ±10% weekly and
            ±2% at demo pace, never past the owner&rsquo;s hard limits of ±25%, ±15% and ±10%.
          </p>
          <p>
            When a run is due anyone may send it, and the person who does is repaid the small account deposit
            when the order closes. Each fill resets the plan&apos;s reference to the price the market actually cleared at, so
            next month starts from where this month landed, without the program reading a price.
          </p>
        </Stage>
        <Stage
          n={6}
          id="market"
          title="Open a launch market"
          on="Launch market"
          proof={{ label: "The pool on Explorer", href: explorerAddress(LAUNCH_EXAMPLE_POOL) }}
          visual={<BasketLaunch basket={LAUNCH_EXAMPLE} navUsd={null} />}
        >
          <p>
            A basket&rsquo;s creator can open a bonding curve beside it: a separate
            launch token, priced from the basket&rsquo;s value, that people can trade
            as a bet on the basket. It is not a share. It is not redeemable for the
            stocks, and only a basket share is backed.
          </p>
          <p>
            The curve is set from the basket&rsquo;s own value per share (its
            NAV) rather than round numbers. It opens at half of it and, at{" "}
            {GRADUATION} times it, moves into a permanent Meteora pool with every
            liquidity position locked. A quarter of the supply goes into that
            pool, so it starts deep enough to trade. The fee is {OPEN_FEE}% in the
            first seconds, to make sniping expensive, and falls to {SETTLED_FEE}%
            over {FEE_MINUTES} minutes.
          </p>
          <p className="text-sm text-ink-3">
            The market shown is the launch of {LAUNCH_EXAMPLE.name}, on this curve.
            The first launches, The Big Five&rsquo;s (since graduated) and
            Frontier Labs&rsquo; among them, opened on an earlier curve that graduates at{" "}
            {FIRST_GRADUATION} times NAV with a {FIRST_OPEN_FEE}% opening fee, and
            keep it.
          </p>
          <p>
            The shape is ours. Four segments, weighted evenly enough that the price
            climbs with every buy: the first fifth of the SOL raised buys about a
            third of the supply, not half of it, so no early wallet can corner the
            token. A basket is not a meme. The whole curve is published as a{" "}
            <a href={PRESET_URL} target="_blank" rel="noreferrer" className="text-ink underline decoration-line-strong underline-offset-4 hover:text-bind">
              reusable preset
            </a>{" "}
            in the repository.
          </p>
          <p>
            The basket&rsquo;s creator opens it from the basket page in one
            signature and earns 40% of the curve&rsquo;s trading fees; Sheaf
            earns 40% and Meteora keeps 20%. The pool&rsquo;s address is derived from the
            basket&rsquo;s, so anyone can find it without an indexer, and a pool
            only counts as the basket&rsquo;s launch if the basket&rsquo;s creator
            opened it, on the published terms, at half the basket&rsquo;s NAV. When the curve fills, anyone can move it into the permanent
            pool from the same page, and the same card keeps buying and selling
            there instead of on the curve.
          </p>
        </Stage>

        <Stage
          n={7}
          id="predict"
          title="Bet on it"
          on="Prediction market · Panta"
          proof={{ label: "The number a market settles from", href: `/api/nav/${PREDICT_EXAMPLE}` }}
          visual={<PredictVisual />}
        >
          <p>
            Every listed basket carries one question: will it beat SPY this week?
            (A pre-IPO basket has no listed close, so it has no market.) It
            settles from a published number at two week-ending NYSE closes: the
            recipe&rsquo;s units times each holding&rsquo;s adjusted close from
            Yahoo times its mint&rsquo;s dividend multiplier, against SPY&rsquo;s
            adjusted close. Every input is listed, so anyone can recompute it from
            public accounts and two public price sources.
          </p>
          <p>
            Panta runs the market, a USDC bonding curve on Solana. Sheaf publishes
            the settling number at <code className="text-sm">/api/nav/&lt;basket&gt;</code>,
            with every input and the calls to check it. Today it runs against
            Panta&rsquo;s sandbox, so nothing is opened on mainnet;{" "}
            <Link
              href="/predict"
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
            >
              every question
            </Link>{" "}
            is on one page.
          </p>
        </Stage>

      </div>

      {/* What is inside a share, read live, and who holds which key: moved here from the home page. */}
      <section id="inside" className="scroll-mt-24 border-t border-line py-16">
        <Anatomy />
      </section>

      <section id="keys" className="scroll-mt-24 border-t border-line py-16">
        <Keys />
      </section>

      <section className="border-t border-line py-16">
        <h2 className="display text-title max-w-[24ch] text-ink">
          Why nobody has to trust the creator, or us
        </h2>
        <ul className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {GUARANTEES.map((item) => (
            <li key={item.title} className="bg-page p-7">
              <h3 className="display text-lg text-ink">{item.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="business" className="scroll-mt-24 border-t border-line py-16">
        <div className="max-w-[60ch]">
          <h2 className="display text-title text-ink">Who pays, and for what</h2>
          <p className="mt-4 text-base leading-relaxed text-ink-2">
            Every fee is fixed for a basket when it is created. Holding and redeeming are free.{" "}
            <Link href="/business" className="text-ink underline decoration-line-strong underline-offset-4 hover:text-bind">
              The full business case
            </Link>{" "}
            has the costs beside the alternatives and the numbers so far.
          </p>
        </div>
        <div className="mt-8">
          <FeeTable />
        </div>
      </section>


      <section id="compare" className="scroll-mt-24 border-t border-line py-16">
        <div className="max-w-[60ch]">
          <h2 className="display text-title text-ink">Beside the other basket products</h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            Others already let you hold many assets in one place, and several are live on mainnet
            where Sheaf is not yet. None of the ones below, as far as their own docs say, pairs a
            token backed in kind with baskets anyone can publish, redemption by anyone, and dollar
            buying where the program reads no price.
          </p>
        </div>
        {/* A phone gets one card per product; six columns of sentences will not fit. */}
        <ul className="mt-10 divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface lg:hidden">
          {COMPARE.map((row) => (
            <li key={row.name} className="px-4 py-4 text-sm leading-relaxed">
              <p className="text-ink">
                <span className={row.name === "Sheaf" ? "font-medium text-bind" : "font-medium"}>{row.name}</span>
                {row.note && <span className="ml-2 text-xs text-ink-3">{row.note}</span>}
              </p>
              <dl className="mt-2 space-y-1">
                {COMPARE_COLUMNS.map((col, i) => (
                  <div key={col} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3">
                    <dt className="text-xs text-ink-3">{col}</dt>
                    <dd className="text-ink-2">{row.cells[i]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div className="mt-10 hidden overflow-hidden rounded-[var(--radius-panel)] border border-line lg:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-surface text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-normal">Product</th>
                {COMPARE_COLUMNS.map((col) => (
                  <th key={col} className="px-4 py-3 font-normal">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row.name} className={`border-t border-line align-top ${row.name === "Sheaf" ? "bg-raised" : ""}`}>
                  <th scope="row" className="px-4 py-3 text-left font-normal">
                    <span className={row.name === "Sheaf" ? "text-bind" : "text-ink"}>{row.name}</span>
                    {row.note && <span className="mt-0.5 block text-xs text-ink-3">{row.note}</span>}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={i} className={`px-4 py-3 ${cell === "Not stated" ? "text-ink-3" : "text-ink-2"}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 max-w-[80ch] text-xs leading-relaxed text-ink-3">
          From each product&rsquo;s own documentation or the coverage linked, checked 9 and 10 October 2026:{" "}
          {COMPARE.filter((r) => r.href).map((r, i, list) => (
            <span key={r.name}>
              <a href={r.href} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
                {r.name}
              </a>
              {i < list.length - 1 ? ", " : "."}
            </span>
          ))}{" "}
          &ldquo;Not stated&rdquo; means we could not find it published, not that it is missing. Corrections are welcome.
        </p>
      </section>

      <section id="risks" className="scroll-mt-24 border-t border-line py-16">
        <div className="max-w-[56ch]">
          <h2 className="display text-title text-ink">What could still go wrong</h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            The program can promise that a vault never holds less than its shares
            claim. It cannot promise anything about the tokens it holds, the
            people allowed to hold them, or the law. These are the limits, in
            plain words.
          </p>
        </div>
        <ul className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {RISKS.map((item) => (
            <li key={item.title} className="bg-surface p-7">
              <h3 className="display text-lg text-ink">{item.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-10 border-t border-line py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <div className="max-w-[48ch] space-y-4 text-base leading-relaxed text-ink-2">
          <h2 className="display text-title text-ink">What is live</h2>
          <p>
            Every price, 24-hour move, liquidity figure and dividend multiplier is
            read from Solana mainnet as you look at it.
          </p>
          <p>
            Creation and redemption settle on {WRITE_CLUSTER} against mirrors of
            the same mints, with the same decimals, metadata, multipliers and
            transfer fees, though not every issuer extension the real mints carry
            (see the risks above). You can try the whole thing without spending money.
          </p>
          <p>
            Solana is what makes it worth doing: issuing the instrument, taking
            custody of its backing and settling the trade happen in one
            transaction for a fraction of a cent.
          </p>
          <p className="tnum text-sm text-ink-3">
            Program{" "}
            <a
              href={explorerAddress(SHEAF_PROGRAM_ID)}
              target="_blank"
              rel="noreferrer"
              className="break-all underline decoration-line-strong underline-offset-4 hover:text-ink-2"
            >
              {SHEAF_PROGRAM_ID}
            </a>
          </p>
        </div>
        <div className="self-center">
          <dl className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-sm">
            {[
              ["Components per basket", `1 to ${MAX_COMPONENTS}`],
              ["Share decimals", String(SHARE_DECIMALS)],
              ["Protocol fee", "0.10% of each creation, in shares (Solana baskets created from Oct 9)"],
              ["On the EVM chains", "the v3 desks pay the 0.10% to a separate treasury key the server does not hold (v2's went to the house key)"],
              ["Creator fee ceiling", `${MAX_CREATOR_FEE_BPS / 100}%`],
              ["Deposits", "round up"],
              ["Redemptions", "round down"],
              ["Prices the program reads", "none"],
              ["Recipe after creation", "immutable"],
              ["Creator's income", `up to ${MAX_CREATOR_FEE_BPS / 100}% of each creation, in shares`],
              ["Sheaf's income", "the 0.10% protocol fee, then the house filler's 0.15% margin, then launch-market fees"],
              ["Launch market", "Meteora bonding curve"],
            ].map(([term, value]) => (
              <div key={term} className="flex items-baseline justify-between gap-4 px-4 py-3">
                <dt className="text-ink-3">{term}</dt>
                <dd className="tnum text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          <Link
            href="/compose"
            className="mt-6 inline-block rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
          >
            Create a basket
          </Link>
        </div>
      </section>

      <section className="border-t border-line py-12">
        <p className="max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Built by Rohan Borade, solo, in India. The code, the program and every script behind these pages are
          on{" "}
          <a
            href="https://github.com/RohanGlitched"
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
          >
            GitHub
          </a>
          .
        </p>
      </section>
    </div>
  );
}
