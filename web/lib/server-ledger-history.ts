import "server-only";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, WRITE_CLUSTER } from "./config";
import { entriesOf, type LedgerEntry } from "./ledger";
import { GcsConflict, gcsConfigured, getJson, putJson } from "./gcs-store";

/**
 * The program's whole history, kept.
 *
 * A signature list is paged newest first, so a window of the last N transactions
 * loses the oldest ones as soon as a busy plan runs. This keeps every successful
 * transaction the program has ever had: it pages back with `before` until the
 * program's first transaction, forward with `until` for whatever landed since,
 * decodes each transaction once, and stores the result in the project's bucket
 * (ledger/<cluster>-<program>.json) so a fresh instance starts from it. Without a
 * bucket the same history is built in memory.
 *
 * Several instances may sync at once: writes are conditional on the generation
 * read, and a lost race reloads, merges and writes again.
 */

type Row = Omit<LedgerEntry, "signature" | "time" | "slot">;
type Sig = { s: string; slot: number; t: number | null };

type History = {
  v: 1;
  program: string;
  /** Successful signatures, newest first. */
  sigs: Sig[];
  /** Decoded rows per signature; a signature missing here is still to be read. */
  rows: Record<string, Row[]>;
  /** The newest and oldest signatures seen (failed ones included), the paging cursors. */
  newest: Sig | null;
  oldest: Sig | null;
  /** True once paging back has reached the program's first transaction. */
  complete: boolean;
  updatedAt: number;
};

const OBJECT = `ledger/${WRITE_CLUSTER}-${SHEAF_PROGRAM_ID}.json`;
const PAGE = 1000;
/** Transactions per JSON-RPC batch, and batches in flight. */
const BATCH = 25;
const LANES = 3;

const empty = (): History => ({ v: 1, program: SHEAF_PROGRAM_ID, sigs: [], rows: {}, newest: null, oldest: null, complete: false, updatedAt: 0 });

let history: History = empty();
let generation: string | null = null;
let loaded = false;
let syncing: Promise<History> | null = null;

const sig = (i: ConfirmedSignatureInfo): Sig => ({ s: i.signature, slot: i.slot, t: i.blockTime ?? null });

function merge(a: History, b: History): History {
  const bySig = new Map<string, Sig>();
  for (const x of [...a.sigs, ...b.sigs]) bySig.set(x.s, x);
  const sigs = [...bySig.values()].sort((x, y) => y.slot - x.slot);
  const pick = (x: Sig | null, y: Sig | null, older: boolean) => (!x ? y : !y ? x : (older ? x.slot <= y.slot : x.slot >= y.slot) ? x : y);
  return {
    v: 1,
    program: a.program,
    sigs,
    rows: { ...a.rows, ...b.rows },
    newest: pick(a.newest, b.newest, false),
    oldest: pick(a.oldest, b.oldest, true),
    complete: a.complete || b.complete,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

async function load() {
  if (!gcsConfigured()) {
    loaded = true;
    return;
  }
  const doc = await getJson<History>(OBJECT);
  if (doc && doc.data.v === 1 && doc.data.program === SHEAF_PROGRAM_ID) {
    history = loaded ? merge(history, doc.data) : doc.data;
    generation = doc.generation;
  } else if (!doc) {
    generation = "0";
  }
  loaded = true;
}

async function save() {
  if (!gcsConfigured()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      generation = await putJson(OBJECT, history, generation != null ? { ifGenerationMatch: generation } : {});
      return;
    } catch (err) {
      if (!(err instanceof GcsConflict)) throw err;
      // Another instance wrote first: take its work too, then write the union.
      await load();
    }
  }
}

/**
 * Brings the history up to date within `budgetMs`: new signatures first, then
 * older pages until the first transaction, then decoding, newest first. Whatever
 * is left is picked up by the next call.
 */
async function syncOnce(connection: Connection, budgetMs: number): Promise<History> {
  const deadline = Date.now() + budgetMs;
  if (!loaded) await load().catch(() => (loaded = true));
  const program = new PublicKey(SHEAF_PROGRAM_ID);
  let changed = false;

  // Forward: everything newer than the newest signature seen.
  if (history.newest) {
    const fresh: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await connection.getSignaturesForAddress(program, { limit: PAGE, until: history.newest.s, before }, "confirmed");
      fresh.push(...page);
      if (page.length < PAGE || Date.now() > deadline) break;
      before = page[page.length - 1].signature;
    }
    if (fresh.length) {
      const known = new Set(history.sigs.map((x) => x.s));
      history.sigs = [...fresh.filter((i) => i.err == null && !known.has(i.signature)).map(sig), ...history.sigs];
      history.newest = sig(fresh[0]);
      changed = true;
    }
  }

  // Back: older pages until the program's first transaction.
  while (!history.complete && Date.now() < deadline) {
    const page = await connection.getSignaturesForAddress(program, { limit: PAGE, before: history.oldest?.s }, "confirmed");
    if (!history.newest && page.length) history.newest = sig(page[0]);
    const known = new Set(history.sigs.map((x) => x.s));
    history.sigs.push(...page.filter((i) => i.err == null && !known.has(i.signature)).map(sig));
    if (page.length) history.oldest = sig(page[page.length - 1]);
    if (page.length < PAGE) history.complete = true;
    changed = true;
  }

  // Decode what has not been read yet, newest first, a few batches at a time.
  const todo = history.sigs.filter((x) => !history.rows[x.s]);
  const chunks: Sig[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) chunks.push(todo.slice(i, i + BATCH));
  const lane = async () => {
    for (let chunk = chunks.shift(); chunk && Date.now() < deadline; chunk = chunks.shift()) {
      const txs = await connection.getTransactions(
        chunk.map((x) => x.s),
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      );
      chunk.forEach((x, i) => {
        const tx = txs[i];
        // A transaction the node cannot return yet is left for the next call.
        if (!tx) return;
        history.rows[x.s] = entriesOf({ signature: x.s, slot: x.slot, blockTime: x.t }, tx.meta?.logMessages, tx.blockTime).map(
          ({ signature: _s, time: _t, slot: _l, ...row }) => row,
        );
        changed = true;
      });
    }
  };
  await Promise.all(Array.from({ length: LANES }, lane));

  if (changed) {
    history.updatedAt = Date.now();
    await save().catch(() => undefined);
  }
  return history;
}

/** One sync at a time per instance; concurrent callers share it. */
export function syncLedgerHistory(connection: Connection, budgetMs = 40_000): Promise<History> {
  syncing ??= syncOnce(connection, budgetMs).finally(() => (syncing = null));
  return syncing;
}

export type HistoryView = { entries: LedgerEntry[]; decoded: number; total: number; complete: boolean };

/** Every decoded event, newest first, optionally for one basket. */
export function historyEntries(h: History, basket?: string): HistoryView {
  const entries: LedgerEntry[] = [];
  let decoded = 0;
  for (const x of h.sigs) {
    const rows = h.rows[x.s];
    if (!rows) continue;
    decoded++;
    for (const row of rows) {
      if (basket && row.basket !== basket) continue;
      entries.push({ signature: x.s, time: x.t ?? 0, slot: x.slot, ...row });
    }
  }
  return { entries, decoded, total: h.sigs.length, complete: h.complete };
}
