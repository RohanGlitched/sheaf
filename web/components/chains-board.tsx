"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { EVM_CHAINS, type ChainCard, type Deployment } from "@/lib/chains";
import { slotColor } from "@/lib/palette";
import { SheafMark } from "./sheaf-mark";

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

function SolanaCard() {
  return (
    <li className="flex flex-col rounded-[var(--radius-panel)] border border-ink bg-surface p-6 lg:col-span-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display text-2xl text-ink">Solana</h3>
        <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs text-page">Home</span>
      </div>
      <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
        The program, the launch markets, cash orders and monthly plans live here. Baskets hold xStocks
        and PreStocks, priced from mainnet, created and redeemed on devnet against mirrors that carry
        the same Token-2022 extensions.
      </p>
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

function ChainTile({ chain }: { chain: ChainCard }) {
  const d = chain.deployment;
  const { reads, error } = useChainReads(d);
  const first = d?.baskets[0];

  return (
    <li className={`flex flex-col rounded-[var(--radius-panel)] border p-6 ${d ? "border-line bg-surface" : "border-dashed border-line-strong bg-raised"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="display text-2xl text-ink">{chain.name}</h3>
        {d ? (
          <span className="flex items-center gap-1.5 text-xs text-gain">
            <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
            Live on testnet
          </span>
        ) : (
          <span className="text-xs text-ink-3">Not deployed yet</span>
        )}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">{chain.why}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-3">{chain.native}</p>

      {d && first && (
        <div className="mt-5 flex items-center gap-4 rounded-[var(--radius-control)] bg-raised p-3">
          <div className="size-20 shrink-0">
            <SheafMark
              stalks={first.components.map((c, i) => ({ key: c.token, weight: c.weightBps / 10_000, color: slotColor(i) }))}
              className="h-full w-full"
            />
          </div>
          <div className="min-w-0 text-sm">
            <p className="truncate text-ink">{d.baskets.map((b) => b.symbol).join(", ")}</p>
            <p className="mt-0.5 text-xs text-ink-3">
              {d.tokenSource === "real" ? "Real stock tokens" : "Labelled testnet mirrors"} · paid in {d.stable.symbol}
            </p>
            <p className="tnum mt-1.5 text-xs text-ink-2">
              {error
                ? "Could not reach the chain just now"
                : reads
                  ? d.baskets
                      .map((b) => {
                        const r = reads[b.address];
                        if (!r) return null;
                        return `${b.symbol}: ${r.supply} shares${r.coverage != null ? `, ${(Math.min(r.coverage, 9.999) * 100).toFixed(1)}% backed` : ""}`;
                      })
                      .filter(Boolean)
                      .join(" · ")
                  : "Reading the vaults"}
            </p>
          </div>
        </div>
      )}

      {d && (
        <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-5 text-xs">
          <a href={`${d.explorer}/address/${d.factory}`} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            Factory
          </a>
          <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            Cash desk
          </a>
          {d.baskets.map((b) => (
            <a key={b.address} href={`${d.explorer}/address/${b.address}`} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              {b.symbol} vault
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

export function ChainsBoard() {
  return (
    <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <SolanaCard />
      {EVM_CHAINS.map((c) => (
        <ChainTile key={c.key} chain={c} />
      ))}
    </ul>
  );
}
