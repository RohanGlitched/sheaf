"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fetchPlans, fetchOrders, runPlanIx, closePlanIx, closeLegacyPlanIx, cancelOrderIx, updatePlanIx, freshNonce, type Plan, type Order } from "@/lib/desk";
import { useBaskets } from "@/lib/use-baskets";
import { valueBasket } from "@/lib/basket-view";
import { useKeeperKick } from "@/lib/use-keeper-kick";
import { confirmSignature } from "@/lib/confirm";
import { explainError } from "@/lib/tx";
import { explorerAddress } from "@/lib/config";
import { fromCashRaw } from "@/lib/use-cash";
import { count, money, shortAddress, timeAgo } from "@/lib/format";
import { useMarket } from "./market-provider";
import { PlanSheaf } from "./plan-sheaf";
import { planTerms } from "./plan-form";
import { ConnectButton } from "./connect-button";
import { teamTag, teamWallet } from "@/lib/team-wallets";

/**
 * Five broken test plans: two from before the hardening release and three from
 * UI tests whose throwaway keys are gone, so nobody can ever close them. Only
 * their owners see them. Every other plan is shown, our own ones tagged.
 */
const HIDDEN_TEST_PLANS = new Set([
  "AfdM1DvJnN4TquHS7py5eZBzHFi5eTwy4Sn5VUKgz8sG",
  "CfDyw9pSC1eqiUZ1fLMMeqqgFquHZDAh7QB222fRhx1B",
  "FZF5XBMGyS8ddbKLFuPnY95QKSUGpXLiZsr5udDz6V9Q",
  "AsqCRKYCvqzDhFPRRBWYRJwfGA5PB7R2JTr7e63sGS62",
  "2DMVZNc3eUsDbU9s15UDfYEkpnkdWoBpStt9tWpGFztc",
]);

/** How long the keeper leaves a buyer's own expired order for them to return, before returning it itself. */
const REFUND_GRACE_SECS = 10 * 60;

/** The pill beside a plan the team opened: the house's live demo, or one of our test wallets. */
function ownerPill(owner: string): string | null {
  const w = teamWallet(owner);
  if (!w || teamTag(owner) == null) return null;
  return w.role === "house" ? "Sheaf demo" : w.role === "test" ? "our test" : "Sheaf";
}
const isHouse = (address: string) => teamWallet(address)?.role === "house";

/** A plan whose reference sits further than this from today's fair rate is offered a re-center. */
const RECENTER_DRIFT = 0.02;

/** The demo cadence's auction, short enough that one run has closed before the next is due. */
const DEMO_AUCTION_SECS = 240;

const every = (secs: number) =>
  secs >= 28 * 86400 ? "a month" : secs >= 7 * 86400 ? "a week" : secs >= 86400 ? "a day" : secs >= 3600 ? `every ${Math.round(secs / 3600)} hours` : `every ${Math.round(secs / 60)} minutes`;

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

