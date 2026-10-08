/**
 * The ledger: every creation and redemption the program has ever settled.
 *
 * The program emits an event for each of its three instructions, and Solana
 * keeps those events in the transaction's log, so the whole history of every
 * basket can be rebuilt from the chain with no indexer and no database. This
 * module walks a program's or a basket's signatures, decodes the events out of
 * the logs, and hands them over newest first, a few at a time as they arrive.
 *
 * It runs in the browser on purpose. A public RPC endpoint rations
 * `getTransaction` per caller, and a visitor's own connection has that budget
 * to itself, where a server shared by every visitor does not. Decoded events
 * never change, so each one is kept in local storage, and the repository
 * carries a snapshot of everything decoded at the last release
 * (public/ledger.snapshot.json, written by scripts/snapshot-ledger.mjs), so a
 * first visit starts from there and only reads what landed since. Every row links
 * to its transaction, so the snapshot is a cache, never the source of truth.
 *
 * The event layouts are copied from target/idl/sheaf.json, which the program
 * itself emits; if the program changes, that file changes and so must this one.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID } from "./config";

const PROGRAM_ID = new PublicKey(SHEAF_PROGRAM_ID);

export type LedgerEntry = {
  signature: string;
  /** Unix seconds. */
  time: number;
  slot: number;
  kind: "created" | "minted" | "redeemed";
  basket: string;
  /** The creator, depositor or redeemer. */
  actor: string;
  /** Set on a creation. */
  name?: string;
  symbol?: string;
  componentCount?: number;
  /** Whole shares issued to the depositor, or burned by the redeemer. */
  shares?: number;
  /** Whole shares issued to the creator as the fee. */
  feeShares?: number;
  /** Raw units moved per component, in recipe order, as strings. */
  amounts?: string[];
};

export type Ledger = {
  entries: LedgerEntry[];
  /** Transactions decoded so far, and how many there are. */
  done: number;
  total: number;
  /** True when the address has more history than was asked for. */
  truncated: boolean;
};

const EVENT_CREATED = [26, 146, 108, 155, 189, 85, 8, 7];
const EVENT_MINTED = [127, 139, 238, 41, 118, 47, 122, 39];
const EVENT_REDEEMED = [232, 166, 7, 56, 67, 19, 42, 117];
const ONE_SHARE = 1_000_000;
const PREFIX = "Program data: ";
const STORE = "sheaf:ledger:v1";

class Reader {
  private offset = 8;
  private readonly data: Uint8Array;
  private readonly view: DataView;
  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8() {
    return this.data[this.offset++];
  }
  u64() {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  pubkey() {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32)).toBase58();
    this.offset += 32;
    return v;
  }
  string() {
    const len = this.view.getUint32(this.offset, true);
    this.offset += 4;
    const s = new TextDecoder().decode(this.data.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }
}

const matches = (data: Uint8Array, discriminator: number[]) =>
  discriminator.every((b, i) => data[i] === b);

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One `Program data` log line, as an event, or null if it is not one of ours. */
export function decodeEvent(
  data: Uint8Array,
): Omit<LedgerEntry, "signature" | "time" | "slot"> | null {
  try {
    const r = new Reader(data);
    if (matches(data, EVENT_CREATED)) {
      const basket = r.pubkey();
      const actor = r.pubkey();
      r.pubkey(); // share mint; the basket record carries it
      const name = r.string();
      const symbol = r.string();
      const componentCount = r.u8();
      return { kind: "created", basket, actor, name, symbol, componentCount };
    }
    if (matches(data, EVENT_MINTED)) {
      const basket = r.pubkey();
      const actor = r.pubkey();
      const shares = Number(r.u64()) / ONE_SHARE;
      const feeShares = Number(r.u64()) / ONE_SHARE;
      const amounts = Array.from({ length: 8 }, () => r.u64().toString());
      return { kind: "minted", basket, actor, shares, feeShares, amounts };
    }
    if (matches(data, EVENT_REDEEMED)) {
      const basket = r.pubkey();
      const actor = r.pubkey();
      const shares = Number(r.u64()) / ONE_SHARE;
      const amounts = Array.from({ length: 8 }, () => r.u64().toString());
      return { kind: "redeemed", basket, actor, shares, amounts };
    }
  } catch {
    // A log line that is not one of ours, or a truncated one. Skip it.
  }
  return null;
}

