"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { tokenAccount } from "@/lib/sheaf";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Basket } from "@/lib/sheaf";
import { placeSellOrderIx, cancelSellOrderIx, decodeSellOrder, freshNonce, requiredCash, type SellOrder } from "@/lib/desk";
import { fromBase64 } from "@/lib/ledger";
import idl from "@/lib/sheaf-idl.json";
import { confirmSignature } from "@/lib/confirm";
import { chainClockOffset, chainNow, explainError, signFresh } from "@/lib/tx";
import { explorerTx } from "@/lib/config";
import { useCash, CASH, fromCashRaw } from "@/lib/use-cash";
import { money, quantity } from "@/lib/format";
import { ConnectButton } from "./connect-button";
import { MIN_ORDER_DOLLARS, START_BUFFER_SECS, kickFillers, routeBpsFor, routeOutsideBand, RouteCostNote, useRouteCost } from "./dollar-order";

const AUCTION_SECS = 90;
const BAND_BPS = 200;
const SHARE = 1_000_000;

type Stage =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "open"; order: SellOrder; signature: string }
  | { kind: "filled"; shares: number; cash: number; signature: string }
  | { kind: "expired"; order: SellOrder; signature: string }
  /** Signature null when someone else returned it and the transaction could not be read. */
  | { kind: "returned"; shares: number; signature: string | null };

// ---------------------------------------------------------------- events

const PREFIX = "Program data: ";
const discOf = (name: string) => Uint8Array.from((idl.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator);
const FILLED = discOf("SellOrderFilled");
const CANCELLED = discOf("SellOrderCancelled");
const starts = (d: Uint8Array, disc: Uint8Array) => d.length >= 8 && disc.every((b, i) => d[i] === b);
const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);

/**
 * What closed a sell order, from its last transaction's logs: SellOrderFilled
 * (sell_order, basket, seller, filler, shares, cash, …) or SellOrderCancelled
 * (sell_order, basket, seller, by, shares_returned, expired). Decoded here
 * because the ledger does not read the sell desk's events yet.
 */
function sellEvent(logs: string[] | null | undefined, order: string) {
  for (const line of logs ?? []) {
    if (!line.startsWith(PREFIX)) continue;
    const d = fromBase64(line.slice(PREFIX.length));
    const forThis = d.length >= 40 && new PublicKey(d.slice(8, 40)).toBase58() === order;
    if (!forThis) continue;
    if (starts(d, FILLED)) return { kind: "filled" as const, shares: Number(u64At(d, 136)) / SHARE, cash: fromCashRaw(u64At(d, 144)) };
    if (starts(d, CANCELLED)) return { kind: "returned" as const, shares: Number(u64At(d, 136)) / SHARE };
  }
  return null;
}

/**
 * Sell shares for dollars: the dollar exit, the buy desk in reverse.
 *
 * The shares go into an escrow the program controls, and the dollars the seller
 * must receive fall over ninety seconds from 2% above the fair value to 2% below,
 * the seller's floor. The first filler to pay the current amount takes the
 * shares; if nobody does, the shares come back. No protocol fee on a sale.
 */
