"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "@/components/connect-button";
import { isTeamWallet } from "@/lib/team-wallets";
import { inviteLink } from "@/lib/invite-ref";
import { useInviteRef } from "@/lib/invite-keep";
import {
  cleanHandle,
  cleanQuote,
  handleText,
  PLATFORMS,
  QUOTE_MAX,
  removalMessage,
  todayUtc,
  voiceMessage,
  type Platform,
  type Voice,
  type VoiceFields,
} from "@/lib/voices-message";

/**
 * Add your name: connect, type a handle and an optional quote, and sign a plain
 * message. The wallet's signMessage is used, never a transaction, so it costs
 * nothing and moves nothing. The exact text is shown before you sign.
 */

const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];

type Status = { kind: "idle" } | { kind: "signing" } | { kind: "sending" } | { kind: "done"; voice: Voice; team: boolean } | { kind: "removed" } | { kind: "error"; text: string };

function signError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel|declin/i.test(m)) return "You cancelled in the wallet. Nothing was signed.";
  return "The wallet couldn't sign that message. Try again, or use Phantom or Solflare.";
}

export function VoicesForm({
  open,
  mine,
  onChange,
}: {
  /** False until storage is configured. */
  open: boolean;
  /** The connected wallet's current entry, if it has one. */
  mine: Voice | null;
  /** Called after a save (with the entry, and whether the wallet is the team's) or a removal (null). */
  onChange: (change: { voice: Voice; team: boolean } | { removed: string }) => void;
}) {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [ref, setRef] = useInviteRef();
  const [platform, setPlatform] = useState<Platform>("x");
  const [handleRaw, setHandleRaw] = useState("");
  const [quoteRaw, setQuoteRaw] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const handle = cleanHandle(platform, handleRaw);
  const quote = cleanQuote(quoteRaw);
  const quoteError = "error" in quote ? quote.error : null;
  const quoteText = "quote" in quote ? quote.quote : "";
  const fields: VoiceFields | null = wallet && handle && !quoteError ? { wallet, platform, handle, quote: quoteText, ref, date: todayUtc() } : null;
  const preview = useMemo(
    () =>
      voiceMessage({
        wallet: wallet ?? "(your wallet address)",
        platform,
        handle: handle ?? (handleRaw.trim().replace(/^@+/, "") || "yourname"),
        quote: quoteText,
        ref,
        date: todayUtc(),
      }),
    [wallet, platform, handle, handleRaw, quoteText, ref],
  );
  const team = wallet ? isTeamWallet(wallet) : false;
  const busy = status.kind === "signing" || status.kind === "sending";

  async function post(body: Record<string, unknown>) {
    setStatus({ kind: "sending" });
    const r = await fetch("/api/voices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; voice?: Voice; team?: boolean };
    if (!r.ok || !j.ok) throw new Error(j.error ?? "We couldn't save that just now.");
    return j;
  }

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (!fields || !signMessage) return;
    try {
      setStatus({ kind: "signing" });
      const sig = await signMessage(new TextEncoder().encode(voiceMessage(fields))).catch((err) => {
        throw new Error(signError(err));
      });
      const j = await post({ ...fields, signature: bs58.encode(sig) });
      setStatus({ kind: "done", voice: j.voice!, team: !!j.team });
      onChange({ voice: j.voice!, team: !!j.team });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    }
  }

  async function remove() {
    if (!wallet || !signMessage) return;
    try {
      setStatus({ kind: "signing" });
      const date = todayUtc();
      const sig = await signMessage(new TextEncoder().encode(removalMessage(wallet, date))).catch((err) => {
        throw new Error(signError(err));
      });
      await post({ action: "remove", wallet, date, signature: bs58.encode(sig) });
      setStatus({ kind: "removed" });
      onChange({ removed: wallet });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    }
  }

  const input =
    "mt-2 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 text-ink outline-none placeholder:text-ink-3 focus:border-bind";

  return (
    <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="display text-3xl text-ink">Sign your name</h3>
        <p className="text-xs text-ink-3">No transaction, no fee</p>
      </div>

      {!open && (
        <p className="mt-6 rounded-[var(--radius-control)] border border-dashed border-line-strong px-4 py-3 text-sm leading-relaxed text-ink-2">
          Signing hasn&rsquo;t opened on this deployment yet. The form works the moment storage is switched on.
        </p>
      )}

      {status.kind === "done" ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-[var(--radius-control)] bg-bind-wash p-5">
            <p className="text-ink">{status.team ? "Signed, and counted as ours." : "You're on the list. Thank you."}</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">
              {status.team
                ? "That wallet is one of the team's, so it is counted apart and never listed with everyone else."
                : `${handleText(status.voice.platform, status.voice.handle)} now appears with this wallet's activity and the signature anyone can check.`}
            </p>
          </div>
          {!status.team && (
            <div className="rounded-[var(--radius-control)] border border-line p-4">
              <p className="text-sm text-ink">Bring someone else</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">Your own invite link. When someone signs after opening it, it shows under where people came from.</p>
              <div className="mt-3 flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] bg-raised px-3 py-2 text-xs text-ink-2">
                  {inviteLink(window.location.origin, status.voice.handle.toLowerCase())}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(inviteLink(window.location.origin, status.voice.handle.toLowerCase())).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    })
                  }
                  className="shrink-0 rounded-[var(--radius-control)] border border-line-strong px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-bind hover:text-bind"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
          <button type="button" onClick={() => setStatus({ kind: "idle" })} className="text-sm text-bind underline decoration-bind/40 underline-offset-4">
            Change what you signed
          </button>
        </div>
      ) : status.kind === "removed" ? (
        <div className="mt-6 rounded-[var(--radius-control)] bg-raised p-5">
          <p className="text-ink">Your name is off the list.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">The entry was replaced with a note that it was taken down. You can sign again from tomorrow.</p>
        </div>
      ) : !connected || !wallet ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm leading-relaxed text-ink-2">Connect the wallet you used on Sheaf. Your name is tied to that wallet&rsquo;s activity, so use the one that did something.</p>
          <ConnectButton block label="Connect the wallet you used" />
        </div>
      ) : (
        <form onSubmit={sign} className="mt-6 space-y-6" noValidate>
          {team && (
            <p className="rounded-[var(--radius-control)] border border-dashed border-line-strong px-4 py-3 text-xs leading-relaxed text-ink-3">
              This is one of the team&rsquo;s wallets. You can sign, but it is counted as ours and never listed.
            </p>
          )}
          {mine && (
            <p className="rounded-[var(--radius-control)] bg-raised px-4 py-3 text-xs leading-relaxed text-ink-2">
              This wallet signed on {mine.date} as {handleText(mine.platform, mine.handle)}. Signing again replaces it.{" "}
              <button type="button" onClick={remove} disabled={busy} className="text-loss underline decoration-loss/40 underline-offset-2 disabled:opacity-60">
                Take my name down
              </button>
            </p>
          )}

          <fieldset>
            <legend className="text-sm font-medium text-ink">Where people can find you</legend>
            <div className="mt-3 inline-flex rounded-[var(--radius-control)] border border-line bg-raised p-1">
              {PLATFORM_KEYS.map((k) => (
                <label
                  key={k}
                  className={`cursor-pointer rounded-[8px] px-3.5 py-1.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-bind ${
                    platform === k ? "bg-surface text-ink shadow-[0_1px_2px_rgb(20_37_28/0.12)]" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  <input type="radio" name="platform" value={k} checked={platform === k} onChange={() => setPlatform(k)} className="sr-only" />
                  {PLATFORMS[k].label}
                </label>
              ))}
            </div>
            <label className="mt-4 block">
              <span className="text-xs text-ink-3">Your {PLATFORMS[platform].label} handle</span>
              <input
                value={handleRaw}
                onChange={(e) => setHandleRaw(e.target.value)}
                placeholder={PLATFORMS[platform].at ? "@yourname" : "yourname"}
                autoComplete="off"
                spellCheck={false}
                maxLength={80}
                className={input}
              />
              {handleRaw.trim() && !handle && <span className="mt-2 block text-xs text-loss">That doesn&rsquo;t look like a {PLATFORMS[platform].label} handle ({PLATFORMS[platform].hint}).</span>}
            </label>
          </fieldset>

          <label className="block">
            <span className="text-sm font-medium text-ink">One line about it</span>
            <span className="ml-2 text-xs text-ink-3">optional</span>
            <textarea
              value={quoteRaw}
              onChange={(e) => setQuoteRaw(e.target.value)}
              rows={3}
              maxLength={QUOTE_MAX + 40}
              placeholder="What worked, what didn't, what you'd want next."
              className={`${input} resize-none leading-relaxed`}
            />
            <span className="mt-1.5 flex justify-between gap-3 text-xs">
              <span className="text-loss">{quoteError}</span>
              <span className={`tnum ${quoteRaw.length > QUOTE_MAX ? "text-loss" : "text-ink-3"}`}>
                {quoteRaw.length}/{QUOTE_MAX}
              </span>
            </span>
          </label>

          {ref && (
            <p className="text-xs text-ink-3">
              You came through the <span className="text-ink-2">{ref}</span> invite.{" "}
              <button type="button" onClick={() => setRef(null)} className="underline decoration-line-strong underline-offset-2 hover:text-ink-2">
                Leave it out
              </button>
            </p>
          )}

          <div>
            <button
              type="submit"
              disabled={!open || !fields || !signMessage || busy}
              className="w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
            >
              {status.kind === "signing" ? "Waiting for your wallet…" : status.kind === "sending" ? "Checking the signature…" : "Sign with your wallet"}
            </button>
            {!signMessage && <p className="mt-2 text-xs text-loss">This wallet can&rsquo;t sign messages. Phantom, Solflare and Backpack can.</p>}
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              Your wallet shows the exact text before you sign it. Not sure what to try first?{" "}
              <Link href="/explore" className="underline decoration-line-strong underline-offset-2 hover:text-ink-2">
                Buy a basket
              </Link>{" "}
              or{" "}
              <Link href="/plans" className="underline decoration-line-strong underline-offset-2 hover:text-ink-2">
                open a plan
              </Link>{" "}
              with free test dollars, then come back.
            </p>
          </div>

          {status.kind === "error" && <p className="border-l-2 border-loss pl-3 text-sm text-loss">{status.text}</p>}
        </form>
      )}

      <details className="group mt-8 border-t border-line pt-4" open>
        <summary className="cursor-pointer list-none text-xs text-ink-3 [&::-webkit-details-marker]:hidden">
          <span className="text-ink-2">What you sign</span> <span className="group-open:hidden">· show</span>
        </summary>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-vault p-4 font-mono text-[11px] leading-relaxed text-vault-ink">{preview}</pre>
      </details>
    </div>
  );
}
