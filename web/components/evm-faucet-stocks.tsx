"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { basketHref, type Deployment } from "@/lib/chains";
import { ERC20_ABI, fromRaw, publicClientFor } from "@/lib/evm";
import { quantity } from "@/lib/format";
import { slotColor } from "@/lib/palette";
import type { EvmWallet } from "./evm-wallet";

/**
 * "Bring your faucet stocks." Robinhood's testnet faucet hands anyone 5 of each
 * stock token a day. This reads what the connected wallet already holds of
 * Robinhood's tokens and says how much of each basket those tokens can bind,
 * so the shortest path to a Sheaf share uses Robinhood's assets, not ours.
 */
export function EvmFaucetStocks({ d, wallet }: { d: Deployment; wallet: EvmWallet }) {
  const [held, setHeld] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (!wallet.address) return;
    let live = true;
    const client = publicClientFor(d);
    const load = () =>
      Promise.all(
        d.tokens.map(async (t) => {
          const raw = await client.readContract({ address: t.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address!] });
          return [t.symbol, { raw: fromRaw(raw, t.decimals) }] as const;
        }),
      ).then((rows) => {
        if (!live) return;
        setHeld(Object.fromEntries(rows.map(([s, v]) => [s, v.raw])));
      });
    void load().catch(() => undefined);
    const t = setInterval(() => document.visibilityState === "visible" && void load().catch(() => undefined), 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [d, wallet.address]);

  const bindable = d.baskets.map((b) => {
    if (!held) return { b, shares: null as number | null };
    const shares = Math.min(...b.components.map((c) => (held[c.symbol] ?? 0) / (Number(BigInt(c.unitsPerShare)) / 1e18)));
    return { b, shares: Math.floor(shares * 1e4) / 1e4 };
  });

  return (
    <section id="faucet-stocks" className="mt-20 scroll-mt-24 border-t border-line pt-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div>
          <h2 className="display text-title text-ink">Bring your faucet stocks</h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
            Robinhood&apos;s{" "}
            <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
              testnet faucet
            </a>{" "}
            gives anyone 5 TSLA, AMZN, AMD, PLTR and NFLX a day. Those are the exact tokens these baskets hold, so whatever is already in your
            wallet can be bound into shares here, in kind, with no swap and no price.
          </p>
        </div>
        <div>
          {!wallet.address ? (
            <p className="rounded-[var(--radius-control)] border border-dashed border-line-strong px-5 py-6 text-sm text-ink-3">
              Connect a wallet above to read what it holds of Robinhood&apos;s tokens.
            </p>
          ) : (
            <>
              <ul className="grid grid-cols-5 gap-2">
                {d.tokens.map((t, i) => (
                  <li key={t.address} className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-3">
                    <span className="flex items-center gap-1.5 text-xs text-ink-3">
                      <span aria-hidden className="size-2" style={{ background: slotColor(i) }} />
                      {t.symbol}
                    </span>
                    <span className="tnum display mt-1 block text-lg text-ink">{held ? quantity(held[t.symbol] ?? 0, 3) : "…"}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-4 divide-y divide-line rounded-[var(--radius-panel)] border border-line bg-surface">
                {bindable.map(({ b, shares }) => (
                  <li key={b.address} className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                    <span className="text-ink">
                      {b.name} <span className="text-ink-3">({b.symbol})</span>
                    </span>
                    <span className="tnum text-ink-2">
                      {shares == null ? "…" : shares > 0 ? `binds ${quantity(shares, 4)} shares` : "nothing to bind yet"}
                      <Link href={basketHref(d.network, b.symbol)} className="ml-3 text-bind underline-offset-4 hover:underline">
                        Open
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
