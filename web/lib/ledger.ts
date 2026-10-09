/**
 * The ledger: every creation and redemption the program has ever settled.
 *
 * The program emits an event for each of its three instructions, and Solana
 * keeps those events in the transaction's log, so the whole history of every
 * basket can be rebuilt from the chain with no indexer and no database. This
 * module walks a program's or a basket's signatures, decodes the events out of
 * the logs, and hands them over newest first, a few at a time as they arrive.
 *
 * The site reads it on the server (readLedgerBatched, behind /api/ledger, with
 * the transactions fetched in JSON-RPC batches and cached), so a visitor makes
 * one request instead of one per transaction. readLedger is the same walk for a
 * browser or a script on its own connection. Decoded events never change, so in
 * a browser each one is kept in local storage, and the repository
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
  kind:
    | "created"
    | "minted"
    | "redeemed"
    | "ordered"
    | "planRun"
    | "filled"
    | "returned"
    | "planOpened"
    /** A holder offered shares for dollars (the dollar exit). */
    | "sellOrdered"
    /** A filler paid for them. */
    | "sold"
    /** Nobody bought in time, or the seller withdrew: the shares went back. */
    | "sellReturned"
    /** The protocol's fee shares accrued on a creation or fill (owed to the treasury, not yet minted). */
    | "feeAccrued"
    /** The treasury claimed the accrued fee shares. */
    | "feeClaimed";
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
  /** Dollars escrowed, paid or refunded, for orders and plans. */
  cash?: number;
  /** A plan's runs, on a plan opening. */
  runs?: number;
  /** The order account, on an order, a plan run, a fill or a refund: what ties a fill to its order. */
  order?: string;
  /** The plan, when the order came from one. */
  plan?: string;
  /** Who delivered the stocks on a fill, or paid the dollars on a sale. */
  filler?: string;
  /** On a creation: the basket's fee terms, from BasketFeeTerms. */
  creatorFeeBps?: number;
  protocolFeeBps?: number;
  /** On a fee accrual: the running total owed to the treasury, in whole shares. */
  accrued?: number;
  /** On a sell order: the dollars the seller asks for at the start, and their floor at the end. */
  startCash?: number;
  endCash?: number;
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
const EVENT_ORDER_PLACED = [96, 130, 204, 234, 169, 219, 216, 227];
const EVENT_ORDER_FILLED = [120, 124, 109, 66, 249, 116, 174, 30];
const EVENT_ORDER_CANCELLED = [108, 56, 128, 68, 168, 113, 168, 239];
const EVENT_PLAN_OPENED = [180, 40, 139, 132, 248, 34, 213, 58];
const EVENT_SELL_PLACED = [102, 129, 44, 158, 235, 219, 216, 128];
const EVENT_SELL_FILLED = [119, 36, 160, 142, 108, 196, 88, 104];
const EVENT_SELL_CANCELLED = [182, 0, 198, 165, 128, 233, 74, 99];
const EVENT_FEE_ACCRUED = [28, 67, 46, 110, 88, 175, 215, 194];
const EVENT_FEE_CLAIMED = [169, 107, 23, 223, 26, 230, 194, 184];
const EVENT_FEE_TERMS = [174, 145, 144, 99, 79, 119, 99, 247];
const CASH = 1_000_000;
const ONE_SHARE = 1_000_000;
const PREFIX = "Program data: ";
const STORE = "sheaf:ledger:v2";

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
  skip(n: number) {
    this.offset += n;
  }
  optPubkey() {
    return this.u8() === 1 ? this.pubkey() : null;
  }
  u32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
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

