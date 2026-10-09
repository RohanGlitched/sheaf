"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { EVM_CHAINS, NEXT, basketHref, type ChainBasket, type ChainCard, type Deployment } from "@/lib/chains";
import { navFrom } from "@/lib/evm";
import { readHyperCorePrices } from "@/lib/hypercore";
import { money, plural, quantity } from "@/lib/format";
import { slotColor } from "@/lib/palette";
import { SheafMark } from "./sheaf-mark";
import { useBaskets } from "@/lib/use-baskets";
import { splitTestBaskets } from "@/lib/hidden";

const ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function vaultBalances() view returns (uint256[])",
]);
const ONE_SHARE = 10n ** 18n;

type BasketRead = { supply: number; coverage: number | null };

function useChainReads(d: Deployment | undefined) {
  const [reads, setReads] = useState<Record<string, BasketRead> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!d) return;
    let live = true;
    const client = createPublicClient({ transport: http(d.rpc, { timeout: 12_000 }) });
    (async () => {
      try {
        const out: Record<string, BasketRead> = {};
        await Promise.all(
          d.baskets.map(async (b) => {
            const [supply, held] = await Promise.all([
              client.readContract({ address: b.address as Address, abi: ABI, functionName: "totalSupply" }),
              client.readContract({ address: b.address as Address, abi: ABI, functionName: "vaultBalances" }),
            ]);
            let coverage: number | null = null;
            if (supply > 0n) {
              coverage = Math.min(
                ...b.components.map((c, i) => {
                  const owed = (BigInt(c.unitsPerShare) * supply) / ONE_SHARE;
                  return owed === 0n ? 1 : Number((held[i] * 1_000_000n) / owed) / 1_000_000;
                }),
              );
            }
            out[b.address] = { supply: Number((supply * 1000n) / ONE_SHARE) / 1000, coverage };
          }),
        );
        if (live) setReads(out);
      } catch {
        if (live) setError(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [d]);
  return { reads, error };
}

const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";

/** The Solana side, filled from the program: the baskets anyone can open, each with its recipe as a sheaf. */
function SolanaCard() {
  const { baskets } = useBaskets();
  const shown = baskets ? splitTestBaskets(baskets).shown : null;
  return (
    <li className="flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-6 lg:col-span-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display text-2xl text-ink">Solana</h3>
        <span className="flex items-center gap-1.5 rounded-full bg-bind-wash px-2.5 py-0.5 text-xs text-bind">Devnet · home</span>
      </div>
      <p className="mt-3 text-sm font-medium leading-relaxed text-ink">
        xStocks and PreStocks, the program, the launch markets, dollar orders and monthly plans.
      </p>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        Baskets hold xStocks and PreStocks, priced from mainnet, created and redeemed on devnet against mirror mints with the same decimals and
        dividend multiplier. Every plan, order and fill is decoded on the ledger.
      </p>
      <p className="mt-4 text-xs text-ink-3">
        {shown ? `${shown.length} ${plural(shown.length, "basket")}, our own test baskets left out` : "Reading the program…"} · paid in test dollars
      </p>
      <ul className="-mx-2 mt-2 grid sm:grid-cols-2">
        {(shown ?? []).slice(0, 4).map((b) => (
          <li key={b.address}>
            <Link
              href={`/basket/${b.address}`}
              className="group flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 transition-colors hover:bg-raised"
            >
              <span className="size-9 shrink-0">
                <SheafMark
                  stalks={b.components.map((c, i) => ({ key: c.mint, weight: c.weightBps / 10_000, color: slotColor(i) }))}
                  className="h-full w-full"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">
                  {b.name} <span className="text-ink-3">{b.symbol}</span>
                </span>
                <span className="block truncate text-xs text-ink-3">
                  {b.components.length} {plural(b.components.length, "holding")}
                </span>
              </span>
              <span aria-hidden className="text-sm text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-bind">
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-3 pt-6 text-sm">
        <Link href="/explore" className="rounded-[var(--radius-control)] bg-bind px-4 py-2 font-medium text-white hover:bg-bind-deep">
          Browse Solana baskets
        </Link>
        <Link href="/ledger" className="rounded-[var(--radius-control)] border border-line-strong px-4 py-2 text-ink hover:border-ink-3">
          Every transaction
        </Link>
      </div>
    </li>
  );
}

function BasketRow({ d, b, read }: { d: Deployment; b: ChainBasket; read?: BasketRead }) {
  return (
    <li>
      <Link
        href={basketHref(d.network, b.symbol)}
        className="group flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 transition-colors hover:bg-raised"
      >
        <span className="size-9 shrink-0">
          <SheafMark
            stalks={b.components.map((c, i) => ({ key: c.token, weight: c.weightBps / 10_000, color: slotColor(i) }))}
            className="h-full w-full"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">
            {b.name} <span className="text-ink-3">{b.symbol}</span>
          </span>
          <span className="tnum block truncate text-xs text-ink-3">
            {read
              ? `${quantity(read.supply, 3)} ${plural(read.supply, "share")}${read.coverage != null ? ` · ${(Math.min(read.coverage, 9.999) * 100).toFixed(1)}% backed` : " · no shares yet"}`
              : `${b.components.length} ${plural(b.components.length, "holding")}`}
          </span>
        </span>
        <span aria-hidden className="text-sm text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-bind">
          →
        </span>
      </Link>
    </li>
  );
}

function FeatureCard({ chain }: { chain: ChainCard }) {
  const d = chain.deployment!;
  const { reads, error } = useChainReads(d);
  return (
    <li className="flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display text-2xl text-ink">{chain.name}</h3>
        <span className="flex items-center gap-1.5 text-xs text-gain">
          <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
          Testnet
        </span>
      </div>
      <p className="mt-3 text-sm font-medium leading-relaxed text-ink">{chain.native}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-3">{chain.why}</p>
      <p className="mt-4 text-xs text-ink-3">
        {d.tokenSource === "real" ? "Real stock tokens" : "Labeled testnet mirrors"} · paid in {d.stable.symbol}
        {error && " · could not reach the chain just now"}
      </p>
      <ul className="-mx-2 mt-2">
        {d.baskets.map((b) => (
          <BasketRow key={b.address} d={d} b={b} read={reads?.[b.address]} />
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-5 text-xs text-ink-2">
        {d.network === "tempoTestnet" && (
          <Link href={`${basketHref(d.network, d.baskets[0].symbol)}#sip`} className={`font-medium text-bind ${link}`}>
            Run the access-key plan
          </Link>
        )}
        {d.tokenSource === "real" && (
          <Link href={`${basketHref(d.network, d.baskets[0].symbol)}#faucet-stocks`} className={`font-medium text-bind ${link}`}>
            Bind your faucet stocks
          </Link>
        )}
        <a href={`${d.explorer}/address/${d.factory}`} target="_blank" rel="noreferrer" className={link}>
          Factory
        </a>
        <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className={link}>
          Dollar desk
        </a>
      </div>
    </li>
  );
}

function PortableCard({ chain }: { chain: ChainCard }) {
  const d = chain.deployment!;
  const { reads, error } = useChainReads(d);
  return (
    <li className="flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display text-xl text-ink">{chain.name}</h3>
        <span className="flex items-center gap-1.5 text-xs text-gain">
          <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
          Testnet
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{chain.why}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
        {chain.native} Paid in {d.stable.symbol}.{error && " Could not reach the chain just now."}
      </p>
      <ul className="-mx-2 mt-3">
        {d.baskets.map((b) => (
          <BasketRow key={b.address} d={d} b={b} read={reads?.[b.address]} />
        ))}
      </ul>
      <div className="mt-auto flex flex-wrap gap-x-4 pt-4 text-xs text-ink-2">
        <a href={`${d.explorer}/address/${d.factory}`} target="_blank" rel="noreferrer" className={link}>
          Factory
        </a>
        <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className={link}>
          Dollar desk
        </a>
      </div>
    </li>
  );
}

/** Hyperliquid, priced but not deployed: one recipe valued from HyperCore's 24/7 stock perps. */
function NextStrip() {
  const mirrorBasket = EVM_CHAINS.find((c) => c.key === "tempoTestnet")?.deployment?.baskets[0];
  const [nav, setNav] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!mirrorBasket) return;
    let live = true;
    readHyperCorePrices(mirrorBasket.components.map((c) => c.symbol))
      .then((p) => live && setNav(navFrom(mirrorBasket, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.price])))))
      .catch(() => live && setNav(null));
    return () => {
      live = false;
    };
  }, [mirrorBasket]);
  if (NEXT.length === 0) return null;
  return (
    <section className="mt-14 border-t border-line pt-6" aria-labelledby="next-chains">
      <h2 id="next-chains" className="sr-only">
        Next
      </h2>
      <ul className="space-y-3">
        {NEXT.map((c) => (
          <li key={c.key} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span className="text-xs uppercase tracking-[0.12em] text-ink-3">Next</span>
            <span className="text-ink">{c.name}</span>
            <span className="min-w-0 flex-1 text-ink-3">{c.why} Nothing deployed yet.</span>
            {c.key === "hyperEvmTestnet" && mirrorBasket && (
              <span className="tnum text-ink-2">
                {mirrorBasket.symbol} recipe at {nav === undefined ? "…" : nav == null ? "—" : money(nav)}
                <span className="ml-1.5 text-xs text-ink-3">priced from HyperCore, not deployed</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChainsBoard() {
  const feature = EVM_CHAINS.filter((c) => c.deployment && c.tier === "feature");
  const portable = EVM_CHAINS.filter((c) => c.deployment && c.tier === "portable");
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="display text-title text-ink">Running now</h2>
        <p className="text-sm text-ink-3">
          Solana devnet and {feature.length + portable.length} EVM testnets · every figure read from the chain when you open it
        </p>
      </div>
      <ul className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SolanaCard />
        {feature.map((c) => (
          <FeatureCard key={c.key} chain={c} />
        ))}
      </ul>
      {portable.length > 0 && (
        <>
          <p className="mt-10 max-w-[70ch] text-sm leading-relaxed text-ink-2">
            The same contracts, deployed unchanged where stock tokens are issued on mainnet but not yet on testnet. Each holds labeled mirrors, and
            every flow works from a wallet.
          </p>
          <ul className="mt-4 grid gap-4 md:grid-cols-3">
            {portable.map((c) => (
              <PortableCard key={c.key} chain={c} />
            ))}
          </ul>
        </>
      )}
      <NextStrip />
    </div>
  );
}
