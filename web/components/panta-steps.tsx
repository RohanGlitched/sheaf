"use client";

import type { ReactNode } from "react";

export type StepState = "todo" | "running" | "done" | "error" | "blocked";

export type Step = {
  key: string;
  title: string;
  /** The Panta endpoint or wallet call behind the step, shown in mono. */
  call: string;
  state: StepState;
  /** Facts from the real answer, label then value. */
  facts?: [string, ReactNode][];
  note?: ReactNode;
};

/**
 * A Panta lifecycle drawn as a numbered rail: each step names the endpoint it
 * calls and, once done, the fields Panta actually answered with.
 */
export function PantaSteps({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol aria-label={label} className="relative">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
            {!last && (
              <span
                aria-hidden
                className={`absolute left-[0.8125rem] top-7 bottom-0 w-px ${s.state === "done" ? "bg-bind" : "bg-line"}`}
              />
            )}
            <span
              aria-hidden
              className={`tnum relative z-[1] flex size-7 items-center justify-center rounded-full border text-xs ${
                s.state === "done"
                  ? "border-bind bg-bind text-white"
                  : s.state === "running"
                    ? "border-bind bg-bind-wash text-bind"
                    : s.state === "error"
                      ? "border-loss bg-surface text-loss"
                      : "border-line-strong bg-surface text-ink-3"
              }`}
            >
              {s.state === "done" ? "✓" : s.state === "error" ? "!" : i + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`text-sm ${s.state === "todo" || s.state === "blocked" ? "text-ink-2" : "text-ink"}`}>
                  {s.title}
                  {s.state === "running" && <span className="ml-2 text-xs text-bind">working…</span>}
                </span>
                <code className="truncate text-[11px] text-ink-3">{s.call}</code>
              </div>
              {s.facts && s.facts.length > 0 && (
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                  {s.facts.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-ink-3">{k}</dt>
                      <dd className="tnum min-w-0 truncate text-ink-2">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {s.note && <p className="mt-1.5 max-w-[56ch] text-xs leading-relaxed text-ink-3">{s.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function FixtureTag({ show }: { show: boolean | undefined }) {
  if (!show) return null;
  return (
    <span className="ml-1.5 rounded-sm border border-line-strong px-1 py-px text-[10px] uppercase tracking-wide text-ink-3">
      sandbox fixture
    </span>
  );
}

export function PoweredByPanta({ className = "" }: { className?: string }) {
  return (
    <a
      href="https://panta.market"
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-sm text-ink transition-colors hover:border-ink-3 ${className}`}
    >
      <span className="size-2 rounded-full bg-ink" aria-hidden />
      Powered by Panta
      <span className="text-ink-3" aria-hidden>
        ↗
      </span>
    </a>
  );
}
