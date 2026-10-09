"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useLedger } from "@/lib/use-ledger";
import { useBaskets } from "@/lib/use-baskets";
import { count, plural, shortAddress } from "@/lib/format";
import { TEAM_WALLET_COUNT } from "@/lib/team-wallets";
import { byActor, deedsOf, type Deed } from "@/lib/voices-activity";
import type { Voice, VoicesAnswer } from "@/lib/voices-message";
import { VoiceCard } from "@/components/voices-wall";
import { VoicesForm } from "@/components/voices-form";
import { VoicesChannels } from "@/components/voices-channels";

/**
 * /voices: people who tried Sheaf, each one a wallet's signature over their own
 * words. The list comes from /api/voices (rendered on the server first), and
 * what each wallet did comes from the program's own events on /api/ledger.
 */

const link = "text-bind underline decoration-bind/40 underline-offset-4 hover:decoration-bind";
const quiet = "text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink";

const VERIFY_SNIPPET = `// npm i tweetnacl bs58
import nacl from "tweetnacl";
import bs58 from "bs58";

const { voices } = await (await fetch("https://sheaf-index.vercel.app/api/voices")).json();
for (const v of voices) {
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(v.message),
    bs58.decode(v.signature),
    bs58.decode(v.wallet),
  );
  console.log(ok ? "valid  " : "INVALID", v.wallet, v.handle);
}`;

