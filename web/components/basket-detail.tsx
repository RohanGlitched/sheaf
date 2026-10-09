"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useBasket } from "@/lib/use-baskets";
import { useBalances } from "@/lib/use-balances";
import { useOnChainBasket, valueBasket } from "@/lib/basket-view";
import { useMarket } from "./market-provider";
import { BasketMosaic } from "./basket-mosaic";
import { Figure } from "./figure";
import { FaucetButton } from "./faucet-button";
import { FillCostPanel } from "./fill-cost";
import { TrackRecord } from "./track-record";
import { BasketHistory } from "./ledger";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, ONE_SHARE, tokenAccount } from "@/lib/sheaf";
import {
  buildMintShares,
  buildRedeemShares,
  sendSteps,
  explainError,
} from "@/lib/tx";
import { feeSplit } from "@/lib/desk";
import { symbolForWriteMint } from "@/lib/mirror";
import { PRESTOCK_SYMBOLS, BY_SYMBOL_PRESTOCKS } from "@/lib/prestocks";
import { BasketLaunch } from "./launch-market";
import { DollarOrder } from "./dollar-order";
import { SellOrderPanel } from "./sell-order";
import { PlanForm } from "./plan-form";
import { BasketPredict } from "./basket-predict";
import { ConnectButton } from "./connect-button";
import { explorerAddress, explorerTx, PUBLIC_WRITE_RPC } from "@/lib/config";
import { slotColor } from "@/lib/palette";
import {
  money,
  percent,
  quantity,
  signedPercent,
  shortAddress,
  count,
} from "@/lib/format";
import type { Basket } from "@/lib/sheaf";
import { Ticker } from "./ticker";
import { BasketSkeleton } from "./skeletons";

/**
 * One basket, in full.
 *
 * The page answers four questions in order: what is in it, what is it worth, is it
 * actually backed, and how do I get in and out. The third one is the reason the
 * page exists — every other index product asks to be believed, and this one shows
 * the vault balance next to the claim against it.
 */

const mulDivCeil = (a: bigint, b: bigint, c: bigint) => (a * b + c - 1n) / c;
const mulDivFloor = (a: bigint, b: bigint, c: bigint) => (a * b) / c;
const ONE = BigInt(ONE_SHARE);

export function BasketDetail({ address, initial }: { address: string; initial: Basket | null }) {
  const { basket, state, error, reload } = useBasket(address, initial);

  useEffect(() => {
    if (basket) document.title = `${basket.name} (${basket.symbol}) · Sheaf`;
  }, [basket]);

  if (state === "loading") {
    return <BasketSkeleton />;
  }

  if (state === "missing" || !basket) {
    return (
      <div className="py-32 text-center">
        <h1 className="display text-title text-ink">No basket here.</h1>
        <p className="mx-auto mt-4 max-w-[48ch] text-base leading-relaxed text-ink-2">
          Nothing at this address belongs to the Sheaf program. It may be on a
          different cluster, or the address may be a typo.
        </p>
        <Link
          href="/explore"
          className="mt-8 inline-block border border-line px-5 py-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink rounded-[var(--radius-control)]"
        >
          See the baskets that do exist
        </Link>
      </div>
    );
  }

  if (state === "error") {
    return (
      <p className="py-32 text-center text-sm text-loss">
        Could not reach the cluster. {error}
      </p>
    );
  }

  return <Loaded basket={basket} reloadBasket={reload} />;
}

