"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import { DESK_ABI, explainEvmError, fromRaw, readDeskOrders, type DeskOrder } from "@/lib/evm";
import { quantity, shortAddress, timeAgo } from "@/lib/format";
import { useKeeperKick } from "@/lib/use-keeper-kick";
import { teamTag, teamWallet } from "@/lib/team-wallets";
import type { EvmWallet } from "./evm-wallet";

/** The tag beside a buyer the team runs: the house filler, or one of our test wallets. Null for anyone else. */
function buyerPill(address: string): string | null {
  const w = teamWallet(address);
  if (!w || teamTag(address) == null) return null;
  return w.role === "house" ? "house" : w.role === "test" ? "our test" : "Sheaf";
}

/**
 * The creation desk's book, read straight from the contract: every recent dollar
 * order on this chain, who placed it, and who filled it. The house filler is just
 * one participant; anyone holding the components can fill an open order.
 */
export function EvmDeskBook({
  d,
  basket,
  wallet,
  tick,
  onDone,
}: {
  d: Deployment;
  basket: ChainBasket;
  wallet: EvmWallet;
  tick: number;
  onDone: () => void;
}) {
  const [orders, setOrders] = useState<DeskOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Ask the house filler to look at this chain's open orders while the page is open.
  useKeeperKick("/api/evm-keeper", { network: d.network });

  const load = useCallback(async () => {
    try {
      setOrders(await readDeskOrders(d, 10));
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(
        /\b(403|429)\b|rate limit|fetch failed|network/i.test(String((err as Error)?.message))
          ? "The chain's connection is busy. The book will try again in a moment."
          : "The desk could not be read just now. The book will try again in a moment.",
      );
    }
  }, [d]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [load, tick]);

  const symbolOf = (addr: string) => d.baskets.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.symbol ?? shortAddress(addr);
  const house = d.deployer?.toLowerCase();
  const me = wallet.address?.toLowerCase();

  async function askHouse(id: number) {
    setActing(id);
    setNote(null);
    try {
      const res = await fetch("/api/evm-keeper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, order: id }),
      });
      const json = (await res.json().catch(() => ({}))) as { results?: { status: string; reason?: string }[]; error?: string };
      const r = json.results?.[0];
      setNote(r ? (r.status === "filled" ? `Order #${id} filled by the house.` : `Order #${id}: ${r.reason ?? r.status}.`) : (json.error ?? "The house did not answer. Try again in a moment."));
      await load();
      onDone();
    } catch {
      setNote("The house could not be reached. Try again in a moment.");
    } finally {
      setActing(null);
    }
  }

  async function cancel(id: number) {
    setActing(id);
    setNote(null);
    try {
      await wallet.send([{ label: `Cancel order #${id}`, to: d.desk as Address, data: encodeFunctionData({ abi: DESK_ABI, functionName: "cancel", args: [BigInt(id)] }) }], () => undefined);
      setNote(`Order #${id} canceled; the dollars are back.`);
      await load();
      onDone();
    } catch (err) {
      setNote(explainEvmError(err));
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="mt-20 border-t border-line pt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-title text-ink">The desk&apos;s book</h2>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            Dollar orders on {d.label}, newest first, read from <span className="tnum">getOrder()</span>. A buyer escrows {d.stable.symbol}; any
            participant who delivers the components in kind collects it, and the shares are minted straight to the buyer. The house filler is one
            such participant{d.tokenSource === "real" ? ", and only while it holds enough of Robinhood's tokens" : ""}.
          </p>
        </div>
        <p className="text-xs text-ink-3">
          Desk{" "}
          <a href={`${d.explorer}/address/${d.desk}`} target="_blank" rel="noreferrer" className="tnum underline decoration-line-strong underline-offset-4 hover:text-ink">
            {shortAddress(d.desk, 6, 4)}
          </a>
        </p>
      </div>
      {error && <p className="mt-6 text-sm text-loss">{error}</p>}
      {!orders ? (
        <p className="mt-7 text-sm text-ink-3">Reading the desk…</p>
      ) : orders.length === 0 ? (
        <p className="mt-7 text-sm text-ink-3">No orders yet.</p>
      ) : (
        <div className="mt-7 min-w-0 overflow-x-auto border border-line">
          <table className="w-full border-collapse text-sm sm:min-w-[44rem]">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-3 py-3 font-normal sm:px-4">Order</th>
                <th className="px-3 py-3 font-normal sm:px-4">Basket</th>
                <th className="px-3 py-3 text-right font-normal sm:px-4">Shares</th>
                <th className="px-3 py-3 text-right font-normal sm:px-4">Escrow</th>
                <th className="hidden px-4 py-3 font-normal sm:table-cell">Buyer</th>
                <th className="px-3 py-3 font-normal sm:px-4">Status</th>
                <th className="px-3 py-3 sm:px-4" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const expired = now > 0 && o.expiry * 1000 < now;
                const mine = me && o.buyer.toLowerCase() === me;
                return (
                  <tr key={o.id} className={`border-b border-line/60 last:border-0 ${o.basket.toLowerCase() === basket.address.toLowerCase() ? "" : "text-ink-3"}`}>
                    <td className="tnum px-3 py-3 text-ink-2 sm:px-4">
                      #{o.id}
                      {/* On phones the buyer column is hidden, so the team tag rides with the order number. */}
                      {buyerPill(o.buyer) && <span className="mt-0.5 block text-[11px] text-ink-3 sm:hidden">{buyerPill(o.buyer)}</span>}
                    </td>
                    <td className="px-3 py-3 sm:px-4">{symbolOf(o.basket)}</td>
                    <td className="tnum px-3 py-3 text-right sm:px-4">{quantity(fromRaw(o.shares), 4)}</td>
                    <td className="tnum px-3 py-3 text-right sm:px-4">
                      {fromRaw(o.usdgAmount, d.stable.decimals).toFixed(2)} {d.stable.symbol}
                    </td>
                    <td className="tnum hidden px-4 py-3 sm:table-cell">
                      <a href={`${d.explorer}/address/${o.buyer}`} target="_blank" rel="noreferrer" className="hover:underline">
                        {mine ? "you" : shortAddress(o.buyer, 6, 4)}
                      </a>
                      {buyerPill(o.buyer) && (
                        <span className="ml-2 whitespace-nowrap rounded-full bg-sunk px-2 py-0.5 text-[11px] leading-none text-ink-3" title="A wallet the Sheaf team runs; not counted as an outside buyer">
                          {buyerPill(o.buyer)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 sm:px-4">
                      {o.status === "Filled" ? (
                        <span className="text-gain">
                          Filled by{" "}
                          <a href={`${d.explorer}/address/${o.filler}`} target="_blank" rel="noreferrer" className="tnum hover:underline">
                            {o.filler.toLowerCase() === house ? "the house" : o.filler.toLowerCase() === me ? "you" : shortAddress(o.filler, 6, 4)}
                          </a>
                        </span>
                      ) : o.status === "Open" ? (
                        <span className={expired ? "text-loss" : "text-ink"}>{expired ? "Expired" : `Open, expires ${timeAgo(o.expiry)}`}</span>
                      ) : (
                        <span className="text-ink-3">{o.status}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right sm:px-4">
                      {o.status === "Open" && (
                        <span className="flex justify-end gap-3 text-xs">
                          {!expired && (
                            <button type="button" disabled={acting != null} onClick={() => void askHouse(o.id)} className="text-bind underline-offset-4 hover:underline disabled:opacity-50">
                              {acting === o.id ? "…" : "Ask the house"}
                            </button>
                          )}
                          {(mine || expired) && wallet.onChain && (
                            <button type="button" disabled={acting != null} onClick={() => void cancel(o.id)} className="text-ink-2 underline-offset-4 hover:underline disabled:opacity-50">
                              Cancel
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="mt-4 text-sm text-ink-2">{note}</p>}
    </section>
  );
}
