"use client";

import { useState } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { tokenAccount, TOKEN_2022_PROGRAM_ID } from "@/lib/sheaf";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Basket } from "@/lib/sheaf";
import { openPlanIx, netSharesFor } from "@/lib/desk";
import { confirmSignature } from "@/lib/confirm";
import { explainError } from "@/lib/tx";
import { useCash, CASH, toCashRaw, fromCashRaw } from "@/lib/use-cash";
import { money } from "@/lib/format";
import { ConnectButton } from "./connect-button";
import { PlanSheaf } from "./plan-sheaf";
import { useRouteCost, routeBpsFor, routeOutsideBand } from "./dollar-order";
import { useInrRate } from "./india-fx";
import { fxNote, rupees } from "@/lib/fx";

/**
 * Each run's auction: half an hour, so a scheduled keeper always gets a turn
 * before it ends; four minutes at demo speed, so one run's order has closed
 * before the next run is due and two never overlap.
 */
const CADENCE = [
  { key: "month", label: "Every month", secs: 30 * 24 * 3600, unit: "month", auctionSecs: 1800 },
  { key: "week", label: "Every week", secs: 7 * 24 * 3600, unit: "week", auctionSecs: 1800 },
  { key: "demo", label: "Every 5 minutes", secs: 300, unit: "5 minutes", auctionSecs: 240, hint: "demo speed, to watch runs land today" },
] as const;

/** Each run's auction opens this far either side of the reference. */
export const PLAN_BAND_BPS = 200;
/** The reference may follow the market this far, three bands, either way and never further. */
export const PLAN_BOUND_BPS = 3 * PLAN_BAND_BPS;

// The bounds are on shares per dollar, so as prices they are 1 / (1 ∓ 6%): 6.4% above, 5.7% below.
const BOUND_ABOVE = Math.round((10_000 / (10_000 - PLAN_BOUND_BPS) - 1) * 1000) / 10;
const BOUND_BELOW = Math.round((1 - 10_000 / (10_000 + PLAN_BOUND_BPS)) * 1000) / 10;

/**
 * A plan's reference rate and the bounds it may never leave, from a share's fair
 * price in dollars. The rate is net of the basket's creator and protocol fees:
 * the shares the owner actually receives per dollar, which is also what every
 * fill moves the reference to.
 */
export function planTerms(navPerShare: number, creatorFeeBps = 0, protocolFeeBps = 0) {
  // Raw share units per raw cash unit, times 1e9: (1e6 / nav) shares per 1e6 cash, less the fees on them.
  const ref = netSharesFor(BigInt(Math.floor(1e9 / navPerShare)), creatorFeeBps, protocolFeeBps);
  return {
    ref,
    minRef: (ref * BigInt(10_000 - PLAN_BOUND_BPS)) / 10_000n,
    maxRef: (ref * BigInt(10_000 + PLAN_BOUND_BPS)) / 10_000n,
    bandBps: PLAN_BAND_BPS,
  };
}

/**
 * A monthly plan: a fixed amount, on a schedule, for as many runs as you choose.
 *
 * Opening it gives the plan account permission to take exactly that much per run
 * from your dollar account and nothing more. Each run, which anyone can trigger
 * once it is due, places the same dollar order as the tab beside this one, and
 * every fill moves the plan's reference price to where the market cleared.
 */
/** The keeper fills only orders of $5 or more (lib/keeper-server.ts), so a plan's run must be at least this. */
export const PLAN_MIN_USD = 5;

/** Rupee chips: the smallest is ₹500, raised to the $5 floor if the rupee weakens past ₹100 to the dollar. */
const chipsFor = (minInr: number) => [Math.max(500, Math.ceil(minInr / 100) * 100), 1_000, 5_000].filter((v, i, a) => a.indexOf(v) === i);

