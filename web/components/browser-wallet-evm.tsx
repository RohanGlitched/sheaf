"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import {
  exportEvmBrowserKey,
  forgetEvmBrowserWallet,
  leaveEvmBrowserWallet,
  storedEvmBrowserAddress,
} from "@/lib/evm-browser-wallet";
import { shortAddress } from "@/lib/format";

const item = "w-full px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink";
const small =
  "rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-ink-3";

type View = "menu" | "export-confirm" | "export" | "forget";

/**
 * The EVM browser wallet's menu: copy the address, take the key out, stop using
 * it, or delete it. The same shape as the Solana one in browser-wallet-menu.tsx.
 */
export function EvmBrowserWalletMenu({
  align = "right",
  header = false,
  address,
}: {
  align?: "left" | "right";
  /** Render as the header's wallet button rather than a small link. */
  header?: boolean;
  address?: Address;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<"address" | "key" | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setView("menu");
    setSecret(null);
    setCopied(null);
  }

  const shown = address ?? (open ? storedEvmBrowserAddress() : null);

  return (
    <div className="relative" ref={root}>
      {header ? (
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          className="flex items-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink transition-colors hover:border-ink-3"
          title="Browser wallet: kept in this browser, testnet funds only"
        >
          <span aria-hidden className="size-1.5 bg-bind" style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }} />
          <span className="text-xs text-ink-3">EVM</span>
          <span className="tnum">{address ? shortAddress(address, 6, 4) : "Browser wallet"}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          className="text-xs text-bind underline decoration-bind/40 underline-offset-4 hover:decoration-bind"
          aria-expanded={open}
        >
          Browser wallet
        </button>
      )}

      {open && (
        <div
          className={`absolute top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-panel)] border border-line bg-raised p-1 text-left shadow-[0_24px_48px_-24px_rgb(20_37_28/0.35)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="px-3 py-2.5 text-xs leading-relaxed text-ink-3">
            Browser wallet on Sheaf&rsquo;s testnets
            <span className="block">Lives in this browser. Test funds only.</span>
          </div>
          {view === "menu" && (
            <>
              {shown && (
                <button
                  type="button"
                  className={item}
                  onClick={() => void navigator.clipboard.writeText(shown).then(() => setCopied("address"))}
                >
                  {copied === "address" ? "Copied" : "Copy address"}
                </button>
              )}
              <button type="button" className={item} onClick={() => setView("export-confirm")}>
                Export key
              </button>
              <button
                type="button"
                className={item}
                onClick={() => {
                  close();
                  leaveEvmBrowserWallet();
                }}
              >
                Use another wallet
              </button>
              <button type="button" className={item} onClick={() => setView("forget")}>
                Forget this wallet
              </button>
            </>
          )}

          {view === "export-confirm" && (
            <div className="border-t border-line px-3 py-3">
              <p className="text-sm leading-relaxed text-ink">Show the private key?</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                Whoever has it controls this wallet. Paste it only into a wallet you are moving it to, such as MetaMask&rsquo;s
                &ldquo;Import account&rdquo;.
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-loss">
                Never send real funds to this address: this site signs for it without asking.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={small}
                  onClick={() => {
                    setSecret(exportEvmBrowserKey());
                    setView("export");
                  }}
                >
                  Show key
                </button>
                <button type="button" className={`${small} border-transparent text-ink-3`} onClick={() => setView("menu")}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {view === "export" && (
            <div className="border-t border-line px-3 py-3">
              {secret ? (
                <>
                  <p className="text-xs text-ink-3">Private key, hex</p>
                  <p className="evm-secret mt-1.5 select-all break-all rounded-[var(--radius-control)] bg-sunk px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink">
                    {secret}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className={small}
                      onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied("key"))}
                    >
                      {copied === "key" ? "Copied" : "Copy key"}
                    </button>
                    <button type="button" className={`${small} border-transparent text-ink-3`} onClick={close}>
                      Hide
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-loss">No key is saved in this browser.</p>
              )}
            </div>
          )}

          {view === "forget" && (
            <div className="border-t border-line px-3 py-3">
              <p className="text-sm leading-relaxed text-ink">Forget this wallet?</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                This deletes its key from this browser. Unless you have exported it, the wallet and its test funds are gone for good.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-[var(--radius-control)] border border-loss/50 px-3 py-1.5 text-xs font-medium text-loss transition-colors hover:border-loss"
                  onClick={() => {
                    close();
                    forgetEvmBrowserWallet();
                  }}
                >
                  Forget it
                </button>
                <button type="button" className={small} onClick={() => setView("export-confirm")}>
                  Export key first
                </button>
                <button type="button" className={`${small} border-transparent text-ink-3`} onClick={() => setView("menu")}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
