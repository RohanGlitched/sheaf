"use client";

import { useCallback, useMemo, useState } from "react";
import type { ConnectionConfig } from "@solana/web3.js";
import {
  ConnectionProvider,
  WalletProvider as AdapterWalletProvider,
} from "@solana/wallet-adapter-react";
import { WRITE_RPC, WRITE_WS } from "@/lib/config";
import { BrowserWalletAdapter } from "@/lib/browser-wallet";
import { BrowserWalletWelcome } from "./browser-wallet-welcome";

const connectionConfig = (): ConnectionConfig => ({ commitment: "confirmed", wsEndpoint: WRITE_WS });

/**
 * Wallets, without the stock modal.
 *
 * The adapter's own UI package ships a stylesheet that would fight every token in
 * globals.css, so Sheaf leans on Wallet Standard, which every current Solana
 * wallet implements: anything the browser has installed shows up on its own. The
 * one adapter registered here is the browser wallet (lib/browser-wallet.ts), a
 * keypair kept in this browser for people who have no wallet set to devnet. The
 * picker in components/connect-button.tsx is ours.
 */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new BrowserWalletAdapter()], []);

  // A fresh config makes a fresh Connection, and every balance hook keyed on the
  // connection reads again. Used after the browser wallet's first top-up.
  const [config, setConfig] = useState(connectionConfig);
  const refreshBalances = useCallback(() => setConfig(connectionConfig()), []);

  return (
    <ConnectionProvider endpoint={WRITE_RPC} config={config}>
      <AdapterWalletProvider wallets={wallets} autoConnect>
        {children}
        <BrowserWalletWelcome onFunded={refreshBalances} />
      </AdapterWalletProvider>
    </ConnectionProvider>
  );
}
