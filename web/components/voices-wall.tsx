"use client";

import { useMemo, useState } from "react";
import bs58 from "bs58";
import { SheafMark, type Stalk } from "@/components/sheaf-mark";
import { explorerAddress, explorerTx } from "@/lib/config";
import { shortAddress, timeAgo } from "@/lib/format";
import { slotColor } from "@/lib/palette";
import type { Deed } from "@/lib/voices-activity";
import { handleText, PLATFORMS, profileUrl, voiceMessage, type Voice } from "@/lib/voices-message";

/**
 * One signed name: who, what they said, what their wallet did on Sheaf, and the
 * message and signature behind it, checkable right here in the browser with the
 * Web Crypto API, without trusting Sheaf's server.
 */

/** A small sheaf drawn from the wallet's own bytes, so every name has a mark nobody picked. */
function walletStalks(wallet: string): Stalk[] {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(wallet);
  } catch {
    bytes = new Uint8Array(32);
  }
  const n = 3 + (bytes[0] % 3);
  return Array.from({ length: n }, (_, i) => ({
    key: String(i),
    weight: 0.25 + bytes[i + 1] / 340,
    color: slotColor(bytes[i + 9] ?? i),
  }));
}

type Check = { state: "idle" } | { state: "checking" } | { state: "ok" } | { state: "bad"; why: string } | { state: "unsupported" };

async function checkInBrowser(v: Voice): Promise<Check> {
  // The message must say exactly what the card shows, or a valid signature would prove something else.
  if (voiceMessage(v) !== v.message) return { state: "bad", why: "The signed message doesn't match what this card shows." };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", bs58.decode(v.wallet) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { state: "unsupported" };
  }
  try {
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, bs58.decode(v.signature) as BufferSource, new TextEncoder().encode(v.message));
    return ok ? { state: "ok" } : { state: "bad", why: "The signature does not match this wallet and message." };
  } catch {
    return { state: "bad", why: "The signature could not be read." };
  }
}

function Verify({ voice }: { voice: Voice }) {
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  return (
    <details className="group mt-5 border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm text-ink-2 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 text-bind">
            <path d="M8 1.5 13.5 4v4c0 3.2-2.4 5.7-5.5 6.5C4.9 13.7 2.5 11.2 2.5 8V4L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="m5.6 8.1 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Verify
        </span>
        <span aria-hidden className="text-xs text-ink-3 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="mt-4 space-y-4 text-xs">
        <div>
          <p className="text-ink-3">The message this wallet signed</p>
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-raised p-3 font-mono text-[11px] leading-relaxed text-ink-2">
            {voice.message}
          </pre>
        </div>
        <div>
          <p className="text-ink-3">Signature (ed25519, base58)</p>
          <p className="mt-1.5 break-all rounded-[var(--radius-control)] bg-raised p-3 font-mono text-[11px] leading-relaxed text-ink-2">{voice.signature}</p>
        </div>
        <div>
          <p className="text-ink-3">Public key (the wallet address)</p>
          <p className="mt-1.5 break-all font-mono text-[11px] text-ink-2">{voice.wallet}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              setCheck({ state: "checking" });
              setCheck(await checkInBrowser(voice));
            }}
            disabled={check.state === "checking"}
            className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-bind hover:text-bind disabled:opacity-60"
          >
            {check.state === "checking" ? "Checking…" : "Check it in this browser"}
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(JSON.stringify({ wallet: voice.wallet, message: voice.message, signature: voice.signature }, null, 2))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                });
            }}
            className="rounded-[var(--radius-control)] px-3 py-2 text-xs text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
          >
            {copied ? "Copied" : "Copy as JSON"}
          </button>
        </div>
        <p aria-live="polite" className="leading-relaxed">
          {check.state === "ok" && (
            <span className="text-gain">
              Valid. Your browser checked the signature against the wallet&rsquo;s public key itself, and the message says exactly what this card shows.
            </span>
          )}
          {check.state === "bad" && <span className="text-loss">{check.why}</span>}
          {check.state === "unsupported" && (
            <span className="text-ink-3">This browser can&rsquo;t check ed25519 signatures yet. Copy the JSON and check it with the snippet further down the page.</span>
          )}
        </p>
      </div>
    </details>
  );
}

export function VoiceCard({ voice, deeds, ledger, index }: { voice: Voice; deeds: Deed[] | undefined; ledger: "loading" | "ready" | "failed"; index: number }) {
  const stalks = useMemo(() => walletStalks(voice.wallet), [voice.wallet]);
  const p = PLATFORMS[voice.platform];
  const signedAt = Date.parse(voice.at) / 1000;
  return (
    <li className="rise flex flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-6" style={{ ["--i" as string]: Math.min(index, 8) }}>
      <div className="flex items-start gap-4">
        <SheafMark stalks={stalks} className="size-12 shrink-0" title={`A sheaf drawn from ${shortAddress(voice.wallet)}`} />
        <div className="min-w-0 flex-1">
          <a
            href={profileUrl(voice.platform, voice.handle)}
            target="_blank"
            rel="noreferrer nofollow ugc"
            className="block truncate text-base font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink-2"
          >
            {handleText(voice.platform, voice.handle)}
          </a>
          <p className="tnum mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            <span>{p.label}</span>
            <span aria-hidden>·</span>
            <a href={explorerAddress(voice.wallet)} target="_blank" rel="noreferrer" className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
              {shortAddress(voice.wallet)}
            </a>
            <span aria-hidden>·</span>
            <time dateTime={voice.at} title={voice.at}>
              signed {Number.isFinite(signedAt) ? timeAgo(signedAt) : voice.date}
            </time>
          </p>
        </div>
      </div>

      {voice.quote ? (
        <blockquote className="display mt-5 text-[1.35rem] leading-snug text-ink">
          <span aria-hidden className="text-ink-3">&ldquo;</span>
          {voice.quote}
          <span aria-hidden className="text-ink-3">&rdquo;</span>
        </blockquote>
      ) : (
        <p className="mt-5 text-sm text-ink-3">Signed without a quote.</p>
      )}

      <div className="mt-5 flex-1">
        <p className="text-xs text-ink-3">On Sheaf, from the program&rsquo;s own events</p>
        {ledger === "loading" ? (
          <p className="skeleton mt-2 h-4 w-3/4 rounded" aria-label="Reading the ledger" />
        ) : ledger === "failed" ? (
          <p className="mt-2 text-sm text-ink-3">The ledger didn&rsquo;t answer; the wallet link above shows its transactions.</p>
        ) : deeds && deeds.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
            {deeds.slice(0, 5).map((d) => (
              <li key={d.text} className="flex items-baseline gap-2">
                <span aria-hidden className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-gain" />
                <a href={explorerTx(d.signature)} target="_blank" rel="noreferrer" className="hover:text-ink hover:underline hover:decoration-line-strong hover:underline-offset-4">
                  {d.text}
                </a>
              </li>
            ))}
            {deeds.length > 5 && <li className="pl-3.5 text-xs text-ink-3">and {deeds.length - 5} more on the ledger</li>}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-ink-3">Nothing on the ledger from this wallet yet.</p>
        )}
      </div>

      {voice.ref && (
        <p className="mt-4">
          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3">joined via {voice.ref}</span>
        </p>
      )}

      <Verify voice={voice} />
    </li>
  );
}
