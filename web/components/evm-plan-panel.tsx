"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import {
  ERC20_ABI,
  EVM_PLAN_V3,
  PLAN_DESK_V3_ABI,
  explainEvmError,
  fairSharesFor,
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

/** What a plan's terms must be, from this page's own deployment record, cadence and price. */
export type ExpectedTerms = {
  basket: string;
  planDesk: string;
  /** The keeper the plan names; omitted on Tempo, where the plan names none and an access key runs it. */
  keeper?: string;
  cashPerRun: bigint;
  interval: bigint;
  auctionSecs: bigint;
  runs?: bigint;
  bandBps: number;
  stepBps: number;
  hardMinBps: number;
  hardMaxBps: number;
  /** Today's fair count for one run at the price this page shows; null while the page has no price. */
  fairShares: bigint | null;
  symbol: string;
};

type OfferedTerms = {
  basket: string;
  planDesk: string;
  keeper?: string;
  cashPerRun: string;
  interval: string;
  auctionSecs: string;
  runs?: string;
  bandBps: number;
  stepBps: number;
  refShares: string;
  hardMin: string;
  hardMax: string;
};

/** How far the server's count may sit from the one this page computes from its own price. */
const FAIR_TOLERANCE = 0.03;
/** How far each hard bound may sit from its stated share of the reference, in bps. */
const BOUND_TOLERANCE_BPS = 10;

/**
 * Checks the terms the keeper route offers against what this page expects before
 * anything is signed: the basket, the plan desk and the keeper from the deployment
 * record; the amount, schedule, band and step for the chosen cadence; hard bounds
 * at the stated share of the reference; and a reference within 3% of the count
 * this page's own price gives. A wrong or tampered answer is refused, unsigned.
 */
export function checkPlanTerms(t: OfferedTerms, want: ExpectedTerms): void {
  const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const refuse = (what: string) => {
    throw new Error(`The plan terms from Sheaf's server don't match this page (${what}), so nothing was signed. Reload and try again.`);
  };
  if (!same(t.basket, want.basket)) refuse("a different basket");
  if (!same(t.planDesk, want.planDesk)) refuse("a different plan desk");
  if (want.keeper != null && !same(t.keeper, want.keeper)) refuse("a keeper other than the house");
  if (BigInt(t.cashPerRun) !== want.cashPerRun) refuse("a different amount a run");
  if (BigInt(t.interval) !== want.interval || BigInt(t.auctionSecs) !== want.auctionSecs) refuse("a different schedule");
  if (want.runs != null && (t.runs == null || BigInt(t.runs) !== want.runs)) refuse("a different number of runs");
  if (t.bandBps !== want.bandBps || t.stepBps !== want.stepBps) refuse("a different window or step");
  const ref = BigInt(t.refShares);
  if (ref <= 0n) refuse("no reference count");
  // Each bound as bps of the reference, to a hundredth of a bp.
  const bps = (v: string) => Number((BigInt(v) * 1_000_000n) / ref) / 100;
  if (Math.abs(bps(t.hardMin) - want.hardMinBps) > BOUND_TOLERANCE_BPS) refuse("a different floor");
  if (Math.abs(bps(t.hardMax) - want.hardMaxBps) > BOUND_TOLERANCE_BPS) refuse("a different ceiling");
  if (want.fairShares == null || want.fairShares <= 0n) {
    throw new Error(`This page hasn't priced ${want.symbol} yet, so it can't check the plan's count. Try again in a moment.`);
  }
  const off = Math.abs(Number(ref - want.fairShares)) / Number(want.fairShares);
  if (off > FAIR_TOLERANCE) refuse(`a count ${(off * 100).toFixed(1)}% from today's price on this page`);
}

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

export function EvmPlanPanel({
  d,
  basket,
  wallet,
  nav,
  onDone,
}: {
  d: Deployment;
  basket: ChainBasket;
  wallet: EvmWallet;
  /** The share price this page shows: the plan terms are checked against it before signing. */
  nav: number | null;
  onDone: () => void;
}) {
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

  // The server names each plan's terms; the page checks every one of them before the wallet sees a step.
  const terms = async (cashPerRun: bigint, cad: PlanCadence, runs?: bigint) => {
    const t = (await keeperPost({ network: d.network, plan: { action: "terms", basket: basket.address, cash: cashPerRun.toString(), cadence: cad } })) as unknown as Terms;
    const k = EVM_PLAN_V3.cadences[cad];
    checkPlanTerms(t, {
      basket: basket.address,
      planDesk: v3.planDesk,
      keeper: house,
      cashPerRun,
      interval: k.interval,
      auctionSecs: k.auctionSecs,
      runs,
      bandBps: EVM_PLAN_V3.bandBps,
      stepBps: EVM_PLAN_V3.stepBps,
      hardMinBps: EVM_PLAN_V3.hardMinBps,
      hardMaxBps: EVM_PLAN_V3.hardMaxBps,
      fairShares: nav != null && nav > 0 ? fairSharesFor(cashPerRun, d.stable.decimals, nav) : null,
      symbol: basket.symbol,
    });
    return t;
  };

  const open = () =>
    act("open", async () => {
      if (!cash || !wallet.address) return;
      const t = await terms(cash, cadence, c.runs);
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
          label: `Open the plan: ${fromRaw(cash, d.stable.decimals).toFixed(2)} ${d.stable.symbol} a run into ${t.symbol}, about ${sh(t.refShares)} a run today, never below ${sh(t.hardMin)} or above ${sh(t.hardMax)}`,
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
      // The terms are checked against this page's price, so a plan on another basket is re-centered from that basket's page.
      if (p.basket.toLowerCase() !== basket.address.toLowerCase()) {
        const other = d.baskets.find((b) => b.address.toLowerCase() === p.basket.toLowerCase())?.symbol ?? shortAddress(p.basket);
        throw new Error(`Plan #${p.id} buys ${other}. Re-center it from the ${other} page, which checks the new terms against that basket's price.`);
      }
      const t = await terms(p.cashPerRun, p.interval >= 86_400 ? "monthly" : "demo");
      await wallet.send(
        [
          {
            label: `Re-center plan #${p.id} at today's price: about ${sh(t.refShares)} ${t.symbol} a run, never below ${sh(t.hardMin)} or above ${sh(t.hardMax)}`,
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
    <section id="plan" className="mt-20 scroll-mt-24 border-t border-line pt-16">
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
          what your last run actually filled at and inside the hard bounds you sign ({floorPct}% to {ceilPct}% of today&apos;s count). Before
          your wallet signs, this page checks the keeper, basket, schedule and bounds the server offers against its own price, and the step
          shows the bounds in shares. A bigger
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
