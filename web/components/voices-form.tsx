"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import bs58 from "bs58";
import { useWallet } from "@solana/wallet-adapter-react";
import { ConnectButton } from "@/components/connect-button";
import { useEvmSigner } from "@/lib/voices-evm-client";
import { BrowserWalletName } from "@/lib/browser-wallet";
import { explorerTx } from "@/lib/config";
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
  type VoiceStatus,
  type WalletKind,
} from "@/lib/voices-message";

/**
 * Add your name: connect, type a handle and an optional quote, and sign a plain
 * message. The wallet's signMessage is used, never a transaction, so it costs
 * nothing and moves nothing. The exact text is shown before you sign.
 *
 * A signed name is listed only once the wallet has done something on Sheaf; until
 * then the signer sees "signed, waiting for a first action" here and can check
 * again after acting. A GitHub handle can be proven with a public gist.
 */

const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];

type Own = { status: VoiceStatus; voice: Voice };
type Busy = null | "signing" | "sending" | "checking" | "gist";

function signError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel|declin/i.test(m)) return "You cancelled in the wallet. Nothing was signed.";
  return "The wallet couldn't sign that message. Try again, or use Phantom or Solflare.";
}

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/voices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; voice?: Voice; status?: VoiceStatus };
  if (!r.ok || !j.ok) throw new Error(j.error ?? "We couldn't save that just now.");
  return j;
}

