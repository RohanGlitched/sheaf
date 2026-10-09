"use client";

import { useCallback, useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BrowserWalletName } from "@/lib/browser-wallet";
import { WRITE_CLUSTER } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { faucetRequest } from "./faucet-button";

const SEEN_KEY = "sheaf:browser-wallet:welcomed";
const ENOUGH_FOR_FEES = 0.01 * LAMPORTS_PER_SOL;
/** Matches CASH_PER_CLAIM in app/api/faucet/route.ts. */
const TEST_DOLLARS = 1_000;

function seenFor(address: string): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === address;
  } catch {
    return true;
  }
}

function markSeen(address: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, address);
  } catch {
    /* private mode: the note simply shows again next time */
  }
}

async function post(path: string, body: Record<string, unknown>, opts: { basket?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    // With the invite code (and, for test dollars, the basket in view), so the faucet knows where the claim came from.
    const response = await fetch(path, faucetRequest(body, opts));
    const json = (await response.json().catch(() => ({}))) as { signature?: string; error?: string };
    return response.ok && json.signature ? { ok: true } : { ok: false, error: json.error ?? "The faucet did not answer." };
  } catch {
    return { ok: false, error: "Could not reach the faucet." };
  }
}

/**
 * The first minute with a browser wallet.
 *
 * A wallet made a second ago is empty, so the first thing anyone would hit is a
 * failed signature. This card says where the wallet lives, once, and while it has
 * no test SOL it carries one button that fills it with test SOL and test dollars
 * from the existing faucets. `onFunded` lets the provider refresh every balance
 * on the page afterwards.
 */
export function BrowserWalletWelcome({ onFunded }: { onFunded?: () => void }) {
  const { connection } = useConnection();
  const { wallet, connected, publicKey } = useWallet();
  const address = connected && wallet?.adapter.name === BrowserWalletName ? (publicKey?.toBase58() ?? null) : null;

  const [lamports, setLamports] = useState<{ owner: string; value: number } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ owner: string; value: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [funded, setFunded] = useState<string | null>(null);

  const readBalance = useCallback(async () => {
    if (!address || !publicKey) return;
    const value = await connection.getBalance(publicKey).catch(() => null);
    if (value != null) setLamports({ owner: address, value });
  }, [address, connection, publicKey]);

  useEffect(() => {
    if (!address) return;
    void Promise.resolve().then(() => {
      setSeen({ owner: address, value: seenFor(address) });
      return readBalance();
    });
  }, [address, readBalance]);

  if (!address || dismissed === address) return null;
  const balance = lamports?.owner === address ? lamports.value : null;
  const firstTime = seen?.owner === address && !seen.value;
  const empty = balance != null && balance < ENOUGH_FOR_FEES;
  const justFunded = funded === address;
  if (!firstTime && !empty && !justFunded) return null;

  function close() {
    if (!address) return;
    markSeen(address);
    setDismissed(address);
  }

  async function fund() {
    if (!address) return;
    setBusy(true);
    setErrors([]);
    const [sol, dollars] = await Promise.all([
      post("/api/faucet/sol", { owner: address }),
      post("/api/faucet", { owner: address, symbols: ["USDC"] }, { basket: true }),
    ]);
    const solOk = sol.ok || /already had/i.test(sol.error ?? "");
    const problems = [
      ...(solOk ? [] : [`Test SOL: ${sol.error}`]),
      ...(dollars.ok ? [] : [`Test dollars: ${dollars.error}`]),
    ];
    setErrors(problems);
    if (sol.ok || dollars.ok) {
      // The faucets confirm on the server's RPC; the page reads through its own,
      // which can trail by a few seconds. Wait until it sees the SOL, then have
      // every balance on the page read again, and once more a little later.
      for (let i = 0; i < 15; i++) {
        const value = await connection.getBalance(new PublicKey(address)).catch(() => 0);
        setLamports({ owner: address, value });
        if (!sol.ok || value >= ENOUGH_FOR_FEES) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      markSeen(address);
      setFunded(address);
      onFunded?.();
      setTimeout(() => onFunded?.(), 4000);
    }
    setBusy(false);
  }

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-[60] rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-[0_24px_48px_-20px_rgb(20_37_28/0.35)] sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[380px]"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="flex items-center gap-2 text-xs text-ink-3">
          <span
            aria-hidden
            className="size-1.5 bg-bind"
            style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }}
          />
          Browser wallet <span className="tnum text-ink-2">{shortAddress(address)}</span>
        </p>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="-m-2 p-2 text-ink-3 transition-colors hover:text-ink"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-ink">
        This wallet lives in this browser.{" "}
        <span className="text-ink-2">
          It holds {WRITE_CLUSTER} test funds only. Export it any time from the wallet menu.
        </span>
      </p>

      {justFunded && errors.length === 0 ? (
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-gain">Test SOL and {TEST_DOLLARS.toLocaleString("en-US")} test dollars are in.</p>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded-[var(--radius-control)] border border-line-strong px-4 py-2 text-xs font-medium text-ink transition-colors hover:border-ink-3"
          >
            Done
          </button>
        </div>
      ) : empty ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={fund}
            disabled={busy}
            className="w-full rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-60"
          >
            {busy ? "Sending test funds…" : "Get test SOL and test dollars"}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            Free: enough SOL for fees and {TEST_DOLLARS.toLocaleString("en-US")} test dollars to buy with. Nothing here is
            real money.
          </p>
        </div>
      ) : (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-[var(--radius-control)] border border-line-strong px-4 py-2 text-xs font-medium text-ink transition-colors hover:border-ink-3"
          >
            Got it
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="mt-3 space-y-1 text-xs leading-relaxed text-loss">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}
