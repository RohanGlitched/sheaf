"use client";

import { useEffect, useRef, useState } from "react";
import {
  BROWSER_WALLET_SIGNED_EVENT,
  setBrowserWalletConfirm,
  type SignRequest,
} from "@/lib/browser-wallet";

type Pending = { request: SignRequest; resolve: (ok: boolean) => void };

/**
 * The browser wallet's two bits of UI that are not in the wallet menu.
 *
 * A confirm step for anything Sheaf did not build itself (a program outside the
 * allow-list in lib/browser-wallet.ts, or a message that is not one of /voices'),
 * defaulting to "Don't sign". And a one-line note after each signature, so a
 * wallet that never pops up still says when it has signed.
 */
export function BrowserWalletConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const decline = useRef<HTMLButtonElement>(null);
  const live = useRef<Pending | null>(null);

  useEffect(() => {
    setBrowserWalletConfirm(
      (request) =>
        new Promise<boolean>((resolve) => {
          // One question at a time: a newer request declines the one still open.
          live.current?.resolve(false);
          live.current = { request, resolve };
          setPending(live.current);
        }),
    );
    const onSigned = (e: Event) => {
      const text = String((e as CustomEvent<string>).detail ?? "Signed");
      setToast({ id: Date.now(), text });
    };
    window.addEventListener(BROWSER_WALLET_SIGNED_EVENT, onSigned);
    return () => {
      setBrowserWalletConfirm(null);
      window.removeEventListener(BROWSER_WALLET_SIGNED_EVENT, onSigned);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!pending) return;
    decline.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function answer(ok: boolean) {
    live.current?.resolve(ok);
    live.current = null;
    setPending(null);
  }

  const r = pending?.request;

  return (
    <>
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-20 z-[70] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-xs text-ink-2 shadow-[0_12px_32px_-16px_rgb(20_37_28/0.4)]"
        >
          <span aria-hidden className="size-1.5 shrink-0 bg-gain" style={{ clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)" }} />
          <span className="truncate">Browser wallet: {toast.text}</span>
        </div>
      )}

      {r && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/30 p-4" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="bw-confirm-title"
            className="w-full max-w-md rounded-[var(--radius-panel)] border border-line bg-surface p-6 shadow-[0_32px_64px_-24px_rgb(20_37_28/0.45)]"
          >
            <p className="text-xs text-ink-3">Browser wallet</p>
            <h2 id="bw-confirm-title" className="mt-1.5 text-lg font-medium leading-snug text-ink">
              {r.kind === "transaction"
                ? r.unknown.length
                  ? "Sign a transaction Sheaf did not build?"
                  : "Sign a transaction that moves funds?"
                : r.kind === "message"
                  ? "Sign a message Sheaf did not write?"
                  : r.title}
            </h2>

            {r.kind === "transaction" && (
              <>
                {r.unknown.length > 0 && (
                  <>
                    <p className="mt-3 text-sm leading-relaxed text-ink-2">
                      {r.count === 1 ? "It calls" : `These ${r.count} transactions call`}{" "}
                      {r.unknown.length === 1 ? "a program" : "programs"} outside the list this wallet signs for without asking:
                    </p>
                    <Items items={r.unknown} mono />
                  </>
                )}
                {r.reasons.length > 0 && (
                  <>
                    <p className="mt-3 text-sm leading-relaxed text-ink-2">
                      {r.unknown.length ? "It would also:" : "Sheaf's own steps never do this. It would:"}
                    </p>
                    <Items items={r.reasons} />
                  </>
                )}
                {r.known.length > 0 && <p className="mt-3 text-xs leading-relaxed text-ink-3">Programs called: {r.known.join(", ")}.</p>}
              </>
            )}
            {r.kind === "message" && (
              <>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">It is not one of the /voices messages. This is the exact text:</p>
                <Exact text={r.text ?? `${r.bytes} bytes of binary data, not text.`} />
              </>
            )}
            {r.kind === "evm" && (
              <>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{r.intro}</p>
                {r.items.length > 0 && <Items items={r.items} />}
                {r.text && <Exact text={r.text} />}
              </>
            )}

            <p className="mt-4 text-xs leading-relaxed text-ink-3">If you did not just ask for this, don&rsquo;t sign it.</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                ref={decline}
                type="button"
                onClick={() => answer(false)}
                className="rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
              >
                Don&rsquo;t sign
              </button>
              <button
                type="button"
                onClick={() => answer(true)}
                className="rounded-[var(--radius-control)] border border-line-strong px-4 py-2.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
              >
                Sign it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Items({ items, mono = false }: { items: string[]; mono?: boolean }) {
  return (
    <ul className="mt-3 max-h-56 space-y-1.5 overflow-auto">
      {items.map((it) => (
        <li
          key={it}
          className={`break-all rounded-[var(--radius-control)] bg-sunk px-3 py-2 leading-relaxed text-ink ${mono ? "font-mono text-[11px]" : "text-xs"}`}
        >
          {it}
        </li>
      ))}
    </ul>
  );
}

function Exact({ text }: { text: string }) {
  return (
    <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-vault p-3 font-mono text-[11px] leading-relaxed text-vault-ink">
      {text}
    </pre>
  );
}
