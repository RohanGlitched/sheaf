import Link from "next/link";
import { EVM_CHAINS } from "@/lib/chains";

/** Where Sheaf runs, at a glance. The full page reads every vault live. */
export function HomeChains() {
  const rows = [
    { name: "Solana", note: "Home: the program, dollar orders, monthly plans and launch markets", live: true },
    ...EVM_CHAINS.map((c) => ({
      name: c.name,
      note: c.why,
      live: !!c.deployment,
    })),
  ];
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <div className="self-center">
        <h2 className="display text-title max-w-[16ch] text-ink">Everywhere stocks are tokenized.</h2>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-ink-2">
          Tokenized stocks are spreading across chains, and so is Sheaf: the same recipe that can never change, the
          same vault nobody can drain and the same dollar orders, written natively for each one.
        </p>
        <Link href="/chains" className="mt-8 inline-flex rounded-[var(--radius-control)] border border-line-strong bg-surface px-5 py-3 text-sm text-ink hover:border-ink-3">
          See every chain
        </Link>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
        {rows.map((r) => (
          <li key={r.name} className="flex items-baseline gap-4 px-5 py-3.5">
            <span className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${r.live ? "bg-gain" : "bg-line-strong"}`} aria-hidden />
            <span className="w-36 shrink-0 text-ink">{r.name}</span>
            <span className="min-w-0 flex-1 text-sm text-ink-3">{r.note}</span>
            <span className={`shrink-0 text-xs ${r.live ? "text-gain" : "text-ink-3"}`}>{r.live ? "Live" : "Next"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