export function PlanForm({ basket, navPerShare, onDone }: { basket: Basket; navPerShare: number | null; onDone: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const cash = useCash();
  // Rupees first; dollars when the visitor asks for them or today's rate can't be read.
  const [unit, setUnit] = useState<"inr" | "usd">("inr");
  const [perRunInr, setPerRunInr] = useState("1000");
  const [perRunUsd, setPerRunUsd] = useState("10");
  const [runs, setRuns] = useState(12);
  const [cadence, setCadence] = useState<(typeof CADENCE)[number]["key"]>("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  // One site-wide rate (lib/fx.ts): live when it can be read, otherwise a dated fallback, so rupees always work.
  const { fx } = useInrRate();
  const inr = fx.rate;
  const inRupees = unit === "inr";
  // The plan itself runs in test dollars, to the cent; rupees are converted at the rate and rounded down.
  const amount = inRupees ? Math.floor((Number(perRunInr) / inr) * 100 + 1e-6) / 100 : Number(perRunUsd);
  const amountInr: number | null = inRupees ? Number(perRunInr) : amount * inr;
  const entered = inRupees ? perRunInr !== "" : perRunUsd !== "";
  const belowMin = entered && Number.isFinite(amount) && amount < PLAN_MIN_USD;
  const valid = Number.isFinite(amount) && amount >= PLAN_MIN_USD && runs >= 1 && navPerShare != null;
  const c = CADENCE.find((x) => x.key === cadence)!;
  const total = valid ? amount * runs : 0;
  const minInr = Math.ceil((PLAN_MIN_USD * inr) / 10) * 10;
  const chips = chipsFor(minInr);
  const per = c.unit === "month" ? "a month" : c.unit === "week" ? "a week" : "every 5 minutes";
  // What one run buys after the basket's fees, and whether a filler could buy the stocks inside the band today.
  const netPerRun =
    valid && navPerShare
      ? Number(netSharesFor(BigInt(Math.floor((amount / navPerShare) * 1e6)), basket.creatorFeeBps, basket.protocolFeeBps ?? 0)) / 1e6
      : null;
  const routeCost = useRouteCost(basket.address);
  const routeBps = routeBpsFor(routeCost, amount);
  const blocked = routeOutsideBand(routeBps, PLAN_BAND_BPS);
  const feeBps = basket.creatorFeeBps + (basket.protocolFeeBps ?? 0);
  const label = amountInr != null && Number.isFinite(amountInr) ? `${rupees(amountInr)} (${money(amount)})` : money(amount);

  async function start() {
    if (!publicKey || !valid || !navPerShare || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const terms = planTerms(navPerShare, basket.creatorFeeBps, basket.protocolFeeBps ?? 0);
      const { plan, ix } = openPlanIx({
        owner: publicKey,
        basket: new PublicKey(basket.address),
        cashMint: CASH.mint,
        cashProgram: CASH.program,
        planId: BigInt(Date.now()),
        cashPerRun: toCashRaw(amount),
        periodSecs: c.secs,
        runs,
        refSharesPerCashE9: terms.ref,
        // The reference may follow the market three bands either side of today's
        // rate and never further, however thin the competition.
        minRef: terms.minRef,
        maxRef: terms.maxRef,
        bandBps: terms.bandBps,
        auctionSecs: c.auctionSecs,
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
      setOpened(plan.toBase58());
      // The first run is due now; ask the keeper, though anyone may run it.
      fetch("/api/keeper", { method: "POST" }).catch(() => {});
      onDone();
    } catch (err) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  if (opened) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-4">
          <div className="size-20 shrink-0">
            <PlanSheaf filled={1} total={runs} className="h-full w-full" />
          </div>
          <div>
            <p className="text-ink">Your plan is running.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">
              {label} {per}
              {c.key === "demo" ? " (demo speed)" : ""} into {basket.symbol}, {runs} times. The first order is being placed now.
            </p>
          </div>
        </div>
        <Link href="/plans" className="mt-5 inline-flex rounded-[var(--radius-control)] bg-ink px-4 py-2.5 text-sm font-medium text-page hover:bg-[#23382c]">
          Watch it on your plans
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      <p className="text-sm leading-relaxed text-ink-2">
        The SIP habit behind India&apos;s mutual-fund boom, onchain: a fixed amount into {basket.name} on a schedule. The
        plan can take exactly that much per run and nothing more, and you can close it any time.
      </p>

      {inRupees && (
        <div className="mt-5 grid grid-cols-3 gap-2" role="group" aria-label="Rupees per run">
          {chips.map((r) => {
            const on = perRunInr === String(r);
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => setPerRunInr(String(r))}
                className={`tnum rounded-[var(--radius-control)] border px-3 py-2.5 text-sm transition-colors ${
                  on ? "border-bind bg-bind-wash text-ink" : "border-line text-ink-2 hover:border-line-strong"
                }`}
              >
                {rupees(r)}
              </button>
            );
          })}
        </div>
      )}

      <div className={`${inRupees ? "mt-3" : "mt-5"} grid grid-cols-2 gap-3`}>
        <label className="block">
          <span className="text-xs text-ink-3">{inRupees ? "Each run, in ₹" : "Each run, in test dollars"}</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
            <span className="text-ink-3">{inRupees ? "₹" : "$"}</span>
            {inRupees ? (
              <input value={perRunInr} onChange={(e) => setPerRunInr(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))} inputMode="numeric" className="tnum w-full bg-transparent text-lg text-ink outline-none" aria-label="Rupees per run" />
            ) : (
              <input value={perRunUsd} onChange={(e) => setPerRunUsd(e.target.value.replace(/[^0-9.]/g, "").slice(0, 9))} inputMode="decimal" className="tnum w-full bg-transparent text-lg text-ink outline-none" aria-label="Dollars per run" />
            )}
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-ink-3">Runs</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
            <input type="number" min={1} max={120} value={runs} onChange={(e) => setRuns(Math.max(1, Math.min(120, Number(e.target.value) || 1)))} className="tnum w-full bg-transparent text-lg text-ink outline-none" aria-label="Number of runs" />
          </div>
        </label>
      </div>

      <p className="tnum mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-ink-3">
        <span>
          {inRupees
            ? `${Number.isFinite(amount) ? money(amount) : "—"} in test dollars a run, at ${fxNote(fx)}`
            : Number.isFinite(amount)
              ? `About ${rupees(amount * inr)} a run, at ${fxNote(fx)}`
              : ""}
        </span>
        <button type="button" onClick={() => setUnit(inRupees ? "usd" : "inr")} className="text-bind underline decoration-bind/40 underline-offset-4">
          {inRupees ? "Enter dollars instead" : "Enter rupees instead"}
        </button>
      </p>
      {belowMin && (
        <p className="mt-2 border-l-2 border-loss pl-3 text-sm text-loss" role="status">
          Plans start at ${PLAN_MIN_USD} a run (about {rupees(minInr)}). The keeper only fills orders of ${PLAN_MIN_USD} or more,
          so a smaller run would sit unfilled.
        </p>
      )}

      <div className="mt-4 grid gap-2" role="radiogroup" aria-label="How often">
        {CADENCE.map((x) => (
          <button
            key={x.key}
            type="button"
            role="radio"
            aria-checked={cadence === x.key}
            onClick={() => setCadence(x.key)}
            className={`flex items-baseline justify-between rounded-[var(--radius-control)] border px-3.5 py-2.5 text-left text-sm transition-colors ${
              cadence === x.key ? "border-bind bg-bind-wash text-ink" : "border-line text-ink-2 hover:border-line-strong"
            }`}
          >
            <span>{x.label}</span>
            {"hint" in x && <span className="text-xs text-ink-3">{x.hint}</span>}
          </button>
        ))}
      </div>

      {valid && (
        <p className="tnum mt-4 text-sm text-ink-2">
          {label} {per}, {runs} {runs === 1 ? "time" : "times"}: {amountInr != null && Number.isFinite(amountInr) ? `${rupees(amountInr * runs)} (${money(total)})` : money(total)} in all. About{" "}
          {(netPerRun ?? amount / navPerShare!).toFixed(4)} {basket.symbol} a run at today&apos;s price
          {feeBps > 0 ? `, after ${(feeBps / 100).toFixed(2)}% in fees` : ""}.
        </p>
      )}
      {valid && routeBps != null && (
        <p className="tnum mt-2 text-xs leading-relaxed text-ink-3">
          On mainnet routes, buying these stocks costs a filler about {(routeBps / 100).toFixed(2)}% one way.
        </p>
      )}
      {blocked && (
        <p className="mt-3 border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">
          On mainnet no filler could fill this inside the 2% band today: buying the stocks costs about{" "}
          {((routeBps ?? 0) / 100).toFixed(2)}% one way, so every run would come back unfilled. Create shares in kind instead,
          from the Create in kind tab.
        </p>
      )}
      {navPerShare != null && (
        <p className="mt-2 text-xs leading-relaxed text-ink-3">
          This plan never pays more than {BOUND_ABOVE}% above or {BOUND_BELOW}% below today&apos;s fair price of{" "}
          {money(navPerShare)} a share, however the market moves. If the price leaves that range, re-center the plan from your
          plans page.
        </p>
      )}

      {!connected ? (
        <div className="mt-6">
          <ConnectButton block label="Connect a wallet to start a plan" />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={start}
            disabled={!valid || busy || blocked}
            className="mt-6 w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
          >
            {busy ? "Approve in your wallet…" : blocked ? "Plans are off for this basket" : valid ? `Start a ${label} plan` : "Start a plan"}
          </button>
          <p className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-ink-3">
            <span className="tnum">{cash.balance == null ? "" : `You hold ${money(fromCashRaw(cash.balance))} in test dollars`}</span>
            <button type="button" onClick={cash.claim} disabled={cash.claiming} className="text-bind underline decoration-bind/40 underline-offset-4">
              {cash.claiming ? "Sending…" : "Get 1,000 test dollars"}
            </button>
          </p>
        </>
      )}
      {(error || cash.error) && <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error ?? cash.error}</p>}
    </div>
  );
}