export function SellOrderPanel({
  basket,
  navPerShare,
  shareBalance,
  onDone,
}: {
  basket: Basket;
  navPerShare: number | null;
  /** The connected wallet's shares of this basket, raw. */
  shareBalance: bigint;
  onDone: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction, connected } = useWallet();
  const cash = useCash();
  const [unit, setUnit] = useState<"shares" | "dollars">("shares");
  const [input, setInput] = useState("1");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [returning, setReturning] = useState(false);

  const typed = Number(input);
  const shares = !Number.isFinite(typed) || typed <= 0 ? 0 : unit === "shares" ? typed : navPerShare ? typed / navPerShare : 0;
  const rawShares = BigInt(Math.floor(shares * SHARE));
  const fairCash = navPerShare ? shares * navPerShare : null;
  const tooSmall = fairCash != null && shares > 0 && fairCash < MIN_ORDER_DOLLARS;
  const valid = rawShares > 0n && fairCash != null && fairCash >= MIN_ORDER_DOLLARS;
  const short = connected && valid && rawShares > shareBalance;
  const askFor = (cashValue: number) => {
    const fair = BigInt(Math.floor(cashValue * 1e6));
    return { start: (fair * BigInt(10_000 + BAND_BPS)) / 10_000n, end: (fair * BigInt(10_000 - BAND_BPS)) / 10_000n };
  };
  const bounds = useMemo(() => (valid && fairCash != null ? askFor(fairCash) : null), [valid, fairCash]);
  // The latest fair price, read again when the order is built: the wallet prompt can sit open for a minute.
  const navRef = useRef(navPerShare);
  useEffect(() => {
    navRef.current = navPerShare;
  }, [navPerShare]);
  const [notice, setNotice] = useState<string | null>(null);
  const routeCost = useRouteCost(basket.address);
  const routeBps = routeBpsFor(routeCost, fairCash ?? 100);
  const blocked = routeOutsideBand(routeBps, BAND_BPS);

  /** A sell order account is gone: read what closed it from its last transaction. */
  async function whatClosed(order: SellOrder, placedWith: string): Promise<Stage | null> {
    const key = new PublicKey(order.address);
    const sigs = await connection.getSignaturesForAddress(key, { limit: 3 }).catch(() => []);
    const last = sigs.find((s) => s.signature !== placedWith && !s.err)?.signature;
    if (!last) return null;
    const tx = await connection.getTransaction(last, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    const e = sellEvent(tx?.meta?.logMessages, order.address);
    if (e?.kind === "filled") return { kind: "filled", shares: e.shares, cash: e.cash, signature: last };
    if (e?.kind === "returned") return { kind: "returned", shares: e.shares, signature: last };
    return null;
  }

  // While the order is open: tick, ask the keeper to look, and watch the account. Once it ends, keep watching
  // for whoever returns it, so the page says so the moment the shares are back.
  useEffect(() => {
    if (stage.kind !== "open" && stage.kind !== "expired") return;
    const { order, signature } = stage;
    const open = stage.kind === "open";
    const tick = open ? setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500) : null;
    let live = true;
    const watch = async () => {
      kickFillers();
      for (let i = 0; i < 240 && live; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!live) return;
        const info = await connection.getAccountInfo(new PublicKey(order.address)).catch(() => undefined);
        if (info === null) {
          const next = await whatClosed(order, signature);
          if (!live) return;
          setStage(next ?? (open ? { kind: "filled", shares: Number(order.shares) / SHARE, cash: fromCashRaw(requiredCash(order, Math.floor(Date.now() / 1000))), signature } : { kind: "returned", shares: Number(order.shares) / SHARE, signature: null }));
          setError(null);
          cash.reload();
          onDone();
          return;
        }
        if (open && Math.floor(Date.now() / 1000) > order.endTs + 3) {
          setStage({ kind: "expired", order, signature });
          return;
        }
        if (i % (open ? 2 : 12) === 1) kickFillers();
      }
    };
    watch();
    return () => {
      live = false;
      if (tick) clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  async function place() {
    if (!publicKey || !bounds || !valid || blocked || short) return;
    setError(null);
    setNotice(null);
    setStage({ kind: "signing" });
    try {
      // Built right before the wallet opens and rebuilt if the signature comes back stale, so the ask and the
      // auction clock start when the order can actually land.
      // The auction's clock is the chain's, not this device's: a slow device clock could start it too far back.
      const offset = await chainClockOffset(connection);
      const { sellOrder, signature } = await signFresh({
        connection,
        payer: publicKey,
        signTransaction,
        sendTransaction,
        onStale: () => setNotice("The wallet was open a while, so the price and the auction clock were refreshed. Approve once more."),
        build: () => {
          const ask = askFor((Number(rawShares) / SHARE) * (navRef.current ?? navPerShare!));
          const startTs = chainNow(offset) + START_BUFFER_SECS;
          const { sellOrder, ix } = placeSellOrderIx({
            seller: publicKey,
            basket,
            cashMint: CASH.mint,
            cashProgram: CASH.program,
            nonce: freshNonce(),
            shares: rawShares,
            startCash: ask.start,
            endCash: ask.end,
            startTs,
            endTs: startTs + AUCTION_SECS,
          });
          // The seller's own dollar account, where the filler pays, created here (idempotently) so no filler has to
          // pay its rent; the keeper skips sales whose seller has none.
          const cashAccount = createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            tokenAccount(CASH.mint, publicKey, CASH.program),
            publicKey,
            CASH.mint,
            CASH.program,
          );
          return { sellOrder, transaction: new Transaction().add(cashAccount, ix) };
        },
      });
      setNotice(null);
      // Sent: wake the fillers now, so a slow confirmation here never eats into their time.
      kickFillers();
      await confirmSignature(connection, signature);
      kickFillers();
      const info = await connection.getAccountInfo(sellOrder);
      const decoded = info ? decodeSellOrder(sellOrder, new Uint8Array(info.data)) : null;
      if (!decoded) throw new Error("The sell order was placed but could not be read back.");
      setNow(Math.floor(Date.now() / 1000));
      setStage({ kind: "open", order: decoded, signature });
      onDone();
    } catch (err) {
      setError(explainError(err));
      setNotice(null);
      setStage({ kind: "idle" });
    }
  }

  async function giveBack(order: SellOrder, placedWith: string) {
    if (!publicKey || returning) return;
    setError(null);
    setReturning(true);
    const gone = async () => (await connection.getAccountInfo(new PublicKey(order.address)).catch(() => undefined)) === null;
    const settled = async () => {
      setStage((await whatClosed(order, placedWith)) ?? { kind: "returned", shares: Number(order.shares) / SHARE, signature: null });
      onDone();
    };
    try {
      if (await gone()) return await settled();
      const signature = await sendTransaction(new Transaction().add(cancelSellOrderIx({ caller: publicKey, sellOrder: order, basket })), connection);
      await confirmSignature(connection, signature);
      setStage({ kind: "returned", shares: Number(order.shares) / SHARE, signature });
      onDone();
    } catch (err) {
      if (await gone().catch(() => false)) await settled().catch(() => setError(explainError(err, { action: "cancel" })));
      else setError(explainError(err, { action: "cancel" }));
    } finally {
      setReturning(false);
    }
  }

  const open = stage.kind === "open" ? stage.order : null;
  const progress = open ? Math.min(1, Math.max(0, (now - open.startTs) / (open.endTs - open.startTs))) : 0;
  const current = open ? fromCashRaw(requiredCash(open, now)) : null;
  const held = Number(shareBalance) / SHARE;

  return (
    <div className="p-6">
      <p className="text-sm leading-relaxed text-ink-2">
        Sell {basket.symbol} for dollars. Your shares wait in an escrow the program controls while fillers compete to pay you; nobody
        can take them for less than the floor you set.
      </p>

      {(stage.kind === "idle" || stage.kind === "signing") && (
        <>
          <label className="mt-5 block">
            <span className="text-xs text-ink-3">{unit === "shares" ? `${basket.symbol} to sell` : "Dollars to raise"}</span>
            <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
              {unit === "dollars" && <span className="text-ink-3">$</span>}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value.replace(/[^0-9.]/g, "").slice(0, 12))}
                inputMode="decimal"
                className="tnum w-full bg-transparent text-lg text-ink outline-none"
                aria-label={unit === "shares" ? "Shares to sell" : "Dollars to raise"}
              />
              {unit === "shares" && <span className="text-sm text-ink-3">{basket.symbol}</span>}
            </div>
          </label>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-3">
            <span className="tnum">
              {!connected ? "Shares on devnet" : `You hold ${quantity(held, 4)} ${basket.symbol}`}
              {connected && held > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => {
                      setUnit("shares");
                      setInput(String(Math.floor(held * 10_000) / 10_000));
                    }}
                    className="text-bind underline decoration-bind/40 underline-offset-4"
                  >
                    Sell all
                  </button>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => {
                setUnit(unit === "shares" ? "dollars" : "shares");
                setInput(unit === "shares" ? (fairCash != null ? String(Math.round(fairCash)) : "100") : shares > 0 ? String(Math.round(shares * 10_000) / 10_000) : "1");
              }}
              className="text-bind underline decoration-bind/40 underline-offset-4"
            >
              {unit === "shares" ? "Enter dollars instead" : "Enter shares instead"}
            </button>
          </div>

          {tooSmall && (
            <p className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-ink-2" aria-live="polite">
              The smallest sale is worth {money(MIN_ORDER_DOLLARS)}. Fillers start there, so a smaller one would only wait out its auction
              and come back.
            </p>
          )}

          {bounds && (
            <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4 text-sm">
              <p className="text-ink-2">
                You receive between <span className="tnum text-ink">{money(fromCashRaw(bounds.end))}</span> and{" "}
                <span className="tnum text-ink">{money(fromCashRaw(bounds.start))}</span> for{" "}
                <span className="tnum text-ink">{quantity(shares, 4)}</span> {basket.symbol}.
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
                The ask starts 2% above the fair value at {money(navPerShare)} a share and falls to 2% below, your floor, over ninety
                seconds. The first filler to pay takes the shares; if nobody does, they come back to you. Sheaf takes no fee on a sale.
              </p>
              <RouteCostNote cost={routeCost} dollars={fairCash ?? 100} verb="selling" bandBps={BAND_BPS} />
            </div>
          )}

          {blocked && (
            <p className="mt-4 border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">
              On mainnet no filler could fill this inside the 2% band today: trading the stocks costs about{" "}
              {((routeBps ?? 0) / 100).toFixed(2)}% one way. Redeem the shares in kind instead, from the Redeem tab.
            </p>
          )}

          {!connected ? (
            <div className="mt-6">
              <ConnectButton block label="Connect a wallet to sell for dollars" />
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
                  ? "Dollar sales are off for this basket"
                  : tooSmall
                    ? `Sell at least ${money(MIN_ORDER_DOLLARS)} worth`
                    : short
                      ? `More than you hold (${quantity(held, 4)} ${basket.symbol})`
                      : valid
                        ? `Sell ${quantity(shares, 4)} ${basket.symbol}`
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
            Right now {quantity(Number(open.shares) / SHARE, 4)} {basket.symbol} sells for <span className="text-ink">{money(current)}</span>
            <span className="text-ink-3"> · floor {money(fromCashRaw(open.endCash))}</span>
          </p>
          <a href={explorerTx(stage.kind === "open" ? stage.signature : "")} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-ink-3 underline decoration-line-strong underline-offset-4">
            The sell order on Explorer
          </a>
        </div>
      )}

      {stage.kind === "expired" && (
        <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4" aria-live="polite">
          <p className="text-sm text-ink">Nobody bought these before the auction ended.</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            The {quantity(Number(stage.order.shares) / SHARE, 4)} {basket.symbol} are still in the order&apos;s escrow. Take them back now;
            anyone may return them to you after the auction, and this page will say so when it happens.
          </p>
          <button
            type="button"
            onClick={() => giveBack(stage.order, stage.signature)}
            disabled={returning}
            className="mt-3 rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white hover:bg-bind-deep disabled:opacity-60"
          >
            {returning ? "Returning…" : `Return my ${quantity(Number(stage.order.shares) / SHARE, 4)} ${basket.symbol}`}
          </button>
        </div>
      )}

      {stage.kind === "returned" && (
        <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4" aria-live="polite">
          <p className="text-sm text-ink">
            Returned. {quantity(stage.shares, 4)} {basket.symbol} {stage.shares === 1 ? "is" : "are"} back in your wallet.
          </p>
          <div className="mt-3 flex gap-4 text-xs">
            {stage.signature && (
              <a href={explorerTx(stage.signature)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4">
                The return on Explorer
              </a>
            )}
            <button type="button" onClick={() => setStage({ kind: "idle" })} className="text-bind underline decoration-bind/40 underline-offset-4">
              Sell again
            </button>
          </div>
        </div>
      )}

      {stage.kind === "filled" && (
        <div className="mt-5 rounded-[var(--radius-control)] border border-gain/40 bg-[#e7f3ef] p-4" aria-live="polite">
          <p className="text-sm text-ink">
            Sold. <span className="tnum">{quantity(stage.shares, 4)}</span> {basket.symbol} brought {money(stage.cash)}, paid into your
            wallet in test dollars.
          </p>
          <div className="mt-3 flex gap-4 text-xs">
            <a href={explorerTx(stage.signature)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4">
              The sale on Explorer
            </a>
            <button type="button" onClick={() => setStage({ kind: "idle" })} className="text-bind underline decoration-bind/40 underline-offset-4">
              Sell again
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
