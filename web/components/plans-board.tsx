"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fetchPlans, fetchOrders, runPlanIx, closePlanIx, cancelOrderIx, freshNonce, type Plan, type Order } from "@/lib/desk";
import { useBaskets } from "@/lib/use-baskets";
import { confirmSignature } from "@/lib/confirm";
import { explainError } from "@/lib/tx";
import { explorerAddress } from "@/lib/config";
import { fromCashRaw } from "@/lib/use-cash";
import { money, shortAddress } from "@/lib/format";
import { PlanSheaf } from "./plan-sheaf";
import { ConnectButton } from "./connect-button";

const every = (secs: number) =>
  secs >= 28 * 86400 ? "a month" : secs >= 7 * 86400 ? "a week" : secs >= 86400 ? "a day" : secs >= 3600 ? `every ${Math.round(secs / 3600)} hours` : `every ${Math.round(secs / 60)} minutes`;

function until(ts: number, now: number) {
  const s = ts - now;
  if (s <= 0) return "due now";
  if (s < 90) return `in ${s}s`;
  if (s < 5400) return `in ${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

function PlanCard({
  plan,
  basketName,
  basketSymbol,
  pending,
  expired,
  now,
  mine,
  onRun,
  onClose,
  onRefund,
  busy,
}: {
  plan: Plan;
  basketName: string;
  basketSymbol: string;
  pending: Order | undefined;
  expired: Order | undefined;
  now: number;
  mine: boolean;
  onRun: (p: Plan) => void;
  onClose: (p: Plan) => void;
  onRefund: (o: Order) => void;
  busy: boolean;
}) {
  const ran = plan.runsTotal - plan.runsLeft;
  const due = plan.runsLeft > 0 && now >= plan.nextRunTs && !pending;
  return (
    <li className="flex gap-5 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
      <div className="size-28 shrink-0">
        <PlanSheaf filled={plan.fills} total={plan.runsTotal} className="h-full w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Link href={`/basket/${plan.basket}`} className="display text-xl text-ink hover:underline">
            {basketName}
          </Link>
          <span className="tnum text-sm text-ink-2">
            {money(fromCashRaw(plan.cashPerRun))} {every(plan.periodSecs)}
          </span>
        </div>
        <p className="tnum mt-1 text-sm text-ink-3">
          {plan.fills} of {plan.runsTotal} filled, {ran} run
          {plan.runsLeft > 0 ? ` · next run ${due ? "is due now" : until(plan.nextRunTs, now)}` : " · finished"}
        </p>
        {pending && (
          <p className="mt-2 text-sm text-ink-2">
            This run&apos;s {money(fromCashRaw(pending.cashAmount))} order for {basketSymbol} is open to fillers for another{" "}
            {until(pending.endTs, now).replace("in ", "")}.
          </p>
        )}
        {expired && (
          <p className="mt-2 text-sm text-ink-2">
            A {money(fromCashRaw(expired.cashAmount))} order ended unfilled. Anyone can return the dollars to the plan owner.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {expired && (
            <button type="button" onClick={() => onRefund(expired)} disabled={busy} className="rounded-[var(--radius-control)] border border-line-strong px-3.5 py-2 text-ink hover:border-ink-3 disabled:opacity-60">
              Return {money(fromCashRaw(expired.cashAmount))}
            </button>
          )}
          {due && (
            <button type="button" onClick={() => onRun(plan)} disabled={busy} className="rounded-[var(--radius-control)] bg-bind px-3.5 py-2 font-medium text-white hover:bg-bind-deep disabled:opacity-60">
              {mine ? "Run it now" : "Run it for them"}
            </button>
          )}
          {mine && (
            <button type="button" onClick={() => onClose(plan)} disabled={busy} className="rounded-[var(--radius-control)] border border-line-strong px-3.5 py-2 text-ink hover:border-ink-3 disabled:opacity-60">
              Close plan
            </button>
          )}
          <a href={explorerAddress(plan.address)} target="_blank" rel="noreferrer" className="text-xs text-ink-3 underline decoration-line-strong underline-offset-4">
            {mine ? "On Explorer" : `${shortAddress(plan.owner)}'s plan on Explorer`}
          </a>
        </div>
      </div>
    </li>
  );
}

