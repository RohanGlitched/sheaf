"use client";

import { useCallback, useEffect, useState } from "react";
import { faucetRequest } from "@/components/faucet-button";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { CASH_MINT, CASH_DECIMALS, CASH_TOKEN_PROGRAM } from "./cash.generated";
import { tokenAccount } from "./sheaf";

export const CASH = {
  mint: new PublicKey(CASH_MINT),
  program: new PublicKey(CASH_TOKEN_PROGRAM),
  decimals: CASH_DECIMALS,
};

export const toCashRaw = (dollars: number) => BigInt(Math.round(dollars * 10 ** CASH_DECIMALS));
export const fromCashRaw = (raw: bigint) => Number(raw) / 10 ** CASH_DECIMALS;

/** The connected wallet's test dollars, and a way to ask the faucet for more. */
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
      const res = await fetch("/api/faucet", faucetRequest({ owner: publicKey.toBase58(), symbols: ["USDC"] }, { basket: true }));
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "The faucet did not answer.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClaiming(false);
    }
  }, [publicKey, load]);

  return { balance, reload: load, claim, claiming, error };
}
