"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { readLedger, type Ledger, type LedgerStats } from "./ledger";

/**
 * The program's history (or one basket's), from the site's /api/ledger, which
 * decodes it on the server and caches it for everyone: one request per visit
 * instead of one per transaction. Refreshed every minute while the tab is
 * visible. If the route is unreachable, the browser decodes the newest hundred
 * transactions itself, as it used to.
 */

const REFRESH_MS = 60_000;

type State = { key: string; ledger: Ledger | null; stats: LedgerStats | null; error: string | null };

export function useLedger(basket?: string) {
  const { connection } = useConnection();
  const key = basket ?? "*";
  // Keyed by what was asked for, so switching baskets shows nothing stale
  // without resetting state inside the effect.
  const [state, setState] = useState<State>({ key, ledger: null, stats: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    let fellBack = false;
    let shown = false;

    const fallback = (reason: string) => {
      if (fellBack) return;
      fellBack = true;
      readLedger(connection, {
        basket,
        limit: 100,
        signal: controller.signal,
        onProgress: (ledger) => live() && setState({ key, ledger, stats: null, error: null }),
      })
        .then((ledger) => live() && setState({ key, ledger, stats: null, error: null }))
        .catch(
          (err) =>
            live() &&
            // Keep whatever was decoded before the read failed; the rows are real.
            setState((s) => ({
              key,
              ledger: s.key === key ? s.ledger : null,
              stats: null,
              error: err instanceof Error ? err.message : reason,
            })),
        );
    };

    const load = () =>
      fetch(`/api/ledger${basket ? `?basket=${encodeURIComponent(basket)}` : ""}`, { signal: controller.signal })
        .then(async (res) => {
          const json = (await res.json()) as (Ledger & { stats?: LedgerStats; error?: string }) | null;
          if (!res.ok || !json || !Array.isArray(json.entries)) throw new Error(json?.error ?? "The ledger did not answer.");
          if (!live()) return;
          const { entries, done, total, truncated, stats } = json;
          shown = true;
          setState({ key, ledger: { entries, done, total, truncated }, stats: stats ?? null, error: null });
        })
        .catch((err) => {
          // Only fall back on the first read; a failed refresh keeps the rows already shown.
          if (live() && !shown) fallback(err instanceof Error ? err.message : "read failed");
        });

    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && !fellBack && void load(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [connection, basket, key]);

  const ledger = state.key === key ? state.ledger : null;
  const error = state.key === key ? state.error : null;
  return {
    ledger,
    /** The server's counts: fills, dollars filled, time to fill and the rest. Null on the browser fallback. */
    stats: state.key === key ? state.stats : null,
    error,
    loading: !ledger && !error,
    decoding: ledger != null && !error && ledger.done < ledger.total,
  };
}