// --------------------------------------------------------------------- store

type Known = Record<string, LedgerEntry[]>;

let SNAPSHOT: Known = {};
let snapshotLoaded: Promise<void> | null = null;

/** The committed snapshot, fetched once per page load; nothing if it is missing. */
function loadSnapshot(): Promise<void> {
  if (!snapshotLoaded) {
    snapshotLoaded =
      typeof window === "undefined"
        ? Promise.resolve()
        : fetch("/ledger.snapshot.json")
            .then((res) => (res.ok ? res.json() : null))
            .then((json: { known?: Known } | null) => {
              SNAPSHOT = json?.known ?? {};
            })
            .catch(() => undefined);
  }
  return snapshotLoaded;
}

function loadKnown(seed?: Known): Known {
  let stored: Known = {};
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORE) : null;
    stored = raw ? (JSON.parse(raw) as Known) : {};
  } catch {
    stored = {};
  }
  return { ...SNAPSHOT, ...stored, ...(seed ?? {}) };
}

function saveKnown(known: Known) {
  try {
    if (typeof localStorage === "undefined") return;
    // Only what the snapshot does not already carry, to keep storage small.
    const fresh: Known = {};
    for (const [sig, entries] of Object.entries(known)) if (!SNAPSHOT[sig]) fresh[sig] = entries;
    localStorage.setItem(STORE, JSON.stringify(fresh));
  } catch {
    // Storage full or unavailable: the next visit decodes again, nothing is lost.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One transaction's events, with a backoff when the endpoint says slow down. */
async function fetchEvents(
  connection: Connection,
  info: { signature: string; slot: number; blockTime?: number | null },
): Promise<LedgerEntry[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await connection.getTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const entries: LedgerEntry[] = [];
      for (const line of tx?.meta?.logMessages ?? []) {
        if (!line.startsWith(PREFIX)) continue;
        const event = decodeEvent(fromBase64(line.slice(PREFIX.length)));
        if (!event) continue;
        entries.push({
          signature: info.signature,
          time: info.blockTime ?? tx?.blockTime ?? 0,
          slot: info.slot,
          ...event,
        });
      }
      return entries;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The public endpoint rations this call per address, and a visitor who
      // has just loaded a basket page has spent some of that ration already.
      // Wait it out, up to eight seconds a try, rather than give up on a row.
      if (attempt < 12 && /429|Too many requests/i.test(message)) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Read the history of the program, or of one basket, newest first.
 *
 * Every instruction names the basket account, so a basket's history is simply
 * the signatures of its own address. `onProgress` is called as transactions
 * decode, so a page can fill in from the top while the rest arrive.
 */
export async function readLedger(
  connection: Connection,
  options: {
    basket?: string;
    limit?: number;
    onProgress?: (ledger: Ledger) => void;
    signal?: AbortSignal;
    /** Already-decoded transactions to start from, for the snapshot script. */
    known?: Known;
  } = {},
): Promise<Ledger> {
  const limit = options.limit ?? 300;
  const address = options.basket ? new PublicKey(options.basket) : PROGRAM_ID;
  const [signatures] = await Promise.all([
    connection.getSignaturesForAddress(address, { limit }, "confirmed"),
    loadSnapshot(),
  ]);
  const ok = signatures.filter((s) => s.err == null);
  const known = loadKnown(options.known);

  const snapshot = (done: number): Ledger => ({
    entries: ok.flatMap((s) => known[s.signature] ?? []),
    done,
    total: ok.length,
    truncated: signatures.length >= limit,
  });

  const queue = ok.filter((s) => !known[s.signature]);
  let done = ok.length - queue.length;
  options.onProgress?.(snapshot(done));

  // Newest first, two at a time with a short gap, so the top of a list fills
  // in first and a public endpoint is never burst. What has been decoded is
  // saved as it arrives, so even an interrupted read is not repeated.
  const lane = async () => {
    for (let info = queue.shift(); info && !options.signal?.aborted; info = queue.shift()) {
      known[info.signature] = await fetchEvents(connection, info);
      done++;
      options.onProgress?.(snapshot(done));
      if (done % 5 === 0) saveKnown(known);
      await sleep(150);
    }
  };
  try {
    await Promise.all([lane(), lane()]);
  } finally {
    saveKnown(known);
  }
  return snapshot(done);
}
