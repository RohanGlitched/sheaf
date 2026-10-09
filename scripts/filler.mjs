/**
 * An independent filler for Sheaf dollar orders.
 *
 * Anyone can run this with their own wallet and compete with the house keeper:
 * it watches every open order, prices the basket from Solana mainnet, and fills
 * an order as soon as the dollars cover the stocks it must deliver plus a margin
 * you choose. It needs the component tokens in its own wallet (on devnet, ask the
 * site's faucet for them) and keeps the dollars it is paid.
 *
 *   node scripts/filler.mjs --keypair ~/.config/solana/id.json [--edge-bps 20] [--once]
 *     [--rpc https://api.devnet.solana.com] [--site https://sheaf-index.vercel.app]
 *
 * Instruction layouts come from web/lib/sheaf-idl.json, the IDL the program emits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const RPC = arg("rpc", "https://api.devnet.solana.com");
const SITE = arg("site", "https://sheaf-index.vercel.app").replace(/\/$/, "");
const EDGE_BPS = Number(arg("edge-bps", "20"));
const keypairPath = arg("keypair", path.join(os.homedir(), ".config/solana/id.json")).replace(/^~/, os.homedir());
const filler = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));

const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "web/lib/sheaf-idl.json"), "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ORDER_DISC = Buffer.from(idl.accounts.find((a) => a.name === "Order").discriminator);
const FILL = idl.instructions.find((ix) => ix.name === "fill_order");
const connection = new Connection(RPC, "confirmed");

const ata = (mint, owner, program) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

function decodeOrder(pubkey, data) {
  let o = 8;
  const key = () => {
    const k = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return k;
  };
  const u64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const i64 = () => {
    const v = Number(data.readBigInt64LE(o));
    o += 8;
    return v;
  };
  const order = { address: pubkey, basket: key(), buyer: key(), rentPayer: key(), cashMint: key(), cashProgram: key() };
  order.plan = data[o++] === 1 ? key() : null;
  order.nonce = u64();
  order.cashAmount = u64();
  order.startShares = u64();
  order.endShares = u64();
  order.startTs = i64();
  order.endTs = i64();
  return order;
}

/** Shares the buyer receives at `t`, exactly as the program computes it. */
function required(o, t) {
  if (t <= o.startTs) return o.startShares;
  if (t >= o.endTs) return o.endShares;
  return o.startShares - ((o.startShares - o.endShares) * BigInt(t - o.startTs)) / BigInt(o.endTs - o.startTs);
}

/** The gross shares whose creator fee leaves exactly `net`, as the program computes it. */
function gross(net, feeBps) {
  const netOf = (g) => g - (g * BigInt(feeBps)) / 10_000n;
  let g = (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
  for (let i = 0; i < 3 && g > net && netOf(g - 1n) >= net; i++) g -= 1n;
  return g;
}

function fillIx(order, basket) {
  const basketKey = new PublicKey(basket.address);
  const shareMint = new PublicKey(basket.shareMint);
  const componentProgram = new PublicKey(basket.tokenProgram);
  const accounts = {
    filler: filler.publicKey,
    order: order.address,
    basket: basketKey,
    share_mint: shareMint,
    buyer: order.buyer,
    buyer_share_account: ata(shareMint, order.buyer, TOKEN_2022),
    creator_share_account: basket.creatorFeeBps > 0 ? ata(shareMint, new PublicKey(basket.creator), TOKEN_2022) : null,
    cash_mint: order.cashMint,
    escrow: ata(order.cashMint, order.address, order.cashProgram),
    filler_cash_account: ata(order.cashMint, filler.publicKey, order.cashProgram),
    rent_payer: order.rentPayer,
    plan: order.plan,
    share_token_program: TOKEN_2022,
    component_token_program: componentProgram,
    cash_token_program: order.cashProgram,
  };
  const keys = FILL.accounts.map((a) => {
    const k = accounts[a.name];
    if (k == null) {
      if (a.address) return { pubkey: new PublicKey(a.address), isSigner: false, isWritable: false };
      if (a.optional) return { pubkey: PROGRAM_ID, isSigner: false, isWritable: false };
      throw new Error(`fill_order: no value for ${a.name}`);
    }
    return { pubkey: k, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  for (const c of basket.components) {
    const mint = new PublicKey(c.mint);
    keys.push({ pubkey: mint, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(mint, filler.publicKey, componentProgram), isSigner: false, isWritable: true });
    keys.push({ pubkey: ata(mint, basketKey, componentProgram), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(FILL.discriminator) });
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const raw = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: (await import("bs58")).default.encode(ORDER_DISC) } }] });
  const orders = raw.map((a) => decodeOrder(a.pubkey, a.account.data)).filter((o) => o.endTs > now + 3);
  if (!orders.length) return console.log(new Date().toISOString(), "no open orders");
  const [baskets, market] = await Promise.all([
    fetch(`${SITE}/api/baskets`).then((r) => r.json()),
    fetch(`${SITE}/api/market`).then((r) => r.json()),
  ]);
  // The site's mirror map links each devnet mint to the mainnet stock it stands for.
  const mirror = fs.readFileSync(path.join(ROOT, "web/lib/mirror.generated.ts"), "utf8") + fs.readFileSync(path.join(ROOT, "web/lib/mirror-prestocks.generated.ts"), "utf8");
  const symbolOf = (mint) => mirror.match(new RegExp(`"?([A-Za-z0-9]+)"?\\s*:\\s*\\{[^}]*writeMint:\\s*"${mint}"`))?.[1];
  const quote = new Map(market.quotes.map((q) => [q.symbol, q]));
  for (const order of orders) {
    const basket = baskets.find((b) => b.address === order.basket.toBase58());
    if (!basket) continue;
    let nav = 0;
    let priced = true;
    for (const c of basket.components) {
      const q = quote.get(symbolOf(c.mint));
      if (!q) priced = false;
      else nav += (Number(c.unitsPerShare) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
    }
    if (!priced) continue;
    const t = Math.floor(Date.now() / 1000) + 3;
    const shares = required(order, t);
    const g = gross(shares, basket.creatorFeeBps);
    const cost = (Number(g) / 1e6) * nav;
    const cash = Number(order.cashAmount) / 1e6;
    const edge = (cash - cost) / cost;
    const tag = `${order.address.toBase58().slice(0, 6)} ${basket.symbol} $${cash.toFixed(2)}`;
    if (edge * 10_000 < EDGE_BPS) {
      console.log(tag, `edge ${(edge * 100).toFixed(2)}%, waiting`);
      continue;
    }
    try {
      const sig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), fillIx(order, basket)),
        [filler],
        { commitment: "confirmed" },
      );
      console.log(tag, `FILLED at edge ${(edge * 100).toFixed(2)}%`, sig);
    } catch (err) {
      console.log(tag, "fill failed:", String(err.message ?? err).slice(0, 160));
    }
  }
}

console.log(`filler ${filler.publicKey.toBase58()} on ${RPC}, edge ${EDGE_BPS} bps`);
do {
  await tick().catch((e) => console.log("tick failed:", e.message));
  if (!flag("once")) await new Promise((r) => setTimeout(r, 5000));
} while (!flag("once"));
