"use client";

import { useEffect, useState } from "react";
import { count } from "@/lib/format";
import type { WaitlistCounts } from "@/lib/waitlist-options";

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

/** The India waitlist, read live; the whole section appears once the count is above zero. */
export function IndiaTraction() {
  const [waitlist, setWaitlist] = useState<WaitlistCounts | null>(null);

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

  if (!waitlist || waitlist.count < 1) return null;
  const abroad = waitlist.byHome.nri;
  const note = abroad > 0 ? `${count(abroad)} ${abroad === 1 ? "is an NRI" : "are NRIs"} outside the US, UK, Canada and Australia` : "";

  return (
    <div className="mt-20">
      <h2 className="display text-title max-w-[22ch] text-ink">What Sheaf measures from India</h2>
      <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink-2">
        Measured before any launch: who asks to be told when Sheaf can serve them.
      </p>
      <dl className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
        <div className="bg-surface p-5 sm:p-6">
          <dt className="text-xs text-ink-3">On the India waitlist</dt>
          <dd className="display tnum mt-2 text-3xl text-ink">{count(waitlist.count)}</dd>
          {note && <dd className="tnum mt-2 text-xs leading-relaxed text-ink-3">{note}</dd>}
        </div>
      </dl>
    </div>
  );
}
