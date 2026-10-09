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
import { FEATURED_DBC } from "@/lib/dbc";
import { fetchBasketAt, type Basket } from "@/lib/sheaf";
import { stockForWriteMint } from "@/lib/mirror";
import { slotColor } from "@/lib/palette";
import { quantity, shortAddress } from "@/lib/format";
import { FeaturedLaunch } from "@/components/launch-market";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Six steps from a list of companies to a token you can hold, buy with dollars, buy every month and trade before it exists. Each one has already happened on devnet and links to the transaction that proves it.",
};

export const revalidate = 300;

const [EXAMPLE, DBC] = FEATURED_DBC;
const EXAMPLE_MINT_TX =
  "4ej9mpPfVwzWeSDg5Ftf8pDxbmMWhPsYBv7CjhpYGX3WRMm6kWRF9Mxt9WptgW23qzH7rfMsiKNLr4Wyz92DHHeA";

const STAGES = [
  { id: "recipe", title: "Write the recipe" },
  { id: "create", title: "Create shares in kind" },
  { id: "hold", title: "Hold one token" },
  { id: "dollars", title: "Or buy with dollars" },
  { id: "plans", title: "Then every month" },
  { id: "market", title: "Open a launch market" },
];

/** Plainly, what the program cannot promise. */
const RISKS = [
  {
    title: "The issuers keep their own powers",
    body: "xStocks and PreStocks are Token-2022 mints, and their issuers keep controls over their own tokens: pausing transfers, freezing an account, or a permanent delegate that can move tokens, depending on the mint. Sheaf cannot override them. If an issuer froze or took tokens held in a vault, the shares backed by them would be short. The devnet mirrors copy these extensions on purpose, so the program is tested against them.",
  },
  {
    title: "Not everyone may hold xStocks",
    body: "xStocks are not offered to US persons and are restricted in some other countries, and PreStocks set their own terms. A basket that holds them inherits those limits, so a mainnet Sheaf would have to check where its users are before letting them in.",
  },
  {
    title: "Devnet is a rehearsal",
    body: "Prices, multipliers and liquidity are read from mainnet, but every vault today holds devnet mirrors of the real mints, worth nothing. On mainnet the vaults would hold the real tokens, and dollar orders would need fillers buying real xStocks. Today the only filler is Sheaf's own, delivering mirrors.",
  },
  {
    title: "The program is not audited",
    body: "The program and the EVM contracts have their own test suites, but nobody outside has reviewed them. The upgrade authority is a deploy wallet on devnet. Before it holds real tokens, it moves to a multisig and is then burned, after an audit.",
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
    title: "No oracle",
    body: "Shares are created and redeemed against tokens, never against a price, so there is no feed to go stale or be pushed.",
  },
  {
    title: "No edit button",
    body: "The recipe is written once. There is no manager, no rebalance authority and no instruction that changes what a share holds.",
  },
  {
    title: "Rounding favors holders",
    body: "Deposits round up and redemptions round down, so the vault can only ever hold at least what the shares claim.",
  },
  {
    title: "The fee never touches the vault",
    body: `The creator earns up to ${MAX_CREATOR_FEE_BPS / 100}% of each creation in new shares. The vault always receives the full recipe.`,
  },
  {
    title: "Anyone can create and redeem",
    body: "In a traditional fund that right belongs to a few authorized participants. Here it belongs to whoever holds the tokens.",
  },
  {
    title: "Buying with dollars, measured",
    body: "Every basket page quotes the round trip through Jupiter for each component. A typical basket lands under a quarter of a percent.",
  },
  {
    title: "A track record, not a promise",
    body: "Every basket shows what its recipe would have done over the past year against SPY, from the listed shares' own closes, with the deepest fall beside the return.",
  },
  {
    title: "Dollars never meet a price feed",
    body: "A dollar order is an auction on share count. The buyer sets the floor, fillers decide when to fill, and the vault still receives the real stocks.",
  },
  {
    title: "A plan can do one thing",
    body: "Opening a plan approves exactly its per-run amount for its runs. Anyone can run it when due; nobody, including Sheaf, can make it spend more or buy anything else.",
  },
  {
    title: "Everything is in the log",
    body: "The program emits an event for every creation, redemption, order, fill and plan run. The ledger decodes them from the chain in your browser, so there is no database to trust.",
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

function AuctionVisual() {
  // Shares the buyer receives over the auction: from 2% above fair to 2% below.
  const W = 520, H = 260, pad = 36;
  const y = (v: number) => pad + ((1.03 - v) / 0.06) * (H - 2 * pad);
  const x = (t: number) => pad + t * (W - 2 * pad);
  return (
    <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Shares offered fall from 2% above fair to 2% below over the auction; a filler takes it near fair">
        <line x1={pad} x2={W - pad} y1={y(1)} y2={y(1)} stroke="var(--color-line-strong)" strokeDasharray="4 4" />
        <text x={W - pad} y={y(1) - 8} textAnchor="end" fontSize="13" fill="var(--color-ink-3)">fair count at mainnet prices</text>
        <line x1={x(0)} y1={y(1.02)} x2={x(1)} y2={y(0.98)} stroke="var(--color-bind)" strokeWidth="3" strokeLinecap="round" />
        <circle cx={x(0.55)} cy={y(1.02 - 0.04 * 0.55)} r="7" fill="var(--color-gain)" />
        <text x={x(0.55) + 12} y={y(1.02 - 0.04 * 0.55) + 22} fontSize="13" fill="var(--color-ink)">a filler delivers the stocks</text>
        <text x={x(0)} y={y(1.02) - 12} fontSize="13" fill="var(--color-ink-2)">+2%</text>
        <text x={x(1)} y={y(0.98) + 22} textAnchor="end" fontSize="13" fill="var(--color-ink-2)">−2%, the buyer&apos;s floor</text>
        <text x={x(0)} y={H - 6} fontSize="12" fill="var(--color-ink-3)">0s</text>
        <text x={x(1)} y={H - 6} textAnchor="end" fontSize="12" fill="var(--color-ink-3)">90s</text>
      </svg>
      <figcaption className="mt-2 text-sm text-ink-3">Shares offered for the same dollars, over the auction.</figcaption>
    </figure>
  );
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
          Six steps take a list of companies to a token you can hold, buy with
          dollars, buy every month and trade before it exists. Each one has
          already happened on {WRITE_CLUSTER} and links to the transaction or
          account that proves it. The running example is{" "}
          <Link
            href={`/basket/${EXAMPLE}`}
            className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
          >
            {basket?.name ?? "Frontier Labs"}
          </Link>
          , a basket of pre-IPO companies.
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
            and NVIDIA, or PreStocks SPVs over OpenAI, Anthropic and SpaceX. Set a
            weight for each.
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
          proof={{ label: "A creation with a PreStocks fee grossed up", href: explorerTx(EXAMPLE_MINT_TX) }}
          visual={<CreateVisual basket={basket} />}
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
        </Stage>

        <Stage
          n={3}
          id="hold"
          title="Hold one token"
          on="Any Solana wallet"
          proof={
            basket
              ? { label: "The share mint on Explorer", href: explorerAddress(basket.shareMint) }
              : undefined
          }
          visual={<HoldVisual basket={basket} />}
        >
          <p>
            Several positions become one. The share sends, sits in a wallet and can be
            sold like any token, and{" "}
            <Link
              href="/portfolio"
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
            >
              Portfolio
            </Link>{" "}
            looks through it to the companies underneath.
          </p>
          <p>
            xStocks pay dividends by raising a multiplier on the mint rather than
            sending tokens. The recipe is in raw units, so the vault keeps every
            dividend for the people holding shares.
          </p>
        </Stage>

        <Stage
          n={4}
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
            dollars. Fillers compete on timing, so the price is the market&apos;s and no oracle is read. If
            nobody fills in time, the order can be cancelled and the dollars go back to the buyer.
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
            approves exactly the amount per run for its runs, and nothing else.
          </p>
          <p>
            When a run is due anyone may send it, and the person who does is repaid the rent when the order
            closes. Each fill resets the plan&apos;s reference to the price the market actually cleared at, so
            next month starts from where this month landed, without an oracle.
          </p>
        </Stage>
        <Stage
          n={6}
          id="market"
          title="Open a launch market"
          on="Launch market"
          proof={{ label: "The pool on Explorer", href: explorerAddress(DBC.pool) }}
          visual={<FeaturedLaunch />}
        >
          <p>
            A new basket has no holders yet, and nobody wants to be first to
            assemble every component. So a bonding curve can open in front of it,
            and people can buy in before the first share exists. The launch token
            is its own market: it is not redeemable for the stocks, and only a
            basket share is backed.
          </p>
          <p>
            The curve is set from the basket&rsquo;s own value per share (its
            NAV) rather than round numbers. It opens at half of it and, at five
            times it, moves into a permanent Meteora pool with every liquidity
            position locked. A quarter of the supply goes into that pool, so it
            starts deep enough to trade. The fee is 25% in the first seconds, to
            make sniping expensive, and falls to 1% over ten minutes.
          </p>
          <p>
            The shape is ours. Four segments, weighted so the curve opens on a
            shelf: the first fifth of the SOL raised buys about a third of the
            supply, not half of it, so early buyers are not racing each other. A
            basket is not a meme. The whole curve is published as a reusable
            preset in the repository.
          </p>
          <p>
            The basket&rsquo;s creator opens it from the basket page in one
            signature and earns half of the curve&rsquo;s trading fees; Sheaf
            earns the other half. The pool&rsquo;s address is derived from the
            basket&rsquo;s, so anyone can find it without an indexer, and a pool
            only counts as the basket&rsquo;s launch if the basket&rsquo;s creator
            opened it. When the curve fills, anyone can move it into the permanent
            pool from the same page, and the same card keeps buying and selling
            there instead of on the curve.
          </p>
        </Stage>

      </div>

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
            transfer fees. You can try the whole thing without spending money.
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
              ["Creator fee ceiling", `${MAX_CREATOR_FEE_BPS / 100}%`],
              ["Deposits", "round up"],
              ["Redemptions", "round down"],
              ["Oracles used", "none"],
              ["Recipe after creation", "immutable"],
              ["Creator's income", `up to ${MAX_CREATOR_FEE_BPS / 100}% of each creation, in shares`],
              ["Sheaf's income", "the house filler's spread, then launch-market fees"],
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
    </div>
  );
}
