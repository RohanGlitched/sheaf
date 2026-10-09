"use client";

import { useEffect, useState } from "react";
import { CONTACT_MAX, HOMES, MONTHLY_BANDS, US_ROUTES, cleanContact, type Home, type MonthlyBand, type UsRoute, type WaitlistCounts } from "@/lib/waitlist-options";
import { count } from "@/lib/format";
import { WAITLIST_EVENT, readWaitlistCounts } from "./india-traction";

type Status = { state: "checking" } | { state: "closed" } | ({ state: "open" } & WaitlistCounts);

function Choice<K extends string>({
  name,
  legend,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  options: readonly { key: K; label: string }[];
  value: K | null;
  onChange: (k: K) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const on = value === o.key;
          return (
            <label
              key={o.key}
              className={`flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border px-3.5 py-2.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-bind ${
                on ? "border-bind bg-bind-wash text-ink" : "border-line text-ink-2 hover:border-line-strong"
              }`}
            >
              <input type="radio" name={name} value={o.key} checked={on} onChange={() => onChange(o.key)} className="sr-only" />
              <span aria-hidden className={`grid size-4 shrink-0 place-items-center rounded-full border ${on ? "border-bind" : "border-line-strong"}`}>
                {on && <span className="size-2 rounded-full bg-bind" />}
              </span>
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Four questions for Indian savers, stored keylessly; the counts show only once the waitlist is open. */
export function IndiaWaitlist() {
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const [home, setHome] = useState<Home | null>(null);
  const [band, setBand] = useState<MonthlyBand | null>(null);
  const [route, setRoute] = useState<UsRoute | null>(null);
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    void readWaitlistCounts().then((c) => live && setStatus(c ? { state: "open", ...c } : { state: "closed" }));
    return () => {
      live = false;
    };
  }, []);

  const contactOk = cleanContact(contact) != null;
  const ready = home != null && band != null && route != null && contactOk && status.state === "open";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ home, band, route, contact: contact.trim(), website }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; counts?: WaitlistCounts | null; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error ?? "We couldn't save that just now. Try again in a minute.");
        if (r.status === 503) setStatus({ state: "closed" });
        return;
      }
      setDone(true);
      if (j.counts) {
        setStatus({ state: "open", ...j.counts });
        window.dispatchEvent(new CustomEvent(WAITLIST_EVENT, { detail: j.counts }));
      }
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="waitlist" aria-labelledby="india-waitlist" className="min-w-0 scroll-mt-24 rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="india-waitlist" className="display text-3xl text-ink">
          The India waitlist
        </h2>
        {status.state === "open" && (
          <p className="tnum text-sm text-ink-2" aria-live="polite">
            {count(status.count)} {status.count === 1 ? "person" : "people"} on the India waitlist · {count(status.withContact)} left a contact
          </p>
        )}
      </div>
      <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
        If you would run a monthly plan into US stocks, four questions tell us where you live, how much, and how you do it
        today. Where you live decides when Sheaf could serve you.
      </p>

      {done ? (
        <div className="mt-8 rounded-[var(--radius-control)] bg-bind-wash p-5">
          <p className="text-ink">You&apos;re on the list. Thank you.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            {contact.trim() ? "We'll write once, when Sheaf opens where you live." : "You left no contact, so your answer counts but we can't write to you."}
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-7" noValidate>
          <Choice name="home" legend="1. Where do you live?" options={HOMES} value={home} onChange={setHome} />
          <Choice name="band" legend="2. How much would you invest a month?" options={MONTHLY_BANDS} value={band} onChange={setBand} />
          <Choice name="route" legend="3. How do you invest in US stocks today?" options={US_ROUTES} value={route} onChange={setRoute} />
          <label className="block">
            <span className="text-sm font-medium text-ink">4. Email or Telegram handle</span>
            <span className="ml-2 text-xs text-ink-3">optional</span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value.slice(0, CONTACT_MAX))}
              placeholder="you@example.com or @handle"
              autoComplete="email"
              className="mt-3 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 text-ink outline-none placeholder:text-ink-3 focus:border-bind"
              aria-invalid={!contactOk}
            />
            {!contactOk && <span className="mt-2 block text-xs text-loss">That isn&apos;t an email address or a Telegram handle.</span>}
          </label>
          {/* Hidden from people; bots fill it. */}
          <input tabIndex={-1} autoComplete="off" aria-hidden value={website} onChange={(e) => setWebsite(e.target.value)} name="website" className="absolute -left-[9999px] size-px opacity-0" />

          <div>
            <button
              type="submit"
              disabled={!ready || busy}
              className="w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
            >
              {status.state === "closed" ? "Waitlist is not open yet" : status.state === "checking" ? "Checking…" : busy ? "Saving…" : "Join the waitlist"}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              We use this only to tell you when Sheaf opens where you live. We keep your answers, the day you sent them and, if
              you leave one, your contact, stored once. A salted hash of the contact stops repeat answers. No IP address, no
              wallet.
            </p>
          </div>
          {error && <p className="border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>}
        </form>
      )}
    </section>
  );
}
