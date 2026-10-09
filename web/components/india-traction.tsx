"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchPlans, type Plan } from "@/lib/desk";
import { fromCashRaw } from "@/lib/use-cash";
import { isTeamWallet } from "@/lib/team-wallets";
import { count, money } from "@/lib/format";
import { fxNote, rupees, type Fx } from "@/lib/fx";
import type { WaitlistCounts } from "@/lib/waitlist-options";
import { useInrRate } from "./india-fx";

/** Fired by the waitlist form after an answer is saved, with the new counts. */
export const WAITLIST_EVENT = "sheaf:waitlist-counts";

/** The waitlist counts, or null while the waitlist is closed; one request per page view, shared by every component. */
let waitlistRead: Promise<WaitlistCounts | null> | null = null;
export function readWaitlistCounts(): Promise<WaitlistCounts | null> {
  waitlistRead ??= fetch("/api/waitlist", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.open === true && typeof j.count === "number" ? (j as WaitlistCounts) : null))
    .catch(() => null);
  return waitlistRead;
}

const MONTH_SECS = 30 * 86400;
const DAY_SECS = 86400;

/** A plan's dollars a month at its real pace; demo-speed plans (runs minutes apart) have no monthly figure. */
const monthly = (p: Plan) => (p.periodSecs >= DAY_SECS ? (fromCashRaw(p.cashPerRun) * MONTH_SECS) / p.periodSecs : 0);
const isDemoPace = (p: Plan) => p.periodSecs < DAY_SECS;

type Split = {
  /** Plans opened by wallets that aren't ours. */
  outside: { plans: number; monthly: number; demoPace: number; toGo: number };
  /** Our own running plans: the house demo and any team test plan. Shown apart, never added to the headline. */
  ours: { plans: number; demoPace: number; perRun: number[] };
};

function split(plans: Plan[]): Split {
  const running = plans.filter((p) => !p.legacy && p.runsLeft > 0);
  const outside = running.filter((p) => !isTeamWallet(p.owner));
  const ours = running.filter((p) => isTeamWallet(p.owner));
  return {
    outside: {
      plans: outside.length,
      monthly: outside.reduce((s, p) => s + monthly(p), 0),
      demoPace: outside.filter(isDemoPace).length,
      toGo: outside.reduce((s, p) => s + fromCashRaw(p.cashPerRun) * p.runsLeft, 0),
    },
    ours: { plans: ours.length, demoPace: ours.filter(isDemoPace).length, perRun: ours.map((p) => fromCashRaw(p.cashPerRun)) },
  };
}

const both = (usd: number, fx: Fx) => `${rupees(usd * fx.rate)} (${money(usd)})`;

/** The India numbers Sheaf can show today, read live: visitors' plans and the waitlist. Our own plans sit apart. */
export function IndiaTraction() {
  const { connection } = useConnection();
  const { fx } = useInrRate();
  const [s, setS] = useState<Split | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistCounts | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchPlans(connection)
        .then((p) => live && setS(split(p)))
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
    void readWaitlistCounts().then((c) => live && c && setWaitlist(c));
    const onCounts = (e: Event) => {
      const c = (e as CustomEvent<WaitlistCounts>).detail;
      if (c && typeof c.count === "number") setWaitlist(c);
    };
    window.addEventListener(WAITLIST_EVENT, onCounts);
    return () => {
      live = false;
      window.removeEventListener(WAITLIST_EVENT, onCounts);
    };
  }, []);

  const o = s?.outside;
  const tiles: { k: string; v: string; s: string }[] = [
    {
      k: "Visitors' plans running",
      v: o ? count(o.plans) : "—",
      s: o ? (o.plans === 0 ? "No wallet outside the team has opened a plan yet." : "Opened by wallets that aren't ours") : "Reading plans from devnet…",
    },
    {
      k: "Committed a month by visitors",
      v: o ? rupees(o.monthly * fx.rate) : "—",
      s: o
        ? `${money(o.monthly)} in test dollars, monthly and weekly plans${o.demoPace ? `; ${count(o.demoPace)} demo-pace ${o.demoPace === 1 ? "plan isn't" : "plans aren't"} counted as monthly` : ""}`
        : "",
    },
    {
      k: "Still to go in from visitors' plans",
      v: o ? rupees(o.toGo * fx.rate) : "—",
      s: o ? `${money(o.toGo)} in test dollars over their remaining runs` : "",
    },
  ];
  if (waitlist) {
    const abroad = waitlist.byHome.nri;
    tiles.push({
      k: "On the India waitlist",
      v: count(waitlist.count),
      s: `${count(waitlist.withContact)} left a contact · ${count(abroad)} ${abroad === 1 ? "is an NRI" : "are NRIs"} outside the US, UK, Canada and Australia`,
    });
  }

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
      {s && s.ours.plans > 0 && (
        <p className="tnum mt-3 rounded-[var(--radius-control)] border border-dashed border-line-strong px-4 py-3 text-xs leading-relaxed text-ink-3">
          <span className="text-ink-2">Ours (demo pace), not counted above:</span>{" "}
          {`${count(s.ours.plans)} ${s.ours.plans === 1 ? "plan" : "plans"} run by the team, ${s.ours.perRun.map((u) => both(u, fx)).join(", ")} a run`}
          {s.ours.demoPace > 0
            ? `, ${s.ours.demoPace === s.ours.plans ? "" : `${count(s.ours.demoPace)} of them `}every few minutes so you can watch runs land. A demo pace isn't a monthly commitment, so it has no monthly figure.`
            : "."}
        </p>
      )}
      <p className="mt-3 max-w-[80ch] text-xs leading-relaxed text-ink-3">
        Read live from the Sheaf program on devnet, in test dollars. Monthly and weekly plans count at their real rate. Rupees at{" "}
        {fxNote(fx)}.
      </p>
    </div>
  );
}
