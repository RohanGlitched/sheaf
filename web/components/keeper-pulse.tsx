"use client";

import { useEffect, useState } from "react";

/**
 * "Keeper ran 40 s ago · house filler 16.2 SOL": proof on the page that the
 * keeper is alive, read from /api/heartbeat every 30 seconds while the tab is
 * visible. `which` picks the Solana keeper or the EVM one. Says so plainly when
 * a key is running low or the keeper has not run for a while.
 */

type Heartbeat = {
  keeperLastRunAt: string | null;
  evmKeeperLastRunAt: string | null;
  houseSol: number | null;
  deploySol: number | null;
  houseLow: boolean;
  deployLow: boolean;
};

const REFRESH_MS = 30_000;
/** Past this, the line says the keeper looks stalled. */
const STALE_SECS = 10 * 60;

function ago(secs: number): string {
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86_400)} d ago`;
}

export function KeeperPulse({ which = "solana", className = "" }: { which?: "solana" | "evm"; className?: string }) {
  const [beat, setBeat] = useState<Heartbeat | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/heartbeat")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Heartbeat | null) => live && j && setBeat(j))
        .catch(() => undefined);
    void load();
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    // The "ago" ticks every few seconds between polls.
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      live = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  if (!beat) return null;
  const at = which === "evm" ? beat.evmKeeperLastRunAt : beat.keeperLastRunAt;
  const secs = at ? (now - Date.parse(at)) / 1000 : null;
  const stale = secs == null || secs > STALE_SECS;
  const parts: string[] = [];
  parts.push(secs == null ? "Keeper has not reported a run yet" : `${which === "evm" ? "EVM keeper" : "Keeper"} ran ${ago(secs)}`);
  if (which === "solana" && beat.houseSol != null) parts.push(`house filler ${beat.houseSol.toFixed(1)} SOL`);
  const warnings: string[] = [];
  if (beat.houseLow) warnings.push("house key low on SOL");
  if (beat.deployLow) warnings.push("upgrade key low on SOL");

  return (
    <p className={`tnum flex flex-wrap items-center gap-x-2 text-xs text-ink-3 ${className}`} aria-live="polite">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: stale ? "var(--color-loss)" : "var(--color-gain)" }}
      />
      <span>{parts.join(" · ")}</span>
      {warnings.length > 0 && <span className="text-loss">· {warnings.join(" · ")}</span>}
    </p>
  );
}
