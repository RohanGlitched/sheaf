"use client";

import { useCallback, useEffect, useState } from "react";
import { faucetRequest } from "@/components/faucet-button";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { CASH_MINT, CASH_DECIMALS, CASH_TOKEN_PROGRAM } from "./cash.generated";
import { tokenAccount } from "./sheaf";

export const CASH = {
  mint: new PublicKey(CASH_MINT),
  program: new PublicKey(CASH_TOKEN_PROGRAM),
  decimals: CASH_DECIMALS,
};

/** Below this the wallet cannot pay the fee for an order, so asking for dollars asks for SOL too. */
const ENOUGH_FOR_FEES = 0.01 * LAMPORTS_PER_SOL;

export const toCashRaw = (dollars: number) => BigInt(Math.round(dollars * 10 ** CASH_DECIMALS));
export const fromCashRaw = (raw: bigint) => Number(raw) / 10 ** CASH_DECIMALS;

/**
 * The connected wallet's test dollars, and a way to ask the faucet for more. A
 * wallet with no SOL for fees gets the faucet's test SOL in the same click, the
 * way the welcome card does, so its first order does not fail on the fee.
 */
export function useCash() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return setBalance(null);
    const ata = tokenAccount(CASH.mint, publicKey, CASH.program);
    const info = await connection.getTokenAccountBalance(ata).catch(() => null);
    setBalance(info ? BigInt(info.value.amount) : 0n);
  }, [connection, publicKey]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const claim = useCallback(async () => {
    if (!publicKey) return;
    setClaiming(true);
    setError(null);
    try {
      const lamports = await connection.getBalance(publicKey).catch(() => null);
      const [res, sol] = await Promise.all([
        fetch("/api/faucet", faucetRequest({ owner: publicKey.toBase58(), symbols: ["USDC"] }, { basket: true })),
        lamports != null && lamports < ENOUGH_FOR_FEES
          ? fetch("/api/faucet/sol", faucetRequest({ owner: publicKey.toBase58() })).then(
              async (r) => ({ ok: r.ok, error: ((await r.json().catch(() => ({}))) as { error?: string }).error }),
              () => ({ ok: false, error: "Could not reach the faucet." }),
            )
          : null,
      ]);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "The faucet did not answer.");
      await load();
      // "Already had its test SOL" is no problem; anything else is worth a line.
      if (sol && !sol.ok && !/already (had|has)/i.test(sol.error ?? "")) {
        throw new Error(`Test dollars sent. Test SOL for fees: ${sol.error ?? "the faucet did not answer."}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClaiming(false);
    }
  }, [connection, publicKey, load]);

  return { balance, reload: load, claim, claiming, error };
}