function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
      className={`shrink-0 rounded-[var(--radius-control)] border border-line-strong px-3 py-2 text-xs font-medium text-ink transition-colors hover:border-bind hover:text-bind ${className}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** Prove a GitHub handle: a public gist from that account with the exact signed message. */
function GithubProve({ voice, onVerified }: { voice: Voice; onVerified: (o: Own) => void }) {
  const [gist, setGist] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rounded-[var(--radius-control)] border border-line p-4">
      <p className="text-sm text-ink">Prove the GitHub handle</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        Until then your card says <span className="text-ink-2">self-reported</span>. Create a public gist as{" "}
        <span className="text-ink-2">{voice.handle}</span> containing the message you signed, then paste its link. The server
        reads it from GitHub and checks the owner and the text.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton text={voice.message} label="Copy the message" />
        <a
          href="https://gist.github.com/"
          target="_blank"
          rel="noreferrer"
          className="rounded-[var(--radius-control)] px-3 py-2 text-xs text-ink-2 transition-colors hover:bg-sunk hover:text-ink"
        >
          Open gist.github.com
        </a>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const j = await post({ action: "github", wallet: voice.wallet, gist });
            onVerified({ status: j.status!, voice: j.voice! });
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't check that.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          value={gist}
          onChange={(e) => setGist(e.target.value)}
          placeholder="https://gist.github.com/you/…"
          spellCheck={false}
          maxLength={200}
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-bind"
        />
        <button
          type="submit"
          disabled={busy || !gist.trim()}
          className="shrink-0 rounded-[var(--radius-control)] bg-bind px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-bind-deep disabled:bg-sunk disabled:text-ink-3"
        >
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-loss">{error}</p>}
    </div>
  );
}

export function VoicesForm({
  open,
  onChange,
}: {
  /** False until storage is configured. */
  open: boolean;
  /** Called after a save (with the entry and where it stands) or a removal. */
  onChange: (change: { voice: Voice; status: VoiceStatus } | { removed: string }) => void;
}) {
  const { publicKey, signMessage, connected, wallet: adapter } = useWallet();
  const evm = useEvmSigner();
  // Solana or an EVM chain: the same message, signed with ed25519 or EIP-191 personal_sign.
  const [chain, setChain] = useState<"solana" | "evm">("solana");
  const wallet = chain === "solana" ? (connected ? (publicKey?.toBase58() ?? null) : null) : evm.address;
  const walletKind: WalletKind = chain === "solana" ? (adapter?.adapter.name === BrowserWalletName ? "browser" : "app") : evm.isBrowser ? "browser" : "app";
  const canSign = chain === "solana" ? !!signMessage : !!evm.provider;
  /** Signs the text with whichever wallet is in use; base58 for Solana, 0x hex for EVM. */
  const signText = async (text: string): Promise<string> => {
    try {
      if (chain === "evm") return await evm.sign(text);
      if (!signMessage) throw new Error("This wallet can't sign messages.");
      return bs58.encode(await signMessage(new TextEncoder().encode(text)));
    } catch (err) {
      throw new Error(signError(err));
    }
  };
  const [connectError, setConnectError] = useState<string | null>(null);
  // Someone who arrives with only an EVM wallet connected starts on the EVM tab.
  const evmOnly = !connected && !!evm.address;
  useEffect(() => {
    if (evmOnly) void Promise.resolve().then(() => setChain("evm"));
  }, [evmOnly]);
  const [ref, setRef] = useInviteRef();
  const [platform, setPlatform] = useState<Platform>("x");
  const [handleRaw, setHandleRaw] = useState("");
  const [quoteRaw, setQuoteRaw] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [own, setOwn] = useState<{ wallet: string; own: Own | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [removed, setRemoved] = useState(false);

  // This wallet's own entry, listed or not, so a returning signer sees where they stand.
  useEffect(() => {
    if (!wallet || !open) return;
    let live = true;
    void fetch(`/api/voices?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { status: VoiceStatus | null; voice: Voice | null } | null) => {
        if (live && j) setOwn({ wallet, own: j.voice && j.status ? { status: j.status, voice: j.voice } : null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wallet, open]);
  const mine = own && own.wallet === wallet ? own.own : null;

  const handle = cleanHandle(platform, handleRaw);
  const quote = cleanQuote(quoteRaw);
  const quoteError = "error" in quote ? quote.error : null;
  const quoteText = "quote" in quote ? quote.quote : "";
  const fields: VoiceFields | null = wallet && handle && !quoteError ? { wallet, walletKind, platform, handle, quote: quoteText, ref, date: todayUtc() } : null;
  const preview = useMemo(
    () =>
      voiceMessage({
        wallet: wallet ?? "(your wallet address)",
        walletKind,
        platform,
        handle: handle ?? (handleRaw.trim().replace(/^@+/, "") || "yourname"),
        quote: quoteText,
        ref,
        date: todayUtc(),
      }),
    [wallet, walletKind, platform, handle, handleRaw, quoteText, ref],
  );
  const team = wallet ? isTeamWallet(wallet) : false;

  const settle = (o: Own) => {
    if (!wallet) return;
    setOwn({ wallet, own: o });
    setEditing(false);
    onChange({ voice: o.voice, status: o.status });
  };

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (!fields || !canSign) return;
    setError(null);
    try {
      setBusy("signing");
      const signature = await signText(voiceMessage(fields));
      setBusy("sending");
      const j = await post({ ...fields, signature });
      settle({ status: j.status!, voice: j.voice! });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function checkAgain() {
    if (!wallet) return;
    setError(null);
    setBusy("checking");
    try {
      const j = await post({ action: "recheck", wallet });
      settle({ status: j.status!, voice: j.voice! });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check just now.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!wallet || !canSign) return;
    setError(null);
    try {
      setBusy("signing");
      const date = todayUtc();
      const signature = await signText(removalMessage(wallet, date));
      setBusy("sending");
      await post({ action: "remove", wallet, date, signature });
      setOwn({ wallet, own: null });
      setRemoved(true);
      onChange({ removed: wallet });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const input =
    "mt-2 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3 text-ink outline-none placeholder:text-ink-3 focus:border-bind";
  const quiet = "underline decoration-line-strong underline-offset-2 hover:text-ink-2";
  const errorLine = error && <p className="border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>;

  let body: React.ReactNode;
  if (removed) {
    body = (
      <div className="mt-6 rounded-[var(--radius-control)] bg-raised p-5">
        <p className="text-ink">Your name is off the list.</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">The entry was replaced with a note that it was taken down. You can sign again from tomorrow.</p>
      </div>
    );
  } else if (!wallet) {
    body = (
      <div className="mt-6 space-y-4">
        <p className="text-sm leading-relaxed text-ink-2">
          Connect the wallet you used on Sheaf. Your name is listed once that wallet has done something here, so use the one that did.
        </p>
        {chain === "solana" ? (
          <ConnectButton block label="Connect the wallet you used" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => {
                setConnectError(null);
                try {
                  evm.connectBrowser();
                } catch (err) {
                  setConnectError((err as Error).message);
                }
              }}
              className="rounded-[var(--radius-control)] bg-bind px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
            >
              The wallet in this browser
            </button>
            <button
              type="button"
              disabled={!evm.hasInjected}
              onClick={() => {
                setConnectError(null);
                evm.connectInjected().catch((err) => setConnectError(signError(err)));
              }}
              className="rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 py-3 text-sm font-medium text-ink transition-colors hover:border-ink-3 disabled:opacity-50"
            >
              {evm.hasInjected ? "Installed wallet (MetaMask, Rabby…)" : "No EVM wallet installed"}
            </button>
          </div>
        )}
        {connectError && <p className="text-xs text-loss">{connectError}</p>}
      </div>
    );
  } else if (mine && !editing) {
    const v = mine.voice;
    const link = inviteLink(window.location.origin, v.handle.toLowerCase());
    body = (
      <div className="mt-6 space-y-4">
        {mine.status === "team" ? (
          <div className="rounded-[var(--radius-control)] border border-dashed border-line-strong p-5">
            <p className="text-ink">Signed, but not listed.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">This is one of Sheaf&rsquo;s own house or test wallets, so it isn&rsquo;t listed.</p>
          </div>
        ) : mine.status === "listed" ? (
          <div className="rounded-[var(--radius-control)] bg-bind-wash p-5">
            <p className="text-ink">You&rsquo;re listed as {handleText(v.platform, v.handle)}. Thank you.</p>
            {v.proof && (
              <p className="mt-1 text-sm leading-relaxed text-ink-2">
                First action on the chain:{" "}
                <a href={explorerTx(v.proof.signature)} target="_blank" rel="noreferrer" className="underline decoration-ink-3/40 underline-offset-4 hover:text-ink">
                  {v.proof.text}
                </a>
                .
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-[var(--radius-control)] border border-line bg-raised p-5">
            <p className="text-ink">Signed, waiting for a first action.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">
              Your name appears once this wallet does something on Sheaf:{" "}
              <Link href="/explore" className={quiet}>
                buy a basket
              </Link>
              ,{" "}
              <Link href="/plans" className={quiet}>
                open a plan
              </Link>
              , or swap on a basket&rsquo;s launch. Until then it is counted, not shown.
            </p>
            <button
              type="button"
              onClick={checkAgain}
              disabled={busy != null}
              className="mt-4 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-bind hover:text-bind disabled:opacity-60"
            >
              {busy === "checking" ? "Reading the chain…" : "I've done something, check again"}
            </button>
          </div>
        )}

        {v.platform === "github" && mine.status !== "team" && (v.github ? (
          <p className="text-xs text-gain">Verified on GitHub: gist {v.github.gist.slice(0, 8)} by @{v.github.login}.</p>
        ) : (
          <GithubProve voice={v} onVerified={settle} />
        ))}

        {mine.status !== "team" && (
          <div className="rounded-[var(--radius-control)] border border-line p-4">
            <p className="text-sm text-ink">Bring someone else</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">Your own invite link to share. Anyone who signs after opening it is counted as coming through you.</p>
            <div className="mt-3 flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] bg-raised px-3 py-2 text-xs text-ink-2">{link}</code>
              <CopyButton text={link} />
            </div>
          </div>
        )}

        <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <button type="button" onClick={() => setEditing(true)} className="text-bind underline decoration-bind/40 underline-offset-4">
            Change what you signed
          </button>
          <button type="button" onClick={remove} disabled={busy != null} className="text-loss underline decoration-loss/40 underline-offset-4 disabled:opacity-60">
            {busy === "signing" ? "Waiting for your wallet…" : "Take my name down"}
          </button>
        </p>
        {errorLine}
      </div>
    );
  } else {
    body = (
      <form onSubmit={sign} className="mt-6 space-y-6" noValidate>
        {team && (
          <p className="rounded-[var(--radius-control)] border border-dashed border-line-strong px-4 py-3 text-xs leading-relaxed text-ink-3">
            This is one of Sheaf&rsquo;s own house or test wallets. You can sign, but it won&rsquo;t be listed.
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
            <span className="mt-2 block text-xs leading-relaxed text-ink-3">
              {platform === "github"
                ? "Shown as self-reported until you prove it with a public gist, one step after signing."
                : "Shown as self-reported: anyone can type a handle, so the card says so."}
            </span>
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
            <button type="button" onClick={() => setRef(null)} className={quiet}>
              Leave it out
            </button>
          </p>
        )}

        <div>
          <button
            type="submit"
            disabled={!open || !fields || !canSign || busy != null}
            className="w-full rounded-[var(--radius-control)] bg-bind px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:cursor-not-allowed disabled:bg-sunk disabled:text-ink-3"
          >
            {busy === "signing" ? "Waiting for your wallet…" : busy === "sending" ? "Checking the signature and the chain…" : "Sign with your wallet"}
          </button>
          {!canSign && <p className="mt-2 text-xs text-loss">This wallet can&rsquo;t sign messages. Phantom, Solflare, Backpack, MetaMask and Rabby can.</p>}
          <p className="mt-3 text-xs leading-relaxed text-ink-3">
            {walletKind === "browser"
              ? "You're on the in-browser wallet, so the message says so and your card will too."
              : "Your wallet shows the exact text before you sign it."}{" "}
            Names are listed once the wallet has done something on Sheaf. Not sure what to try first?{" "}
            <Link href="/explore" className={quiet}>
              Buy a basket
            </Link>{" "}
            or{" "}
            <Link href="/plans" className={quiet}>
              open a plan
            </Link>{" "}
            with free test dollars.
          </p>
          {mine && (
            <button type="button" onClick={() => setEditing(false)} className="mt-3 text-xs text-ink-3 underline decoration-line-strong underline-offset-2">
              Keep what I signed
            </button>
          )}
        </div>
        {errorLine}
      </form>
    );
  }

  return (
    <div className="min-w-0 rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="display text-3xl text-ink">Sign your name</h3>
        <p className="text-xs text-ink-3">No transaction, no fee</p>
      </div>

      {!removed && (
        <div role="radiogroup" aria-label="Which wallet you used" className="mt-5 inline-flex rounded-[var(--radius-control)] border border-line bg-raised p-1 text-sm">
          {(
            [
              ["solana", "Solana"],
              ["evm", "EVM chains"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={chain === k}
              onClick={() => {
                setChain(k);
                setEditing(false);
                setError(null);
              }}
              className={`rounded-[8px] px-3.5 py-1.5 transition-colors ${chain === k ? "bg-surface text-ink shadow-[0_1px_2px_rgb(20_37_28/0.12)]" : "text-ink-2 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!open && (
        <p className="mt-6 rounded-[var(--radius-control)] border border-dashed border-line-strong px-4 py-3 text-sm leading-relaxed text-ink-2">
          Signing hasn&rsquo;t opened on this deployment yet. The form works the moment storage is switched on.
        </p>
      )}

      {body}

      <details className="group mt-8 border-t border-line pt-4" open>
        <summary className="cursor-pointer list-none text-xs text-ink-3 [&::-webkit-details-marker]:hidden">
          <span className="text-ink-2">What you sign</span> <span className="group-open:hidden">· show</span>
        </summary>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-vault p-4 font-mono text-[11px] leading-relaxed text-vault-ink">{preview}</pre>
      </details>
    </div>
  );
}
