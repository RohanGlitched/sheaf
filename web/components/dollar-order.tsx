"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { tokenAccount, TOKEN_2022_PROGRAM_ID } from "@/lib/sheaf";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Basket } from "@/lib/sheaf";
import { placeOrderIx, cancelOrderIx, freshNonce, requiredShares, decodeOrder, netSharesFor, type Order } from "@/lib/desk";
import { eventsInLogs } from "@/lib/ledger";
import { confirmSignature } from "@/lib/confirm";
import { chainClockOffset, chainNow, explainError, signFresh } from "@/lib/tx";
import { explorerTx } from "@/lib/config";
import { useCash, CASH, toCashRaw, fromCashRaw } from "@/lib/use-cash";
import { money, moneyWhole, timeAgo } from "@/lib/format";
import { ConnectButton } from "./connect-button";

const AUCTION_SECS = 90;
/** Seconds between signing and the auction's start, so confirmation never eats into it. The program allows a future start. */
export const START_BUFFER_SECS = 8;

/** Wake the house keeper and the second filler. Fire and forget: both routes throttle themselves. */
export function kickFillers() {
  fetch("/api/keeper", { method: "POST", keepalive: true }).catch(() => {});
  fetch("/api/filler2", { method: "POST", keepalive: true }).catch(() => {});
}
const BAND_BPS = 200;
/**
 * The house filler takes orders from $5 (keeper-server's fill filter). A smaller
 * order would only wait out its auction and come back, so the form starts there.
 */
export const MIN_ORDER_DOLLARS = 5;

/**
 * What a filler pays on mainnet routes to buy this basket's stocks, in basis
 * points over spot, by order size in dollars: one way, and the round trip
 * (GET /api/route-cost, the same Jupiter quotes as /api/fill-cost). A size that
 * cannot be routed reads null.
 */
export type RouteCost = {
  basket: string;
  bps: Record<string, number | null>;
  roundTripBps?: Record<string, number | null>;
  /** ISO time of the quote (older answers sent unix seconds or milliseconds). */
  at: string | number;
};

/** The house filler's margin, which it waits for inside the band before it fills. */
const HOUSE_MARGIN_BPS = 15;

/**
 * The measured one-way route cost for a basket (GET /api/route-cost), or null
 * while it loads or when the route is unavailable. Null never blocks anything.
 */
export function useRouteCost(basket: string): RouteCost | null {
  const [cost, setCost] = useState<RouteCost | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/route-cost?basket=${encodeURIComponent(basket)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: RouteCost | null) => {
        if (live && j && j.bps && typeof j.bps === "object") setCost(j);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [basket]);
  return cost;
}

/** The quote for an order of `dollars`: the measured size nearest to it, with that size, or null if none was measured. */
export function routeQuoteFor(cost: RouteCost | null, dollars: number): { size: number; bps: number; roundTrip: number | null } | null {
  if (!cost) return null;
  const sizes = Object.keys(cost.bps)
    .map(Number)
    .filter((s) => Number.isFinite(s) && Number.isFinite(cost.bps[String(s)]));
  if (sizes.length === 0) return null;
  const target = Number.isFinite(dollars) && dollars > 0 ? dollars : 100;
  const size = sizes.reduce((a, b) => (Math.abs(Math.log(b / target)) < Math.abs(Math.log(a / target)) ? b : a));
  const roundTrip = cost.roundTripBps?.[String(size)];
  return { size, bps: cost.bps[String(size)] as number, roundTrip: Number.isFinite(roundTrip) ? (roundTrip as number) : null };
}

/** The one-way route cost for an order of `dollars`, or null if none was measured. */
export const routeBpsFor = (cost: RouteCost | null, dollars: number): number | null => routeQuoteFor(cost, dollars)?.bps ?? null;

/** Unix seconds of a quote's time, whatever form the route sent. */
const quotedAt = (at: string | number) => (typeof at === "string" ? Date.parse(at) / 1000 : at > 1e12 ? at / 1000 : at);

/** "about 0.42%", or "next to nothing" when routes are at or better than fair, so a negative cost never reads as "-0.03%". */
export const routeCostText = (bps: number) => (bps <= 0.5 ? "next to nothing" : `about ${(bps / 100).toFixed(2)}%`);

/**
 * The route cost as one line, with the order size it was measured at, both
 * ways, and its age. Above the house filler's margin, it says the house will
 * wait deeper into the auction or not fill, though other fillers may.
 */
