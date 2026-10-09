"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { tokenAccount, TOKEN_2022_PROGRAM_ID } from "@/lib/sheaf";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Basket } from "@/lib/sheaf";
import { placeOrderIx, cancelOrderIx, freshNonce, requiredShares, decodeOrder, type Order } from "@/lib/desk";
import { eventsInLogs } from "@/lib/ledger";
import { confirmSignature } from "@/lib/confirm";
import { explainError } from "@/lib/tx";
import { explorerTx } from "@/lib/config";
import { useCash, CASH, toCashRaw, fromCashRaw } from "@/lib/use-cash";
import { money } from "@/lib/format";
import { ConnectButton } from "./connect-button";

const AUCTION_SECS = 90;
const BAND_BPS = 200;

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
  const { publicKey, sendTransaction, connected } = useWallet();
  const cash = useCash();
  const [dollars, setDollars] = useState("100");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [refunding, setRefunding] = useState(false);

  const amount = Number(dollars);
  const valid = Number.isFinite(amount) && amount >= 1;
  const fair = valid && navPerShare ? amount / navPerShare : null;
  const bounds = useMemo(() => {
    if (!fair) return null;
    const raw = BigInt(Math.floor(fair * 1e6));
    return {
      start: (raw * BigInt(10_000 + BAND_BPS)) / 10_000n,
      end: (raw * BigInt(10_000 - BAND_BPS)) / 10_000n,
    };
  }, [fair]);
  const short = cash.balance != null && valid && cash.balance < toCashRaw(amount);

  // While an order is open, tick the clock and watch the order account: when the
  // account disappears, a filler has taken it.
  useEffect(() => {
    if (stage.kind !== "open") return;
    const order = stage.order;
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    let live = true;
    const watch = async () => {
      // Ask the house keeper to look; any filler may beat it.
      fetch("/api/keeper", { method: "POST" }).catch(() => {});
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
        if (i % 2 === 1) fetch("/api/keeper", { method: "POST" }).catch(() => {});
      }
    };
    watch();
    return () => {
      live = false;
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  // An expired order is still worth watching: the keeper returns the dollars on
  // its next pass, and the page should say so the moment it does.
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
    if (!publicKey || !bounds || !valid) return;
    setError(null);
    setStage({ kind: "signing" });
    try {
      const t = Math.floor(Date.now() / 1000);
      const nonce = freshNonce();
      const { order, ix } = placeOrderIx({
        buyer: publicKey,
        basket: new PublicKey(basket.address),
        cashMint: CASH.mint,
        cashProgram: CASH.program,
        nonce,
        cashAmount: toCashRaw(amount),
        startShares: bounds.start,
        endShares: bounds.end,
        startTs: t,
        endTs: t + AUCTION_SECS,
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
      const signature = await sendTransaction(new Transaction().add(shareAccount, ix), connection);
      await confirmSignature(connection, signature);
      const info = await connection.getAccountInfo(order);
      const decoded = info ? decodeOrder(order, new Uint8Array(info.data)) : null;
      if (!decoded) throw new Error("The order was placed but could not be read back.");
      setNow(Math.floor(Date.now() / 1000));
      setStage({ kind: "open", order: decoded, signature });
      cash.reload();
    } catch (err) {
      setError(explainError(err));
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
                The offer starts 2% above the fair count at {money(navPerShare)} a share and falls to 2% below over ninety seconds.
                The first filler to deliver takes your dollars; if nobody does, the order can be refunded in full.
              </p>
            </div>
          )}

          {!connected ? (
            <div className="mt-6">
              <ConnectButton block label="Connect a wallet to buy with dollars" />
            </div>
          ) : (
            <button
              type="button"
              onClick={place}
              disabled={!bounds || short || stage.kind === "signing"}
              className="mt-6 w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
            >
              {stage.kind === "signing" ? "Approve in your wallet…" : short ? "Not enough test dollars" : `Place a ${money(amount)} order`}
            </button>
          )}
        </>
      )}

      {open && (
        <div className="mt-5" aria-live="polite">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink">Waiting for a filler</span>
            <span className="tnum text-ink-3">{Math.max(0, open.endTs - now)}s left</span>
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
            The dollars are still in the order&apos;s escrow. Anyone may return them now; the keeper does on its next pass,
            and this page will say so when it has.
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

      {(error || cash.error) && <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error ?? cash.error}</p>}
    </div>
  );
}
