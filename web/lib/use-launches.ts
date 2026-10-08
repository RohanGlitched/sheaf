"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { openLaunches } from "./dbc";
import type { Basket } from "./sheaf";

/** The set of these baskets that have an open launch market. */
export function useOpenLaunches(baskets: Basket[] | null): Set<string> {
  const { connection } = useConnection();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const key = baskets?.map((b) => b.address).join(",") ?? "";

  useEffect(() => {
    if (!baskets?.length) return;
    let live = true;
    openLaunches(connection, baskets)
      .then((found) => live && setOpen(new Set(found.keys())))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);

  return open;
}
