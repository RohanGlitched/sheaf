"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { basketHref, type ChainBasket, type ChainCard, type Deployment } from "@/lib/chains";
import {
  BASKET_ABI,
  ERC20_ABI,
  ONE_SHARE,
  TEMPO_PATH_USD,
  UI_MULTIPLIER_ABI,
  fromRaw,
  isTempo,
  navFrom,
  publicClientFor,
} from "@/lib/evm";
import { readHyperCorePrices, type PerpPrice } from "@/lib/hypercore";
import { count, money, percent, plural, quantity, shortAddress } from "@/lib/format";
import { slotColor } from "@/lib/palette";
import { SheafMark } from "./sheaf-mark";
import { useEvmWallet } from "./evm-wallet";
import { EvmTradePanel } from "./evm-trade";
import { EvmDeskBook } from "./evm-desk-book";
import { EvmFaucetStocks } from "./evm-faucet-stocks";
import { TempoSip } from "./tempo-sip";

/**
 * One Sheaf basket on an EVM chain, in full: the recipe, what it is worth, the
 * vault against what it owes, and the wallet flows to get in and out. Every
 * number below the fold is read from the chain in the browser.
 */

export type BasketReads = {
  supply: bigint;
  held: bigint[];
  mintCount: number;
  redeemCount: number;
  multipliers: (number | null)[];
  user: {
    shares: bigint;
    components: bigint[];
    basketAllowance: bigint[];
    stable: bigint;
    deskAllowance: bigint;
    gas: bigint;
  } | null;
};

export function useBasketReads(d: Deployment, basket: ChainBasket, address: Address | null) {
  const [reads, setReads] = useState<BasketReads | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [multipliers, setMultipliers] = useState<(number | null)[]>(basket.components.map(() => null));

  // The Scaled UI multiplier (ERC-8056) only moves on a corporate action; read it once.
  useEffect(() => {
    if (d.tokenSource !== "real") return;
    let live = true;
    const client = publicClientFor(d);
    void Promise.all(
      basket.components.map((c) =>
        client
          .readContract({ address: c.token as Address, abi: UI_MULTIPLIER_ABI, functionName: "uiMultiplier" })
          .then((m) => Number(m) / 1e18)
          .catch(() => null),
      ),
    ).then((m) => live && setMultipliers(m));
    return () => {
      live = false;
    };
  }, [d, basket]);

  const load = useCallback(async () => {
    const client = publicClientFor(d);
    const b = basket.address as Address;
    try {
      const [supply, held, mints, redeems] = await Promise.all([
        client.readContract({ address: b, abi: BASKET_ABI, functionName: "totalSupply" }),
        client.readContract({ address: b, abi: BASKET_ABI, functionName: "vaultBalances" }),
        client.readContract({ address: b, abi: BASKET_ABI, functionName: "mintCount" }),
        client.readContract({ address: b, abi: BASKET_ABI, functionName: "redeemCount" }),
      ]);
      let user: BasketReads["user"] = null;
      if (address) {
        const [shares, components, basketAllowance, stable, deskAllowance, gas] = await Promise.all([
          client.readContract({ address: b, abi: BASKET_ABI, functionName: "balanceOf", args: [address] }),
          Promise.all(basket.components.map((c) => client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }))),
          Promise.all(
            basket.components.map((c) => client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "allowance", args: [address, b] })),
          ),
          client.readContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
          client.readContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "allowance", args: [address, d.desk as Address] }),
          // Tempo has no gas token. Its getBalance is a placeholder; the real fee balance is pathUSD.
          isTempo(d)
            ? client.readContract({ address: TEMPO_PATH_USD, abi: ERC20_ABI, functionName: "balanceOf", args: [address] })
            : client.getBalance({ address }),
        ]);
        user = { shares, components, basketAllowance, stable, deskAllowance, gas };
      }
      setReads({ supply, held: [...held], mintCount: Number(mints), redeemCount: Number(redeems), multipliers: [], user });
      setError(null);
    } catch (err) {
      setError((err as Error).message?.split("\n")[0] ?? "read failed");
    }
  }, [d, basket, address]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return { reads: reads ? { ...reads, multipliers } : null, error, reload: load };
}