export function fromBase64(text: string): Uint8Array {
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
    if (matches(data, EVENT_ORDER_PLACED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey();
      const plan = r.optPubkey();
      r.pubkey(); // cash mint
      r.u64(); // nonce
      const cash = Number(r.u64()) / CASH;
      return { kind: plan ? "planRun" : "ordered", basket, actor, cash, order, ...(plan ? { plan } : {}) };
    }
    if (matches(data, EVENT_ORDER_FILLED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey(); // the buyer
      const filler = r.pubkey();
      const plan = r.optPubkey();
      const shares = Number(r.u64()) / ONE_SHARE;
      const feeShares = Number(r.u64()) / ONE_SHARE;
      const cash = Number(r.u64()) / CASH;
      return { kind: "filled", basket, actor, shares, feeShares, cash, order, filler, ...(plan ? { plan } : {}) };
    }
    if (matches(data, EVENT_ORDER_CANCELLED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey();
      const plan = r.optPubkey();
      r.pubkey(); // by
      const cash = Number(r.u64()) / CASH;
      return { kind: "returned", basket, actor, cash, order, ...(plan ? { plan } : {}) };
    }
    if (matches(data, EVENT_PLAN_OPENED)) {
      r.pubkey(); // plan
      const basket = r.pubkey();
      const actor = r.pubkey();
      r.pubkey(); // cash mint
      r.pubkey(); // cash account
      const cash = Number(r.u64()) / CASH;
      r.u64(); // period
      const runs = r.u32();
      return { kind: "planOpened", basket, actor, cash, runs };
    }
    if (matches(data, EVENT_SELL_PLACED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey(); // the seller
      r.pubkey(); // cash mint
      r.u64(); // nonce
      const shares = Number(r.u64()) / ONE_SHARE;
      const startCash = Number(r.u64()) / CASH;
      const endCash = Number(r.u64()) / CASH;
      return { kind: "sellOrdered", basket, actor, shares, cash: startCash, startCash, endCash, order };
    }
    if (matches(data, EVENT_SELL_FILLED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey(); // the seller
      const filler = r.pubkey();
      const shares = Number(r.u64()) / ONE_SHARE;
      const cash = Number(r.u64()) / CASH; // what the seller received
      return { kind: "sold", basket, actor, shares, cash, order, filler };
    }
    if (matches(data, EVENT_SELL_CANCELLED)) {
      const order = r.pubkey();
      const basket = r.pubkey();
      const actor = r.pubkey(); // the seller
      r.pubkey(); // by
      const shares = Number(r.u64()) / ONE_SHARE;
      return { kind: "sellReturned", basket, actor, shares, order };
    }
    if (matches(data, EVENT_FEE_ACCRUED)) {
      const basket = r.pubkey();
      const shares = Number(r.u64()) / ONE_SHARE;
      const accrued = Number(r.u64()) / ONE_SHARE;
      // The event names no wallet; entriesOf credits it to whoever made the transaction.
      return { kind: "feeAccrued", basket, actor: basket, shares, accrued };
    }
    if (matches(data, EVENT_FEE_CLAIMED)) {
      const basket = r.pubkey();
      const actor = r.pubkey(); // the treasury's share account
      const shares = Number(r.u64()) / ONE_SHARE;
      return { kind: "feeClaimed", basket, actor, shares };
    }
  } catch {
    // A log line that is not one of ours, or a truncated one. Skip it.
  }
  return null;
}

// --------------------------------------------------------------------- store

export type Known = Record<string, LedgerEntry[]>;

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

/** One transaction's rows, from its logs. */
export function entriesOf(
  info: { signature: string; slot: number; blockTime?: number | null },
  logs: string[] | null | undefined,
  blockTime?: number | null,
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let terms: { creatorFeeBps: number; protocolFeeBps: number } | null = null;
  for (const line of logs ?? []) {
    if (!line.startsWith(PREFIX)) continue;
    const data = fromBase64(line.slice(PREFIX.length));
    // BasketFeeTerms is not a row of its own: it belongs on the creation it came with.
    if (matches(data, EVENT_FEE_TERMS) && data.length >= 8 + 32 + 4) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      terms = { creatorFeeBps: view.getUint16(40, true), protocolFeeBps: view.getUint16(42, true) };
      continue;
    }
    const event = decodeEvent(data);
    if (!event) continue;
    entries.push({ signature: info.signature, time: info.blockTime ?? blockTime ?? 0, slot: info.slot, ...event });
  }
  const created = entries.find((e) => e.kind === "created");
  if (terms && created) Object.assign(created, terms);
  // A fee accrual is credited to whoever made the transaction (the depositor, or the buyer of a fill).
  const maker = entries.find((e) => e.kind !== "feeAccrued" && e.kind !== "feeClaimed");
  for (const e of entries) if (e.kind === "feeAccrued" && maker) e.actor = maker.actor;
  // A fill also emits the share mint's own event; the fill row says it all.
  return entries.some((e) => e.kind === "filled") ? entries.filter((e) => e.kind !== "minted") : entries;
}

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
      return entriesOf(info, tx?.meta?.logMessages, tx?.blockTime);
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

/**
 * The same walk for a server: `store` is a long-lived cache of decoded
 * transactions that this call reads and fills, and the transactions it lacks are
 * fetched in JSON-RPC batches, a few batches at a time.
 */
export async function readLedgerBatched(
  connection: Connection,
  options: { basket?: string; limit?: number; store: Known; batch?: number; lanes?: number },
): Promise<Ledger> {
  const limit = options.limit ?? 300;
  const address = options.basket ? new PublicKey(options.basket) : PROGRAM_ID;
  const signatures = await connection.getSignaturesForAddress(address, { limit }, "confirmed");
  const ok = signatures.filter((s) => s.err == null);
  const known = options.store;
  const queue = ok.filter((s) => !known[s.signature]);
  const size = options.batch ?? 25;
  const chunks: (typeof queue)[] = [];
  for (let i = 0; i < queue.length; i += size) chunks.push(queue.slice(i, i + size));
  const lane = async () => {
    for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
      const txs = await connection.getTransactions(
        chunk.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      );
      // A transaction the node cannot return yet is left out, and read on the next call.
      chunk.forEach((info, i) => {
        const tx = txs[i];
        if (tx) known[info.signature] = entriesOf(info, tx.meta?.logMessages, tx.blockTime);
      });
    }
  };
  await Promise.all(Array.from({ length: options.lanes ?? 3 }, lane));
  return {
    entries: ok.flatMap((s) => known[s.signature] ?? []),
    done: ok.filter((s) => known[s.signature]).length,
    total: ok.length,
    truncated: signatures.length >= limit,
  };
}

/** How orders of one kind fared: placed, filled, returned, and how fast. */
export type FillStats = {
  /** Orders placed (a plan run places one). */
  orders: number;
  fills: number;
  returned: number;
  dollarsFilled: number;
  /** Fills over every order that has finished, filled or returned. */
  fillRate: number | null;
  /** Median seconds from the order to its fill, over fills whose order is in view. */
  medianSecsToFill: number | null;
};

export type LedgerStats = {
  /** Every event, and the distinct wallets behind them. */
  actions: number;
  wallets: number;
  /** Wallets that are not the team's own (the house key and test wallets), and their events. */
  outsideWallets: number;
  outsideActions: number;
  baskets: number;
  /** Baskets created by a wallet that is not ours. */
  outsideBaskets: number;
  plans: number;
  outsidePlans: number;
  /** Dollar orders and plan runs together. */
  orders: number;
  fills: number;
  /** Fills delivered by a wallet other than ours. */
  outsideFills: number;
  dollarsFilled: number;
  returned: number;
  medianSecsToFill: number | null;
  fillRate: number | null;
  /** The same, split by cause: one-off dollar orders and plan runs. */
  byCause: { dollar: FillStats; plan: FillStats };
  /** Only orders whose buyer is not ours, split the same way. */
  outside: { dollar: FillStats; plan: FillStats };
  /** Who delivered: the house filler, the second (reference-code) filler, and anyone else. */
  fillsByFiller: { house: number; second: number; outside: number; otherOurs: number };
  /** Fill rate over finished orders of at least $5, the house's minimum, by cause too. */
  fillRateAtLeast5: number | null;
  fillRateAtLeast5ByCause: { dollar: number | null; plan: number | null };
  /** Protocol fee shares accrued to the treasury, and claimed by it, in whole shares. */
  protocolFeeAccrued: number;
  protocolFeeClaimed: number;
  /** The dollar exit: sell orders placed, filled and returned, and the dollars paid out to sellers. */
  sells: number;
  sellFills: number;
  sellReturned: number;
  dollarsPaidOut: number;
  /** Fills over finished sell orders, and the median seconds from a sell order to its sale. */
  sellFillRate: number | null;
  medianSecsToSell: number | null;
  /** Who bought the shares, as fillsByFiller does for buys. */
  sellFillsByFiller: { house: number; second: number; outside: number; otherOurs: number };
  /** The oldest event in view, unix seconds. */
  since: number | null;
};

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

function fillStats(entries: LedgerEntry[], placedAt: Map<string, number>): FillStats {
  const fills = entries.filter((e) => e.kind === "filled");
  const returned = entries.filter((e) => e.kind === "returned").length;
  const waits = fills
    .map((f) => (f.order && placedAt.has(f.order) ? f.time - placedAt.get(f.order)! : null))
    .filter((w): w is number => w != null && w >= 0);
  return {
    orders: entries.filter((e) => e.kind === "ordered" || e.kind === "planRun").length,
    fills: fills.length,
    returned,
    dollarsFilled: Math.round(fills.reduce((a, f) => a + (f.cash ?? 0), 0) * 100) / 100,
    fillRate: fills.length + returned > 0 ? Math.round((fills.length / (fills.length + returned)) * 1000) / 1000 : null,
    medianSecsToFill: median(waits),
  };
}

/** Fills over finished orders of at least $5 (a fill or a refund carries the order's dollars). */
function rateAtLeast5(xs: LedgerEntry[]): number | null {
  const fills = xs.filter((e) => e.kind === "filled" && (e.cash ?? 0) >= 5).length;
  const returned = xs.filter((e) => e.kind === "returned" && (e.cash ?? 0) >= 5).length;
  return fills + returned > 0 ? Math.round((fills / (fills + returned)) * 1000) / 1000 : null;
}

/** The numbers behind a set of events. `isOurs` tells a team wallet from anyone else's. */
export function ledgerStats(
  entries: LedgerEntry[],
  isOurs: (wallet: string) => boolean,
  fillers: { house?: string; second?: string } = {},
): LedgerStats {
  // Fee rows are bookkeeping, not anyone's action: they stay out of the activity counts.
  const acts = entries.filter((e) => e.kind !== "feeAccrued" && e.kind !== "feeClaimed");
  const wallets = new Set(acts.map((e) => e.actor));
  let outsideWallets = 0;
  for (const w of wallets) if (!isOurs(w)) outsideWallets++;
  const placedAt = new Map<string, number>();
  for (const e of entries) if ((e.kind === "ordered" || e.kind === "planRun") && e.order) placedAt.set(e.order, e.time);
  // An order's cause: a plan run carries its plan on every event, a one-off dollar order none.
  const orderish = entries.filter((e) => e.kind === "ordered" || e.kind === "planRun" || e.kind === "filled" || e.kind === "returned");
  const dollar = orderish.filter((e) => e.kind === "ordered" || (e.kind !== "planRun" && !e.plan));
  const plan = orderish.filter((e) => e.kind === "planRun" || (e.kind !== "ordered" && !!e.plan));
  const theirs = (xs: LedgerEntry[]) => xs.filter((e) => !isOurs(e.actor));
  const all = fillStats(orderish, placedAt);
  const fills = entries.filter((e) => e.kind === "filled");
  const sold = entries.filter((e) => e.kind === "sold");
  const sellReturned = entries.filter((e) => e.kind === "sellReturned").length;
  const sellPlacedAt = new Map<string, number>();
  for (const e of entries) if (e.kind === "sellOrdered" && e.order) sellPlacedAt.set(e.order, e.time);
  const byFiller = (xs: LedgerEntry[]) => ({
    house: xs.filter((f) => f.filler != null && f.filler === fillers.house).length,
    second: xs.filter((f) => f.filler != null && f.filler === fillers.second).length,
    outside: xs.filter((f) => f.filler != null && !isOurs(f.filler) && f.filler !== fillers.second).length,
    otherOurs: xs.filter((f) => f.filler != null && isOurs(f.filler) && f.filler !== fillers.house && f.filler !== fillers.second).length,
  });
  return {
    actions: acts.length,
    wallets: wallets.size,
    outsideWallets,
    outsideActions: acts.filter((e) => !isOurs(e.actor)).length,
    baskets: entries.filter((e) => e.kind === "created").length,
    outsideBaskets: entries.filter((e) => e.kind === "created" && !isOurs(e.actor)).length,
    plans: entries.filter((e) => e.kind === "planOpened").length,
    outsidePlans: entries.filter((e) => e.kind === "planOpened" && !isOurs(e.actor)).length,
    orders: all.orders,
    fills: all.fills,
    outsideFills: fills.filter((f) => f.filler != null && !isOurs(f.filler)).length,
    dollarsFilled: all.dollarsFilled,
    returned: all.returned,
    medianSecsToFill: all.medianSecsToFill,
    fillRate: all.fillRate,
    byCause: { dollar: fillStats(dollar, placedAt), plan: fillStats(plan, placedAt) },
    outside: { dollar: fillStats(theirs(dollar), placedAt), plan: fillStats(theirs(plan), placedAt) },
    fillsByFiller: byFiller(fills),
    sells: entries.filter((e) => e.kind === "sellOrdered").length,
    sellFills: sold.length,
    sellReturned,
    dollarsPaidOut: Math.round(sold.reduce((a, e) => a + (e.cash ?? 0), 0) * 100) / 100,
    sellFillRate: sold.length + sellReturned > 0 ? Math.round((sold.length / (sold.length + sellReturned)) * 1000) / 1000 : null,
    medianSecsToSell: median(
      sold.map((e) => (e.order && sellPlacedAt.has(e.order) ? e.time - sellPlacedAt.get(e.order)! : -1)).filter((w) => w >= 0),
    ),
    sellFillsByFiller: byFiller(sold),
    fillRateAtLeast5: rateAtLeast5(orderish),
    fillRateAtLeast5ByCause: { dollar: rateAtLeast5(dollar), plan: rateAtLeast5(plan) },
    protocolFeeAccrued: Math.round(entries.filter((e) => e.kind === "feeAccrued").reduce((a, e) => a + (e.shares ?? 0), 0) * 1e6) / 1e6,
    protocolFeeClaimed: Math.round(entries.filter((e) => e.kind === "feeClaimed").reduce((a, e) => a + (e.shares ?? 0), 0) * 1e6) / 1e6,
    since: entries.reduce<number | null>((a, e) => (e.time > 0 && (a == null || e.time < a) ? e.time : a), null),
  };
}

/** The program's events in one transaction's logs, decoded. */
export function eventsInLogs(logs: string[] | null | undefined) {
  const out: NonNullable<ReturnType<typeof decodeEvent>>[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith(PREFIX)) continue;
    const e = decodeEvent(fromBase64(line.slice(PREFIX.length)));
    if (e) out.push(e);
  }
  return out;
}
