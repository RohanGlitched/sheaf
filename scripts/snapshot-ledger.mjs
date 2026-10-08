#!/usr/bin/env node
/**
 * Write web/public/ledger.snapshot.json: every event the program has emitted so
 * far, decoded once here so a visitor's browser starts from it and only reads
 * the transactions that landed since. Decoded events never change, and every
 * row still links to its transaction on the explorer, so the snapshot is a
 * cache, not a source of truth. Re-run before a release:
 *
 *   node scripts/snapshot-ledger.mjs [--url https://api.devnet.solana.com]
 *
 * The decoder below mirrors web/lib/ledger.ts (the event layouts come from
 * target/idl/sheaf.json). If the program's events change, change both.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "web", "public", "ledger.snapshot.json");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg("url", "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey(arg("program", "F8QLTZPe9mJuPgXCbccnU9G2kMSEE4inygdUw3QZbrQ"));

const EVENT_CREATED = [26, 146, 108, 155, 189, 85, 8, 7];
const EVENT_MINTED = [127, 139, 238, 41, 118, 47, 122, 39];
const EVENT_REDEEMED = [232, 166, 7, 56, 67, 19, 42, 117];
const ONE_SHARE = 1_000_000;
const PREFIX = "Program data: ";

class Reader {
  constructor(data) {
    this.data = data;
    this.offset = 8;
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

const matches = (data, d) => d.every((b, i) => data[i] === b);

function decodeEvent(data) {
  try {
    const r = new Reader(data);
    if (matches(data, EVENT_CREATED)) {
      const basket = r.pubkey();
      const actor = r.pubkey();
      r.pubkey();
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
    // Not one of ours.
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchEvents(connection, info) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await connection.getTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const entries = [];
      for (const line of tx?.meta?.logMessages ?? []) {
        if (!line.startsWith(PREFIX)) continue;
        const event = decodeEvent(Buffer.from(line.slice(PREFIX.length), "base64"));
        if (!event) continue;
        entries.push({ signature: info.signature, time: info.blockTime ?? tx?.blockTime ?? 0, slot: info.slot, ...event });
      }
      return entries;
    } catch (err) {
      if (attempt < 12 && /429|Too many requests/i.test(String(err?.message ?? err))) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

const known = (() => {
  try {
    return JSON.parse(readFileSync(out, "utf8")).known ?? {};
  } catch {
    return {};
  }
})();

const connection = new Connection(url, "confirmed");
const signatures = await connection.getSignaturesForAddress(PROGRAM_ID, { limit: 1000 }, "confirmed");
const ok = signatures.filter((s) => s.err == null);
const queue = ok.filter((s) => !known[s.signature]).reverse();
let done = ok.length - queue.length;
process.stdout.write(`${ok.length} transactions, ${queue.length} to decode\n`);
const lane = async () => {
  for (let info = queue.shift(); info; info = queue.shift()) {
    known[info.signature] = await fetchEvents(connection, info);
    done++;
    process.stdout.write(`\r${done} of ${ok.length}`);
    await sleep(150);
  }
};
await Promise.all([lane(), lane()]);
process.stdout.write("\n");

// Only transactions the program still lists, newest first, so the file stays
// in one order and nothing stale lingers if a cluster is ever reset.
const ordered = {};
for (const s of ok) ordered[s.signature] = known[s.signature] ?? [];
const events = Object.values(ordered).flat().length;
writeFileSync(out, JSON.stringify({ asOf: new Date().toISOString().slice(0, 10), cluster: "devnet", known: ordered }));
process.stdout.write(`wrote ${out}: ${events} events in ${ok.length} transactions\n`);
