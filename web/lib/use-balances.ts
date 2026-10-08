"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { tokenAccount } from "./sheaf";

/**
 * What the connected wallet actually holds, for a named set of mints.
 *
 * One `getMultipleAccountsInfo` covers every mint, and a missing account reads as
 * zero rather than as an error, because a wallet that has never touched a mirror
 * mint has no account for it and that is the normal case, not a failure.
 */

const AMOUNT_OFFSET = 64;

export type Balances = {
  /** Raw units held, keyed by mint. Every requested mint is present. */
  raw: Map<string, bigint>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

export function useBalances(
  mints: { mint: string; tokenProgram: string }[],
): Balances {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [raw, setRaw] = useState<Map<string, bigint>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Serialise the request so the effect does not refire on every render.
  const key = useMemo(
    () => mints.map((m) => `${m.mint}:${m.tokenProgram}`).join(","),
    [mints],
  );

  const load = useCallback(async () => {
    if (!publicKey || !key) {
      setRaw(new Map());
      return;
    }
    const wanted = key.split(",").map((entry) => {
      const [mint, tokenProgram] = entry.split(":");
      return { mint, tokenProgram };
    });
    setLoading(true);
    try {
      const addresses = wanted.map((m) =>
        tokenAccount(
          new PublicKey(m.mint),
          publicKey,
          new PublicKey(m.tokenProgram),
        ),
      );
      const infos = await connection.getMultipleAccountsInfo(addresses);
      const next = new Map<string, bigint>();
      wanted.forEach((m, i) => {
        const info = infos[i];
        if (!info) {
          next.set(m.mint, 0n);
          return;
        }
        const bytes = new Uint8Array(info.data);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        next.set(m.mint, view.getBigUint64(AMOUNT_OFFSET, true));
      });
      setRaw(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read balances.");
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, key]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { raw, loading, error, reload: load };
}
