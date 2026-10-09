import "server-only";
import { randomBytes } from "node:crypto";
import { isTeamWallet } from "./team-wallets";
import { listNames, readJson, voicesConfigured, writeJson, Conflict, type Tombstone } from "./voices-gcs";
import { getAddress } from "viem";
import { findProof } from "./voices-proof";
import { findEvmProof } from "./voices-evm";
import type { Voice, VoicesAnswer, VoiceStatus } from "./voices-message";

/**
 * Where /voices keeps what people signed, in the project's private bucket:
 *
 *   voices/v/<wallet>.json                     one signed entry per wallet (or a tombstone once taken down)
 *   invites/o/<ref>/<day>-<ts>-<rand>.json     one per invite-link open, empty; counted from the names alone
 *
 * Nothing about a person is kept beyond what they typed into the message they
 * signed: no IP address, no user agent, no email. The team's own wallets are
 * stored like anyone's but never listed, only counted, and which wallets are ours
 * is decided when the list is read, so adding a wallet to lib/team-wallets.ts
 * moves its entry to the "ours" count at once.
 *
 * An entry is listed only once its wallet has done something on Sheaf (a program
 * event or a swap on an official launch pool, lib/voices-proof.ts). Until then it
 * is counted as "signed, waiting for a first action" and its handle is not shown.
 */

const VOICES = "voices/v/";
const OPENS = "invites/o/";
const TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;

export { voicesConfigured };

export class StaleSignature extends Error {}
export class NotListed extends Error {}

type Stored = Voice | Tombstone;
const isTomb = (s: Stored): s is Tombstone => (s as Tombstone).removed === true;

/** EVM addresses are stored lower-case so one address has one entry whatever its checksum casing. */
const nameFor = (wallet: string) => `${VOICES}${wallet.startsWith("0x") ? wallet.toLowerCase() : wallet}.json`;

let all: { voices: Voice[]; at: number } | null = null;
let opens: { byRef: Map<string, number>; at: number } | null = null;

/** Every live signed entry, newest first; read at most every 30 s per instance. */
async function allVoices(): Promise<Voice[]> {
  if (all && Date.now() - all.at < TTL_MS) return all.voices;
  const names = (await listNames(VOICES, MAX_ENTRIES)).filter((n) => n.endsWith(".json"));
  const out: Voice[] = [];
  for (let i = 0; i < names.length; i += 16) {
    const got = await Promise.all(names.slice(i, i + 16).map((n) => readJson<Stored>(n).catch(() => null)));
    for (const g of got) if (g && !isTomb(g.data) && typeof g.data.wallet === "string") out.push(g.data);
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  all = { voices: out, at: Date.now() };
  return out;
}

async function opensByRef(): Promise<Map<string, number>> {
  if (opens && Date.now() - opens.at < TTL_MS) return opens.byRef;
  const byRef = new Map<string, number>();
  for (const n of await listNames(OPENS)) {
    const ref = n.slice(OPENS.length).split("/")[0];
    if (ref) byRef.set(ref, (byRef.get(ref) ?? 0) + 1);
  }
  opens = { byRef, at: Date.now() };
  return byRef;
}

export function statusOf(v: Voice): VoiceStatus {
  return isTeamWallet(v.wallet) ? "team" : v.proof ? "listed" : "waiting";
}

/** What the page shows: listed entries, how many wait for a first action, the team's count, and each invite code. */
export async function voicesAnswer(): Promise<VoicesAnswer> {
  const [voices, byRef] = await Promise.all([allVoices(), opensByRef().catch(() => new Map<string, number>())]);
  const listed = voices.filter((v) => statusOf(v) === "listed");
  const waiting = voices.filter((v) => statusOf(v) === "waiting").length;
  const ours = voices.filter((v) => statusOf(v) === "team").length;
  const signed = new Map<string, number>();
  for (const v of listed) if (v.ref) signed.set(v.ref, (signed.get(v.ref) ?? 0) + 1);
  const refs = [...new Set([...byRef.keys(), ...signed.keys()])]
    .map((ref) => ({ ref, opens: byRef.get(ref) ?? 0, signed: signed.get(ref) ?? 0 }))
    .sort((a, b) => b.signed - a.signed || b.opens - a.opens || a.ref.localeCompare(b.ref));
  return { open: true, voices: listed, waiting, ours, refs, asOf: Date.now() };
}

/** One wallet's live entry, or null. */
export async function getVoice(wallet: string): Promise<Voice | null> {
  const got = await readJson<Stored>(nameFor(wallet));
  return got && !isTomb(got.data) ? got.data : null;
}

/** Read-modify-write of a live entry, safe against a concurrent write. Returns the stored entry, or null if none. */
export async function updateVoice(wallet: string, change: (v: Voice) => Voice): Promise<Voice | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await readJson<Stored>(nameFor(wallet));
    if (!got || isTomb(got.data)) return null;
    const next = change(got.data);
    try {
      await writeJson(nameFor(wallet), next, got.generation);
      all = null;
      return next;
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
    }
  }
  throw new Error("Voices write kept colliding");
}

