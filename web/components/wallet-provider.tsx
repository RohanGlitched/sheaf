"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import { WRITE_RPC } from "@/lib/config";

/**
 * Wallets, without the stock modal.
 *
 * The adapter's own UI package ships a stylesheet that would fight every token in
 * globals.css, so Sheaf registers no adapters and leans on Wallet Standard,
 * which every current Solana wallet implements. Anything the browser has
 * installed shows up on its own; the picker in components/connect-button.tsx is
 * ours.
 */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={WRITE_RPC} config={{ commitment: "confirmed" }}>
      <AdapterWalletProvider wallets={wallets} autoConnect>
        {children}
      </AdapterWalletProvider>
    </ConnectionProvider>
  );
}
