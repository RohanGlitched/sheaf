"use client";

import { useEffect, useState } from "react";
import { faucetRequest } from "./faucet-button";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WRITE_CLUSTER } from "@/lib/config";

const ENOUGH_FOR_FEES = 0.01 * LAMPORTS_PER_SOL;

/**
 * Most wallets arrive set to mainnet, where this wallet's devnet SOL does not
 * exist, so every write would fail. Say so before the first signature, not after.
 */
export function DevnetNotice() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<{ owner: string; lamports: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey || WRITE_CLUSTER !== "devnet") return;
    let live = true;
    const owner = publicKey.toBase58();
    const read = () =>
      connection
        .getBalance(publicKey)
        .then((lamports) => live && setBalance({ owner, lamports }))
        .catch(() => {});
    read();
    const timer = setInterval(read, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connection, publicKey]);

  if (
    !publicKey ||
    balance?.owner !== publicKey.toBase58() ||
    balance.lamports >= ENOUGH_FOR_FEES
  ) {
    return null;
  }

  async function fund() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/faucet/sol", faucetRequest({ owner: publicKey!.toBase58() }));
      const body = (await response.json()) as { signature?: string; error?: string };
      if (!response.ok || !body.signature) {
        setError(body.error ?? "The faucet did not answer.");
        return;
      }
      setBalance({ owner: publicKey!.toBase58(), lamports: await connection.getBalance(publicKey!) });
    } catch {
      setError("Could not reach the faucet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className="border-b border-bind/30 bg-bind/[0.07]">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-3 text-sm sm:px-8 md:flex-row md:items-center md:gap-6">
        <p className="leading-relaxed text-ink-2 md:flex-1">
          <span className="text-ink">
            {balance.lamports > 0
              ? "This wallet is running low on test SOL."
              : "This wallet has no test SOL yet."}
          </span>{" "}
          Sheaf runs on Solana devnet while it is in testing, so trying it is free: one click
          sends enough to create a basket, create shares and open a launch market.
          {error && <span className="mt-1 block text-loss">{error}</span>}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={fund}
            disabled={busy}
            className="bg-bind px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-60 rounded-[var(--radius-control)]"
          >
            {busy ? "Sending…" : "Get free test SOL"}
          </button>
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2"
          >
            or faucet.solana.com
          </a>
        </div>
      </div>
    </div>
  );
}
