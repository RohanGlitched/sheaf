"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { openLaunches, readDbcState, type DbcPoolInfo } from "@/lib/dbc";
import { count, quantity } from "@/lib/format";
import { TOKEN_2022_PROGRAM_ID, type Basket } from "@/lib/sheaf";

type Holding = { basket: Basket; info: DbcPoolInfo; amount: number; valueSol: number | null; graduated: boolean };

/** Launch tokens this wallet bought on any basket's curve, valued at the curve's price now. */
export function LaunchHoldings({ baskets }: { baskets: Basket[] | null }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const owner = publicKey?.toBase58() ?? null;
  const key = baskets?.map((b) => b.address).join(",") ?? "";

  useEffect(() => {
    if (!owner || !baskets?.length) return;
    let live = true;
    void (async () => {
      // Only official launches count: a pool squatting a basket's launch address
      // is not that basket's token, whatever its name says.
      const official = await openLaunches(connection, baskets);
      const launched = baskets.filter((b) => official.has(b.address));
      const infos = launched.map((b) => official.get(b.address)!);
      const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
        programId: TOKEN_2022_PROGRAM_ID,
      });
      const held = new Map<string, number>();
      for (const { account } of accounts.value) {
        const info = account.data.parsed.info;
        held.set(info.mint, (held.get(info.mint) ?? 0) + (info.tokenAmount.uiAmount ?? 0));
      }
      const mine = infos
        .map((info, i) => ({ info, basket: launched[i], amount: held.get(info.baseMint) ?? 0 }))
        .filter((h) => h.amount > 0);
      const rows = await Promise.all(
        mine.map(async (h) => {
          const state = await readDbcState(connection, h.info, h.basket.creator).catch(() => null);
          return {
            ...h,
            valueSol: state ? (state.cap / h.info.supply) * h.amount : null,
            graduated: state?.migrated ?? false,
          };
        }),
      );
      if (live) setHoldings(rows);
    })().catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, owner, key]);

  if (!owner || holdings.length === 0) return null;

  return (
    <section className="mt-16">
      <h2 className="display text-title text-ink">Launch tokens</h2>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        Bought on a basket&rsquo;s Meteora curve. Each is a separate token priced off its
        basket, valued here at the curve&rsquo;s price right now.
      </p>
      <div className="mt-7 divide-y divide-line border border-line">
        {holdings.map((h) => (
          <Link
            key={h.info.baseMint}
            href={`/basket/${h.basket.address}#launch`}
            className="flex flex-wrap items-baseline justify-between gap-4 px-5 py-5 transition-colors hover:bg-raised"
          >
            <div className="min-w-0">
              <p className="display truncate text-lg text-ink">{h.info.baseSymbol}</p>
              <p className="tnum mt-0.5 text-xs text-ink-3">
                {count(Math.floor(h.amount))} tokens · {h.info.baseName}
              </p>
            </div>
            <div className="text-right">
              <p className="tnum display text-lg text-ink">
                {h.valueSol != null ? `${quantity(h.valueSol, 4)} SOL` : "—"}
              </p>
              <p className="text-xs text-ink-3">
                {h.graduated ? "Graduated to DAMM v2" : "On the curve"}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
