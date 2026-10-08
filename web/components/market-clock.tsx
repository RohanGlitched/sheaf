"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { XSTOCKS } from "@/lib/universe";
import { parseSchedule, marketState, CLOSED_REASON } from "@/lib/clock";
import { duration } from "@/lib/format";

/**
 * Both clocks, always. The exchange's, and the chain's.
 *
 * Every xStock tracks a US listing, so one schedule covers the universe; it comes
 * from the first ticker that publishes one rather than being written down twice.
 */
const SCHEDULE = parseSchedule(
  XSTOCKS.find((s) => s.schedule)?.schedule ?? null,
);

const noSubscribe = () => () => {};

function useTick(ms = 1000) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function MarketClock({ compact = false }: { compact?: boolean }) {
  useTick();
  // Rendered on the client only: the server's clock and the reader's differ, and
  // a countdown that arrives pre-rendered is a countdown that arrives wrong.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const state = mounted ? marketState(SCHEDULE) : null;

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden
          className={`size-1.5 ${state?.open ? "bg-gain pulse" : "bg-ink-3"}`}
          style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}
        />
        <span className="text-ink-2">
          {state == null
            ? " "
            : state.open
              ? "NYSE open"
              : "NYSE closed"}
        </span>
        {state?.secondsToFlip != null && (
          <span className="tnum text-ink-3">
            {duration(state.secondsToFlip)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="grid divide-y divide-line border border-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <div className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm text-ink-2">New York Stock Exchange</h3>
          <span
            aria-hidden
            className={`size-2 shrink-0 ${state?.open ? "bg-gain" : "bg-ink-3"}`}
            style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}
          />
        </div>
        <p className="display mt-3 text-3xl text-ink">
          {state == null ? " " : state.open ? "Open" : "Closed"}
        </p>
        <p className="mt-2 text-sm text-ink-3">
          {state == null ? " " : CLOSED_REASON[state.reason]}
        </p>
        {state?.secondsToFlip != null && (
          <p className="mt-4 text-sm text-ink-2">
            <span className="tnum text-ink">
              {duration(state.secondsToFlip)}
            </span>{" "}
            until it {state.edge.startsWith("opens") ? "opens" : "closes"}
          </p>
        )}
      </div>
      <div className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm text-ink-2">Solana</h3>
          <span
            aria-hidden
            className="size-2 shrink-0 bg-gain pulse"
            style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}
          />
        </div>
        <p className="display mt-3 text-3xl text-ink">Open</p>
        <p className="mt-2 text-sm text-ink-3">
          No session, no holidays, no bell
        </p>
        <p className="mt-4 text-sm text-ink-2">
          Trades and settles in about{" "}
          <span className="tnum text-ink">400ms</span>
        </p>
      </div>
    </div>
  );
}
