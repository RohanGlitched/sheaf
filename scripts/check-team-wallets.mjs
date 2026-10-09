#!/usr/bin/env node
// Pre-deploy check: does /ledger's "wallets that aren't ours" count only people
// who are not us?
//
// It reads every Sheaf program event on the write cluster (the same events the
// ledger decodes), takes each event's wallet, and lists the ones missing from
// web/lib/team-wallets.ts. Any of those that look like one of our own test
// runs is flagged, and the script exits 1 so the wallet can be added before the
// deploy. Wallets that look like real visitors are listed and do not fail the
// check: the lead decides.
//
// "Looks like a test run" means one of:
//   - the address appears in a QA artifact under .judge/ (wallets.txt, logs, JSON);
//   - it created a basket named like our QA baskets ("QA judge …", symbol QA…).
//
//   node scripts/check-team-wallets.mjs [--rpc URL] [--limit N]
//
// Reads public data only; no keys are needed or touched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RPC = flag("rpc", process.env.SHEAF_RPC ?? "https://api.devnet.solana.com");
const LIMIT = Number(flag("limit", "1000"));

// ---------------------------------------------------------------- team list

const teamSource = fs.readFileSync(path.join(ROOT, "web/lib/team-wallets.ts"), "utf8");
const TEAM = new Set([...teamSource.matchAll(/address:\s*"([^"]+)"/g)].map((m) => m[1]));

const configSource = fs.readFileSync(path.join(ROOT, "web/lib/config.ts"), "utf8");
const PROGRAM = process.env.NEXT_PUBLIC_SHEAF_PROGRAM_ID ?? configSource.match(/SHEAF_PROGRAM_ID =[\s\S]*?"([1-9A-HJ-NP-Za-km-z]{32,44})"/)?.[1];
if (!PROGRAM) throw new Error("Could not read SHEAF_PROGRAM_ID from web/lib/config.ts.");

// ----------------------------------------------------------------- decoding

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// Event discriminators and where each event keeps its basket and wallet, as in web/lib/ledger.ts.
const EVENTS = {
  created: { disc: [26, 146, 108, 155, 189, 85, 8, 7], basket: 8, wallet: 40 },
  minted: { disc: [127, 139, 238, 41, 118, 47, 122, 39], basket: 8, wallet: 40 },
  redeemed: { disc: [232, 166, 7, 56, 67, 19, 42, 117], basket: 8, wallet: 40 },
  ordered: { disc: [96, 130, 204, 234, 169, 219, 216, 227], basket: 40, wallet: 72 },
  filled: { disc: [120, 124, 109, 66, 249, 116, 174, 30], basket: 40, wallet: 72 },
  returned: { disc: [108, 56, 128, 68, 168, 113, 168, 239], basket: 40, wallet: 72 },
  planOpened: { disc: [180, 40, 139, 132, 248, 34, 213, 58], basket: 40, wallet: 72 },
};

function decode(data) {
  for (const [kind, e] of Object.entries(EVENTS)) {
    if (!e.disc.every((b, i) => data[i] === b)) continue;
    const event = {
      kind,
      basket: base58(data.subarray(e.basket, e.basket + 32)),
      wallet: base58(data.subarray(e.wallet, e.wallet + 32)),
    };
    if (kind === "created") {
      // basket, creator, share mint, then name and symbol as length-prefixed strings.
      let at = 8 + 32 * 3;
      const str = () => {
        const len = data.readUInt32LE(at);
        const s = data.subarray(at + 4, at + 4 + len).toString("utf8");
        at += 4 + len;
        return s;
      };
      try {
        event.name = str();
        event.symbol = str();
      } catch {
        /* a truncated log line; the wallet is still right */
      }
    }
    return event;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 10) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const json = await res.json();
    if (json.error) {
      if (attempt < 6) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }
}

// ------------------------------------------------------------ QA artifacts

function qaArtifacts() {
  const dir = path.join(ROOT, ".judge");
  const text = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(txt|log|json|md)$/.test(entry.name) && fs.statSync(p).size < 20_000_000) text.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return text.join("\n");
}

// --------------------------------------------------------------------- main

const signatures = [];
for (let before; signatures.length < LIMIT; ) {
  const page = await rpc("getSignaturesForAddress", [PROGRAM, { limit: Math.min(1000, LIMIT - signatures.length), before }]);
  signatures.push(...page.filter((s) => !s.err));
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}

const byWallet = new Map();
for (const s of signatures) {
  const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  for (const line of tx?.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const event = decode(Buffer.from(line.slice(14), "base64"));
    if (!event) continue;
    const row = byWallet.get(event.wallet) ?? { events: 0, first: s.blockTime, kinds: new Set(), created: [] };
    row.events++;
    row.first = Math.min(row.first ?? Infinity, s.blockTime ?? Infinity);
    row.kinds.add(event.kind);
    if (event.kind === "created") row.created.push(`${event.symbol ?? "?"} "${event.name ?? "?"}"`);
    byWallet.set(event.wallet, row);
  }
  await sleep(120);
}

const qa = qaArtifacts();
const outside = [...byWallet.entries()].filter(([wallet]) => !TEAM.has(wallet));
const flagged = [];
for (const [wallet, row] of outside) {
  const reasons = [];
  if (qa.includes(wallet)) reasons.push("named in a QA artifact under .judge/");
  if (row.created.some((c) => /QA judge|^QA[A-Z0-9]+ /.test(c))) reasons.push(`created ${row.created.join(", ")}`);
  row.reasons = reasons;
  if (reasons.length) flagged.push(wallet);
}

console.log(`Program ${PROGRAM} on ${RPC}`);
console.log(`${signatures.length} transactions, ${byWallet.size} distinct wallets, ${TEAM.size} in team-wallets.ts`);
if (outside.length === 0) {
  console.log("Every wallet on the ledger is in team-wallets.ts. Wallets that aren't ours: 0.");
  process.exit(0);
}
console.log(`\n${outside.length} wallet(s) not in team-wallets.ts:`);
for (const [wallet, row] of outside) {
  const when = row.first ? new Date(row.first * 1000).toISOString() : "?";
  console.log(`  ${wallet}  ${row.events} events (${[...row.kinds].join(", ")}), first ${when}`);
  for (const reason of row.reasons) console.log(`      looks like a test run: ${reason}`);
}
if (flagged.length) {
  console.log(`\n${flagged.length} of them match our test-run patterns. Add them to web/lib/team-wallets.ts as "test" before deploying.`);
  process.exit(1);
}
console.log("\nNone match a test-run pattern. If they are not ours, they are the outside count.");
