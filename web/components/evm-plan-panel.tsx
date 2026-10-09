"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import {
  ERC20_ABI,
  EVM_PLAN_V3,
  PLAN_DESK_V3_ABI,
  explainEvmError,
  fromRaw,
  publicClientFor,
  readPlansOfV3,
  v3Of,
  worstCaseLine,
  type PlanCadence,
  type PlanV3,
} from "@/lib/evm";
import { quantity, shortAddress } from "@/lib/format";
import { StepList, type EvmWallet, type Step, type StepState } from "./evm-wallet";

/**
 * A monthly plan on a chain without Tempo's access keys (Robinhood Chain, the
 * Sepolias), on PlanDeskV3.
 *
 * The visitor opens the plan with their own wallet, naming the house as the plan's
 * keeper, and approves the plan desk for a fixed number of runs. The house's keeper
 * loop runs each installment when it is due, at today's fair count; the contract
 * only accepts a count within the trailing window around the last fill and inside
 * the hard bounds the visitor signed, pulls exactly the run's dollars, and posts an
 * auction on the v3 desk with the visitor as buyer. The allowance caps the total.
 */

/** What /api/evm-keeper answers for `plan.action = "terms"`. Bigints as strings. */
type Terms = {
  basket: Address;
  symbol: string;
  nav: number;
  planDesk: Address;
  keeper: Address;
  cashPerRun: string;
  interval: string;
  auctionSecs: string;
  runs: string;
  bandBps: number;
  stepBps: number;
  refShares: string;
  hardMin: string;
  hardMax: string;
};

type RunResult = { planId: number; status: "ran" | "skipped" | "failed"; orderId?: number; reason?: string; hash?: string };

