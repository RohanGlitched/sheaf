"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchPlans, type Plan } from "@/lib/desk";
import { fromCashRaw } from "@/lib/use-cash";
import { isTeamWallet } from "@/lib/team-wallets";
import { count, money } from "@/lib/format";
import { fxNote, rupees } from "@/lib/fx";
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
  /** Plans opened by wallets outside the team. */
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

/** The India numbers, read live: visitors' plans and the waitlist, each shown once it is above zero. Team plans never count. */
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

  // Each figure appears once it is above zero; until then the section stands on its own without empty tiles.
  const o = s?.outside;
  const tiles: { k: string; v: string; s: string }[] = [];
  if (o && o.plans > 0) {
    tiles.push({ k: "Visitors' plans running", v: count(o.plans), s: "Opened by wallets outside the team" });
    if (o.monthly > 0) {
      tiles.push({
        k: "Committed a month by visitors",
        v: rupees(o.monthly * fx.rate),
        s: `${money(o.monthly)} in test dollars, monthly and weekly plans${o.demoPace ? `; ${count(o.demoPace)} demo-pace ${o.demoPace === 1 ? "plan isn't" : "plans aren't"} counted as monthly` : ""}`,
      });
    }
    if (o.toGo > 0) {
      tiles.push({ k: "Still to go in from visitors' plans", v: rupees(o.toGo * fx.rate), s: `${money(o.toGo)} in test dollars over their remaining runs` });
    }
  }
  if (waitlist && waitlist.count >= 1) {
    const abroad = waitlist.byHome.nri;
    const parts = [
      abroad > 0 ? `${count(abroad)} ${abroad === 1 ? "is an NRI" : "are NRIs"} outside the US, UK, Canada and Australia` : null,
    ].filter(Boolean);
    tiles.push({ k: "On the India waitlist, with a contact", v: count(waitlist.count), s: parts.join(" ") });
  }
  if (tiles.length === 0) return null;

  return (
    <div>
      <dl className={`grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2 ${tiles.length === 4 ? "lg:grid-cols-4" : tiles.length === 3 ? "lg:grid-cols-3" : ""}`}>
        {tiles.map((x) => (
          <div key={x.k} className="bg-surface p-5 sm:p-6">
            <dt className="text-xs text-ink-3">{x.k}</dt>
            <dd className="display tnum mt-2 text-3xl text-ink">{x.v}</dd>
            {x.s && <dd className="tnum mt-2 text-xs leading-relaxed text-ink-3">{x.s}</dd>}
          </div>
        ))}
      </dl>
      <p className="mt-3 max-w-[80ch] text-xs leading-relaxed text-ink-3">
        Read live from the Sheaf program on devnet, in test dollars. Monthly and weekly plans count at their real rate. Rupees at{" "}
        {fxNote(fx)}.
      </p>
    </div>
  );
}
