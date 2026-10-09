"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { shortAddress } from "@/lib/format";
import { WRITE_CLUSTER } from "@/lib/config";
import { BrowserWalletName, storedBrowserWalletAddress } from "@/lib/browser-wallet";
import { BrowserWalletMenu } from "./browser-wallet-menu";

/** Wallet apps open a page in their own browser from these links, which is how a phone connects. */
function walletBrowseLinks() {
  const url = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  return [
    { name: "Phantom", href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: "Solflare", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export function ConnectButton({
  block = false,
  label = "Connect wallet",
}: {
  /** Full width and filled, for when connecting is the next step on a page.
   *  Otherwise it is the white secondary button, so it never competes with the
   *  page's one primary action. */
  block?: boolean;
  label?: string;
}) {
  const { wallets, select, connect, connected, connecting, publicKey, disconnect, wallet } =
    useWallet();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const installed = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed && w.adapter.name !== BrowserWalletName,
  );
  const browserWallet = wallets.find((w) => w.adapter.name === BrowserWalletName);
  const onBrowserWallet = wallet?.adapter.name === BrowserWalletName;

  /**
   * With autoConnect on, the provider connects a newly selected wallet itself,
   * after it has subscribed to the adapter. Connecting from here raced that
   * subscription: a wallet that already trusts the site connects without a
   * popup, its connect event was lost, and every later click was a no-op.
   */
  function pick(name: string) {
    setOpen(false);
    if (wallet?.adapter.name !== name) {
      select(name as never);
      return;
    }
    void connect().catch(() => {
      /* the wallet reports its own rejection */
    });
  }

  // Read only while the picker is open, which is always after hydration.
  const savedBrowserWallet = open && !connected ? storedBrowserWalletAddress() : null;

  if (connected && publicKey) {
    return (
      <div className="relative" ref={root}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex items-center gap-2.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink transition-colors hover:border-ink-3"
        >
          <span
            aria-hidden
            className="size-1.5 bg-gain"
            style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}
          />
          <span className="tnum">{shortAddress(publicKey.toBase58())}</span>
        </button>
        {open && (
          <div className={`absolute right-0 top-full z-50 mt-1.5 max-w-[calc(100vw-2rem)] ${onBrowserWallet ? "w-72" : "w-60"} border border-line bg-raised p-1 shadow-[0_24px_48px_-24px_rgb(20_37_28/0.35)] rounded-[var(--radius-panel)]`}>
            <div className="px-3 py-2.5 text-xs leading-relaxed text-ink-3">
              {wallet?.adapter.name} on {WRITE_CLUSTER}
              {onBrowserWallet && (
                <span className="block">Lives in this browser. Test funds only.</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(publicKey.toBase58());
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
            >
              Copy address
            </button>
            {onBrowserWallet && <BrowserWalletMenu onDone={() => setOpen(false)} />}
            <button
              type="button"
              onClick={() => {
                void disconnect();
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={connecting}
        className={
          block
            ? "w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-60"
            : "whitespace-nowrap rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-3 disabled:opacity-60"
        }
      >
        {connecting ? "Connecting…" : label}
      </button>
      {open && (
        <div
          // A block button sits inside order panels that clip their overflow, so
          // its picker opens in the flow and pushes the panel taller instead.
          className={`mt-1.5 rounded-[var(--radius-control)] border border-line bg-raised p-1 ${
            block
              ? "relative"
              : "absolute right-0 top-full z-50 w-72 max-w-[calc(100vw-2rem)] shadow-[0_24px_48px_-24px_rgb(20_37_28/0.35)]"
          }`}
        >
          {installed.map((w) => (
            <button
              key={w.adapter.name}
              type="button"
              onClick={() => pick(w.adapter.name)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
            >
              {w.adapter.icon && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={w.adapter.icon} alt="" className="size-5" />
              )}
              {w.adapter.name}
            </button>
          ))}
          {browserWallet && (
            <>
              {installed.length > 0 && <div aria-hidden className="mx-3 my-1 border-t border-line" />}
              <button
                type="button"
                onClick={() => pick(BrowserWalletName)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-sunk"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={browserWallet.adapter.icon} alt="" className="mt-0.5 size-5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">Use a wallet in this browser</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">
                    {savedBrowserWallet
                      ? `Reconnect ${shortAddress(savedBrowserWallet)}, saved here. ${WRITE_CLUSTER} test funds only.`
                      : `Nothing to install, ${WRITE_CLUSTER} test funds only.`}
                  </span>
                </span>
              </button>
            </>
          )}
          {installed.length === 0 && (
            <div className="mx-3 mt-1 border-t border-line py-3 text-xs leading-relaxed text-ink-3">
              <p>Have a wallet app? On a phone, open Sheaf inside it:</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {walletBrowseLinks().map((w) => (
                  <a
                    key={w.name}
                    href={w.href}
                    className="border border-line-strong px-3 py-2 text-xs text-ink transition-colors hover:border-bind hover:text-bind rounded-[var(--radius-control)]"
                  >
                    Open in {w.name}
                  </a>
                ))}
              </div>
              <p className="mt-2.5">
                On a computer,{" "}
                <a
                  href="https://phantom.app/download"
                  target="_blank"
                  rel="noreferrer"
                  className="text-bind underline decoration-bind/40 underline-offset-2"
                >
                  install Phantom
                </a>{" "}
                and reload.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
