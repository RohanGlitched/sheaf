import Link from "next/link";
import { PlanSheaf } from "./plan-sheaf";

const STAGES = [
  { filled: 1, label: "Month 1" },
  { filled: 3, label: "Month 3" },
  { filled: 6, label: "Month 6" },
  { filled: 12, label: "Month 12" },
];

/** The monthly plan, told as a sheaf that fills over a year. */
export function HomePlans() {
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <div className="self-center">
        <h2 className="display text-title max-w-[16ch] text-ink">A year of buying is a full sheaf.</h2>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-ink-2">
          India&apos;s investors run about 100 million monthly plans into mutual funds. A Sheaf plan does the same
          onchain: a fixed amount of dollars into a basket every month. The plan can spend exactly that much per run
          and nothing more, anyone can run it when it is due, and each run is filled by fillers competing to deliver
          the stocks.
        </p>
        <p className="mt-4 max-w-[46ch] text-sm leading-relaxed text-ink-3">
          The program reads no price. Each fill moves the plan&apos;s reference to where the market cleared, so next
          month&apos;s order starts from what this month&apos;s actually cost.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/explore" className="rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white hover:bg-bind-deep">
            Start a plan
          </Link>
          <Link href="/plans" className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink hover:border-ink-3">
            See every plan
          </Link>
        </div>
      </div>
      <ol className="grid grid-cols-2 items-start gap-4 self-center sm:grid-cols-4">
        {STAGES.map((s) => (
          <li key={s.label} className="flex flex-col items-center rounded-[var(--radius-panel)] border border-line bg-surface px-3 pb-4 pt-5">
            <div className="aspect-square w-full max-w-[150px]">
              <PlanSheaf filled={s.filled} total={12} className="h-full w-full" />
            </div>
            <p className="mt-3 text-sm text-ink">{s.label}</p>
            <p className="tnum text-xs text-ink-3">{s.filled} of 12 runs</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
