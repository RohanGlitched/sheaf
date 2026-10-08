"use client";

import { useState } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Basket } from "@/lib/sheaf";
import { openPlanIx } from "@/lib/desk";
import { confirmSignature } from "@/lib/confirm";
import { explainError } from "@/lib/tx";
import { useCash, CASH, toCashRaw, fromCashRaw } from "@/lib/use-cash";
import { money } from "@/lib/format";
import { ConnectButton } from "./connect-button";
import { PlanSheaf } from "./plan-sheaf";

const CADENCE = [
  { key: "month", label: "Every month", secs: 30 * 24 * 3600, unit: "month" },
  { key: "week", label: "Every week", secs: 7 * 24 * 3600, unit: "week" },
  { key: "demo", label: "Every 5 minutes", secs: 300, unit: "5 minutes", hint: "for trying it out today" },
] as const;

/**
 * A monthly plan: a fixed amount, on a schedule, for as many runs as you choose.
 *
 * Opening it gives the plan account permission to take exactly that much per run
 * from your dollar account and nothing more. Each run, which anyone can trigger
 * once it is due, places the same dollar order as the tab beside this one, and
 * every fill moves the plan's reference price to where the market cleared.
 */
export function PlanForm({ basket, navPerShare, onDone }: { basket: Basket; navPerShare: number | null; onDone: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const cash = useCash();
  const [perRun, setPerRun] = useState("50");
  const [runs, setRuns] = useState(12);
  const [cadence, setCadence] = useState<(typeof CADENCE)[number]["key"]>("month");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  const amount = Number(perRun);
  const valid = Number.isFinite(amount) && amount >= 1 && runs >= 1 && navPerShare != null;
  const c = CADENCE.find((x) => x.key === cadence)!;
  const total = valid ? amount * runs : 0;

  async function start() {
    if (!publicKey || !valid || !navPerShare) return;
    setBusy(true);
    setError(null);
    try {
      // Raw share units per raw cash unit, times 1e9: (1e6 / nav) shares per 1e6 cash.
      const refE9 = BigInt(Math.floor(1e9 / navPerShare));
      const { plan, ix } = openPlanIx({
        owner: publicKey,
        basket: new PublicKey(basket.address),
        cashMint: CASH.mint,
        cashProgram: CASH.program,
        planId: BigInt(Date.now()),
        cashPerRun: toCashRaw(amount),
        periodSecs: c.secs,
        runs,
        refSharesPerCashE9: refE9,
        bandBps: 200,
        auctionSecs: 180,
      });
      const signature = await sendTransaction(new Transaction().add(ix), connection);
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
              {money(amount)} {c.unit === "month" ? "a month" : c.unit === "week" ? "a week" : "every 5 minutes"} into {basket.symbol}, {runs} times.
              The first order is being placed now.
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
        The habit behind India&apos;s index-fund boom, onchain: a fixed amount into {basket.name} on a schedule. The plan can
        take exactly that much per run and nothing more, and you can close it any time.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-ink-3">Each run</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
            <span className="text-ink-3">$</span>
            <input value={perRun} onChange={(e) => setPerRun(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className="tnum w-full bg-transparent text-lg text-ink outline-none" aria-label="Dollars per run" />
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-ink-3">Runs</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 focus-within:border-bind">
            <input type="number" min={1} max={120} value={runs} onChange={(e) => setRuns(Math.max(1, Math.min(120, Number(e.target.value) || 1)))} className="tnum w-full bg-transparent text-lg text-ink outline-none" aria-label="Number of runs" />
          </div>
        </label>
      </div>

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
          {money(total)} over {runs} runs. About {(amount / navPerShare!).toFixed(4)} {basket.symbol} a run at today&apos;s price.
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
            disabled={!valid || busy}
            className="mt-6 w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
          >
            {busy ? "Approve in your wallet…" : `Start a ${money(amount)} plan`}
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
