"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import {
  DESK_ABI,
  DESK_V2_ABI,
  auctionSharesAt,
  explainEvmError,
  fromRaw,
  readDeskOrders,
  readDeskOrdersV2,
  v2Of,
  type DeskOrder,
  type DeskOrderV2,
} from "@/lib/evm";
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

const th = "px-3 py-3 font-normal sm:px-4";
const td = "px-3 py-3 sm:px-4";

/**
 * The creation desks' books, read straight from the contracts. First the v2 desk:
 * Dutch auctions, each with its count falling live, who placed it and who filled it.
 * Under it, the v1 desk's fixed-price orders, which still settle exactly as before.
 * The house filler is just one participant; anyone holding the components can fill.
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
  const v2 = v2Of(d);
  const [auctions, setAuctions] = useState<DeskOrderV2[] | null>(null);
  const [orders, setOrders] = useState<DeskOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Ask the house filler to look at this chain's open orders while the page is open.
  useKeeperKick("/api/evm-keeper", { network: d.network });

  const load = useCallback(async () => {
    try {
      const [a, o] = await Promise.all([v2 ? readDeskOrdersV2(d, 10) : Promise.resolve([] as DeskOrderV2[]), readDeskOrders(d, 6)]);
      setAuctions(a);
      setOrders(o);
      setNow(Math.floor(Date.now() / 1000));
      setError(null);
    } catch (err) {
      setError(
        /\b(403|429)\b|rate limit|fetch failed|network/i.test(String((err as Error)?.message))
          ? "The chain's connection is busy. The book will try again in a moment."
          : "The desk could not be read just now. The book will try again in a moment.",
      );
    }
  }, [d, v2]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [load, tick]);

  // A live auction's count falls every second; tick the clock while one is open.
  const live = !!auctions?.some((o) => o.status === "Open" && o.endTs > now);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, [live]);

  const symbolOf = (addr: string) => d.baskets.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.symbol ?? shortAddress(addr);
  const house = d.deployer?.toLowerCase();
  const me = wallet.address?.toLowerCase();
  const who = (a: string) => (a.toLowerCase() === house ? "the house" : a.toLowerCase() === me ? "you" : shortAddress(a, 6, 4));

  async function askHouse(version: 1 | 2, id: number) {
    setActing(`${version}:${id}`);
    setNote(null);
    try {
      const res = await fetch("/api/evm-keeper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, order: id, version }),
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

  async function cancel(version: 1 | 2, id: number) {
    setActing(`${version}:${id}`);
    setNote(null);
    try {
      const step =
        version === 2
          ? { label: `Cancel auction #${id}`, to: v2!.desk as Address, data: encodeFunctionData({ abi: DESK_V2_ABI, functionName: "cancel", args: [BigInt(id)] }) }
          : { label: `Cancel order #${id}`, to: d.desk as Address, data: encodeFunctionData({ abi: DESK_ABI, functionName: "cancel", args: [BigInt(id)] }) };
      await wallet.send([step], () => undefined);
      setNote(`Order #${id} canceled; the dollars are back with its buyer.`);
      await load();
      onDone();
    } catch (err) {
      setNote(explainEvmError(err));
    } finally {
      setActing(null);
    }
  }

  const buyerCell = (address: string) => (
    <td className="tnum hidden px-4 py-3 sm:table-cell">
      <a href={`${d.explorer}/address/${address}`} target="_blank" rel="noreferrer" className="hover:underline">
        {me && address.toLowerCase() === me ? "you" : shortAddress(address, 6, 4)}
      </a>
      {buyerPill(address) && (
        <span className="ml-2 whitespace-nowrap rounded-full bg-sunk px-2 py-0.5 text-[11px] leading-none text-ink-3" title="A wallet the Sheaf team runs; not counted as an outside buyer">
          {buyerPill(address)}
        </span>
      )}
    </td>
  );

  const actionsCell = (version: 1 | 2, id: number, buyer: string, expired: boolean) => {
    const mine = !!me && buyer.toLowerCase() === me;
    return (
      <span className="flex justify-end gap-3 text-xs">
        {!expired && (
          <button type="button" disabled={acting != null} onClick={() => void askHouse(version, id)} className="text-bind underline-offset-4 hover:underline disabled:opacity-50">
            {acting === `${version}:${id}` ? "…" : "Ask the house"}
          </button>
        )}
        {(mine || expired) && wallet.onChain && (
          <button type="button" disabled={acting != null} onClick={() => void cancel(version, id)} className="text-ink-2 underline-offset-4 hover:underline disabled:opacity-50">
            {expired && !mine ? "Return the dollars" : "Cancel"}
          </button>
        )}
      </span>
    );
  };

  const filledBy = (filler: string) => (
    <span className="text-gain">
      Filled by{" "}
      <a href={`${d.explorer}/address/${filler}`} target="_blank" rel="noreferrer" className="tnum hover:underline">
        {who(filler)}
      </a>
    </span>
  );

  const head = (sharesLabel: string) => (
    <thead>
      <tr className="border-b border-line text-left text-xs text-ink-3">
        <th className={th}>Order</th>
        <th className={th}>Basket</th>
        <th className={`${th} text-right`}>{sharesLabel}</th>
        <th className={`${th} text-right`}>Escrow</th>
        <th className="hidden px-4 py-3 font-normal sm:table-cell">Buyer</th>
        <th className={th}>Status</th>
        <th className={td} />
      </tr>
    </thead>
  );

  const idCell = (id: number, buyer: string) => (
    <td className={`tnum ${td} text-ink-2`}>
      #{id}
      {/* On phones the buyer column is hidden, so the team tag rides with the order number. */}
      {buyerPill(buyer) && <span className="mt-0.5 block text-[11px] text-ink-3 sm:hidden">{buyerPill(buyer)}</span>}
    </td>
  );

  const rowClass = (b: string) => `border-b border-line/60 last:border-0 ${b.toLowerCase() === basket.address.toLowerCase() ? "" : "text-ink-3"}`;
  const deskLink = (label: string, address: string) => (
    <>
      {label}{" "}
      <a href={`${d.explorer}/address/${address}`} target="_blank" rel="noreferrer" className="tnum underline decoration-line-strong underline-offset-4 hover:text-ink">
        {shortAddress(address, 6, 4)}
      </a>
    </>
  );

  return (
    <section className="mt-20 border-t border-line pt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-title text-ink">The desk&apos;s book</h2>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            Dollar orders on {d.label}, newest first, read from <span className="tnum">getOrder()</span>. A buyer escrows {d.stable.symbol} and
            posts a Dutch auction: the shares they must receive start high and fall until a participant delivers the components in kind and
            collects the escrow. The shares are minted straight to the buyer, less the creator fee and the 0.10% protocol fee. The house filler
            is one such participant and fills at fair plus 0.15%
            {d.tokenSource === "real" ? ", only while it holds enough of Robinhood's tokens" : ""}.
          </p>
        </div>
        <p className="text-xs text-ink-3">
          {v2 && (
            <>
              {deskLink("Desk v2", v2.desk)}
              {" · "}
            </>
          )}
          {deskLink("Desk v1", d.desk)}
        </p>
      </div>
      {error && <p className="mt-6 text-sm text-loss">{error}</p>}

      {v2 && (
        <>
          <h3 className="mt-10 text-sm text-ink-3">Auctions, v2 desk</h3>
          {!auctions ? (
            <p className="mt-4 text-sm text-ink-3">Reading the desk…</p>
          ) : auctions.length === 0 ? (
            <p className="mt-4 text-sm text-ink-3">No auctions yet. Order with dollars above to post the first one.</p>
          ) : (
            <div className="mt-4 min-w-0 overflow-x-auto border border-line">
              <table className="w-full border-collapse text-sm sm:min-w-[46rem]">
                {head("Shares owed")}
                <tbody>
                  {auctions.map((o) => {
                    const expired = now > 0 && o.endTs < now;
                    const count = now > 0 ? auctionSharesAt(o, now) : o.startShares;
                    const range = `${quantity(fromRaw(o.startShares), 4)} → ${quantity(fromRaw(o.endShares), 4)}`;
                    return (
                      <tr key={o.id} className={rowClass(o.basket)}>
                        {idCell(o.id, o.buyer)}
                        <td className={td}>{symbolOf(o.basket)}</td>
                        <td className={`tnum ${td} text-right`}>
                          {o.status === "Filled" ? (
                            quantity(fromRaw(o.sharesOut), 4)
                          ) : o.status === "Open" && !expired ? (
                            <>
                              <span className="text-ink">{quantity(fromRaw(count), 4)}</span>
                              <span className="block text-[11px] text-ink-3">{range}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">{range}</span>
                          )}
                        </td>
                        <td className={`tnum ${td} text-right`}>
                          {fromRaw(o.cashAmount, d.stable.decimals).toFixed(2)} {d.stable.symbol}
                        </td>
                        {buyerCell(o.buyer)}
                        <td className={td}>
                          {o.status === "Filled" ? (
                            filledBy(o.filler)
                          ) : o.status === "Open" ? (
                            <span className={expired ? "text-loss" : "text-ink"}>{expired ? "Ended unfilled" : `Live, ${Math.max(0, o.endTs - now)}s left`}</span>
                          ) : (
                            <span className="text-ink-3">{o.status === "Cancelled" ? "Returned" : o.status}</span>
                          )}
                        </td>
                        <td className={`${td} text-right`}>{o.status === "Open" && actionsCell(2, o.id, o.buyer, expired)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h3 className="mt-10 text-sm text-ink-3">{v2 ? "Fixed-price orders, v1 desk" : "Orders"}</h3>
      {v2 && (
        <p className="mt-2 max-w-[62ch] text-xs leading-relaxed text-ink-3">
          The first desk: N shares for a fixed amount, no auction and no protocol fee. It is immutable, so it stays live for the orders it holds;
          new dollar orders go to the v2 desk.
        </p>
      )}
      {!orders ? (
        <p className="mt-4 text-sm text-ink-3">Reading the desk…</p>
      ) : orders.length === 0 ? (
        <p className="mt-4 text-sm text-ink-3">No orders yet.</p>
      ) : (
        <div className="mt-4 min-w-0 overflow-x-auto border border-line">
          <table className="w-full border-collapse text-sm sm:min-w-[44rem]">
            {head("Shares")}
            <tbody>
              {orders.map((o) => {
                const expired = now > 0 && o.expiry < now;
                return (
                  <tr key={o.id} className={rowClass(o.basket)}>
                    {idCell(o.id, o.buyer)}
                    <td className={td}>{symbolOf(o.basket)}</td>
                    <td className={`tnum ${td} text-right`}>{quantity(fromRaw(o.shares), 4)}</td>
                    <td className={`tnum ${td} text-right`}>
                      {fromRaw(o.usdgAmount, d.stable.decimals).toFixed(2)} {d.stable.symbol}
                    </td>
                    {buyerCell(o.buyer)}
                    <td className={td}>
                      {o.status === "Filled" ? (
                        filledBy(o.filler)
                      ) : o.status === "Open" ? (
                        <span className={expired ? "text-loss" : "text-ink"}>{expired ? "Expired" : `Open, expires ${timeAgo(o.expiry)}`}</span>
                      ) : (
                        <span className="text-ink-3">{o.status === "Cancelled" ? "Canceled" : o.status}</span>
                      )}
                    </td>
                    <td className={`${td} text-right`}>{o.status === "Open" && actionsCell(1, o.id, o.buyer, expired)}</td>
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
