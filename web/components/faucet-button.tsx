"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { FAUCET_TOKENS_PER_CLAIM } from "@/lib/mirror";
import { explorerTx } from "@/lib/config";
import { currentRef } from "@/lib/invite-keep";

/**
 * Test tokens, on request.
 *
 * Nobody should have to go hunting for a tokenized equity before they can see what
 * this does. The button asks the server to mint the exact tickers the person is
 * short of, and says what happened in a sentence either way.
 */
/** The basket this page is about, from its /basket/<address> URL, or null on any other page. */
export function basketInView(): string | null {
  if (typeof window === "undefined") return null;
  return /^\/basket\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/|$)/.exec(window.location.pathname)?.[1] ?? null;
}

/**
 * Body and headers for a faucet call: the basket in view and the invite code
 * the visitor arrived with, so the faucet can tell which page and which invite
 * a claim came from. Both are left out when there are none.
 */
export function faucetRequest(body: Record<string, unknown>, opts: { basket?: boolean } = {}): RequestInit {
  const ref = currentRef();
  const basket = opts.basket ? basketInView() : null;
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(ref ? { "x-sheaf-ref": ref } : {}) },
    body: JSON.stringify({ ...body, ...(basket ? { basket } : {}), ...(ref ? { ref } : {}) }),
  };
}

/** How long "Sent." stays up, even if the page re-renders the button after the balances reload. */
const SENT_MS = 5_000;
/** The last claim, kept outside the component so a remounted button still shows it. */
let lastSent: { signature: string; at: number } | null = null;

export function FaucetButton({
  symbols,
  onDone,
  label,
}: {
  symbols: string[];
  onDone?: () => void;
  label?: string;
}) {
  const { publicKey, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(() =>
    lastSent && Date.now() - lastSent.at < SENT_MS ? lastSent.signature : null,
  );

  // Clear the confirmation once it has been up for its five seconds, counted from the claim.
  useEffect(() => {
    if (!signature) return;
    const left = lastSent && lastSent.signature === signature ? SENT_MS - (Date.now() - lastSent.at) : SENT_MS;
    const timer = setTimeout(() => setSignature(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [signature]);

  async function claim() {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    setSignature(null);
    try {
      const response = await fetch("/api/faucet", faucetRequest({ owner: publicKey.toBase58(), symbols }, { basket: true }));
      const body = (await response.json()) as {
        signature?: string;
        error?: string;
      };
      if (!response.ok || !body.signature) {
        setError(body.error ?? "The faucet did not answer.");
        return;
      }
      lastSent = { signature: body.signature, at: Date.now() };
      setSignature(body.signature);
      onDone?.();
    } catch {
      setError("Could not reach the faucet.");
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <p className="text-xs text-ink-3">
        Connect a wallet to claim test tokens.
      </p>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy || symbols.length === 0}
        onClick={claim}
        className="border border-line-strong px-4 py-2.5 text-xs text-ink transition-colors hover:border-bind hover:text-bind disabled:cursor-not-allowed disabled:border-line disabled:text-ink-3 rounded-[var(--radius-control)]"
      >
        {busy
          ? "Minting…"
          : (label ??
            `Send me ${FAUCET_TOKENS_PER_CLAIM} of each`)}
      </button>
      {error && (
        <p className="mt-2 text-xs leading-relaxed text-loss">{error}</p>
      )}
      {signature && (
        <p className="mt-2 text-xs leading-relaxed text-gain">
          Sent: test tokens, worth nothing, are in your wallet.{" "}
          <a
            href={explorerTx(signature)}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-current underline-offset-4"
          >
            Transaction
          </a>
        </p>
      )}
    </div>
  );
}
