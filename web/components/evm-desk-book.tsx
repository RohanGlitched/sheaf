"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import {
  DESK_ABI,
  DESK_V2_ABI,
  auctionSharesAt,
  deskAddress,
  explainEvmError,
  fromRaw,
  readDeskOrders,
  readDeskOrdersV2,
  v2Of,
  v3Of,
  type DeskOrder,
  type DeskOrderV2,
  type DeskVersion,
} from "@/lib/evm";
import { quantity, shortAddress, timeAgo } from "@/lib/format";
import { useKeeperKick } from "@/lib/use-keeper-kick";
import { KeeperPulse } from "./keeper-pulse";
import type { EvmWallet } from "./evm-wallet";

const th = "px-3 py-3 font-normal sm:px-4";
const td = "px-3 py-3 sm:px-4";

/**
 * The creation desks' books, read straight from the contracts. First the auction
 * desks, newest first (v3, whose protocol fee goes to a cold treasury, then v2), each
 * auction's count falling live; under them the v1 desk's fixed-price orders, which
 * still settle exactly as before. The house filler is just one participant; anyone
 * holding the components can fill.
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
  const desks = ([3, 2] as const).filter((v) => (v === 3 ? v3Of(d) : v2Of(d)));
  const [auctions, setAuctions] = useState<Record<number, DeskOrderV2[]> | null>(null);
  const [orders, setOrders] = useState<DeskOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Ask the house filler to look at this chain's open orders while the page is open.
  useKeeperKick("/api/evm-keeper", { network: d.network });
  const desksKey = desks.join(",");

  const load = useCallback(async () => {
    try {
      const versions = desksKey ? (desksKey.split(",").map(Number) as (2 | 3)[]) : [];
      const [rows, o] = await Promise.all([Promise.all(versions.map((v) => readDeskOrdersV2(d, v === 3 ? 10 : 6, v))), readDeskOrders(d, 6)]);
      setAuctions(Object.fromEntries(versions.map((v, i) => [v, rows[i]])));
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
  }, [d, desksKey]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [load, tick]);

  // A live auction's count falls every second; tick the clock while one is open.
  const live = !!auctions && Object.values(auctions).some((rows) => rows.some((o) => o.status === "Open" && o.endTs > now));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(t);
  }, [live]);

  const symbolOf = (addr: string) => d.baskets.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.symbol ?? shortAddress(addr);
  const house = d.deployer?.toLowerCase();
  const me = wallet.address?.toLowerCase();
  const who = (a: string) => (a.toLowerCase() === house ? "the house" : a.toLowerCase() === me ? "you" : shortAddress(a, 6, 4));

  async function askHouse(version: DeskVersion, id: number) {
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

  async function cancel(version: DeskVersion, id: number) {
    setActing(`${version}:${id}`);
    setNote(null);
    try {
      const to = deskAddress(d, version)!;
      const data =
        version === 1
          ? encodeFunctionData({ abi: DESK_ABI, functionName: "cancel", args: [BigInt(id)] })
          : encodeFunctionData({ abi: DESK_V2_ABI, functionName: "cancel", args: [BigInt(id)] });
      await wallet.send([{ label: version === 1 ? `Cancel order #${id}` : `Cancel auction #${id}`, to, data }], () => undefined);
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
    </td>
  );

  const actionsCell = (version: DeskVersion, id: number, buyer: string, expired: boolean) => {
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

  const idCell = (id: number) => <td className={`tnum ${td} text-ink-2`}>#{id}</td>;

  const rowClass = (b: string) => `border-b border-line/60 last:border-0 ${b.toLowerCase() === basket.address.toLowerCase() ? "" : "text-ink-3"}`;
  const deskLink = (label: string, address: string) => (
    <>
      {label}{" "}
      <a href={`${d.explorer}/address/${address}`} target="_blank" rel="noreferrer" className="tnum underline decoration-line-strong underline-offset-4 hover:text-ink">
        {shortAddress(address, 6, 4)}
      </a>
    </>
  );

  const auctionTable = (version: 2 | 3, rows: DeskOrderV2[]) => (
    <div className="mt-4 min-w-0 overflow-x-auto border border-line">
      <table className="w-full border-collapse text-sm sm:min-w-[46rem]">
        {head("Shares owed")}
        <tbody>
          {rows.map((o) => {
            const expired = now > 0 && o.endTs < now;
            const count = now > 0 ? auctionSharesAt(o, now) : o.startShares;
            const range = `${quantity(fromRaw(o.startShares), 4)} → ${quantity(fromRaw(o.endShares), 4)}`;
            return (
              <tr key={o.id} className={rowClass(o.basket)}>
                {idCell(o.id)}
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
                <td className={`${td} text-right`}>{o.status === "Open" && actionsCell(version, o.id, o.buyer, expired)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const v2 = v2Of(d);
  const v3 = v3Of(d);

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
          <KeeperPulse which="evm" className="mt-4" />
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          {v3 && (
            <>
              {deskLink("Desk v3", v3.desk)}
              {" · "}
            </>
          )}
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

      {desks.map((v) => {
        const rows = auctions?.[v];
        return (
          <div key={v}>
            <h3 className="mt-10 text-sm text-ink-3">
              {v === 3 ? "Auctions, v3 desk (protocol fee to a cold treasury)" : v3 ? "Auctions, v2 desk (earlier; its protocol fee went to the house key)" : "Auctions, v2 desk"}
            </h3>
            {!rows ? (
              <p className="mt-4 text-sm text-ink-3">Reading the desk…</p>
            ) : rows.length === 0 ? (
              <p className="mt-4 text-sm text-ink-3">{v === desks[0] ? "No auctions yet. Order with dollars above to post the first one." : "No auctions."}</p>
            ) : (
              auctionTable(v, rows)
            )}
          </div>
        );
      })}

      <h3 className="mt-10 text-sm text-ink-3">{desks.length > 0 ? "Fixed-price orders, v1 desk" : "Orders"}</h3>
      {desks.length > 0 && (
        <p className="mt-2 max-w-[62ch] text-xs leading-relaxed text-ink-3">
          The first desk: N shares for a fixed amount, no auction and no protocol fee. It is immutable, so it stays live for the orders it holds;
          new dollar orders go to the newest auction desk.
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
                    {idCell(o.id)}
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