const sh = (v: bigint | string) => quantity(fromRaw(BigInt(v)), 4);
const when = (secs: number) =>
  new Date(secs * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";

async function keeperPost(body: Record<string, unknown>) {
  const res = await fetch("/api/evm-keeper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "The keeper did not answer. Try again in a moment.");
  return json;
}

export function EvmPlanPanel({ d, basket, wallet, onDone }: { d: Deployment; basket: ChainBasket; wallet: EvmWallet; onDone: () => void }) {
  const v3 = v3Of(d)!;
  const house = (d.deployer ?? "") as Address;
  const [cadence, setCadence] = useState<PlanCadence>("demo");
  // The house faucet sends 3 USDG on Robinhood Chain, so the demo's three runs fit it at 1 a run; mirror dollars are free.
  const [amount, setAmount] = useState(d.tokenSource === "real" ? "1" : "5");
  const [plans, setPlans] = useState<PlanV3[] | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const ready = !!wallet.address && wallet.onChain;
  const c = EVM_PLAN_V3.cadences[cadence];
  const cash = (() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 10 ** d.stable.decimals)) : null;
  })();

  const load = useCallback(async () => {
    if (!wallet.address) return setPlans(null);
    try {
      const all = await readPlansOfV3(d, wallet.address);
      setPlans(all.filter((p) => p.keeper.toLowerCase() === house.toLowerCase()).reverse());
      setNow(Math.floor(Date.now() / 1000));
    } catch {
      // The list retries on the next refresh.
    }
  }, [d, wallet.address, house]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
      onDone();
    } catch (err) {
      setError(explainEvmError(err));
    } finally {
      setBusy(null);
    }
  }

  const terms = async (cashPerRun: bigint, cad: PlanCadence) =>
    (await keeperPost({ network: d.network, plan: { action: "terms", basket: basket.address, cash: cashPerRun.toString(), cadence: cad } })) as unknown as Terms;

  const open = () =>
    act("open", async () => {
      if (!cash || !wallet.address) return;
      const t = await terms(cash, cadence);
      // Add this plan's runs to whatever the plan desk may already pull, so another plan's allowance is kept.
      const have = await publicClientFor(d).readContract({
        address: d.stable.address as Address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [wallet.address, v3.planDesk as Address],
      });
      const total = have + cash * BigInt(t.runs);
      const list: Step[] = [
        {
          label: `Approve the plan desk for ${t.runs} runs (${fromRaw(cash * BigInt(t.runs), d.stable.decimals).toFixed(2)} ${d.stable.symbol})`,
          to: d.stable.address as Address,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [v3.planDesk as Address, total] }),
        },
        {
          label: `Open the plan: ${fromRaw(cash, d.stable.decimals).toFixed(2)} ${d.stable.symbol} a run into ${t.symbol}`,
          to: v3.planDesk as Address,
          data: encodeFunctionData({
            abi: PLAN_DESK_V3_ABI,
            functionName: "openPlan",
            args: [t.basket, cash, BigInt(t.interval), BigInt(t.auctionSecs), t.bandBps, t.stepBps, BigInt(t.refShares), BigInt(t.hardMin), BigInt(t.hardMax), t.keeper],
          }),
        },
      ];
      await wallet.send(list, setSteps);
      setNote("Plan opened. The house runs the first installment on its next sweep (within a few minutes), or press Run now.");
    });

  const runNow = (id: number) =>
    act(`run:${id}`, async () => {
      const json = (await keeperPost({ network: d.network, plan: { action: "run", id } })) as { plans?: RunResult[] };
      const r = json.plans?.[0];
      setNote(
        !r
          ? "Not due yet: the plan's interval hasn't passed."
          : r.status === "ran"
            ? `Installment placed: auction #${r.orderId} on the v3 desk. The house fills it once it reaches fair plus 0.15%; it shows in the book below.`
            : `The keeper didn't run it: ${r.reason ?? r.status}.`,
      );
    });

  const recenter = (p: PlanV3) =>
    act(`recenter:${p.id}`, async () => {
      const t = await terms(p.cashPerRun, p.interval >= 86_400 ? "monthly" : "demo");
      await wallet.send(
        [
          {
            label: `Re-center plan #${p.id} at today's price`,
            to: v3.planDesk as Address,
            data: encodeFunctionData({ abi: PLAN_DESK_V3_ABI, functionName: "recenter", args: [BigInt(p.id), BigInt(t.refShares), BigInt(t.hardMin), BigInt(t.hardMax)] }),
          },
        ],
        setSteps,
      );
      setNote(`Plan #${p.id} re-centered: ${sh(t.refShares)} ${t.symbol} a run, hard bounds ${sh(t.hardMin)} to ${sh(t.hardMax)}.`);
    });

  const close = (p: PlanV3) =>
    act(`close:${p.id}`, async () => {
      await wallet.send(
        [{ label: `Close plan #${p.id}`, to: v3.planDesk as Address, data: encodeFunctionData({ abi: PLAN_DESK_V3_ABI, functionName: "closePlan", args: [BigInt(p.id)] }) }],
        setSteps,
      );
      setNote(`Plan #${p.id} closed. Runs already posted stay on the desk until they fill or end.`);
    });

  const floorPct = EVM_PLAN_V3.hardMinBps / 100;
  const ceilPct = EVM_PLAN_V3.hardMaxBps / 100;

  return (
    <section className="mt-20 border-t border-line pt-16">
      <div className="max-w-[62ch]">
        <p className="text-xs text-ink-3">PlanDeskV3 on {d.label}</p>
        <h2 className="display mt-2 text-title text-ink">A monthly plan into {basket.symbol}</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          You open the plan from your wallet and name the house as its keeper: a fixed amount of {d.stable.symbol} a run, on a schedule, and the
          plan desk may pull only that much, only that often, up to the runs you approve. Each run is a Dutch auction on the v3 desk with you as
          the buyer. {d.tokenSource === "real" ? "The shares are made of Robinhood's own test stock tokens." : ""}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-3">
          The keeper names each run&apos;s fair count from live quotes, but the contract only accepts one within {EVM_PLAN_V3.stepBps / 100}% of
          what your last run actually filled at and inside the hard bounds you sign ({floorPct}% to {ceilPct}% of today&apos;s count). A bigger
          move pauses the plan until you re-center it. The 0.10% protocol fee goes to a separate treasury key.
        </p>
        <p className="mt-3 rounded-[var(--radius-control)] border border-line bg-raised px-4 py-3 text-sm leading-relaxed text-ink-2">
          {worstCaseLine(EVM_PLAN_V3.hardMinBps, basket.symbol)}
        </p>
      </div>

      <div className="mt-8 grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <div className="rounded-[var(--radius-panel)] border border-line-strong bg-surface p-6">
          <h3 className="text-base text-ink">Open a plan</h3>
          <label className="mt-4 block">
            <span className="text-xs text-ink-3">{d.stable.symbol} a run</span>
            <input
              type="number"
              min="0"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tnum display mt-2 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-3 text-xl text-ink outline-none focus-visible:border-bind"
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-sunk p-1" role="radiogroup" aria-label="How often">
            {(Object.keys(EVM_PLAN_V3.cadences) as PlanCadence[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={cadence === k}
                onClick={() => setCadence(k)}
                className={`rounded-[8px] px-2 py-2 text-[13px] ${cadence === k ? "bg-surface text-ink shadow-[0_1px_3px_rgb(20_37_28/0.15)]" : "text-ink-3 hover:text-ink"}`}
              >
                {EVM_PLAN_V3.cadences[k].label}
              </button>
            ))}
          </div>
          <p className="tnum mt-3 text-xs leading-relaxed text-ink-3">
            {cash ? `You approve ${fromRaw(cash * c.runs, d.stable.decimals).toFixed(2)} ${d.stable.symbol} in all (${c.runs} runs). ` : ""}
            Each run&apos;s auction lasts {Number(c.auctionSecs) / 60} minutes; the house fills at fair plus 0.15%, and anyone may fill first.
            {d.tokenSource === "real" ? " The test tokens above include 3 USDG: enough for the demo at 1 USDG a run." : ""}
          </p>
          <button
            type="button"
            onClick={() => void open()}
            disabled={!ready || !!busy || !cash}
            className="mt-4 w-full rounded-[var(--radius-control)] bg-bind px-4 py-3 text-sm font-medium text-white hover:bg-bind-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "open" ? "Working…" : !ready ? "Connect a wallet above first" : "Open the plan"}
          </button>
          <StepList steps={steps} d={d} />
          {note && <p className="mt-3 text-xs leading-relaxed text-ink-2">{note}</p>}
          {error && <p className="mt-3 text-sm text-loss">{error}</p>}
        </div>

        <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-6">
          <h3 className="text-base text-ink">Your plans on {d.label}</h3>
          {!wallet.address ? (
            <p className="mt-4 text-sm text-ink-3">Connect a wallet to see your plans.</p>
          ) : !plans ? (
            <p className="mt-4 text-sm text-ink-3">Reading the plan desk…</p>
          ) : plans.length === 0 ? (
            <p className="mt-4 text-sm text-ink-3">No plans yet.</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {plans.map((p) => {
                const sym = d.baskets.find((b) => b.address.toLowerCase() === p.basket.toLowerCase())?.symbol ?? shortAddress(p.basket);
                const due = p.nextRunAt <= now;
                return (
                  <li key={p.id} className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
                    <p className="text-ink">
                      Plan #{p.id}: {fromRaw(p.cashPerRun, d.stable.decimals).toFixed(2)} {d.stable.symbol} a run into {sym}
                      {p.active ? "" : " (closed)"}
                    </p>
                    <p className="tnum mt-1 text-xs leading-relaxed text-ink-3">
                      {p.runs} run{p.runs === 1 ? "" : "s"} so far ·{" "}
                      {p.active ? (due ? "due now" : `next ${when(p.nextRunAt)}`) : "no more runs"} · next run between {sh(p.low)} and {sh(p.high)}{" "}
                      {sym}; never outside {sh(p.hardMin)} to {sh(p.hardMax)}
                    </p>
                    {p.active && (
                      <span className="mt-2 flex flex-wrap gap-3 text-xs">
                        <button type="button" disabled={!!busy || !due} onClick={() => void runNow(p.id)} className="text-bind underline-offset-4 hover:underline disabled:opacity-50">
                          {busy === `run:${p.id}` ? "…" : "Run now"}
                        </button>
                        <button type="button" disabled={!!busy || !ready} onClick={() => void recenter(p)} className="text-ink-2 underline-offset-4 hover:underline disabled:opacity-50">
                          {busy === `recenter:${p.id}` ? "…" : "Re-center at today's price"}
                        </button>
                        <button type="button" disabled={!!busy || !ready} onClick={() => void close(p)} className="text-ink-2 underline-offset-4 hover:underline disabled:opacity-50">
                          {busy === `close:${p.id}` ? "…" : "Close"}
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            Plan desk{" "}
            <a href={`${d.explorer}/address/${v3.planDesk}`} target="_blank" rel="noreferrer" className={`tnum ${link}`}>
              {shortAddress(v3.planDesk, 6, 4)}
            </a>
            , keeper {shortAddress(house, 6, 4)} (the house). Only your own wallet can re-center or close a plan.
          </p>
        </div>
      </div>
    </section>
  );
}
