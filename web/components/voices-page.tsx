"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLedger } from "@/lib/use-ledger";
import { useBaskets } from "@/lib/use-baskets";
import { count, plural, shortAddress } from "@/lib/format";
import { byActor, deedsOf, type Deed } from "@/lib/voices-activity";
import type { Voice, VoicesAnswer, VoiceStatus } from "@/lib/voices-message";
import { VoiceCard } from "@/components/voices-wall";
import { VoicesForm } from "@/components/voices-form";
import { VoicesChannels } from "@/components/voices-channels";

/**
 * /voices: people who tried Sheaf, each one a wallet's signature over their own
 * words. The list comes from /api/voices (rendered on the server first). A name
 * is listed only once its wallet has done something on Sheaf (a program event or
 * a swap on an official launch pool, found by the server and stored as `proof`);
 * signers without one are counted as waiting, never shown. Handles are
 * self-reported unless proven on GitHub. Card activity comes from /api/ledger.
 */

const link = "text-bind underline decoration-bind/40 underline-offset-4 hover:decoration-bind";
const quiet = "text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink";

const VERIFY_SNIPPET = `// npm i tweetnacl bs58
import nacl from "tweetnacl";
import bs58 from "bs58";

const { voices } = await (await fetch("https://sheaf.world/api/voices")).json();
for (const v of voices) {
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(v.message),
    bs58.decode(v.signature),
    bs58.decode(v.wallet),
  );
  console.log(ok ? "valid  " : "INVALID", v.wallet, v.handle, v.proof?.signature);
}`;

type Change = { voice: Voice; status: VoiceStatus } | { removed: string };