export function useHyperCoreNav(basket: ChainBasket) {
  const [perps, setPerps] = useState<Record<string, PerpPrice> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      readHyperCorePrices(basket.components.map((c) => c.symbol))
        .then((p) => live && setPerps(p))
        .catch(() => live && setPerps({}));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [basket]);
  const nav = perps ? navFrom(basket, Object.fromEntries(Object.entries(perps).map(([k, v]) => [k, v.price]))) : null;
  return { perps, nav };
}

const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";

export function EvmBasket({
  chain,
  deployment: d,
  basket,
  prices,
  pricedLive,
}: {
  chain: ChainCard;
  deployment: Deployment;
  basket: ChainBasket;
  /** Per-ticker USD, from Robinhood's Stock Token quotes, or the deploy-time prices if those failed. */
  prices: Record<string, number>;
  pricedLive: boolean;
}) {
  const wallet = useEvmWallet(d);
  const { reads, error, reload } = useBasketReads(d, basket, wallet.address);
  const hyper = useHyperCoreNav(basket);
  const [deskTick, setDeskTick] = useState(0);
  const nav = navFrom(basket, prices);
  const mirror = d.tokenSource !== "real";

  const rows = basket.components.map((c, i) => {
    const units = fromRaw(BigInt(c.unitsPerShare));
    const m = reads?.multipliers[i] ?? null;
    const price = prices[c.symbol];
    const value = price != null ? units * price : null;
    return { ...c, i, units, multiplier: m, price, value, weight: value != null && nav ? value / nav : null };
  });

  const supply = reads?.supply ?? null;
  const owed = basket.components.map((c) => (supply == null ? null : (BigInt(c.unitsPerShare) * supply) / ONE_SHARE));
  const backedRatio =
    reads && supply && supply > 0n
      ? Math.min(...owed.map((o, i) => (o == null || o === 0n ? 1 : Number((reads.held[i] * 1_000_000n) / o) / 1_000_000)))
      : null;
  const fullyBacked = reads ? owed.every((o, i) => o == null || reads.held[i] >= o) : null;
  const supplyNum = supply != null ? fromRaw(supply) : null;
  const siblings = d.baskets.filter((b) => b.address !== basket.address);

  const stalks = useMemo(
    () =>
      basket.components.map((c, i) => ({
        key: c.token,
        weight: c.weightBps / 10_000,
        color: slotColor(i),
        label: c.symbol,
      })),
    [basket],
  );

  const onDone = () => {
    void reload();
    setDeskTick((t) => t + 1);
    // Public RPCs can lag a block behind the receipt; read once more shortly after.
    setTimeout(() => {
      void reload();
      setDeskTick((t) => t + 1);
    }, 4000);
  };

  return (
    <div>
      <nav className="flex flex-wrap items-center gap-2 text-sm text-ink-3" aria-label="Breadcrumb">
        <Link href="/chains" className={link}>
          Chains
        </Link>
        <span aria-hidden>/</span>
        <span>{chain.name}</span>
        <span aria-hidden>/</span>
        <span className="text-ink-2">{basket.symbol}</span>
      </nav>

      <div className="mt-6 grid gap-12 [&>*]:min-w-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* ----------------------------------------------------------- left */}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="flex items-center gap-1.5 text-xs text-gain">
                <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
                Live on {d.label}
              </p>
              <h1 className="display mt-3 text-hero leading-[0.95] text-ink">{basket.name}</h1>
              <p className="tnum mt-3 text-sm text-ink-3">
                {basket.symbol} ·{" "}
                <a href={`${d.explorer}/address/${basket.address}`} target="_blank" rel="noreferrer" className={link}>
                  {shortAddress(basket.address, 6, 4)}
                </a>{" "}
                · creator fee {percent(basket.feeBps / 100)} of shares created
              </p>
            </div>
            <div className="text-left sm:text-right">
              <p className="text-xs text-ink-3">{mirror ? "One share, at the real stocks' price" : "One share"}</p>
              <p className="tnum display mt-1 text-title leading-none text-ink">{money(nav)}</p>
              <p className="mt-1.5 text-xs text-ink-3">{pricedLive ? "Robinhood Stock Token quotes" : "Prices at deploy; live quotes unreachable"}</p>
              <p className="tnum mt-1 text-xs text-ink-3">
                HyperCore 24/7: {hyper.nav != null ? money(hyper.nav) : hyper.perps ? "a component has no perp" : "reading"}
              </p>
            </div>
          </div>

          <p className="mt-8 max-w-[62ch] text-base leading-relaxed text-ink-2">
            One {basket.symbol} share is a claim on {basket.components.length} {plural(basket.components.length, "holding")} sitting in a contract
            on {chain.name} that has no owner, no pause and no upgrade path. Anyone can create a share by depositing the recipe, and any
            share can be redeemed for it.{" "}
            {mirror ? (
              <>
                No issuer has stock tokens on this testnet, so the holdings are labeled mirrors: free tokens named &ldquo;Tesla (Sheaf testnet
                mirror)&rdquo; and so on, worth nothing. The dollar figure is what the same recipe would be worth in the real shares.
              </>
            ) : (
              <>The holdings are Robinhood&apos;s own testnet stock tokens, the same contracts its faucet hands out.</>
            )}
          </p>

          <div className="mt-8 grid items-center gap-6 rounded-[var(--radius-panel)] border border-line bg-surface p-6 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <div className="mx-auto aspect-[56/60] w-full max-w-[15rem]">
              <SheafMark
                stalks={stalks}
                labels
                animate
                bandNote={backedRatio != null ? `${(Math.min(backedRatio, 9.999) * 100).toFixed(1)}% backed` : undefined}
                className="h-full w-full"
                title={`${basket.symbol} recipe`}
              />
            </div>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-control)] bg-line">
              <Cell label="Shares outstanding" value={supplyNum != null ? quantity(supplyNum, 4) : "—"} note={`${count(reads?.mintCount)} ${plural(reads?.mintCount ?? 0, "creation")}, ${count(reads?.redeemCount)} ${plural(reads?.redeemCount ?? 0, "redemption")}`} />
              <Cell label="Everything in the vault" value={nav != null && supplyNum != null ? money(nav * supplyNum) : "—"} note={mirror ? "At the real stocks' price" : "At Robinhood's quotes"} />
              <Cell
                label="Backing"
                value={fullyBacked == null ? "—" : supply === 0n ? "Empty" : fullyBacked ? "Full" : "Short"}
                note={supply === 0n ? "No shares exist yet" : "Held against owed, every component"}
                tone={fullyBacked === false ? "loss" : fullyBacked ? "gain" : undefined}
              />
              <Cell label="Cash desk" value={d.stable.symbol} note={d.stable.isMirror ? "A labeled test dollar" : d.network === "tempoTestnet" ? "Tempo's own TIP-20 dollar" : "Paxos Global Dollar, testnet"} />
            </dl>
          </div>
          {error && <p className="mt-3 text-sm text-loss">Could not read the chain just now: {error}</p>}
        </div>

        {/* ---------------------------------------------------------- right */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <EvmTradePanel d={d} basket={basket} wallet={wallet} reads={reads} nav={nav} onDone={onDone} />
        </div>
      </div>

      {d.tokenSource === "real" && <EvmFaucetStocks d={d} wallet={wallet} />}

      {isTempo(d) && (
        <section id="sip" className="mt-20 scroll-mt-24 border-t border-line pt-16">
          <TempoSip d={d} />
        </section>
      )}

      <div className="mt-16 grid gap-14 [&>*]:min-w-0 lg:grid-cols-2 lg:gap-16">
        {/* -------------------------------------------------------- recipe */}
        <section>
          <h2 className="display text-title text-ink">The recipe</h2>
          <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
            Written once, in the constructor, with no setter. The recipe is in raw token units, so a split or a dividend that a token applies
            through its multiplier accrues to every share without anyone touching the vault.
          </p>
          <div className="mt-7 min-w-0 overflow-x-auto border border-line">
            <table className="w-full border-collapse text-sm sm:min-w-[34rem]">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-3 py-3 font-normal sm:px-4">Holding</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">Per share</th>
                  <th className="hidden px-4 py-3 text-right font-normal sm:table-cell">Price</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">Value</th>
                  <th className="px-3 py-3 text-right font-normal sm:px-4">Weight</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.token} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-3 sm:px-4">
                      <div className="flex items-center gap-2.5">
                        <span aria-hidden className="size-2.5 shrink-0" style={{ background: slotColor(r.i) }} />
                        <a href={`${d.explorer}/address/${r.token}`} target="_blank" rel="noreferrer" className="text-ink hover:underline">
                          {r.symbol}
                        </a>
                        {mirror && <span className="text-xs text-ink-3">mirror</span>}
                      </div>
                    </td>
                    <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">
                      {quantity(r.units * (r.multiplier ?? 1), 6)}
                      {r.multiplier != null && <span className="block text-xs text-ink-3">× {r.multiplier.toFixed(4)} multiplier</span>}
                    </td>
                    <td className="tnum hidden px-4 py-3 text-right text-ink-2 sm:table-cell">{money(r.price)}</td>
                    <td className="tnum px-3 py-3 text-right text-ink sm:px-4">{money(r.value)}</td>
                    <td className="tnum px-3 py-3 text-right sm:px-4">
                      <span className="text-ink-2">{r.weight != null ? percent(r.weight * 100, 1) : "—"}</span>
                      {r.weight != null && Math.abs(r.weight * 10_000 - r.weightBps) > 5 && (
                        <span className="block text-xs text-ink-3">set {percent(r.weightBps / 100, 1)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.tokenSource === "real" && (
            <p className="mt-4 text-xs leading-relaxed text-ink-3">
              Robinhood Stock Tokens implement ERC-8056 Scaled UI Amount. The multiplier above is read live from each token&apos;s{" "}
              <span className="tnum">uiMultiplier()</span>; units shown are what a holder sees after it.
            </p>
          )}
        </section>

        {/* ------------------------------------------------------- backing */}
        <section>
          <h2 className="display text-title text-ink">Is it actually backed?</h2>
          <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
            Held is the vault&apos;s balance of each token right now, from <span className="tnum">vaultBalances()</span>. Owed is the recipe
            times <span className="tnum">totalSupply()</span>. Deposits round up and redemptions round down, so held can never fall below owed.
          </p>
          {!reads ? (
            <p className="mt-7 text-sm text-ink-3">Reading the vault…</p>
          ) : (
            <>
              <div
                className="mt-7 flex items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-sm"
                style={{
                  borderColor: fullyBacked ? "color-mix(in oklab, var(--color-gain) 45%, transparent)" : "var(--color-loss)",
                  color: fullyBacked ? "var(--color-gain)" : "var(--color-loss)",
                }}
              >
                <span aria-hidden className="size-2 rotate-45 bg-current" />
                {supply === 0n
                  ? "No shares exist yet, so there is nothing to back."
                  : fullyBacked
                    ? `Every one of the ${quantity(supplyNum, 4)} ${plural(supplyNum ?? 0, "share")} outstanding is fully backed.`
                    : "A vault is short. Do not create more shares."}
              </div>
              <div className="mt-5 min-w-0 overflow-x-auto border border-line">
                <table className="w-full border-collapse text-sm sm:min-w-[26rem]">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-3">
                      <th className="px-3 py-3 font-normal sm:px-4">Holding</th>
                      <th className="px-3 py-3 text-right font-normal sm:px-4">Held</th>
                      <th className="px-3 py-3 text-right font-normal sm:px-4">Owed</th>
                      <th className="px-3 py-3 text-right font-normal sm:px-4">Surplus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {basket.components.map((c, i) => {
                      const h = reads.held[i] ?? 0n;
                      const o = owed[i] ?? 0n;
                      return (
                        <tr key={c.token} className="border-b border-line/60 last:border-0">
                          <td className="px-3 py-3 text-ink sm:px-4">{c.symbol}</td>
                          <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">{quantity(fromRaw(h), 8)}</td>
                          <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">{quantity(fromRaw(o), 8)}</td>
                          <td className="tnum px-3 py-3 text-right sm:px-4" style={{ color: h >= o ? "var(--color-ink-3)" : "var(--color-loss)" }}>
                            {h - o === 0n ? "0" : `${(h - o).toString()} raw`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <details className="mt-6 border border-line">
            <summary className="cursor-pointer px-4 py-3 text-sm text-ink-2 marker:text-bind hover:text-ink">Check it without this page</summary>
            <div className="space-y-3 border-t border-line px-4 py-4 text-sm leading-relaxed text-ink-2">
              <p>Two reads against the public RPC, no key:</p>
              <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-page px-3 py-2.5 text-[11px] leading-relaxed">
                <code>{`cast call ${basket.address} "totalSupply()(uint256)" --rpc-url ${d.rpc}\ncast call ${basket.address} "vaultBalances()(uint256[])" --rpc-url ${d.rpc}`}</code>
              </pre>
              <p>
                For every component, vaultBalances[i] must be at least unitsPerShare[i] × totalSupply ÷ 10^18. The recipe is in{" "}
                <span className="tnum">components()</span>.
              </p>
            </div>
          </details>
        </section>
      </div>

      <EvmDeskBook d={d} basket={basket} wallet={wallet} tick={deskTick} onDone={onDone} />

      <HyperCorePricing basket={basket} perps={hyper.perps} nav={hyper.nav} quoteNav={nav} />

      <section className="mt-20 border-t border-line pt-10">
        <h2 className="text-sm text-ink-3">The contracts, verified</h2>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <li>
            <a href={`${d.explorer}/address/${basket.address}`} target="_blank" rel="noreferrer" className={link}>
              {basket.symbol} basket
            </a>
          </li>
          <li>
            <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className={link}>
              Creation desk
            </a>
          </li>
          <li>
            <a href={`${d.explorer}/address/${d.factory}`} target="_blank" rel="noreferrer" className={link}>
              Factory
            </a>
          </li>
          <li>
            <a href={`${d.explorer}/address/${d.stable.address}`} target="_blank" rel="noreferrer" className={link}>
              {d.stable.symbol}
            </a>
          </li>
        </ul>
        {siblings.length > 0 && (
          <p className="mt-6 text-sm text-ink-2">
            Also on {chain.name}:{" "}
            {siblings.map((b, i) => (
              <span key={b.address}>
                {i > 0 && ", "}
                <Link href={basketHref(d.network, b.symbol)} className={link}>
                  {b.name} ({b.symbol})
                </Link>
              </span>
            ))}
            .
          </p>
        )}
      </section>
    </div>
  );
}

function Cell({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "gain" | "loss" }) {
  return (
    <div className="bg-surface p-4">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd>
        <span className="tnum display mt-1.5 block text-xl" style={{ color: tone ? `var(--color-${tone})` : "var(--color-ink)" }}>
          {value}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-ink-3">{note}</span>
      </dd>
    </div>
  );
}

/** The same recipe priced from HyperCore's stock perps. Nothing is deployed on Hyperliquid. */
function HyperCorePricing({
  basket,
  perps,
  nav,
  quoteNav,
}: {
  basket: ChainBasket;
  perps: Record<string, PerpPrice> | null;
  nav: number | null;
  quoteNav: number | null;
}) {
  return (
    <section className="mt-20 border-t border-line pt-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <h2 className="display text-title text-ink">Priced around the clock</h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
            The stock exchanges close; HyperCore&apos;s stock perpetuals do not. This prices the same recipe from trade.xyz&apos;s oracle on
            Hyperliquid testnet, read through HyperEVM&apos;s oraclePx precompile with a plain <span className="tnum">eth_call</span>, no gas
            and no key. It is a reading, not a deployment: nothing of Sheaf runs on Hyperliquid yet.
          </p>
          <p className="tnum display mt-6 text-title text-ink">{nav != null ? money(nav) : "—"}</p>
          <p className="mt-1 text-xs text-ink-3">
            Priced from HyperCore, not deployed
            {nav != null && quoteNav != null && ` · ${(((nav - quoteNav) / quoteNav) * 100).toFixed(2)}% against the stock quotes`}
          </p>
        </div>
        <div className="min-w-0 overflow-x-auto border border-line">
          <table className="w-full border-collapse text-sm sm:min-w-[26rem]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-3 py-3 font-normal sm:px-4">Perp</th>
                <th className="px-3 py-3 text-right font-normal sm:px-4">Precompile index</th>
                <th className="px-3 py-3 text-right font-normal sm:px-4">Oracle price</th>
              </tr>
            </thead>
            <tbody>
              {basket.components.map((c) => {
                const p = perps?.[c.symbol];
                return (
                  <tr key={c.token} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-3 text-ink sm:px-4">{p?.coin ?? `xyz:${c.symbol}`}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-3 sm:px-4">{p?.index ?? "—"}</td>
                    <td className="tnum px-3 py-3 text-right text-ink-2 sm:px-4">{perps == null ? "reading" : p ? money(p.price) : "no perp"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
