"use client";

import { useEffect } from "react";

const EVERY_MS = 30_000;

/**
 * Nudge a keeper from the page while someone is looking at it.
 *
 * The scheduled cron runs rarely, so a page that shows due plans or open orders
 * asks the keeper itself: once on mount, then every thirty seconds while the tab
 * is visible, and not at all while it is hidden. Fire and forget: the route has
 * its own throttle, and a failed nudge changes nothing a visitor can see.
 */
export function useKeeperKick(path: "/api/keeper" | "/api/evm-keeper", body?: Record<string, unknown>, enabled = true) {
  const payload = body ? JSON.stringify(body) : undefined;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const kick = () => {
      fetch(path, {
        method: "POST",
        keepalive: true,
        ...(payload ? { headers: { "content-type": "application/json" }, body: payload } : {}),
      }).catch(() => {});
    };
    const start = () => {
      if (timer) return;
      kick();
      timer = setInterval(() => {
        if (document.visibilityState === "visible") kick();
      }, EVERY_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [path, payload, enabled]);
}
