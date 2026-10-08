/**
 * The logo: three stalks crossed at one ultramarine band. It is the Sheaf mark
 * reduced to the fewest strokes that still read as a bound bundle.
 */
export function Mark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M12 2.5 V21.5" />
        <path d="M6.4 3.6 L15.6 21" />
        <path d="M17.6 3.6 L8.4 21" />
      </g>
      <rect x="6.6" y="13" width="10.8" height="4" rx="1.4" fill="var(--color-bind)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Mark className="size-6 text-ink" />
      <span className="display text-[1.5rem] leading-none tracking-[-0.03em] text-ink">sheaf</span>
    </span>
  );
}
