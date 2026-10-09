"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchPlans, type Plan } from "@/lib/desk";
import { fromCashRaw } from "@/lib/use-cash";
import { isTeamWallet } from "@/lib/team-wallets";
import { count, money } from "@/lib/format";
import { rupees, useInrRate } from "./plan-form";

/** Fired by the waitlist form after an answer is saved, with the new count. */
export const WAITLIST_EVENT = "sheaf:waitlist-count";

/** The waitlist count, or null while the waitlist is closed; one request per page view, shared by every component. */
let waitlistRead: Promise<number | null> | null = null;
export function readWaitlistCount(): Promise<number | null> {
  waitlistRead ??= fetch("/api/waitlist", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.open === true && typeof j.count === "number" ? (j.count as number) : null))
    .catch(() => null);
  return waitlistRead;
}

const MONTH_SECS = 30 * 86400;

/**
 * A running plan's dollars per month. Monthly and weekly plans count at their
 * real rate; a demo-speed plan (every few minutes) counts one run a month, as
 * if it were the monthly plan it stands in for.
 */
function perMonth(p: Plan): number {
  const run = fromCashRaw(p.cashPerRun);
  return p.periodSecs >= 86400 ? (run * MONTH_SECS) / p.periodSecs : run;
}

type Totals = { plans: number; outsidePlans: number; monthly: number; outsideMonthly: number; toGo: number };

function totals(plans: Plan[]): Totals {
  const running = plans.filter((p) => !p.legacy && p.runsLeft > 0);
  const outside = running.filter((p) => !isTeamWallet(p.owner));
  const sum = (xs: Plan[], f: (p: Plan) => number) => xs.reduce((s, p) => s + f(p), 0);
  return {
    plans: running.length,
    outsidePlans: outside.length,
    monthly: sum(running, perMonth),
    outsideMonthly: sum(outside, perMonth),
    toGo: sum(running, (p) => fromCashRaw(p.cashPerRun) * p.runsLeft),
  };
}

/** The India numbers Sheaf can show today, read live: rupees committed by running plans, and the waitlist. */
export function IndiaTraction() {
  const { connection } = useConnection();
  const { rate } = useInrRate();
  const [t, setT] = useState<Totals | null>(null);
  const [waitlist, setWaitlist] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchPlans(connection)
        .then((p) => live && setT(totals(p)))
        .catch(() => {});
    void load();
    const r = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => {
      live = false;
      clearInterval(r);
    };
  }, [connection]);

  useEffect(() => {
    let live = true;
    void readWaitlistCount().then((n) => live && n != null && setWaitlist(n));
    const onCount = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === "number") setWaitlist(n);
    };
    window.addEventListener(WAITLIST_EVENT, onCount);
    return () => {
      live = false;
      window.removeEventListener(WAITLIST_EVENT, onCount);
    };
  }, []);

  const inr = (usd: number) => (rate ? rupees(usd * rate) : money(usd));
  const usdNote = (usd: number) => (rate ? `${money(usd)} in test dollars` : "in test dollars");

  const tiles: { k: string; v: string; s: string }[] = [
    {
      k: "Committed a month by running plans",
      v: t ? inr(t.monthly) : "—",
      s: t ? `${usdNote(t.monthly)}, across ${count(t.plans)} ${t.plans === 1 ? "plan" : "plans"}` : "Reading plans from devnet…",
    },
    {
      k: "Of that, from wallets that aren't ours",
      v: t ? inr(t.outsideMonthly) : "—",
      s: t ? `${count(t.outsidePlans)} ${t.outsidePlans === 1 ? "plan" : "plans"} opened by visitors` : "",
    },
    {
      k: "Still to go in over the remaining runs",
      v: t ? inr(t.toGo) : "—",
      s: t ? usdNote(t.toGo) : "",
    },
  ];
  if (waitlist != null) tiles.push({ k: "On the India waitlist", v: count(waitlist), s: `${waitlist === 1 ? "person has" : "people have"} asked to hear when Sheaf opens in India` });

  return (
    <div>
      <dl className={`grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 ${tiles.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {tiles.map((x) => (
          <div key={x.k} className="bg-surface p-5 sm:p-6">
            <dt className="text-xs text-ink-3">{x.k}</dt>
            <dd className="display tnum mt-2 text-3xl text-ink">{x.v}</dd>
            <dd className="tnum mt-2 text-xs leading-relaxed text-ink-3">{x.s}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 max-w-[80ch] text-xs leading-relaxed text-ink-3">
        Read live from the Sheaf program on devnet. Monthly and weekly plans count at their real rate; a demo-speed plan counts
        one run a month. Rupees at today&apos;s rate{rate ? ` (₹${rate.toFixed(2)} to the dollar)` : ""}.
      </p>
    </div>
  );
}
