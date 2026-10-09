"use client";

import { useCallback, useEffect, useState } from "react";
import { getAddress, toHex, type Address, type EIP1193Provider } from "viem";
import {
  chooseEvmBrowserWallet,
  evmBrowserProvider,
  evmBrowserWalletChosen,
  EVM_BROWSER_WALLET_EVENT,
  isEvmBrowserProvider,
} from "./evm-browser-wallet";

/**
 * The EVM side of the /voices form: whichever EVM wallet this browser uses (the
 * in-browser wallet when the visitor chose it, otherwise an injected one such as
 * MetaMask or Rabby), its address, and an EIP-191 personal_sign over the voices
 * message. No chain switch is needed: personal_sign is chain-independent.
 */

function injected(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null) as EIP1193Provider | null;
}

function active(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return evmBrowserWalletChosen() ? evmBrowserProvider() : injected();
}

export function useEvmSigner() {
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [hasInjected, setHasInjected] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(EVM_BROWSER_WALLET_EVENT, bump);
    return () => window.removeEventListener(EVM_BROWSER_WALLET_EVENT, bump);
  }, []);

  useEffect(() => {
    const p = active();
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      setProvider(p);
      setHasInjected(!!injected());
      if (!p) setAddress(null);
    });
    if (!p) return;
    const take = (a: unknown) => {
      const first = (a as string[] | undefined)?.[0];
      setAddress(first ? getAddress(first) : null);
    };
    // Silent: no prompt unless the visitor already connected this site.
    void p
      .request({ method: "eth_accounts" })
      .then((a) => live && take(a))
      .catch(() => undefined);
    p.on?.("accountsChanged", take as never);
    return () => {
      live = false;
      p.removeListener?.("accountsChanged", take as never);
    };
  }, [version]);

  const connectInjected = useCallback(async () => {
    const p = injected();
    if (!p) throw new Error("No EVM wallet is installed in this browser.");
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
    setProvider(p);
    setAddress(accounts[0] ? getAddress(accounts[0]) : null);
  }, []);

  const connectBrowser = useCallback(() => {
    const made = chooseEvmBrowserWallet();
    if (!made) throw new Error("This browser does not allow saving a wallet here.");
    setProvider(evmBrowserProvider());
    setAddress(getAddress(made));
  }, []);

  const sign = useCallback(
    async (message: string): Promise<string> => {
      if (!provider || !address) throw new Error("Connect an EVM wallet first.");
      return (await provider.request({ method: "personal_sign", params: [toHex(message), address] })) as string;
    },
    [provider, address],
  );

  return { provider, address, hasInjected, isBrowser: isEvmBrowserProvider(provider), connectInjected, connectBrowser, sign };
}
