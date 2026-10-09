"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { openLaunches, preIpoCompanies } from "./dbc";
import type { Basket } from "./sheaf";

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
    openLaunches(connection, baskets.filter((b) => preIpoCompanies(b).length === 0))
      .then((found) => live && setOpen(new Set(found.keys())))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);

  return open;
}