function Loaded({
  basket,
  reloadBasket,
}: {
  basket: Basket;
  /** The creation and redemption counts live on the basket record, so a trade has
   *  to refetch that too or the tally sits one behind what just happened. */
  reloadBasket: () => Promise<void>;
}) {
  const { snapshot } = useMarket();
  const { onChain, reload: reloadChain } = useOnChainBasket(basket);
  const valuation = useMemo(
    () => valueBasket(basket, snapshot),
    [basket, snapshot],
  );

  const watched = useMemo(
    () => [
      { mint: basket.shareMint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() },
      ...basket.components.map((c) => ({
        mint: c.mint,
        tokenProgram: basket.tokenProgram,
      })),
    ],
    [basket],
  );
  const balances = useBalances(watched);

  const tiles = valuation.components.map((c) => ({
    key: c.mint,
    label: c.base,
    sub: c.company,
    weightBps: c.actualWeightBps ?? c.targetWeightBps,
    slot: c.slot,
  }));

  const heldRaw = balances.raw.get(basket.shareMint) ?? 0n;

  // What each holding is worth inside one share today, which is where every
  // line of the track record ends.
  const trackComponents = useMemo(
    () => valuation.components.map((c) => ({ base: c.base, valueNow: c.value ?? 0 })),
    [valuation],
  );

  return (
    <div>
      <div className="grid gap-12 [&>*]:min-w-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      {/* ------------------------------------------------------------- left */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <h1 className="display text-hero leading-[0.95] text-ink">
              {basket.name}
            </h1>
            <p className="tnum mt-3 text-sm text-ink-3">
              {basket.symbol} · created{" "}
              <time dateTime={new Date(basket.createdAt * 1000).toISOString()}>
                {new Date(basket.createdAt * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
              </time>{" "}
              by{" "}
              <a
                href={explorerAddress(basket.creator)}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
              >
                {shortAddress(basket.creator)}
              </a>
            </p>
          </div>
          {/* Right-aligned beside the name, but once it wraps under the name on a
              narrow screen a right rag would leave it floating, so it aligns left. */}
          <div className="text-left sm:text-right">
            <p className="text-xs text-ink-3">One share</p>
            <p className="tnum display mt-1 text-title leading-none text-ink">
              <Ticker value={money(valuation.nav)} />
            </p>
            <p
              className="tnum mt-1.5 text-sm"
              style={{
                color:
                  valuation.change24h == null
                    ? "var(--color-ink-3)"
                    : valuation.change24h > 0
                      ? "var(--color-gain)"
                      : "var(--color-loss)",
              }}
            >
              {signedPercent(valuation.change24h)} today
            </p>
          </div>
        </div>

        <p className="mt-8 max-w-[62ch] text-base leading-relaxed text-ink-2">
          One {basket.symbol} share is a claim on{" "}
          {basket.components.length === 1
            ? "one holding"
            : `${basket.components.length} holdings`}{" "}
          sitting in a vault this program controls. The program releases them only
          against a redeemed share, and a share can always be redeemed; the
          tokens&rsquo; issuers keep their own powers over them, as{" "}
          <Link href="/method#risks" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
            the risks
          </Link>{" "}
          explain.
        </p>

        {valuation.components.some((c) => PRESTOCK_SYMBOLS.has(c.symbol)) && (
          <p className="mt-6 max-w-[66ch] border-l-2 border-loss pl-4 text-sm leading-relaxed text-ink-2">
            <span className="text-ink">Pre-IPO holdings carry a risk listed shares do not.</span> In May 2026
            Anthropic said any transfer of its shares its board has not approved is void, and OpenAI warned
            that unauthorized transfers could invalidate the underlying equity. PreStocks&rsquo; Anthropic and
            OpenAI tokens fell by roughly a third or more within a week (
            <a
              href="https://www.theblock.co/post/401088/anthropic-openai-tokenized-prestocks-plunge"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              The Block
            </a>
            ). PreStocks holds the shares indirectly, through special-purpose vehicles. On mainnet today a basket like this could only be created in kind; buying it with dollars here is a
            devnet demonstration.
          </p>
        )}

        <div className="mt-9">
          <BasketMosaic tiles={tiles} height={260} />
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-4">
          {/* The hero already prints the price of one share, so this slot carries
              the size of the whole thing instead. */}
          <Figure
            label="Everything in the vault"
            value={
              onChain && valuation.nav != null
                ? money(valuation.nav * onChain.shares)
                : "—"
            }
            note="Components held against every outstanding share"
          />
          <Figure
            label="Against the real shares"
            value={
              valuation.premiumBps == null
                ? "—"
                : signedPercent(valuation.premiumBps / 100)
            }
            note={
              valuation.premiumBps == null
                ? valuation.components.some((c) => PRESTOCK_SYMBOLS.has(c.symbol))
                  ? "Pre-IPO components have no listed share to compare"
                  : "Needs a listed price for every component"
                : valuation.premiumBps > 0
                  ? "The tokens trade above the shares behind them"
                  : "The tokens trade below the shares behind them"
            }
            tone={
              /* The same rule as the home page: a premium in teal, a discount in rust. */
              valuation.premiumBps == null || Math.abs(valuation.premiumBps) < 0.5
                ? undefined
                : valuation.premiumBps > 0
                  ? "gain"
                  : "loss"
            }
          />
          <Figure
            label="Dividends inside"
            value={
              valuation.components.length > 0 && valuation.components.every((c) => PRESTOCK_SYMBOLS.has(c.symbol))
                ? "None, pre-IPO"
                : percent(valuation.accruedSharePct)
            }
            note="Share of the value that is dividends already paid onchain"
            tone={
              valuation.accruedSharePct && valuation.accruedSharePct > 0.005
                ? "bind"
                : undefined
            }
          />
          <Figure
            label="Shares outstanding"
            value={onChain ? count(onChain.shares) : "—"}
            note={`${count(Number(basket.mintCount))} ${
              Number(basket.mintCount) === 1 ? "creation" : "creations"
            }, ${count(Number(basket.redeemCount))} ${
              Number(basket.redeemCount) === 1 ? "redemption" : "redemptions"
            }`}
          />
        </dl>

        {valuation.unpriced.length > 0 && (
          <p className="mt-5 border-l-2 border-bind pl-3 text-sm leading-relaxed text-ink-2">
            No price for {valuation.unpriced.join(", ")}, so the value of a share
            is left blank rather than computed from part of the basket.
          </p>
        )}

      </div>

      {/* ------------------------------------------------------------ right */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        <TradePanel
          basket={basket}
          navPerShare={valuation.nav}
          balances={balances}
          shareBalance={heldRaw}
          onDone={() => {
            void balances.reload();
            void reloadChain();
            void reloadBasket();
          }}
        />
      </div>
      </div>

      {valuation.nav != null && (
        <TrackRecord components={trackComponents} symbol={basket.symbol} createdAt={basket.createdAt} />
      )}

      <BasketLaunch basket={basket} navUsd={valuation.nav} />

      <section id="predict" className="mt-20 scroll-mt-24 border-t border-line pt-16">
        <BasketPredict basket={basket.address} name={basket.name} symbol={basket.symbol} creator={basket.creator} />
      </section>

      {/* What it should hold, beside what it does hold. `min-w-0` on the tracks,
          because a grid item defaults to min-content and the tables inside carry a
          minimum width — without it the whole page scrolls sideways. */}
      <div className="mt-16 grid gap-14 [&>*]:min-w-0 lg:grid-cols-2 lg:gap-16">
        <Composition basket={basket} valuation={valuation} />
        <Backing basket={basket} onChain={onChain} />
      </div>

      <CappedHistory basket={basket} />

      <FillCostPanel components={valuation.components} nav={valuation.nav} />

      <div className="mt-16 flex flex-wrap items-baseline justify-between gap-5 border-t border-line pt-7 text-sm">
        <p className="max-w-[62ch] leading-relaxed text-ink-2">
          Prices come from Solana mainnet, balances from the program itself. The
          arithmetic behind both is written out in full.
        </p>
        <div className="flex gap-7">
          <Link
            href="/method"
            className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink"
          >
            How it works
          </Link>
          <Link
            href="/explore"
            className="underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink"
          >
            Every basket
          </Link>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composition

function Composition({
  basket,
  valuation,
}: {
  basket: Basket;
  valuation: ReturnType<typeof valueBasket>;
}) {
  return (
    <section>
      <h2 className="display text-title text-ink">The recipe</h2>
      <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        These numbers were written once, when the basket was created, and cannot be
        changed: a fixed basket, like a unit investment trust, with no manager and no
        rebalancing. The weight on the right drifts as prices move. To change the
        recipe, publish a new basket.
      </p>

      {/* The market price of one component is the least useful column here — the
          value it produces is right beside it — so a narrow screen drops that and
          the company name rather than scrolling sideways. */}
      <div className="mt-7 min-w-0 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
        <table className="w-full border-collapse text-sm sm:min-w-[34rem]">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-3 py-3 font-normal sm:px-4">Holding</th>
              <th className="px-3 py-3 text-right font-normal sm:px-4">
                Per share
              </th>
              <th className="hidden px-4 py-3 text-right font-normal sm:table-cell">
                Price
              </th>
              <th className="px-3 py-3 text-right font-normal sm:px-4">Value</th>
              <th className="px-3 py-3 text-right font-normal sm:px-4">Weight</th>
            </tr>
          </thead>
          <tbody>
            {valuation.components.map((c) => (
              <tr key={c.mint} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-3 sm:px-4">
                  <div className="flex items-center gap-2.5 sm:gap-3">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: slotColor(c.slot) }}
                    />
                    <span>
                      <span className="text-ink">{c.base}</span>
                      {PRESTOCK_SYMBOLS.has(c.symbol) && (
                        <span className="ml-2 text-xs text-ink-3">
                          PreStocks
                        </span>
                      )}
                      <span className="ml-2 hidden text-xs text-ink-3 sm:inline">
                        {c.company}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">
                  {quantity(c.tokensPerShare, 6)}
                </td>
                <td className="tnum hidden px-4 py-3 text-right text-ink-2 sm:table-cell">
                  {money(c.quote?.price)}
                </td>
                <td className="tnum px-3 py-3 text-right text-ink sm:px-4">
                  {money(c.value)}
                </td>
                <td className="tnum px-3 py-3 text-right sm:px-4">
                  <span className="text-ink-2">
                    {percent(
                      (c.actualWeightBps ?? c.targetWeightBps) / 100,
                      1,
                    )}
                  </span>
                  {c.actualWeightBps != null &&
                    Math.abs(c.actualWeightBps - c.targetWeightBps) > 5 && (
                      <span className="block text-xs text-ink-3">
                        set {percent(c.targetWeightBps / 100, 1)}
                      </span>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tnum mt-4 text-xs leading-relaxed text-ink-3">
        Share mint{" "}
        <a
          href={explorerAddress(basket.shareMint)}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          {shortAddress(basket.shareMint, 6, 6)}
        </a>{" "}
        · vault owner{" "}
        <a
          href={explorerAddress(basket.address)}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          {shortAddress(basket.address, 6, 6)}
        </a>{" "}
        · creator fee {percent(basket.creatorFeeBps / 100)} of shares created
      </p>
    </section>
  );
}

// --------------------------------------------------------------------- backing

function Backing({
  basket,
  onChain,
}: {
  basket: Basket;
  onChain: ReturnType<typeof useOnChainBasket>["onChain"];
}) {
  return (
    <section>
      <h2 className="display text-title text-ink">Is it actually backed?</h2>
      <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        Held is what the vault contains right now. Owed is what every outstanding
        share can claim. Deposits round up and redemptions round down, so held can
        only ever be at or above owed, and the difference is rounding dust that
        stays with the remaining holders.
      </p>

      {!onChain ? (
        <p className="mt-7 text-sm text-ink-3">Reading the vault…</p>
      ) : onChain.supply === 0n ? (
        <p className="mt-7 border border-dashed border-line-strong/60 px-6 py-8 text-sm leading-relaxed text-ink-2 rounded-[var(--radius-control)]">
          No shares exist yet, so the vault is empty and there is nothing to back.
          Create the first share and this table fills in.
        </p>
      ) : (
        <>
          <div
            className="mt-7 flex items-center gap-3 border px-4 py-3 text-sm rounded-[var(--radius-control)]"
            style={{
              borderColor: onChain.fullyBacked
                ? "color-mix(in oklab, var(--color-gain) 45%, transparent)"
                : "var(--color-loss)",
              color: onChain.fullyBacked
                ? "var(--color-gain)"
                : "var(--color-loss)",
            }}
          >
            <span aria-hidden className="size-2 rotate-45 bg-current" />
            {onChain.fullyBacked
              ? "Every outstanding share is fully backed, today by devnet mirror tokens; on mainnet it would be by the real xStocks and PreStocks."
              : "A vault is short. Do not create more shares."}
          </div>

          <div className="mt-5 min-w-0 overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
            <table className="w-full border-collapse text-sm sm:min-w-[26rem]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-3 py-3 font-normal sm:px-4">Holding</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">Held</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">Owed</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">
                    Surplus
                  </th>
                </tr>
              </thead>
              <tbody>
                {onChain.vaults.map((vault, i) => {
                  const component = basket.components[i];
                  const decimals = component?.decimals ?? 0;
                  const label = symbolForWriteMint(vault.mint) ?? "Unknown";
                  const surplus = onChain.surplus[i] ?? 0n;
                  return (
                    <tr
                      key={vault.mint}
                      className="border-b border-line/60 last:border-0"
                    >
                      <td className="px-3 py-3 text-ink sm:px-4">
                        {label.replace(/x$/, "")}
                        {PRESTOCK_SYMBOLS.has(label) && (
                          <span className="ml-2 text-xs text-ink-3">
                            PreStocks
                          </span>
                        )}
                      </td>
                      <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">
                        <Ticker value={quantity(Number(vault.held) / 10 ** decimals, 6)} />
                      </td>
                      <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">
                        <Ticker value={quantity(Number(vault.owed) / 10 ** decimals, 6)} />
                      </td>
                      <td className="tnum px-3 py-3 text-right sm:px-4">
                        <span
                          style={{
                            color:
                              surplus > 0n
                                ? "var(--color-bind)"
                                : "var(--color-ink-3)",
                          }}
                        >
                          {surplus === 0n
                            ? "exact"
                            : `${surplus.toString()} ${surplus === 1n ? "unit" : "units"}`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Proof basket={basket} />
    </section>
  );
}

// ----------------------------------------------------------------------- proof

const rpcCall = (method: string, address: string) =>
  `curl -s ${PUBLIC_WRITE_RPC} -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"${method}","params":["${address}"]}'`;

/**
 * The backing check, as two RPC calls anyone can run.
 *
 * The table above is this page's reading of the chain. This is how to take the
 * page out of the loop: the share supply from the mint, each vault's balance
 * from its token account, and the inequality that has to hold between them.
 */
function Proof({ basket }: { basket: Basket }) {
  const [copied, setCopied] = useState<string | null>(null);
  const basketKey = new PublicKey(basket.address);
  const tokenProgram = new PublicKey(basket.tokenProgram);
  const vaults = basket.components.map((c) => ({
    label: (symbolForWriteMint(c.mint) ?? "?").replace(/x$/, ""),
    address: tokenAccount(new PublicKey(c.mint), basketKey, tokenProgram).toBase58(),
    units: c.unitsPerShare.toString(),
  }));

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };

  return (
    <details className="mt-7 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm text-ink-2 marker:text-bind hover:text-ink">
        Verify it yourself
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4 text-sm leading-relaxed text-ink-2 rounded-[var(--radius-control)]">
        <p>
          Two kinds of read, both against the public RPC, no key. First, how many
          shares exist:
        </p>
        <Command id="supply" text={rpcCall("getTokenSupply", basket.shareMint)} copied={copied} onCopy={copy} />
        <p>Then what each vault holds:</p>
        {vaults.map((v) => (
          <div key={v.address}>
            <p className="tnum mb-1.5 text-xs text-ink-3">
              {v.label} · vault {shortAddress(v.address, 6, 6)} · recipe {v.units} raw units per share
            </p>
            <Command id={v.address} text={rpcCall("getTokenAccountBalance", v.address)} copied={copied} onCopy={copy} />
          </div>
        ))}
        <p>
          For every vault, <span className="tnum text-ink">amount</span> must be at
          least <span className="tnum text-ink">units per share × supply ÷ 1,000,000</span>,
          both in raw units. If that holds, every share is backed. The program cannot
          make it false: deposits round up, redemptions round down, and no instruction
          moves anything out of a vault except a redemption.
        </p>
      </div>
    </details>
  );
}

function Command({
  id,
  text,
  copied,
  onCopy,
}: {
  id: string;
  text: string;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-page px-3 py-2.5 text-[11px] leading-relaxed text-ink-2">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() => onCopy(id, text)}
        className="absolute right-2 top-2 border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-bind hover:text-ink rounded-[var(--radius-panel)]"
      >
        {copied === id ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ trade panel

type Mode = "create" | "redeem" | "cash" | "sell" | "plan";

const TABS: { mode: Mode; label: string }[] = [
  { mode: "cash", label: "Buy with dollars" },
  { mode: "sell", label: "Sell for dollars" },
  { mode: "plan", label: "Monthly plan" },
  { mode: "create", label: "Create in kind" },
  { mode: "redeem", label: "Redeem" },
];

function TradePanel({
  basket,
  navPerShare,
  balances,
  shareBalance,
  onDone,
}: {
  basket: Basket;
  navPerShare: number | null;
  balances: ReturnType<typeof useBalances>;
  shareBalance: bigint;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [mode, setMode] = useState<Mode>("cash");
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  const shares = Number(amount);
  const valid = Number.isFinite(shares) && shares > 0;
  const rawShares = valid ? BigInt(Math.round(shares * ONE_SHARE)) : 0n;

  const rows = basket.components.map((component) => {
    const symbol = symbolForWriteMint(component.mint) ?? "?";
    const target = mulDivCeil(component.unitsPerShare, rawShares, ONE);
    // The program grosses up a deposit for a live TransferFeeConfig, same as
    // gross_for_transfer_fee in lib.rs, so a PreStocks component costs
    // slightly more than the recipe alone would suggest. Estimated from the
    // fee this component quoted at seeding time, not a live read, so it can
    // undershoot by a few raw units if the fee has since changed on chain.
    const feeBps = BY_SYMBOL_PRESTOCKS[symbol]?.transferFeeBps ?? 0;
    const need = feeBps > 0 ? mulDivCeil(target, 10_000n, 10_000n - BigInt(feeBps)) : target;
    const back = mulDivFloor(component.unitsPerShare, rawShares, ONE);
    const have = balances.raw.get(component.mint) ?? 0n;
    return {
      mint: component.mint,
      symbol,
      decimals: component.decimals,
      need,
      back,
      have,
      grossedUp: feeBps > 0,
      short: have < need,
    };
  });

  const split = feeSplit(rawShares, basket.creatorFeeBps, basket.protocolFeeBps);
  const feeShares = split.creator;
  const protocolShares = split.protocol;
  const netShares = rawShares - feeShares - protocolShares;
  const shortSymbols = connected
    ? rows.filter((r) => r.short).map((r) => r.symbol)
    : [];
  const enoughShares = shareBalance >= rawShares;

  const blocked =
    !connected ||
    !valid ||
    (mode === "create" ? shortSymbols.length > 0 : !enoughShares);

  async function submit() {
    if (!publicKey || !valid) return;
    setBusy(true);
    setError(null);
    setSignature(null);
    try {
      const steps =
        mode === "create"
          ? await buildMintShares({
              connection,
              basket,
              depositor: publicKey,
              shares: rawShares,
            })
          : await buildRedeemShares({
              connection,
              basket,
              owner: publicKey,
              shares: rawShares,
            });
      const signatures = await sendSteps(
        steps,
        connection,
        sendTransaction,
        (done, total) => setStep({ done, total }),
      );
      setSignature(signatures[signatures.length - 1] ?? null);
      onDone();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="p-2">
        <div className="grid grid-cols-5 gap-1 rounded-[var(--radius-control)] bg-sunk p-1" role="tablist" aria-label="How to buy or sell shares">
          {TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={mode === tab.mode}
              onClick={() => {
                setMode(tab.mode);
                setSignature(null);
                setError(null);
              }}
              className={`rounded-[calc(var(--radius-control)-2px)] px-1.5 py-2 text-[13px] leading-tight transition-all ${
                mode === tab.mode ? "bg-surface text-ink shadow-[0_1px_3px_rgb(20_37_28/0.15)]" : "text-ink-3 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "cash" && <DollarOrder basket={basket} navPerShare={navPerShare} onDone={onDone} />}
      {mode === "sell" && <SellOrderPanel basket={basket} navPerShare={navPerShare} shareBalance={shareBalance} onDone={onDone} />}
      {mode === "plan" && <PlanForm basket={basket} navPerShare={navPerShare} onDone={onDone} />}
      {(mode === "create" || mode === "redeem") && (
      <div className="p-6">
        <label className="block">
          <span className="text-xs text-ink-3">
            {mode === "create" ? "Shares to create" : "Shares to redeem"}
          </span>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.000001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="tnum display w-full border border-line bg-surface px-3 py-3 text-xl text-ink outline-none focus-visible:border-bind rounded-[var(--radius-panel)]"
            />
            {mode === "redeem" && shareBalance > 0n && (
              <button
                type="button"
                onClick={() =>
                  setAmount((Number(shareBalance) / ONE_SHARE).toString())
                }
                className="shrink-0 border border-line px-3 py-3 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink rounded-[var(--radius-control)]"
              >
                All
              </button>
            )}
          </div>
        </label>

        <p className="tnum mt-2 text-xs text-ink-3">
          {connected
            ? `You hold ${quantity(Number(shareBalance) / ONE_SHARE, 6)} ${basket.symbol}`
            : `${basket.symbol} shares`}
          {navPerShare != null && valid
            ? ` · about ${money(navPerShare * shares)} of components`
            : ""}
        </p>

        <div className="mt-6 border-t border-line pt-5">
          <p className="text-xs text-ink-3">
            {mode === "create"
              ? "You hand the vault"
              : "The vault hands you back"}
          </p>
          <ul className="mt-3 space-y-2.5">
            {rows.map((row) => {
              const value = mode === "create" ? row.need : row.back;
              return (
                <li
                  key={row.mint}
                  className="tnum flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-ink-2">
                    {row.symbol.replace(/x$/, "")}
                    {mode === "create" && row.grossedUp && (
                      <span
                        className="ml-1.5 text-xs text-ink-3"
                        title="PreStocks charges a transfer fee; the program grosses up the deposit so the vault still nets the recipe amount."
                      >
                        +fee
                      </span>
                    )}
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="text-ink">
                      {quantity(Number(value) / 10 ** row.decimals, 6)}
                    </span>
                    {mode === "create" && connected && (
                      <span
                        className="text-xs"
                        style={{
                          color: row.short
                            ? "var(--color-loss)"
                            : "var(--color-ink-3)",
                        }}
                      >
                        have {quantity(Number(row.have) / 10 ** row.decimals, 4)}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {mode === "create" && (basket.creatorFeeBps > 0 || basket.protocolFeeBps > 0) && (
          <p className="tnum mt-5 border-t border-line pt-5 text-xs leading-relaxed text-ink-3">
            You receive {quantity(Number(netShares) / ONE_SHARE, 6)}{" "}
            {basket.symbol}.
            {basket.creatorFeeBps > 0 && (
              <>
                {" "}The creator receives {quantity(Number(feeShares) / ONE_SHARE, 6)} (
                {percent(basket.creatorFeeBps / 100)}).
              </>
            )}
            {basket.protocolFeeBps > 0 && (
              <>
                {" "}Sheaf receives {quantity(Number(protocolShares) / ONE_SHARE, 6)} (
                {percent(basket.protocolFeeBps / 100)}).
              </>
            )}{" "}
            Fees are paid in new shares and never come out of the vault, so backing per share is unchanged.
          </p>
        )}

        {mode === "create" && shortSymbols.length > 0 && (
          <div className="mt-5 border border-line bg-surface p-4 rounded-[var(--radius-panel)]">
            <p className="text-sm leading-relaxed text-ink-2">
              Short on {shortSymbols.map((s) => s.replace(/x$/, "")).join(", ")}.
            </p>
            <div className="mt-3">
              <FaucetButton
                symbols={shortSymbols}
                onDone={() => void balances.reload()}
              />
            </div>
          </div>
        )}

        {mode === "redeem" && !enoughShares && valid && !signature && (
          <p className="mt-5 text-sm leading-relaxed text-loss">
            {shareBalance === 0n
              ? `You hold no ${basket.symbol} to redeem.`
              : `You only hold ${quantity(
                  Number(shareBalance) / ONE_SHARE,
                  6,
                )} ${basket.symbol}.`}
          </p>
        )}

        {!connected ? (
          <div className="mt-6">
            <ConnectButton block label={`Connect a wallet to ${mode} shares`} />
          </div>
        ) : (
        <button
          type="button"
          disabled={blocked || busy}
          onClick={submit}
          className="mt-6 w-full bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-3 rounded-[var(--radius-control)]"
        >
          {busy
            ? /* A basket with many components needs a second signature, so say
                 which one the wallet is asking about rather than hanging. */
              (step && step.total > 1
                ? `${mode === "create" ? "Creating" : "Redeeming"} · ${Math.min(
                    step.done + 1,
                    step.total,
                  )} of ${step.total}`
                : mode === "create"
                  ? "Creating…"
                  : "Redeeming…")
            : mode === "create"
              ? `Create ${basket.symbol}`
              : `Redeem ${basket.symbol}`}
        </button>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-loss pl-3 text-sm leading-relaxed text-loss">
            {error}
          </p>
        )}

        {signature && (
          <p className="mt-4 text-sm leading-relaxed text-gain">
            Done.{" "}
            <a
              href={explorerTx(signature)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-current underline-offset-4"
            >
              See the transaction
            </a>
          </p>
        )}

        <p className="mt-5 text-xs leading-relaxed text-ink-3">
          {mode === "create"
            ? "In kind, so the program reads no price. Amounts round up in the vault's favor."
            : "In kind, so redemption always works, whatever the market thinks the basket is worth. Amounts round down in the vault's favor."}
        </p>
      </div>
      )}
    </div>
  );
}

/**
 * The basket's history, first eight events only until asked for more. A busy
 * basket otherwise runs to dozens of near-identical rows before the footer.
 * The rows themselves come from the shared ledger table; this only folds them.
 */
const HISTORY_ROWS = 8;

function CappedHistory({ basket }: { basket: Basket }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recount = () =>
      setRows(Math.max(el.querySelectorAll("ul > li").length, el.querySelectorAll("tbody > tr").length));
    recount();
    const watch = new MutationObserver(recount);
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  return (
    <div>
      <div
        ref={ref}
        className={open ? undefined : "[&_tbody>tr:nth-child(n+9)]:hidden [&_ul>li:nth-child(n+9)]:hidden"}
      >
        <BasketHistory basket={basket} />
      </div>
      {rows > HISTORY_ROWS && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-4 rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-2.5 text-sm text-ink transition-colors hover:border-ink-3"
        >
          {open ? "Show the latest eight" : `Show all ${count(rows)} events`}
        </button>
      )}
    </div>
  );
}