export function PlansBoard() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { baskets } = useBaskets();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, o] = await Promise.all([fetchPlans(connection).catch(() => []), fetchOrders(connection).catch(() => [])]);
    setPlans(p.sort((a, b) => b.createdAt - a.createdAt));
    setOrders(o);
  }, [connection]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const r = setInterval(load, 15_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [load]);

  const byBasket = useMemo(() => new Map((baskets ?? []).map((b) => [b.address, b])), [baskets]);
  const pendingFor = (p: Plan) => orders.find((o) => o.plan === p.address && o.endTs >= now);
  const expiredFor = (p: Plan) => orders.find((o) => o.plan === p.address && o.endTs < now);
  const me = publicKey?.toBase58();
  const mine = (plans ?? []).filter((p) => p.owner === me);
  const others = (plans ?? []).filter((p) => p.owner !== me);
  const due = (plans ?? []).filter((p) => p.runsLeft > 0 && now >= p.nextRunTs && !pendingFor(p));

  async function act(build: () => Transaction, done: string) {
    if (!publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      const sig = await sendTransaction(build(), connection);
      await confirmSignature(connection, sig);
      setMessage(done);
      fetch("/api/keeper", { method: "POST" }).catch(() => {});
      await load();
    } catch (err) {
      setMessage(explainError(err));
    } finally {
      setBusy(false);
    }
  }

  const run = (p: Plan) =>
    act(() => new Transaction().add(runPlanIx({ cranker: publicKey!, plan: p, nonce: freshNonce() }).ix), "Ran it. The order is out; a filler will take it within the auction.");
  const close = (p: Plan) => act(() => new Transaction().add(closePlanIx({ owner: publicKey!, plan: p })), "Closed. The plan can no longer spend anything.");
  const refund = (o: Order) => act(() => new Transaction().add(cancelOrderIx({ caller: publicKey!, order: o })), "Returned. The dollars went back to the plan owner.");

  const card = (p: Plan, own: boolean) => {
    const b = byBasket.get(p.basket);
    return (
      <PlanCard
        key={p.address}
        plan={p}
        basketName={b?.name ?? shortAddress(p.basket)}
        basketSymbol={b?.symbol ?? ""}
        pending={pendingFor(p)}
        expired={expiredFor(p)}
        now={now}
        mine={own}
        onRun={run}
        onClose={close}
        onRefund={refund}
        busy={busy}
      />
    );
  };

  return (
    <div className="grid gap-14 lg:grid-cols-2">
      <section>
        <h2 className="display text-title text-ink">Your plans</h2>
        {!connected ? (
          <div className="mt-6 max-w-sm">
            <p className="mb-4 text-sm text-ink-2">Connect a wallet to see the plans it owns.</p>
            <ConnectButton block label="Connect a wallet" />
          </div>
        ) : plans == null ? (
          <div className="skeleton mt-6 h-40 rounded-[var(--radius-panel)]" />
        ) : mine.length === 0 ? (
          <div className="mt-6 rounded-[var(--radius-panel)] border border-dashed border-line-strong p-8">
            <p className="text-ink">No plans yet.</p>
            <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-ink-2">
              Open any basket and choose Monthly. Start with &ldquo;every 5 minutes&rdquo; to watch a few runs land today.
            </p>
            <Link href="/explore" className="mt-5 inline-flex rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white hover:bg-bind-deep">
              Choose a basket
            </Link>
          </div>
        ) : (
          <ul className="mt-6 space-y-4">{mine.map((p) => card(p, true))}</ul>
        )}
      </section>

      <section>
        <h2 className="display text-title text-ink">Every plan on Sheaf</h2>
        <p className="mt-3 max-w-[50ch] text-sm leading-relaxed text-ink-2">
          Running a due plan needs no permission: anyone can send the transaction, and the plan can only do the one thing
          its owner allowed. {due.length > 0 ? `${due.length} ${due.length === 1 ? "plan is" : "plans are"} due right now.` : "No plan is due right now."}
        </p>
        {plans == null ? (
          <div className="skeleton mt-6 h-40 rounded-[var(--radius-panel)]" />
        ) : others.length === 0 ? (
          <p className="mt-6 text-sm text-ink-3">Nobody else has opened one yet.</p>
        ) : (
          <ul className="mt-6 space-y-4">{others.slice(0, 12).map((p) => card(p, false))}</ul>
        )}
      </section>
      {message && <p className="lg:col-span-2 rounded-[var(--radius-control)] bg-raised px-4 py-3 text-sm text-ink-2" aria-live="polite">{message}</p>}
    </div>
  );
}