/** Least often: a waiting wallet is read again at most every ten minutes. */
const RECHECK_MS = 10 * 60_000;

/** Reads the chain for a waiting entry's first action and stores it if found. */
export async function recheck(wallet: string, opts: { force?: boolean } = {}): Promise<Voice | null> {
  const v = await getVoice(wallet);
  if (!v || v.proof) return v;
  const since = v.checkedAt ? Date.now() - Date.parse(v.checkedAt) : Infinity;
  if (!opts.force && since < RECHECK_MS) return v;
  if (since < 30_000) return v;
  const proof = await (wallet.startsWith("0x") ? findEvmProof(getAddress(wallet)) : findProof(wallet)).catch(() => undefined);
  if (proof === undefined) return v; // the chain didn't answer; try again later
  return updateVoice(wallet, (cur) => ({ ...cur, proof: cur.proof ?? proof, checkedAt: new Date().toISOString() }));
}

/** A few waiting entries due for another look, read after a response has gone out. */
export async function recheckWaiting(max = 2): Promise<void> {
  const due = (await allVoices())
    .filter((v) => statusOf(v) === "waiting" && (!v.checkedAt || Date.now() - Date.parse(v.checkedAt) >= RECHECK_MS))
    .slice(0, max);
  for (const v of due) await recheck(v.wallet).catch(() => {});
}

/**
 * Stores a verified entry, replacing the wallet's earlier one. A signature dated
 * before the stored one (or on or before the day the entry was taken down) is
 * refused, so an old signature can't be replayed to undo a newer choice.
 */
export async function saveVoice(voice: Voice): Promise<Voice> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readJson<Stored>(nameFor(voice.wallet));
    if (existing) {
      const d = existing.data;
      if (isTomb(d) ? voice.date <= d.date : voice.date < d.date) throw new StaleSignature();
    }
    // The wallet's proof of use carries over (it is the same wallet); a GitHub proof doesn't, because the message changed.
    const prior = existing && !isTomb(existing.data) ? existing.data : null;
    const next: Voice = { ...voice, proof: prior?.proof ?? voice.proof, checkedAt: prior?.checkedAt, github: null };
    try {
      await writeJson(nameFor(voice.wallet), next, existing?.generation ?? "0");
      all = null;
      return next;
    } catch (err) {
      if (!(err instanceof Conflict)) throw err;
    }
  }
  throw new Error("Voices write kept colliding");
}

/** Takes a wallet's entry down, after its signed request to. */
export async function removeVoice(wallet: string, date: string): Promise<void> {
  const existing = await readJson<Stored>(nameFor(wallet));
  if (!existing || isTomb(existing.data)) throw new NotListed();
  if (date < existing.data.date) throw new StaleSignature();
  const tomb: Tombstone = { removed: true, date, at: new Date().toISOString() };
  await writeJson(nameFor(wallet), tomb, existing.generation);
  all = null;
}

/** Counts one open of an invite link. The object is empty; its name is the whole record. */
export async function recordOpen(ref: string): Promise<void> {
  const now = new Date();
  const name = `${OPENS}${ref}/${now.toISOString().slice(0, 10)}-${now.getTime()}-${randomBytes(4).toString("hex")}.json`;
  await writeJson(name, {}, "0");
  if (opens) opens.byRef.set(ref, (opens.byRef.get(ref) ?? 0) + 1);
}
