import Link from "next/link";

/**
 * The two markets that can sit next to a basket without touching its vault,
 * kept short on the home page: a launch token on Meteora and a weekly question
 * on Panta. Each card is still and data-free, so nothing pops in after load;
 * the live versions are a click away.
 */
export function HomeBeside() {
  return (
    <div>
      <div className="max-w-[56ch]">
        <h2 className="display text-title text-ink">Beside the share.</h2>
        <p className="mt-5 text-base leading-relaxed text-ink-2">
          Two markets can sit next to a basket without touching its vault. Neither is a share, and
          neither can be redeemed for the stocks.
        </p>
      </div>

      <ul className="mt-12 grid gap-4 lg:grid-cols-2">
        <li>
          <Link
            href="/explore#launch"
            className="lift flex h-full flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-7 hover:border-line-strong sm:p-8"
          >
            <span className="text-xs text-ink-3">Launch market · Meteora</span>
            <span className="display mt-3 block text-2xl text-ink">A token to bet on the basket</span>
            <span className="mt-3 block max-w-[48ch] text-sm leading-relaxed text-ink-2">
              The basket&apos;s creator opens a Dynamic Bonding Curve priced from the basket&apos;s own value. It
              opens at half the value of a share and graduates at five times it into a DAMM v2 pool with its
              liquidity locked.
            </span>
            <CurveSketch />
            <span className="mt-auto pt-6 text-sm text-bind">See the launch markets →</span>
          </Link>
        </li>
        <li>
          <Link
            href="/predict"
            className="lift flex h-full flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-7 hover:border-line-strong sm:p-8"
          >
            <span className="text-xs text-ink-3">Weekly question · Panta</span>
            <span className="display mt-3 block text-2xl text-ink">Will it beat SPY this week?</span>
            <span className="mt-3 block max-w-[48ch] text-sm leading-relaxed text-ink-2">
              Every basket whose holdings are all listed carries one question. It settles from the
              basket&apos;s own recipe at two week-ending US closes, with every input published so anyone can
              recompute it. In Panta&apos;s sandbox today.
            </span>
            <QuestionSketch />
            <span className="mt-auto pt-6 text-sm text-bind">See the questions →</span>
          </Link>
        </li>
      </ul>
    </div>
  );
}

/** The curve's shape, from ½× to 5× the share's value. */
function CurveSketch() {
  return (
    <svg viewBox="0 0 320 96" className="mt-6 w-full max-w-[420px] overflow-visible" aria-hidden>
      <line x1="8" y1="84" x2="312" y2="84" stroke="var(--color-line-strong)" strokeWidth="1" />
      <path d="M 8 80 C 120 78, 210 62, 304 14 L 304 84 L 8 84 Z" fill="var(--color-bind-wash)" />
      <path d="M 8 80 C 120 78, 210 62, 304 14" fill="none" stroke="var(--color-bind)" strokeWidth="2" />
      <circle cx="8" cy="80" r="3.5" fill="var(--color-bind)" />
      <circle cx="304" cy="14" r="3.5" fill="var(--color-bind)" />
      <text x="14" y="70" fontSize="11" fill="var(--color-ink-3)" className="tnum">½× value</text>
      <text x="294" y="16" fontSize="11" fill="var(--color-ink-3)" textAnchor="end" className="tnum">
        5× · graduates
      </text>
    </svg>
  );
}

/** One week between two Friday closes: the basket and SPY start level, and the gap at the second close is the answer. */
function QuestionSketch() {
  const days = [
    { x: 24, d: "Fri" },
    { x: 92, d: "Mon" },
    { x: 146, d: "Tue" },
    { x: 200, d: "Wed" },
    { x: 254, d: "Thu" },
    { x: 296, d: "Fri" },
  ];
  return (
    <svg viewBox="0 0 320 124" className="mt-6 w-full max-w-[420px] overflow-visible" aria-hidden>
      {days.map((t, i) => (
        <g key={t.d + i}>
          <line x1={t.x} y1="14" x2={t.x} y2="96" stroke="var(--color-line)" strokeWidth="1" strokeDasharray={i === 0 || i === days.length - 1 ? undefined : "2 3"} />
          <text x={t.x} y="112" fontSize="10.5" fill="var(--color-ink-3)" textAnchor="middle">
            {i === 0 || i === days.length - 1 ? `${t.d} close` : t.d}
          </text>
        </g>
      ))}
      {/* SPY: a quieter week */}
      <path d="M 24 72 C 50 70, 70 66, 92 68 S 130 60, 146 63 S 180 58, 200 60 S 236 54, 254 56 S 284 52, 296 54" fill="none" stroke="var(--color-ink-3)" strokeWidth="1.6" strokeDasharray="4 3" />
      {/* the basket: its own recipe, valued at each close */}
      <path d="M 24 72 C 52 76, 72 62, 92 60 S 128 70, 146 64 S 178 44, 200 46 S 238 40, 254 34 S 284 26, 296 24" fill="none" stroke="var(--color-bind)" strokeWidth="2.4" />
      <circle cx="24" cy="72" r="3.5" fill="var(--color-ink)" />
      <circle cx="296" cy="24" r="4" fill="var(--color-bind)" />
      <circle cx="296" cy="54" r="3.5" fill="var(--color-ink-3)" />
      {/* the gap that settles it */}
      <line x1="306" y1="24" x2="306" y2="54" stroke="var(--color-ink)" strokeWidth="1.2" />
      <line x1="302" y1="24" x2="310" y2="24" stroke="var(--color-ink)" strokeWidth="1.2" />
      <line x1="302" y1="54" x2="310" y2="54" stroke="var(--color-ink)" strokeWidth="1.2" />
      <text x="290" y="16" fontSize="11" fill="var(--color-bind)" textAnchor="end">basket</text>
      <text x="290" y="70" fontSize="11" fill="var(--color-ink-3)" textAnchor="end">SPY</text>
      <text x="316" y="43" fontSize="11" fill="var(--color-ink)">YES</text>
    </svg>
  );
}