export function RouteCostNote({
  cost,
  dollars,
  verb = "buying",
  bandBps = 200,
}: {
  cost: RouteCost | null;
  dollars: number;
  verb?: "buying" | "selling";
  /** The auction's band: above it the form says plainly that nobody can fill, so this line stays quiet. */
  bandBps?: number;
}) {
  const q = routeQuoteFor(cost, dollars);
  if (!q || !cost) return null;
  const at = quotedAt(cost.at);
  return (
    <p className="tnum mt-1.5 text-xs leading-relaxed text-ink-3">
      On mainnet routes, for a {moneyWhole(q.size)} order, {verb} these stocks costs a filler {routeCostText(q.bps)} one way
      {q.roundTrip != null ? ` (${routeCostText(q.roundTrip).replace("about ", "")} round trip)` : ""}
      {Number.isFinite(at) ? `, measured ${timeAgo(at)}` : ""}.
      {q.bps > HOUSE_MARGIN_BPS && q.bps <= bandBps
        ? ` That is above Sheaf's filler's ${(HOUSE_MARGIN_BPS / 100).toFixed(2)}% margin, so it waits deeper into the auction or doesn't fill; other fillers may.`
        : ""}
    </p>
  );
}

/** True when no filler could buy the stocks inside the auction's band today, so a dollar order or plan run could not fill. */
export const routeOutsideBand = (bps: number | null, bandBps = 200) => bps != null && bps > bandBps;

type Stage =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "open"; order: Order; signature: string }
  | { kind: "filled"; shares: number; cash: number; signature: string }
  | { kind: "expired"; order: Order; signature: string }
  /** Signature null when the keeper returned it and its transaction could not be read. */
  | { kind: "refunded"; cash: number; signature: string | null };

/**
 * Buy shares with dollars.
 *
 * The dollars go into an escrow the program controls, and the number of shares
 * they buy falls over ninety seconds (AUCTION_SECS), from 2% above the fair
 * count to 2% below. The first filler to deliver the stocks at the current count gets
 * the dollars; the vault still receives the real stocks. Nobody's price is
 * trusted: competition between fillers sets it.
 */
