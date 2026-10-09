"use client";

import { useState } from "react";
import { count } from "@/lib/format";
import { cleanRef, inviteLink, INVITE_TARGETS, type InviteCount, type InviteTarget } from "@/lib/invite-ref";

/**
 * Where people came from: each invite code, how many times its link was opened,
 * and how many people who came with it signed. Plus a box to make a new link.
 */

const TARGET_LABEL: Record<InviteTarget, string> = {
  "/voices": "this page",
  "/": "home",
  "/plans": "plans",
  "/explore": "baskets",
  "/compose": "make a basket",
  "/ledger": "the ledger",
  "/portfolio": "portfolio",
};

function InviteMaker() {
  const [raw, setRaw] = useState("");
  const [to, setTo] = useState<InviteTarget>("/voices");
  const [copied, setCopied] = useState(false);
  const ref = cleanRef(raw);
  const link = ref ? inviteLink(typeof window === "undefined" ? "" : window.location.origin, ref, to) : null;
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5 sm:p-6">
      <p className="text-sm font-medium text-ink">Make an invite link</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        Name the channel you&rsquo;re posting in, or use your own handle. The link counts an open and lands with the code in the address; nothing else is tracked.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="block">
          <span className="sr-only">Invite code</span>
          <input
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="telegram-solana-devs"
            maxLength={44}
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-bind"
          />
        </label>
        <label className="block">
          <span className="sr-only">Lands on</span>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value as InviteTarget)}
            className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2.5 text-sm text-ink-2 outline-none focus:border-bind"
          >
            {INVITE_TARGETS.map((t) => (
              <option key={t} value={t}>
                lands on {TARGET_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {raw.trim() && !ref && <p className="mt-2 text-xs text-loss">Letters, digits, dots, dashes and underscores, up to 44.</p>}
      {link && (
        <div className="mt-3 flex gap-2">
          <code className="min-w-0 flex-1 truncate rounded-[var(--radius-control)] bg-raised px-3 py-2.5 text-xs text-ink-2">{link}</code>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              })
            }
            className="shrink-0 rounded-[var(--radius-control)] bg-bind px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-bind-deep"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}

export function VoicesChannels({ refs, open }: { refs: InviteCount[]; open: boolean }) {
  const max = Math.max(1, ...refs.map((r) => r.opens));
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:gap-12">
      <div>
        {refs.length === 0 ? (
          <p className="rounded-[var(--radius-panel)] border border-dashed border-line-strong/70 px-6 py-10 text-sm leading-relaxed text-ink-2">
            {open
              ? "Make an invite link on the right and post it somewhere; each channel shows up here with its opens and signatures."
              : "Channels show up here once signing opens."}
          </p>
        ) : (
          <table className="tnum w-full overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-3">
                <th className="px-4 py-3 font-normal sm:px-5">Invite code</th>
                <th className="px-4 py-3 font-normal">Opened</th>
                <th className="px-4 py-3 text-right font-normal sm:px-5">Signed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {refs.map((r) => (
                <tr key={r.ref}>
                  <td className="max-w-[14rem] truncate px-4 py-3 text-ink sm:px-5">{r.ref}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3">
                      <span className="w-8 text-ink-2">{count(r.opens)}</span>
                      <span aria-hidden className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-sunk sm:block">
                        <span className="block h-full rounded-full bg-bind/70" style={{ width: `${(r.opens / max) * 100}%` }} />
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-ink sm:px-5">{count(r.signed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 max-w-[70ch] text-xs leading-relaxed text-ink-3">
          An open is counted once per address per code per hour, and link previews from chat apps aren&rsquo;t counted. Team wallets never count as signed.
        </p>
      </div>
      <InviteMaker />
    </div>
  );
}
