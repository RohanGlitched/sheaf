import "server-only";
import { randomBytes } from "node:crypto";
import { isTeamWallet } from "./team-wallets";
import { listNames, readJson, voicesConfigured, writeJson, Conflict, type Tombstone } from "./voices-gcs";
import type { Voice, VoicesAnswer } from "./voices-message";

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

const nameFor = (wallet: string) => `${VOICES}${wallet}.json`;

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

/** What the page shows: outside entries, the team's count, and each invite code's opens and signatures. */
export async function voicesAnswer(): Promise<VoicesAnswer> {
  const [voices, byRef] = await Promise.all([allVoices(), opensByRef().catch(() => new Map<string, number>())]);
  const outside = voices.filter((v) => !isTeamWallet(v.wallet));
  const signed = new Map<string, number>();
  for (const v of outside) if (v.ref) signed.set(v.ref, (signed.get(v.ref) ?? 0) + 1);
  const refs = [...new Set([...byRef.keys(), ...signed.keys()])]
    .map((ref) => ({ ref, opens: byRef.get(ref) ?? 0, signed: signed.get(ref) ?? 0 }))
    .sort((a, b) => b.signed - a.signed || b.opens - a.opens || a.ref.localeCompare(b.ref));
  return { open: true, voices: outside, ours: voices.length - outside.length, refs, asOf: Date.now() };
}

/**
 * Stores a verified entry, replacing the wallet's earlier one. A signature dated
 * before the stored one (or on or before the day the entry was taken down) is
 * refused, so an old signature can't be replayed to undo a newer choice.
 */
export async function saveVoice(voice: Voice): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readJson<Stored>(nameFor(voice.wallet));
    if (existing) {
      const d = existing.data;
      if (isTomb(d) ? voice.date <= d.date : voice.date < d.date) throw new StaleSignature();
    }
    try {
      await writeJson(nameFor(voice.wallet), voice, existing?.generation ?? "0");
      all = null;
      return;
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