export function VoicesPage({ initial, showInvite = false }: { initial: VoicesAnswer; /** The invite-link builder, for whoever recruits testers: /voices?invite=1. */ showInvite?: boolean }) {
  const [answer, setAnswer] = useState<VoicesAnswer>(initial);
  const { ledger, decoding, error: ledgerError } = useLedger();
  const { baskets } = useBaskets();
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/voices", { cache: "no-store" });
      const j = (await r.json()) as VoicesAnswer;
      if (Array.isArray(j.voices)) setAnswer(j);
    } catch {
      /* keep what is shown */
    }
  }, []);

  /**
   * The signer sees their own change at once. The list from the server can lag
   * by up to half a minute (edge and instance caches), so it is merged, not trusted blindly.
   */
  const [local, setLocal] = useState<Change | null>(null);
  const applyChange = useCallback(
    (c: Change) => {
      setLocal(c);
      void refresh();
    },
    [refresh],
  );
  const shown: VoicesAnswer = useMemo(() => {
    if (!local) return answer;
    if ("removed" in local) return { ...answer, voices: answer.voices.filter((v) => v.wallet !== local.removed) };
    const rest = answer.voices.filter((v) => v.wallet !== local.voice.wallet);
    if (local.status === "listed") return { ...answer, voices: [local.voice, ...rest] };
    return { ...answer, voices: rest };
  }, [answer, local]);

  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const symbols = useMemo(() => new Map((baskets ?? []).map((b) => [b.address, b.symbol])), [baskets]);
  const deeds = useMemo(() => {
    const m = new Map<string, Deed[]>();
    if (!ledger) return m;
    const grouped = byActor(ledger.entries);
    const created = new Map(ledger.entries.filter((e) => e.kind === "created" && e.symbol).map((e) => [e.basket, e.symbol!]));
    const symbolOf = (b: string) => symbols.get(b) ?? created.get(b) ?? shortAddress(b);
    for (const v of shown.voices) m.set(v.wallet, deedsOf(grouped.get(v.wallet) ?? [], symbolOf));
    return m;
  }, [ledger, shown.voices, symbols]);
  const ledgerReady = !!ledger && !decoding;

  const n = shown.voices.length;
  const viaBrowser = shown.voices.filter((v) => v.walletKind === "browser").length;
  const onGithub = shown.voices.filter((v) => v.github).length;
  const waiting = shown.waiting ?? 0;
  const waitingLine =
    waiting > 0
      ? `${count(waiting)} more ${waiting === 1 ? "person has" : "people have"} signed and ${waiting === 1 ? "is" : "are"} waiting for a first action on Sheaf. Names without one are counted here, never shown.`
      : null;

  // ------------------------------------------------------------ wall
  const wall = (
    <section id="wall" aria-labelledby="wall-title" className={`scroll-mt-24 border-t border-line ${n === 0 ? "mt-24 pt-16" : "pt-14"}`}>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h2 id="wall-title" className="display text-title text-ink">
            Names, and what each wallet did
          </h2>
          <p className="mt-3 max-w-[66ch] text-sm leading-relaxed text-ink-2">
            A name is listed only after its wallet has done something on Sheaf: a program event, or a swap on an official launch
            pool. The handle is what the person typed, so it says <span className="text-ink">self-reported</span> unless it was
            proven on GitHub. Open <span className="text-ink">Verify</span> on any card to check the signature in your browser.
          </p>
        </div>
        {ledger?.truncated && ledgerReady && <p className="text-xs text-ink-3">Card activity from the ledger&rsquo;s newest transactions</p>}
        {ledgerError && !ledger && <p className="text-xs text-loss">Couldn&rsquo;t read the ledger, so card activity is missing for now.</p>}
      </div>

      {n === 0 && shown.open && shown.message ? (
        <p className="mt-8 rounded-[var(--radius-panel)] border border-dashed border-line-strong/70 px-6 py-10 text-sm text-ink-2">
          Couldn&rsquo;t read the list just now. Reload in a minute; the raw list is at{" "}
          <a href="/api/voices" className={quiet}>
            /api/voices
          </a>
          .
        </p>
      ) : n === 0 ? (
        <div className="mt-8 rounded-[var(--radius-panel)] border border-dashed border-line-strong/70 px-6 py-12 sm:px-10">
          <p className="display text-2xl text-ink">First names will appear here.</p>
          <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-ink-2">
            Each will be a wallet&rsquo;s own signature, next to what that wallet did on the chain.
            {waitingLine ? ` ${waitingLine}` : ""}
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {shown.voices.map((v, i) => (
              <VoiceCard
                key={v.wallet}
                voice={v}
                deeds={deeds.get(v.wallet)}
                ledger={ledgerReady ? "ready" : !ledger && ledgerError ? "failed" : "loading"}
                index={i}
              />
            ))}
          </ul>
          {waitingLine && <p className="mt-5 text-xs leading-relaxed text-ink-3">{waitingLine}</p>}
        </>
      )}
    </section>
  );

  // ------------------------------------------------------------ sign
  const sign = (
    <section id="sign" aria-labelledby="sign-title" className={`scroll-mt-24 border-t border-line pt-16 ${n === 0 ? "" : "mt-24"}`}>
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <h2 id="sign-title" className="display text-title max-w-[16ch] text-ink">
            Tried it? Put your name to it.
          </h2>
          <p className="mt-5 max-w-[48ch] text-base leading-relaxed text-ink-2">
            It takes a minute, costs nothing, and you can take it down any time with the same wallet.
          </p>
          <ol className="mt-8 space-y-5">
            {[
              {
                t: "Use Sheaf for something real",
                d: (
                  <>
                    <Link href="/explore" className={quiet}>
                      Buy a basket
                    </Link>
                    ,{" "}
                    <Link href="/plans" className={quiet}>
                      open a plan
                    </Link>
                    ,{" "}
                    <Link href="/compose" className={quiet}>
                      make your own
                    </Link>{" "}
                    or swap on a basket&rsquo;s launch. It&rsquo;s devnet: the faucet gives you test dollars and stocks for free.
                  </>
                ),
              },
              { t: "Connect that same wallet here", d: "Your name is listed once that wallet has done something on Sheaf, and the card shows what." },
              { t: "Sign one plain message", d: "Your handle, an optional line, and today’s date. A signature, not a transaction: nothing moves and there is no fee." },
            ].map((s, i) => (
              <li key={s.t} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
                <span className="display tnum grid size-8 place-items-center rounded-full border border-line-strong text-sm text-ink-2">{i + 1}</span>
                <div>
                  <p className="text-sm font-medium text-ink">{s.t}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-2">{s.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <VoicesForm open={shown.open} onChange={applyChange} />
      </div>
    </section>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-5 pb-28 sm:px-8">
      {/* ------------------------------------------------------------ hero */}
      <section className="grid gap-12 pt-16 pb-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end lg:gap-16">
        <div>
          <p className="rise text-sm text-ink-3" style={{ ["--i" as string]: 0 }}>
            Proof of people
          </p>
          <h1 className="rise display mt-4 text-hero text-ink" style={{ ["--i" as string]: 1 }}>
            People who tried Sheaf
          </h1>
          <p className="rise mt-6 max-w-[54ch] text-lg leading-relaxed text-ink-2" style={{ ["--i" as string]: 2 }}>
            Every name here signed with the wallet that used Sheaf, so you can check it. We don&rsquo;t add names.
          </p>
          <p className="rise mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" style={{ ["--i" as string]: 3 }}>
            <a href="#check" className={link}>
              Check a name yourself
            </a>
            {showInvite && (
              <a href="#channels" className={link}>
                Make an invite link
              </a>
            )}
          </p>
        </div>

        <div className="rise rounded-[var(--radius-panel)] border border-line bg-surface p-6 sm:p-8" style={{ ["--i" as string]: 2 }}>
          {n > 0 ? (
            <>
              <p className="display tnum text-[clamp(4rem,9vw,7rem)] leading-none text-ink">{count(n)}</p>
              <p className="mt-3 text-base text-ink-2">
                {n === 1 ? "person who used Sheaf has signed their name" : "people who used Sheaf have signed their names"}
              </p>
              <dl className="tnum mt-7 grid grid-cols-2 gap-4 border-t border-line pt-5 text-sm">
                <div>
                  <dt className="text-xs text-ink-3">Of which on the in-browser wallet</dt>
                  <dd className="display mt-1 text-xl text-ink">{count(viaBrowser)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Handles proven on GitHub</dt>
                  <dd className="display mt-1 text-xl text-ink">{count(onGithub)}</dd>
                </div>
              </dl>
              {waiting > 0 && (
                <p className="mt-4 text-xs leading-relaxed text-ink-3">
                  Plus {count(waiting)} signed and waiting for a first action, not counted.
                </p>
              )}
              {/* The page's one call to action. */}
              <a href="#sign" className="mt-6 inline-flex rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep">
                Add your name
              </a>
            </>
          ) : (
            <>
              <p className="display text-3xl leading-tight text-ink">Signed names, checkable by anyone.</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">
                One signature from the wallet ties a name to what that wallet did on Sheaf; Verify on each card checks it in your browser.
                {waiting > 0 ? ` ${count(waiting)} ${plural(waiting, "person")} signed and ${waiting === 1 ? "is" : "are"} waiting for a first action.` : ""}
              </p>
              <a href="#sign" className="mt-6 inline-flex rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep">
                Add your name
              </a>
            </>
          )}
          {shown.open && shown.message && <p className="mt-5 text-xs text-loss">{shown.message} The count may be behind.</p>}
          {!shown.open && <p className="mt-5 text-xs leading-relaxed text-ink-3">Signing hasn&rsquo;t opened on this deployment yet.</p>}
        </div>
      </section>

      {/* With nobody listed yet, the steps and the form lead and the empty wall sits below them. */}
      {n === 0 ? (
        <>
          {sign}
          {wall}
        </>
      ) : (
        <>
          {wall}
          {sign}
        </>
      )}

      {/* ------------------------------------------------------------ check */}
      <section id="check" aria-labelledby="check-title" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <h2 id="check-title" className="display text-title max-w-[20ch] text-ink">
          Check any name yourself
        </h2>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          A Solana address is an ed25519 public key, and an EVM address is recovered from an EIP-191 signature, so a signature over
          the message proves the wallet&rsquo;s owner wrote it. The wallet&rsquo;s activity is on the chain for anyone to read. What a
          signature can&rsquo;t prove is who owns an X or Telegram handle; those stay self-reported.
        </p>
        <div className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-3">
          <div className="bg-surface p-6">
            <p className="display tnum text-sm text-ink-3">1</p>
            <p className="mt-2 text-base font-medium text-ink">Read the raw list</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Every listed entry, with its message, signature and first on-chain action, as JSON at{" "}
              <a href="/api/voices" target="_blank" className={quiet}>
                /api/voices
              </a>
              . The page shows exactly that.
            </p>
          </div>
          <div className="bg-surface p-6">
            <p className="display tnum text-sm text-ink-3">2</p>
            <p className="mt-2 text-base font-medium text-ink">Verify each signature</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              In your browser with <span className="text-ink">Verify</span> on a card, or anywhere with the script below. The
              message names the wallet, how it was made, the handle and the date, so it can&rsquo;t be moved to another name.
            </p>
          </div>
          <div className="bg-surface p-6">
            <p className="display tnum text-sm text-ink-3">3</p>
            <p className="mt-2 text-base font-medium text-ink">Match the wallet to the chain</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Each card links its wallet and its first action to that chain&rsquo;s explorer: Solana Explorer, or the EVM testnet&rsquo;s own. The{" "}
              <Link href="/ledger" className={quiet}>
                ledger
              </Link>{" "}
              lists every event the program has written.
            </p>
          </div>
        </div>
        <div className="mt-6 overflow-hidden rounded-[var(--radius-panel)] bg-vault">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
            <p className="text-xs text-vault-ink/70">verify.mjs</p>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(VERIFY_SNIPPET).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                })
              }
              className="text-xs text-vault-ink/80 transition-colors hover:text-vault-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="overflow-auto p-5 font-mono text-xs leading-relaxed text-vault-ink">{VERIFY_SNIPPET}</pre>
        </div>

        <div className="mt-14 grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="text-base font-medium text-ink">What we keep</h3>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
              <li>The wallet address, the handle you typed, your line if you wrote one, the invite code if you came through one, and the date.</li>
              <li>The exact message you signed and the signature, the transaction of your wallet&rsquo;s first Sheaf action, and the gist if you proved a GitHub handle.</li>
              <li>One entry per wallet. Signing again replaces it; signing a removal takes it down.</li>
            </ul>
          </div>
          <div>
            <h3 className="text-base font-medium text-ink">What we don&rsquo;t</h3>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
              <li>No IP address, email, user agent or cookie. Rate limits hold addresses in memory for minutes, never on disk.</li>
              <li>Your browser remembers only the invite code it arrived with, for 30 days, so it can go with your signature.</li>
              <li>Quotes are plain text: no links, no formatting. Only the handle links, to its own profile.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ channels: a recruiting tool, shown at /voices?invite=1 */}
      {showInvite && (
      <section id="channels" aria-labelledby="channels-title" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <h2 id="channels-title" className="display text-title max-w-[20ch] text-ink">
          Where people came from
        </h2>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Each invite link carries a short code in its address. When someone signs after arriving through it, the code goes into the
          message they sign, so the signed count per channel is checkable too.
        </p>
        <div className="mt-10">
          <VoicesChannels refs={shown.refs} open={shown.open} />
        </div>
      </section>
      )}
    </div>
  );
}
