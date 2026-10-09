"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { openLaunches, preIpoCompanies } from "./dbc";
import type { Basket } from "./sheaf";

/**
 * The pools the server's price check refused (pool -> reason), from the feed,
 * which is cached at the edge. Empty if the feed cannot be read: callers that
 * trade fail closed on their own (the launch card does); lists only lose a
 * badge they would have shown.
 */
export async function fetchRejected(): Promise<Map<string, string>> {
  const body = await fetch("/api/launches?tests=1")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const rejected = new Map<string, string>();
  for (const l of body?.launches ?? []) {
    for (const u of l.unofficial ?? []) {
      if (u.anchor?.status === "mismatch") rejected.set(u.pool, u.reason ?? "It did not open at half the basket's NAV.");
    }
  }
  return rejected;
}

/**
 * The set of these baskets that have an open launch market, for the "launch"
 * badges on Explore and the featured lists. Baskets with a pre-IPO component
 * are left out: their launch stays reachable on the basket page, with a
 * warning, but is not promoted anywhere else.
 */
export function useOpenLaunches(baskets: Basket[] | null): Set<string> {
  const { connection } = useConnection();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const key = baskets?.map((b) => b.address).join(",") ?? "";

  useEffect(() => {
    if (!baskets?.length) return;
    let live = true;
    fetchRejected()
      .then((rejected) => openLaunches(connection, baskets.filter((b) => preIpoCompanies(b).length === 0), rejected))
      .then((found) => live && setOpen(new Set(found.keys())))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);

  return open;
}
