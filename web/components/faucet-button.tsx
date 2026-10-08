"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { FAUCET_TOKENS_PER_CLAIM } from "@/lib/mirror";
import { explorerTx } from "@/lib/config";

/**
 * Test tokens, on request.
 *
 * Nobody should have to go hunting for a tokenized equity before they can see what
 * this does. The button asks the server to mint the exact tickers the person is
 * short of, and says what happened in a sentence either way.
 */
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
  const [signature, setSignature] = useState<string | null>(null);

  async function claim() {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    setSignature(null);
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: publicKey.toBase58(), symbols }),
      });
      const body = (await response.json()) as {
        signature?: string;
        error?: string;
      };
      if (!response.ok || !body.signature) {
        setError(body.error ?? "The faucet did not answer.");
        return;
      }
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
          Sent.{" "}
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
