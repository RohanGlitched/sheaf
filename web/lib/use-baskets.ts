"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  basketFromJson,
  fetchBaskets,
  fetchBasket,
  type Basket,
  type BasketJson,
} from "./sheaf";
import { WRITE_CLUSTER, WRITE_RPC } from "./config";

/**
 * What to say when the read fails.
 *
 * A raw `fetch failed` tells a visitor nothing. The overwhelmingly likely cause is
 * that the write cluster is a validator on somebody's laptop and this page is not
 * on that laptop, so say that instead of the transport error — and keep the prices,
 * which come from mainnet and are unaffected.
 */
function explainReadFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const unreachable =
    /fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|Load failed/i.test(
      detail,
    );
  if (unreachable && WRITE_CLUSTER === "localnet") {
    return `Baskets live on a local validator at ${WRITE_RPC}, which this browser cannot reach. Prices on this page still come from mainnet. Run solana-test-validator to see baskets.`;
  }
  if (unreachable) {
    return `Could not reach ${WRITE_CLUSTER} at ${WRITE_RPC}. Prices on this page still come from mainnet.`;
  }
  return `Could not read the program: ${detail}`;
}

/** Every basket on the write cluster. */
export function useBaskets() {
  const { connection } = useConnection();
  const [baskets, setBaskets] = useState<Basket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // The shared, cached list first; straight from the chain if that fails.
      const res = await fetch("/api/baskets").catch(() => null);
      setBaskets(
        res?.ok
          ? ((await res.json()) as BasketJson[]).map(basketFromJson)
          : await fetchBaskets(connection),
      );
      setError(null);
    } catch (err) {
      setError(explainReadFailure(err));
    }
  }, [connection]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { baskets, error, reload: load, loading: baskets == null && !error };
}

/** One basket, by address. */
export function useBasket(address: string | null, initial: Basket | null = null) {
  const { connection } = useConnection();
  const [basket, setBasket] = useState<Basket | null>(initial);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">(
    initial ? "ready" : "loading",
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      setState("missing");
      return;
    }
    try {
      const found = await fetchBasket(connection, key);
      if (!found) {
        setState("missing");
        return;
      }
      setBasket(found);
      setState("ready");
    } catch (err) {
      setError(explainReadFailure(err));
      setState("error");
    }
  }, [connection, address]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { basket, state, error, reload: load };
}
