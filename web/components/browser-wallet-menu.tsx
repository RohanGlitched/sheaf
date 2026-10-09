"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { exportBrowserWalletSecret, forgetBrowserWallet } from "@/lib/browser-wallet";

const item =
  "w-full px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:bg-sunk hover:text-ink";
const small =
  "rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:border-ink-3";

type View = "menu" | "export-confirm" | "export" | "forget";

/**
 * The browser wallet's part of the wallet menu: take the key out, or delete it.
 * Both say plainly what they mean before they do it.
 */
export function BrowserWalletMenu({ onDone }: { onDone: () => void }) {
  const { disconnect } = useWallet();
  const [view, setView] = useState<View>("menu");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (view === "menu") {
    return (
      <>
        <button type="button" onClick={() => setView("export-confirm")} className={item}>
          Export key
        </button>
        <button type="button" onClick={() => setView("forget")} className={item}>
          Forget this wallet
        </button>
      </>
    );
  }

  if (view === "export-confirm") {
    return (
      <div className="border-t border-line px-3 py-3">
        <p className="text-sm leading-relaxed text-ink">Show the secret key?</p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
          Whoever has it controls this wallet. Paste it only into a wallet app you are moving it to, such as
          Phantom&rsquo;s &ldquo;Import private key&rdquo;.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setSecret(exportBrowserWalletSecret());
              setView("export");
            }}
            className={small}
          >
            Show key
          </button>
          <button type="button" onClick={() => setView("menu")} className={`${small} border-transparent text-ink-3`}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (view === "export") {
    return (
      <div className="border-t border-line px-3 py-3">
        {secret ? (
          <>
            <p className="text-xs text-ink-3">Secret key, base58</p>
            <p className="tnum mt-1.5 select-all break-all rounded-[var(--radius-control)] bg-sunk px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink">
              {secret}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">
              In Phantom: add account, import private key, then switch to devnet to see these test funds.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(secret).then(() => setCopied(true));
                }}
                className={small}
              >
                {copied ? "Copied" : "Copy key"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSecret(null);
                  setCopied(false);
                  onDone();
                }}
                className={`${small} border-transparent text-ink-3`}
              >
                Hide
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-loss">No key is saved in this browser.</p>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-line px-3 py-3">
      <p className="text-sm leading-relaxed text-ink">Forget this wallet?</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
        This deletes its key from this browser. Unless you have exported the key, the wallet and everything in it are
        gone for good. They are test funds, but no one can bring them back.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={async () => {
            await disconnect().catch(() => {});
            forgetBrowserWallet();
            onDone();
          }}
          className="rounded-[var(--radius-control)] border border-loss/50 px-3 py-1.5 text-xs font-medium text-loss transition-colors hover:border-loss"
        >
          Forget it
        </button>
        <button type="button" onClick={() => setView("export-confirm")} className={small}>
          Export key first
        </button>
        <button type="button" onClick={() => setView("menu")} className={`${small} border-transparent text-ink-3`}>
          Keep it
        </button>
      </div>
    </div>
  );
}