function until(ts: number, now: number) {
  const s = ts - now;
  if (s <= 0) return "due now";
  if (s < 90) return `in ${s}s`;
  if (s < 5400) return `in ${Math.round(s / 60)} min`;
  if (s < 2 * 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

type Note = { plan: string; text: string; tone: "done" | "error" };

function PlanCard({
  plan,
  basketName,
  basketSymbol,
  fairPrice,
  pending,
  expired,
  now,
  mine,
  onRun,
  onClose,
  onRefund,
  onRecenter,
  busy,
  note,
}: {
  plan: Plan;
  basketName: string;
  basketSymbol: string;
  /** Today's fair price of one share in dollars, when the market has been read. */
  fairPrice: number | null;
  pending: Order | undefined;
  expired: Order | undefined;
  now: number;
  mine: boolean;
  onRun: (p: Plan) => void;
  onClose: (p: Plan) => void;
  onRefund: (p: Plan, o: Order) => void;
  onRecenter: (p: Plan, fair: number) => void;
  busy: boolean;
  note: Note | null;
}) {
  const ran = plan.runsTotal - plan.runsLeft;
  const due = !plan.legacy && plan.runsLeft > 0 && now >= plan.nextRunTs && !pending;
  // The reference is shares per dollar, times 1e9; as a price, one share costs 1e9 / ref dollars.
  const refPrice = plan.refSharesPerCashE9 > 0n ? 1e9 / Number(plan.refSharesPerCashE9) : null;
  const drift = fairPrice != null && refPrice != null ? refPrice / fairPrice - 1 : null;
  const offCenter = mine && !plan.legacy && plan.runsLeft > 0 && drift != null && Math.abs(drift) > RECENTER_DRIFT;
  const pill = ownerPill(plan.owner);
  // An expired order the house paid rent for goes back on the keeper's next pass; anyone else's after the grace.
  const returnsIn = expired && !isHouse(expired.rentPayer) ? expired.endTs + REFUND_GRACE_SECS - now : 0;
  return (
    <li className="flex gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-4 sm:gap-5 sm:p-5">
      <div className="size-20 shrink-0 sm:size-28">
        <PlanSheaf filled={plan.fills} total={plan.runsTotal} className="h-full w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <Link href={`/basket/${plan.basket}`} className="display text-xl text-ink hover:underline">
              {basketName}
            </Link>
            {pill && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] leading-none ${pill === "Sheaf demo" ? "bg-bind-wash text-bind" : "bg-sunk text-ink-3"}`}
                title={pill === "Sheaf demo" ? "The house's own demo plan, run by the keeper on its schedule" : "Opened by one of the team's test wallets"}
              >
                {pill}
              </span>
            )}
          </span>
          <span className="tnum text-sm text-ink-2">
            {money(fromCashRaw(plan.cashPerRun))} {every(plan.periodSecs)}
          </span>
        </div>
        <p className="tnum mt-1 text-sm text-ink-3">
          {plan.fills} of {plan.runsTotal} filled from {plural(ran, "run")}
          {plan.runsLeft === 0
            ? pending
              ? " · last run filling"
              : " · finished"
            : due
              ? " · next run is due now"
              : pending && now >= plan.nextRunTs
                ? " · next run once this order closes"
                : ` · next run ${until(plan.nextRunTs, now)}`}
          {plan.fills > 0 && plan.lastFillTs > 0 && ` · last filled ${timeAgo(plan.lastFillTs)}`}
        </p>
        {pending && (
          <p className="mt-2 text-sm text-ink-2">
            This run&apos;s {money(fromCashRaw(pending.cashAmount))} order for {basketSymbol || basketName} is open to fillers for another{" "}
            {until(pending.endTs, now).replace("in ", "")}.
          </p>
        )}
        {expired && (
          <p className="mt-2 text-sm text-ink-2">
            A {money(fromCashRaw(expired.cashAmount))} order ended unfilled. Anyone can press Return to send the dollars back to the plan
            owner now;{" "}
            {returnsIn > 0
              ? `otherwise the keeper returns them in about ${Math.max(1, Math.ceil(returnsIn / 60))} min.`
              : "otherwise the keeper returns them on its next pass."}
          </p>
        )}
        {offCenter && refPrice != null && fairPrice != null && (
          <p className="mt-2 text-sm text-ink-2">
            Its reference price, {money(refPrice)} a share, is {Math.abs(drift! * 100).toFixed(1)}% {drift! > 0 ? "above" : "below"} today&apos;s
            fair price of {money(fairPrice)}. Re-center it so the next run starts from today&apos;s price.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {expired && (
            <button type="button" onClick={() => onRefund(plan, expired)} disabled={busy} className="rounded-[var(--radius-control)] border border-line-strong px-3.5 py-2 text-ink hover:border-ink-3 disabled:opacity-60">
              Return {money(fromCashRaw(expired.cashAmount))}
            </button>
          )}
          {due && (
            <button type="button" onClick={() => onRun(plan)} disabled={busy} className="rounded-[var(--radius-control)] bg-bind px-3.5 py-2 font-medium text-white hover:bg-bind-deep disabled:opacity-60">
              {mine ? "Run it now" : "Run it for them"}
            </button>
          )}
          {offCenter && fairPrice != null && (
            <button type="button" onClick={() => onRecenter(plan, fairPrice)} disabled={busy} className="rounded-[var(--radius-control)] border border-bind px-3.5 py-2 text-bind hover:bg-bind-wash disabled:opacity-60">
              Re-center
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
        {note && (
          <p className={`mt-3 text-sm ${note.tone === "error" ? "border-l-2 border-loss pl-3 text-loss" : "text-ink-2"}`} aria-live="polite">
            {note.text}
          </p>
        )}
      </div>
    </li>
  );
}

/** Plans from before the hardening release: they no longer run, so they sit folded away in one quiet row. */
function LegacyPlans({
  plans,
  mine,
  nameOf,
  onClose,
  busy,
  notes,
}: {
  plans: Plan[];
  mine: boolean;
  nameOf: (p: Plan) => string;
  onClose: (p: Plan) => void;
  busy: boolean;
  notes: Note | null;
}) {
  if (plans.length === 0) return null;
  return (
    <details className="group mt-4 rounded-[var(--radius-panel)] border border-line">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-ink-3 hover:text-ink-2 [&::-webkit-details-marker]:hidden">
        <span>{plural(plans.length, "plan")} from an earlier version</span>
        <span aria-hidden className="text-xs transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="border-t border-line px-4 pb-4 pt-3">
        <p className="text-xs leading-relaxed text-ink-3">
          Opened before the program&apos;s hardening release, so {plans.length === 1 ? "it no longer runs" : "they no longer run"}.{" "}
          {mine ? "Close one to cancel its allowance on your dollars." : "Only their owners can close them."}
        </p>
        <ul className="mt-3 divide-y divide-line">
          {plans.map((p) => (
            <li key={p.address} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <span className="tnum text-ink-2">
                  {nameOf(p)} · {money(fromCashRaw(p.cashPerRun))} {every(p.periodSecs)} · {p.fills} of {p.runsTotal} filled
                </span>
                <span className="flex items-center gap-3">
                  {mine && (
                    <button type="button" onClick={() => onClose(p)} disabled={busy} className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-xs text-ink hover:border-ink-3 disabled:opacity-60">
                      Close plan
                    </button>
                  )}
                  <a href={explorerAddress(p.address)} target="_blank" rel="noreferrer" className="text-xs text-ink-3 underline decoration-line-strong underline-offset-4">
                    Explorer
                  </a>
                </span>
              </div>
              {notes?.plan === p.address && (
                <p className={`mt-2 text-xs ${notes.tone === "error" ? "text-loss" : "text-ink-2"}`} aria-live="polite">
                  {notes.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function PlansBoard() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { baskets } = useBaskets();
  const { snapshot } = useMarket();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  // The cron runs rarely; while someone watches this page, it asks the keeper itself.
  useKeeperKick("/api/keeper");

  const load = useCallback(async () => {
    const [p, o] = await Promise.all([fetchPlans(connection).catch(() => null), fetchOrders(connection).catch(() => null)]);
    // A failed read keeps what is already on screen rather than emptying the board.
    if (p) setPlans(p.sort((a, b) => b.createdAt - a.createdAt));
    else setPlans((prev) => prev ?? []);
    if (o) setOrders(o);
  }, [connection]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const r = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [load]);

  const byBasket = useMemo(() => new Map((baskets ?? []).map((b) => [b.address, b])), [baskets]);
  const fairOf = useMemo(() => {
    const navs = new Map<string, number | null>();
    for (const b of baskets ?? []) navs.set(b.address, valueBasket(b, snapshot).nav);
    return (basket: string) => navs.get(basket) ?? null;
  }, [baskets, snapshot]);

  const pendingFor = (p: Plan) => orders.find((o) => o.plan === p.address && o.endTs >= now);
  const expiredFor = (p: Plan) => orders.find((o) => o.plan === p.address && o.endTs < now);
  const me = publicKey?.toBase58();
  const visible = (plans ?? []).filter((p) => !HIDDEN_TEST_PLANS.has(p.address) || p.owner === me);
  // The house's running demo first, so a sheaf visibly grows at the top; then running plans; finished ones last.
  const rank = (p: Plan) => (p.runsLeft > 0 ? (isHouse(p.owner) ? 0 : 1) : 2);
  const live = visible.filter((p) => !p.legacy).sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  const mine = live.filter((p) => p.owner === me);
  const others = live.filter((p) => p.owner !== me);
  const mineLegacy = visible.filter((p) => p.legacy && p.owner === me);
  const othersLegacy = visible.filter((p) => p.legacy && p.owner !== me);
  const due = live.filter((p) => p.runsLeft > 0 && now >= p.nextRunTs && !pendingFor(p));
  // Every figure is split into the team's own plans and everyone else's, so nothing of ours reads as traction.
  const tally = (list: Plan[]) => ({
    running: list.filter((p) => p.runsLeft > 0).length,
    fills: list.reduce((n, p) => n + p.fills, 0),
    // Every fill spends exactly one run's dollars, so this is what plans have actually put in.
    invested: list.reduce((sum, p) => sum + fromCashRaw(p.cashPerRun) * p.fills, 0),
  });
  const ours = tally(live.filter((p) => ownerPill(p.owner) != null));
  const outside = tally(live.filter((p) => ownerPill(p.owner) == null));
  const nameOf = (p: Plan) => byBasket.get(p.basket)?.name ?? shortAddress(p.basket);

  async function act(plan: Plan, build: () => Transaction, done: string, explainAs?: { action?: "cancel" }) {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      const sig = await sendTransaction(build(), connection);
      await confirmSignature(connection, sig);
      setNote({ plan: plan.address, text: done, tone: "done" });
      fetch("/api/keeper", { method: "POST" }).catch(() => {});
      await load();
    } catch (err) {
      const text = explainError(err, explainAs);
      setNote({ plan: plan.address, text, tone: text === "Already returned." ? "done" : "error" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const run = (p: Plan) =>
    act(p, () => new Transaction().add(runPlanIx({ cranker: publicKey!, plan: p, nonce: freshNonce() }).ix), "Ran it. The order is out; a filler will take it within the auction.");
  const close = (p: Plan) =>
    act(
      p,
      () => new Transaction().add(p.legacy ? closeLegacyPlanIx({ owner: publicKey!, plan: p }) : closePlanIx({ owner: publicKey!, plan: p })),
      "Closed. The plan can no longer spend anything.",
    );
  async function refund(p: Plan, o: Order) {
    // The keeper may have returned it while this page was open; then there is nothing to sign.
    const info = await connection.getAccountInfo(new PublicKey(o.address)).catch(() => undefined);
    if (info === null) {
      setNote({ plan: p.address, text: "Already returned. The dollars are back with the plan owner.", tone: "done" });
      await load();
      return;
    }
    await act(p, () => new Transaction().add(cancelOrderIx({ caller: publicKey!, order: o })), "Returned. The dollars went back to the plan owner.", { action: "cancel" });
  }
  const recenter = (p: Plan, fair: number) => {
    const terms = planTerms(fair);
    return act(
      p,
      () =>
        new Transaction().add(
          updatePlanIx({
            owner: publicKey!,
            plan: p,
            ref: terms.ref,
            bandBps: p.bandBps,
            // A demo-speed plan from before the shorter auction gets it now, so its runs stop overlapping.
            auctionSecs: p.periodSecs <= 300 ? Math.min(p.auctionSecs, DEMO_AUCTION_SECS) : p.auctionSecs,
            minRef: terms.minRef,
            maxRef: terms.maxRef,
          }),
        ),
      `Re-centered on today's fair price of ${money(fair)} a share. The next run starts from there.`,
    );
  };

  const card = (p: Plan, own: boolean) => {
    const b = byBasket.get(p.basket);
    return (
      <PlanCard
        key={p.address}
        plan={p}
        basketName={b?.name ?? shortAddress(p.basket)}
        basketSymbol={b?.symbol ?? ""}
        fairPrice={fairOf(p.basket)}
        pending={pendingFor(p)}
        expired={expiredFor(p)}
        now={now}
        mine={own}
        onRun={run}
        onClose={close}
        onRefund={refund}
        onRecenter={recenter}
        busy={busy}
        note={note?.plan === p.address ? note : null}
      />
    );
  };

  const split = (o: number | string, x: number | string) => (
    <>
      <span className="block">{o} ours</span>
      <span className="block">{x} from outside wallets</span>
    </>
  );
  const stats = [
    { label: "Plans running", value: count(ours.running + outside.running), note: split(ours.running, outside.running) },
    { label: "Runs filled", value: count(ours.fills + outside.fills), note: split(ours.fills, outside.fills) },
    { label: "Dollars put in by plans", value: money(ours.invested + outside.invested), note: split(money(ours.invested), money(outside.invested)) },
    { label: "Due right now", value: count(due.length), note: "anyone may run a due plan" },
  ];

  return (
    <div>
      <dl className="mb-14 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface px-4 py-4 sm:px-5">
            <dt className="text-xs text-ink-3">{s.label}</dt>
            <dd className="display tnum mt-1 text-2xl text-ink">{plans == null ? "—" : s.value}</dd>
            <dd className="tnum mt-1 text-xs text-ink-3">{plans == null ? "reading the chain" : s.note}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-14 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="display text-title text-ink">Your plans</h2>
          {!connected ? (
            <div className="mt-6 max-w-sm">
              <p className="mb-4 text-sm text-ink-2">Connect a wallet to see the plans it owns.</p>
              <ConnectButton block label="Connect a wallet" />
            </div>
          ) : plans == null ? (
            <div className="skeleton mt-6 h-40 rounded-[var(--radius-panel)]" />
          ) : mine.length === 0 ? (
            <>
              <div className="mt-6 rounded-[var(--radius-panel)] border border-dashed border-line-strong p-8">
                <p className="text-ink">No plans yet.</p>
                <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-ink-2">
                  Open any basket and choose the Monthly plan tab. Start with &ldquo;every 5 minutes&rdquo; to watch a few runs land today.
                </p>
                <Link href="/explore" className="mt-5 inline-flex rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white hover:bg-bind-deep">
                  Choose a basket
                </Link>
              </div>
              <LegacyPlans plans={mineLegacy} mine nameOf={nameOf} onClose={close} busy={busy} notes={note} />
            </>
          ) : (
            <>
              <ul className="mt-6 space-y-4">{mine.map((p) => card(p, true))}</ul>
              <LegacyPlans plans={mineLegacy} mine nameOf={nameOf} onClose={close} busy={busy} notes={note} />
            </>
          )}
        </section>

        <section className="min-w-0">
          <h2 className="display text-title text-ink">Every plan on Sheaf</h2>
          <p className="mt-3 max-w-[50ch] text-sm leading-relaxed text-ink-2">
            Running a due plan needs no permission: anyone can send the transaction, and the plan can only do the one thing
            its owner allowed.{" "}
            {plans == null ? "" : due.length > 0 ? `${due.length} ${due.length === 1 ? "plan is" : "plans are"} due right now.` : "No plan is due right now."}
          </p>
          {plans == null ? (
            <div className="skeleton mt-6 h-40 rounded-[var(--radius-panel)]" />
          ) : others.length === 0 ? (
            <p className="mt-6 text-sm text-ink-3">Nobody else has a plan running yet.</p>
          ) : (
            <ul className="mt-6 space-y-4">{others.slice(0, 12).map((p) => card(p, false))}</ul>
          )}
          {plans != null && outside.running + outside.fills === 0 && (
            <p className="mt-4 text-sm text-ink-3">
              No outside wallet has opened a plan yet. Be the first:{" "}
              <Link href="/explore" className="text-bind underline decoration-bind/40 underline-offset-4">
                choose a basket
              </Link>
              , then the Monthly plan tab.
            </p>
          )}
          {plans != null && <LegacyPlans plans={othersLegacy} mine={false} nameOf={nameOf} onClose={close} busy={busy} notes={note} />}
        </section>
      </div>
    </div>
  );
}