export function VoicesPage({ initial }: { initial: VoicesAnswer }) {
  const [answer, setAnswer] = useState<VoicesAnswer>(initial);
  const { publicKey } = useWallet();
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
  const [local, setLocal] = useState<{ voice?: Voice; team?: boolean; removed?: string } | null>(null);
  const applyChange = useCallback(
    (c: { voice: Voice; team: boolean } | { removed: string }) => {
      setLocal(c);
      void refresh();
    },
    [refresh],
  );
  const shown: VoicesAnswer = useMemo(() => {
    if (!local) return answer;
    if (local.removed) return { ...answer, voices: answer.voices.filter((v) => v.wallet !== local.removed) };
    if (local.voice && !local.team) {
      const rest = answer.voices.filter((v) => v.wallet !== local.voice!.wallet);
      return { ...answer, voices: [local.voice, ...rest] };
    }
    return answer;
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
  const active = shown.voices.filter((v) => (deeds.get(v.wallet)?.length ?? 0) > 0).length;
  const opens = shown.refs.reduce((a, r) => a + r.opens, 0);

  const wallet = publicKey?.toBase58() ?? null;
  const mine: Voice | null = wallet ? (shown.voices.find((v) => v.wallet === wallet) ?? null) : null;
  const n = shown.voices.length;

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
            Every name here signed with the wallet that used Sheaf, so you can check it. We don&rsquo;t add names, and our
            own wallets are counted apart, never listed.
          </p>
          <p className="rise mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" style={{ ["--i" as string]: 3 }}>
            <a href="#sign" className={link}>
              Add your name
            </a>
            <a href="#check" className={link}>
              Check a name yourself
            </a>
            <a href="#channels" className={link}>
              Where people came from
            </a>
          </p>
        </div>

        <div className="rise rounded-[var(--radius-panel)] border border-line bg-surface p-6 sm:p-8" style={{ ["--i" as string]: 2 }}>
          <p className="display tnum text-[clamp(4rem,9vw,7rem)] leading-none text-ink">{count(n)}</p>
          <p className="mt-3 text-base text-ink-2">
            {n === 1 ? "person who isn’t us has signed in" : "people who aren’t us have signed in"}
          </p>
          <dl className="tnum mt-7 grid grid-cols-3 gap-4 border-t border-line pt-5 text-sm">
            <div>
              <dt className="text-xs text-ink-3">With activity on the ledger</dt>
              <dd className="display mt-1 text-xl text-ink">{ledgerReady ? count(active) : "…"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Invite links opened</dt>
              <dd className="display mt-1 text-xl text-ink">{count(opens)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Ours, not counted</dt>
              <dd className="display mt-1 text-xl text-ink-3">{count(shown.ours)}</dd>
            </div>
          </dl>
          {shown.open && shown.message && <p className="mt-5 text-xs text-loss">{shown.message} The count may be behind.</p>}
          {!shown.open && <p className="mt-5 text-xs leading-relaxed text-ink-3">Signing hasn&rsquo;t opened on this deployment yet, so the count is zero by construction.</p>}
        </div>
      </section>

      {/* ------------------------------------------------------------ wall */}
      <section id="wall" aria-labelledby="wall-title" className="scroll-mt-24 border-t border-line pt-14">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 id="wall-title" className="display text-title text-ink">
              Names, and what each wallet did
            </h2>
            <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
              The handle is what the person typed; the activity is read from the Sheaf program&rsquo;s own events for that wallet; the
              signature ties the two together. Open <span className="text-ink">Verify</span> on any card to check it in your browser.
            </p>
          </div>
          {ledger?.truncated && ledgerReady && <p className="text-xs text-ink-3">Activity from the ledger&rsquo;s newest 300 transactions</p>}
          {ledgerError && !ledger && <p className="text-xs text-loss">Couldn&rsquo;t read the ledger, so activity is missing for now.</p>}
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
          <div className="mt-8 grid gap-6 rounded-[var(--radius-panel)] border border-dashed border-line-strong/70 px-6 py-12 sm:px-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div>
              <p className="display text-2xl text-ink">Nobody outside the team has signed yet.</p>
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
                The first name here will be the first person who tried Sheaf and said so with their own wallet. We would rather show
                zero than fill this with our own test wallets{shown.ours > 0 ? `, which have signed ${count(shown.ours)} ${plural(shown.ours, "time")} and are counted apart` : ""}.
              </p>
            </div>
            <a href="#sign" className="justify-self-start rounded-[var(--radius-control)] bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep">
              Be the first
            </a>
          </div>
        ) : (
          <ul className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {shown.voices.map((v, i) => (
              <VoiceCard key={v.wallet} voice={v} deeds={deeds.get(v.wallet)} ledger={ledgerReady ? "ready" : !ledger && ledgerError ? "failed" : "loading"} index={i} />
            ))}
          </ul>
        )}
      </section>

      {/* ------------------------------------------------------------ sign */}
      <section id="sign" aria-labelledby="sign-title" className="mt-24 scroll-mt-24 border-t border-line pt-16">
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
                      </Link>{" "}
                      or{" "}
                      <Link href="/compose" className={quiet}>
                        make your own
                      </Link>
                      . It&rsquo;s devnet: the faucet gives you test dollars and stocks for free.
                    </>
                  ),
                },
                { t: "Connect that same wallet here", d: "Your card shows what the wallet did, read from the chain, so the one you used is the one that counts." },
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
          <VoicesForm open={shown.open} mine={mine} onChange={applyChange} />
        </div>
      </section>

      {/* ------------------------------------------------------------ check */}
      <section id="check" aria-labelledby="check-title" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <h2 id="check-title" className="display text-title max-w-[20ch] text-ink">
          Check any name yourself
        </h2>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Nothing here asks you to trust us. A Solana address is an ed25519 public key, so a signature over the message proves the
          wallet&rsquo;s owner wrote it. The wallet&rsquo;s activity is on the chain for anyone to read.
        </p>
        <div className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line lg:grid-cols-3">
          <div className="bg-surface p-6">
            <p className="display tnum text-sm text-ink-3">1</p>
            <p className="mt-2 text-base font-medium text-ink">Read the raw list</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Every entry, with its message and signature, as JSON at{" "}
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
              message names the wallet, the handle and the date, so it can&rsquo;t be moved to another name.
            </p>
          </div>
          <div className="bg-surface p-6">
            <p className="display tnum text-sm text-ink-3">3</p>
            <p className="mt-2 text-base font-medium text-ink">Match the wallet to the chain</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Each card&rsquo;s wallet and activity link to Solana Explorer. The{" "}
              <Link href="/ledger" className={quiet}>
                ledger
              </Link>{" "}
              lists every event the program has written, with our {count(TEAM_WALLET_COUNT)} wallets tagged.
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
              <li>The exact message you signed and the signature, so anyone can check them.</li>
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

      {/* ------------------------------------------------------------ channels */}
      <section id="channels" aria-labelledby="channels-title" className="mt-24 scroll-mt-24 border-t border-line pt-16">
        <h2 id="channels-title" className="display text-title max-w-[20ch] text-ink">
          Where people came from
        </h2>
        <p className="mt-4 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Each invite link carries a short code in its address. When someone signs after arriving through it, the code goes into the
          message they sign, so even this count is checkable.
        </p>
        <div className="mt-10">
          <VoicesChannels refs={shown.refs} open={shown.open} />
        </div>
      </section>
    </div>
  );
}