export function DollarOrder({ basket, navPerShare, onDone }: { basket: Basket; navPerShare: number | null; onDone: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction, connected } = useWallet();
  const cash = useCash();
  const [dollars, setDollars] = useState("100");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [refunding, setRefunding] = useState(false);

  const amount = Number(dollars);
  const tooSmall = Number.isFinite(amount) && amount > 0 && amount < MIN_ORDER_DOLLARS;
  const valid = Number.isFinite(amount) && amount >= MIN_ORDER_DOLLARS;
  const fair = valid && navPerShare ? amount / navPerShare : null;
  const creatorFeeBps = basket.creatorFeeBps;
  const protocolFeeBps = basket.protocolFeeBps ?? 0;
  // The order names the shares the buyer receives. The filler delivers the stocks for the gross count and the
  // basket's creator and protocol fees come out of it, so the auction runs ±2% around the fair count net of both.
  const quote = useCallback(
    (fairShares: number) => {
      const gross = BigInt(Math.floor(fairShares * 1e6));
      return {
        start: netSharesFor((gross * BigInt(10_000 + BAND_BPS)) / 10_000n, creatorFeeBps, protocolFeeBps),
        end: netSharesFor((gross * BigInt(10_000 - BAND_BPS)) / 10_000n, creatorFeeBps, protocolFeeBps),
      };
    },
    [creatorFeeBps, protocolFeeBps],
  );
  const bounds = useMemo(() => (fair ? quote(fair) : null), [fair, quote]);
  // The latest fair price, read again when the order is built: the quote shown can be minutes old by the time the wallet signs.
  const navRef = useRef(navPerShare);
  useEffect(() => {
    navRef.current = navPerShare;
  }, [navPerShare]);
  const [notice, setNotice] = useState<string | null>(null);
  const feeBps = creatorFeeBps + protocolFeeBps;
  const short = cash.balance != null && valid && cash.balance < toCashRaw(amount);
  const routeCost = useRouteCost(basket.address);
  const routeBps = routeBpsFor(routeCost, amount);
  const blocked = routeOutsideBand(routeBps, BAND_BPS);

  // While an order is open, tick the clock and watch the order account: when the
  // account disappears, a filler has taken it.
  useEffect(() => {
    if (stage.kind !== "open") return;
    const order = stage.order;
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    let live = true;
    const watch = async () => {
      // Ask the house keeper and the second filler to look; any filler may beat them.
      kickFillers();
      for (let i = 0; i < 200 && live; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const key = new PublicKey(order.address);
        const info = await connection.getAccountInfo(key).catch(() => undefined);
        if (info === null) {
          const next = await whatClosed(order, stage.signature);
          if (!live) return;
          setStage(next ?? { kind: "filled", shares: Number(requiredShares(order, Math.floor(Date.now() / 1000))) / 1e6, cash: fromCashRaw(order.cashAmount), signature: stage.signature });
          cash.reload();
          onDone();
          return;
        }
        if (Math.floor(Date.now() / 1000) > order.endTs + 3) {
          setStage({ kind: "expired", order, signature: stage.signature });
          return;
        }
        if (i % 2 === 1) kickFillers();
      }
    };
    watch();
    return () => {
      live = false;
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  // An expired order is still worth watching: the keeper returns a buyer's
  // dollars once a ten-minute grace has passed, and the page should say so the
  // moment it does.
  useEffect(() => {
    if (stage.kind !== "expired") return;
    const order = stage.order;
    let live = true;
    const watch = async () => {
      fetch("/api/keeper", { method: "POST" }).catch(() => {});
      for (let i = 0; i < 240 && live; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!live) return;
        const info = await connection.getAccountInfo(new PublicKey(order.address)).catch(() => undefined);
        if (info === null) {
          const next = await whatClosed(order, stage.signature);
          if (!live) return;
          setStage(next ?? { kind: "refunded", cash: fromCashRaw(order.cashAmount), signature: null });
          setError(null);
          cash.reload();
          onDone();
          return;
        }
        if (i % 12 === 11) fetch("/api/keeper", { method: "POST" }).catch(() => {});
      }
    };
    watch();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  /**
   * An order account is gone: read what closed it, a fill or a refund, from its
   * last transaction. Null when that transaction cannot be read or says neither.
   */
  async function whatClosed(order: Order, placedWith: string): Promise<Stage | null> {
    const key = new PublicKey(order.address);
    const sigs = await connection.getSignaturesForAddress(key, { limit: 3 }).catch(() => []);
    const last = sigs.find((s) => s.signature !== placedWith && !s.err)?.signature;
    if (!last) return null;
    const tx = await connection.getTransaction(last, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    const events = eventsInLogs(tx?.meta?.logMessages);
    const filled = events.find((e) => e.kind === "filled");
    const returned = events.find((e) => e.kind === "returned");
    if (filled) return { kind: "filled", shares: filled.shares ?? 0, cash: filled.cash ?? fromCashRaw(order.cashAmount), signature: last };
    if (returned) return { kind: "refunded", cash: returned.cash ?? fromCashRaw(order.cashAmount), signature: last };
    return null;
  }

  async function place() {
    if (!publicKey || !bounds || !valid || blocked) return;
    setError(null);
    setNotice(null);
    setStage({ kind: "signing" });
    try {
      // Built right before the wallet opens, and rebuilt if the signature comes back stale: the auction's clock and
      // price start when the order can actually land, not when the quote was first shown.
      // The auction's clock is the chain's, not this device's: a slow device clock could start it too far back.
      const offset = await chainClockOffset(connection);
      const { order, signature } = await signFresh({
        connection,
        payer: publicKey,
        signTransaction,
        sendTransaction,
        onStale: () => setNotice("The wallet was open a while, so the price and the auction clock were refreshed. Approve once more."),
        build: () => {
          const nav = navRef.current ?? navPerShare!;
          const fresh = quote(amount / nav);
          // A few seconds' head start so confirmation never eats into the auction; the program allows a future start.
          const startTs = chainNow(offset) + START_BUFFER_SECS;
          const { order, ix } = placeOrderIx({
            buyer: publicKey,
            basket: new PublicKey(basket.address),
            cashMint: CASH.mint,
            cashProgram: CASH.program,
            nonce: freshNonce(),
            cashAmount: toCashRaw(amount),
            startShares: fresh.start,
            endShares: fresh.end,
            startTs,
            endTs: startTs + AUCTION_SECS,
          });
          // The share account the fill will pay into, created by the buyer, idempotently.
          const shareMint = new PublicKey(basket.shareMint);
          const shareAccount = createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            tokenAccount(shareMint, publicKey, TOKEN_2022_PROGRAM_ID),
            publicKey,
            shareMint,
            TOKEN_2022_PROGRAM_ID,
          );
          return { order, transaction: new Transaction().add(shareAccount, ix) };
        },
      });
      setNotice(null);
      // Sent: wake the fillers now, so a slow confirmation here never eats into their time.
      kickFillers();
      await confirmSignature(connection, signature);
      // The order is on chain: wake both fillers now rather than waiting for their schedules.
      kickFillers();
      const info = await connection.getAccountInfo(order);
      const decoded = info ? decodeOrder(order, new Uint8Array(info.data)) : null;
      if (!decoded) throw new Error("The order was placed but could not be read back.");
      setNow(Math.floor(Date.now() / 1000));
      setStage({ kind: "open", order: decoded, signature });
      cash.reload();
    } catch (err) {
      setError(explainError(err));
      setNotice(null);
      setStage({ kind: "idle" });
    }
  }

  async function refund(order: Order, placedWith: string) {
    if (!publicKey || refunding) return;
    setError(null);
    setRefunding(true);
    // The keeper may have returned it already; never ask for a signature that can only fail.
    const gone = async () => (await connection.getAccountInfo(new PublicKey(order.address)).catch(() => undefined)) === null;
    const settled = async () => {
      const next = await whatClosed(order, placedWith);
      setStage(next ?? { kind: "refunded", cash: fromCashRaw(order.cashAmount), signature: null });
      cash.reload();
      onDone();
    };
    try {
      if (await gone()) return await settled();
      const signature = await sendTransaction(new Transaction().add(cancelOrderIx({ caller: publicKey, order })), connection);
      await confirmSignature(connection, signature);
      setStage({ kind: "refunded", cash: fromCashRaw(order.cashAmount), signature });
      cash.reload();
      onDone();
    } catch (err) {
      // Lost a race with the keeper: the dollars are back either way.
      if (await gone().catch(() => false)) await settled().catch(() => setError(explainError(err, { action: "cancel" })));
      else setError(explainError(err, { action: "cancel" }));
    } finally {
      setRefunding(false);
    }
  }

  const open = stage.kind === "open" ? stage.order : null;
  const progress = open ? Math.min(1, Math.max(0, (now - open.startTs) / (open.endTs - open.startTs))) : 0;
  const current = open ? Number(requiredShares(open, now)) / 1e6 : null;

  return (
    <div className="p-6">
      <p className="text-sm leading-relaxed text-ink-2">
        Pay in dollars and let fillers compete to deliver the stocks. The vault still receives the real
        components; you never trust anyone&apos;s price.
      </p>

      {(stage.kind === "idle" || stage.kind === "signing") && (
        <>
          <label className="mt-5 block">
            <span className="text-xs text-ink-3">Dollars to spend</span>
            <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
              <span className="text-ink-3">$</span>
              <input
                value={dollars}
                onChange={(e) => setDollars(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                className="tnum w-full bg-transparent text-lg text-ink outline-none"
                aria-label="Dollars to spend"
              />
            </div>
          </label>
          {tooSmall && (
            <p className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-ink-2" aria-live="polite">
              The smallest order is {money(MIN_ORDER_DOLLARS)}. The house filler starts there, so a smaller order would only wait out
              its auction and come back.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-3">
            <span className="tnum">
              {cash.balance == null ? "Test dollars on devnet" : `You hold ${money(fromCashRaw(cash.balance))} in test dollars`}
            </span>
            {connected && (
              <button type="button" onClick={cash.claim} disabled={cash.claiming} className="text-bind underline decoration-bind/40 underline-offset-4 hover:decoration-bind disabled:opacity-60">
                {cash.claiming ? "Sending…" : "Get 1,000 test dollars"}
              </button>
            )}
          </div>

          {bounds && (
            <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4 text-sm">
              <p className="text-ink-2">
                You receive between{" "}
                <span className="tnum text-ink">{(Number(bounds.end) / 1e6).toFixed(4)}</span> and{" "}
                <span className="tnum text-ink">{(Number(bounds.start) / 1e6).toFixed(4)}</span> {basket.symbol}.
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                The offer starts 2% above the fair count at {money(navPerShare)} a share and falls to 2% below over ninety seconds
                {feeBps > 0
                  ? `, after the basket's fees (${(creatorFeeBps / 100).toFixed(2)}% to its creator${protocolFeeBps > 0 ? `, ${(protocolFeeBps / 100).toFixed(2)}% to Sheaf` : ""})`
                  : ""}
                .
                The first filler to deliver takes your dollars; if nobody does, the order can be refunded in full.
              </p>
              <RouteCostNote cost={routeCost} dollars={amount} bandBps={BAND_BPS} />
            </div>
          )}

          {blocked && (
            <p className="mt-4 border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">
              On mainnet no filler could fill this inside the 2% band today: buying the stocks costs about{" "}
              {((routeBps ?? 0) / 100).toFixed(2)}% one way. Create shares in kind instead, from the In kind tab.
            </p>
          )}

          {!connected ? (
            <div className="mt-6">
              <ConnectButton block label="Connect a wallet to buy with dollars" />
            </div>
          ) : (
            <button
              type="button"
              onClick={place}
              disabled={!bounds || short || blocked || stage.kind === "signing"}
              className="mt-6 w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
            >
              {stage.kind === "signing"
                ? "Approve in your wallet…"
                : blocked
                  ? "Dollar orders are off for this basket"
                  : tooSmall
                  ? `Enter at least ${money(MIN_ORDER_DOLLARS)}`
                  : short
                    ? "Not enough test dollars"
                    : valid
                      ? `Place a ${money(amount)} order`
                      : "Enter an amount"}
            </button>
          )}
        </>
      )}

      {open && (
        <div className="mt-5" aria-live="polite">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink">Waiting for a filler</span>
            <span className="tnum text-ink-3">
              {now < open.startTs ? `starts in ${open.startTs - now}s` : `${Math.max(0, open.endTs - now)}s left`}
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunk">
            <div className="h-full rounded-full bg-bind transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <p className="tnum mt-3 text-sm text-ink-2">
            Right now {money(fromCashRaw(open.cashAmount))} buys <span className="text-ink">{current?.toFixed(4)} {basket.symbol}</span>
          </p>
          <a href={explorerTx(stage.kind === "open" ? stage.signature : "")} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-ink-3 underline decoration-line-strong underline-offset-4">
            The order on Explorer
          </a>
        </div>
      )}

      {stage.kind === "expired" && (
        <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4" aria-live="polite">
          <p className="text-sm text-ink">Nobody filled this one before the auction ended.</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            The dollars are still in the order&apos;s escrow. Return them now with the button, or leave it: the keeper returns
            them about ten minutes after the auction ended, and this page will say so when it has.
          </p>
          <button
            type="button"
            onClick={() => refund(stage.order, stage.signature)}
            disabled={refunding}
            className="mt-3 rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white hover:bg-bind-deep disabled:opacity-60"
          >
            {refunding ? "Returning…" : `Return my ${money(fromCashRaw(stage.order.cashAmount))}`}
          </button>
        </div>
      )}

      {stage.kind === "refunded" && (
        <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4" aria-live="polite">
          <p className="text-sm text-ink">Returned. {money(stage.cash)} is back in your wallet.</p>
          <div className="mt-3 flex gap-4 text-xs">
            {stage.signature && (
              <a href={explorerTx(stage.signature)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4">The refund on Explorer</a>
            )}
            <button type="button" onClick={() => setStage({ kind: "idle" })} className="text-bind underline decoration-bind/40 underline-offset-4">Place another</button>
          </div>
        </div>
      )}

      {stage.kind === "filled" && (
        <div className="mt-5 rounded-[var(--radius-control)] border border-gain/40 bg-[#e7f3ef] p-4" aria-live="polite">
          <p className="text-sm text-ink">
            Filled. {money(stage.cash)} bought <span className="tnum">{stage.shares.toFixed(4)}</span> {basket.symbol}, and the
            vault received the stocks behind them.
          </p>
          <div className="mt-3 flex gap-4 text-xs">
            <a href={explorerTx(stage.signature)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4">
              The fill on Explorer
            </a>
            <button type="button" onClick={() => setStage({ kind: "idle" })} className="text-bind underline decoration-bind/40 underline-offset-4">
              Place another
            </button>
          </div>
        </div>
      )}

      {notice && (
        <p className="mt-4 border-l-2 border-bind pl-3 text-sm text-ink-2" aria-live="polite">
          {notice}
        </p>
      )}
      {(error || cash.error) && <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error ?? cash.error}</p>}
    </div>
  );
}
