/**
 * An independent filler for Sheaf dollar orders. Reference code: copy it, read
 * it, change the pricing, run it against the house keeper.
 *
 * A dollar order escrows cash and runs a Dutch auction on share count. Whoever
 * delivers the stocks for the current count first takes the escrowed cash. This
 * script watches every open order, prices the stocks it would have to hand over
 * at Solana mainnet prices, and fills when the cash it would receive beats that
 * cost by the margin you choose. It needs the component tokens in its own wallet
 * (on devnet, the site's faucet hands them out) and keeps the cash it is paid.
 *
 * Run it (in Linux, macOS or WSL; @solana/web3.js wants a current Node):
 *
 *   node scripts/filler.mjs --keypair ~/.config/solana/id.json --dry-run --once
 *   node scripts/filler.mjs --keypair ~/.config/solana/id.json --edge-bps 20
 *
 *   --keypair <path>     wallet that delivers the stocks and is paid (default ~/.config/solana/id.json)
 *   --edge-bps <n>       minimum margin over cost, in basis points (default 20)
 *   --cash-mint <addr>   the only cash mint it accepts (default CASH_MINT in web/lib/cash.generated.ts)
 *   --rpc <url>          write cluster (default https://api.devnet.solana.com)
 *   --site <url>         where mainnet quotes come from (default https://sheaf-index.vercel.app)
 *   --dry-run            price and simulate, print what it would fill, sign and send nothing
 *   --once               one pass, then exit
 *
 * Defences. place_order is permissionless, so anyone can post an order in any
 * token. A filler that trusts the order is a free vending machine for stocks.
 * Before it sends anything, this one:
 *
 *   1. Accepts one cash mint. Every order in any other mint is skipped and
 *      logged. A token someone minted for free is worth nothing, whatever the
 *      raw amount says.
 *   2. Reads that mint from chain: its owner must be a token program and must
 *      match the order's cash program, and decimals come from the mint, not an
 *      assumption.
 *   3. Prices the payout net of the mint's Token-2022 transfer fee for the
 *      current epoch. A mint whose fee config cannot be read is skipped.
 *   4. Reads the basket's recipe from chain, not from the site, and prices the
 *      stocks it must deliver including any transfer-fee gross-up on them.
 *   5. Simulates the exact signed transaction and checks the filler's cash
 *      account grows by at least the expected net payout, and that no component
 *      leaves the wallet in a larger amount than was priced. Else it skips.
 *
 * What it still trusts: the quotes from --site (replace quotesBySymbol to use
 * your own feed), the mirror maps in web/lib/*.generated.ts that link each
 * devnet mint to the mainnet stock it stands for, and that one whole unit of the
 * accepted cash mint is one dollar.
 *
 * Instruction and account layouts come from web/lib/sheaf-idl.json (the IDL the
 * program emits) and programs/sheaf/src/lib.rs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// ---------------------------------------------------------------- config

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** CASH_MINT as scripts/setup-cash.mjs wrote it, read as text so this file needs no TypeScript. */
function defaultCashMint() {
  const text = fs.readFileSync(path.join(ROOT, "web/lib/cash.generated.ts"), "utf8");
  const m = text.match(/export const CASH_MINT\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!m) throw new Error("CASH_MINT not found in web/lib/cash.generated.ts; pass --cash-mint");
  return m[1];
}

const RPC = arg("rpc", "https://api.devnet.solana.com");
const SITE = arg("site", "https://sheaf-index.vercel.app").replace(/\/$/, "");
const EDGE_BPS = Number(arg("edge-bps", "20"));
const CASH_MINT = new PublicKey(arg("cash-mint", null) ?? defaultCashMint());
const DRY_RUN = flag("dry-run");
const ONCE = flag("once");
const keypairPath = arg("keypair", path.join(os.homedir(), ".config/solana/id.json")).replace(/^~/, os.homedir());
const filler = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));

const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "web/lib/sheaf-idl.json"), "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ORDER_DISC = Buffer.from(idl.accounts.find((a) => a.name === "Order").discriminator);
const BASKET_DISC = Buffer.from(idl.accounts.find((a) => a.name === "Basket").discriminator);
const FILL = idl.instructions.find((ix) => ix.name === "fill_order");
const ONE_SHARE = 1_000_000n;
const connection = new Connection(RPC, "confirmed");

const short = (k) => k.toBase58().slice(0, 6);
const ata = (mint, owner, program) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** Base58, for the getProgramAccounts memcmp filter. Inline so the script needs only @solana/web3.js. */
function base58(bytes) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ---------------------------------------------------------------- decoding

/** A little-endian cursor over an account's bytes. */
function reader(data, at = 0) {
  let o = at;
  return {
    key: () => new PublicKey(data.subarray(o, (o += 32))),
    u8: () => data[o++],
    u16: () => ((o += 2), data.readUInt16LE(o - 2)),
    u64: () => ((o += 8), data.readBigUInt64LE(o - 8)),
    i64: () => ((o += 8), Number(data.readBigInt64LE(o - 8))),
    str: () => {
      const len = data.readUInt32LE(o);
      o += 4;
      return data.subarray(o, (o += len)).toString("utf8");
    },
    skip: (n) => (o += n),
  };
}

/** `Order` in programs/sheaf/src/lib.rs. */
function decodeOrder(address, data) {
  const r = reader(data, 8);
  const order = { address, basket: r.key(), buyer: r.key(), rentPayer: r.key(), cashMint: r.key(), cashProgram: r.key() };
  order.plan = r.u8() === 1 ? r.key() : null;
  order.nonce = r.u64();
  order.cashAmount = r.u64();
  order.startShares = r.u64();
  order.endShares = r.u64();
  order.startTs = r.i64();
  order.endTs = r.i64();
  return order;
}

/** `Basket` in programs/sheaf/src/lib.rs: the recipe the program will actually pull from the filler. */
function decodeBasket(address, data) {
  if (!Buffer.from(data.subarray(0, 8)).equals(BASKET_DISC)) throw new Error("not a basket");
  const r = reader(data, 8);
  const basket = { address, creator: r.key(), shareMint: r.key(), tokenProgram: r.key(), name: r.str(), symbol: r.str() };
  basket.creatorFeeBps = r.u16();
  const count = r.u8();
  basket.components = [];
  for (let i = 0; i < 8; i++) {
    const c = { mint: r.key(), unitsPerShare: r.u64(), weightBps: r.u16(), decimals: r.u8() };
    r.skip(5);
    if (i < count) basket.components.push(c);
  }
  r.skip(8 + 8 + 8 + 1); // created_at, mint_count, redeem_count, bump
  // The protocol fee sits in the account's headroom: older baskets read 0.
  basket.protocolFeeBps = r.u16();
  return basket;
}

/**
 * A mint's program, decimals and Token-2022 transfer fee for `epoch`, from the
 * raw account. Base layout: 82 bytes, decimals at 44, is_initialized at 45.
 * Token-2022 pads to 165, writes the account type (1 = mint) at 165, then TLV
 * entries { type u16, length u16, value }. TransferFeeConfig (type 1) is two
 * authorities (64 bytes), withheld (8), then the older and newer fee, each
 * { epoch u64, maximum_fee u64, basis_points u16 }; the newer one applies from
 * its epoch on. Throws on anything it cannot read, so callers skip.
 */
function readMint(info, epoch) {
  if (!info) throw new Error("mint account missing");
  if (!info.owner.equals(TOKEN) && !info.owner.equals(TOKEN_2022)) throw new Error("mint not owned by a token program");
  const data = Buffer.from(info.data);
  if (data.length < 82 || data[45] !== 1) throw new Error("not an initialised mint");
  const mint = { program: info.owner, decimals: data[44], fee: { bps: 0n, max: 0n } };
  if (data.length === 82) return mint;
  if (data.length <= 165 || data[165] !== 1) throw new Error("malformed Token-2022 mint");
  for (let at = 166; at + 4 <= data.length; ) {
    const type = data.readUInt16LE(at);
    const len = data.readUInt16LE(at + 2);
    if (type === 0) break;
    if (at + 4 + len > data.length) throw new Error("malformed extension list");
    if (type === 1) {
      if (len < 108) throw new Error("short TransferFeeConfig");
      const older = at + 4 + 72;
      const newer = at + 4 + 90;
      const f = BigInt(epoch) >= data.readBigUInt64LE(newer) ? newer : older;
      mint.fee = { max: data.readBigUInt64LE(f + 8), bps: BigInt(data.readUInt16LE(f + 16)) };
    }
    at += 4 + len;
  }
  return mint;
}

/** Token-2022 `calculate_fee`: ceil(amount * bps / 10000), capped at maximum_fee. */
function transferFee(amount, fee) {
  if (fee.bps === 0n || amount === 0n) return 0n;
  const f = (amount * fee.bps + 9_999n) / 10_000n;
  return f < fee.max ? f : fee.max;
}

/** Token-2022 `calculate_pre_fee_amount`: what to send so `net` arrives. The program grosses deposits up this way. */
function preFeeAmount(net, fee) {
  if (fee.bps === 0n || net === 0n) return net;
  if (fee.bps === 10_000n) return net + fee.max;
  const raw = (net * 10_000n + (10_000n - fee.bps) - 1n) / (10_000n - fee.bps);
  return raw - net >= fee.max ? net + fee.max : raw;
}

/** A token account's raw amount (offset 64), or 0 if it does not exist yet. */
const tokenAmount = (data) => (data && data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n);

// ---------------------------------------------------------------- program math

/** Shares the buyer receives at `t`, exactly as the program computes it. */
function required(o, t) {
  if (t <= o.startTs) return o.startShares;
  if (t >= o.endTs) return o.endShares;
  return o.startShares - ((o.startShares - o.endShares) * BigInt(t - o.startTs)) / BigInt(o.endTs - o.startTs);
}

/**
 * The gross shares whose fees leave exactly `net`, as the program computes it.
 * `feeBps` is the creator fee plus the basket's protocol fee: the program
 * floors the pair once, so the gross depends only on their sum.
 */
function gross(net, feeBps) {
  const netOf = (g) => g - (g * BigInt(feeBps)) / 10_000n;
  let g = (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
  for (let i = 0; i < 3 && g > net && netOf(g - 1n) >= net; i++) g -= 1n;
  return g;
}

// ---------------------------------------------------------------- transaction

/** Create the filler's cash account if it is missing (associated token program, CreateIdempotent). */
function createAtaIdempotent(mint, owner, program) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: filler.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata(mint, owner, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function fillIx(order, basket) {
  const accounts = {
    filler: filler.publicKey,
    order: order.address,
    basket: basket.address,
    share_mint: basket.shareMint,
    buyer: order.buyer,
    buyer_share_account: ata(basket.shareMint, order.buyer, TOKEN_2022),
    creator_share_account: basket.creatorFeeBps > 0 ? ata(basket.shareMint, basket.creator, TOKEN_2022) : null,
    cash_mint: order.cashMint,
    escrow: ata(order.cashMint, order.address, order.cashProgram),
    filler_cash_account: ata(order.cashMint, filler.publicKey, order.cashProgram),
    rent_payer: order.rentPayer,
    plan: order.plan,
    share_token_program: TOKEN_2022,
    component_token_program: basket.tokenProgram,
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
    keys.push({ pubkey: c.mint, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(c.mint, filler.publicKey, basket.tokenProgram), isSigner: false, isWritable: true });
    keys.push({ pubkey: ata(c.mint, basket.address, basket.tokenProgram), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(FILL.discriminator) });
}

// ---------------------------------------------------------------- pricing

/** Mainnet quotes by symbol. Replace this to price from your own feed. */
async function quotesBySymbol() {
  const market = await fetch(`${SITE}/api/market`).then((r) => r.json());
  return new Map(market.quotes.map((q) => [q.symbol, q]));
}

/** devnet mirror mint -> mainnet symbol, from the generated mirror maps. */
function mirrorSymbols() {
  const text = ["mirror.generated.ts", "mirror-prestocks.generated.ts"]
    .map((f) => fs.readFileSync(path.join(ROOT, "web/lib", f), "utf8"))
    .join("\n");
  const map = new Map();
  for (const m of text.matchAll(/"?([A-Za-z0-9]+)"?\s*:\s*\{[^}]*?writeMint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)) map.set(m[2], m[1]);
  return map;
}

// ---------------------------------------------------------------- one pass

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const raw = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: base58(ORDER_DISC) } }] });
  const orders = raw.map((a) => decodeOrder(a.pubkey, a.account.data)).filter((o) => o.endTs > now + 3);
  if (!orders.length) return console.log(new Date().toISOString(), "no open orders");

  // Defence 1: one cash mint. Everything else is skipped before any other work.
  const accepted = [];
  for (const o of orders) {
    if (o.cashMint.equals(CASH_MINT)) accepted.push(o);
    else console.log(`${short(o.address)} skipped: unknown cash mint ${o.cashMint.toBase58()}`);
  }
  if (!accepted.length) return;

  // Defences 2 and 3: decimals and transfer fee from the mint itself, read fresh every pass.
  const { epoch } = await connection.getEpochInfo();
  let cash;
  try {
    cash = readMint(await connection.getAccountInfo(CASH_MINT), epoch);
  } catch (e) {
    return console.log(`skipped all: cash mint ${CASH_MINT.toBase58()} unreadable (${e.message})`);
  }

  const quotes = await quotesBySymbol();
  const symbols = mirrorSymbols();
  const basketKeys = [...new Set(accepted.map((o) => o.basket.toBase58()))].map((k) => new PublicKey(k));
  const basketInfos = await connection.getMultipleAccountsInfo(basketKeys);
  const baskets = new Map();
  basketKeys.forEach((k, i) => {
    const info = basketInfos[i];
    if (!info || !info.owner.equals(PROGRAM_ID)) return;
    try {
      baskets.set(k.toBase58(), decodeBasket(k, info.data));
    } catch {}
  });

  for (const order of accepted) {
    const id = short(order.address);
    const basket = baskets.get(order.basket.toBase58());
    if (!basket) {
      console.log(`${id} skipped: basket ${order.basket.toBase58()} not readable on chain`);
      continue;
    }
    if (!order.cashProgram.equals(cash.program)) {
      console.log(`${id} skipped: cash program ${order.cashProgram.toBase58()} is not the mint's owner`);
      continue;
    }

    // What the filler is paid: the escrow's whole balance, less the cash mint's fee this epoch.
    const escrowKey = ata(order.cashMint, order.address, order.cashProgram);
    const fillerCash = ata(order.cashMint, filler.publicKey, order.cashProgram);
    const componentMints = basket.components.map((c) => c.mint);
    const fillerComponents = basket.components.map((c) => ata(c.mint, filler.publicKey, basket.tokenProgram));
    const [escrowInfo, fillerCashInfo, ...rest] = await connection.getMultipleAccountsInfo([
      escrowKey,
      fillerCash,
      ...componentMints,
      ...fillerComponents,
    ]);
    const mintInfos = rest.slice(0, componentMints.length);
    const holdingInfos = rest.slice(componentMints.length);
    if (!escrowInfo) {
      console.log(`${id} skipped: escrow missing`);
      continue;
    }
    const payoutGross = tokenAmount(escrowInfo.data);
    const payoutNet = payoutGross - transferFee(payoutGross, cash.fee);
    const dollars = Number(payoutNet) / 10 ** cash.decimals;

    // Defence 4: the stocks the program will pull, from the on-chain recipe, grossed up for their own fees.
    const t = Math.floor(Date.now() / 1000) + 3;
    const shares = required(order, t);
    const g = gross(shares, basket.creatorFeeBps + basket.protocolFeeBps);
    const tag = `${id} ${basket.symbol} $${dollars.toFixed(2)} net`;
    let cost = 0;
    const deliver = [];
    let unpriced = null;
    for (const [i, c] of basket.components.entries()) {
      const q = quotes.get(symbols.get(c.mint.toBase58()));
      let mint;
      try {
        mint = readMint(mintInfos[i], epoch);
      } catch (e) {
        unpriced = `component ${c.mint.toBase58()} unreadable (${e.message})`;
        break;
      }
      if (!q) {
        unpriced = `no quote for ${c.mint.toBase58()}`;
        break;
      }
      const target = (c.unitsPerShare * g + ONE_SHARE - 1n) / ONE_SHARE;
      const amount = preFeeAmount(target, mint.fee);
      deliver.push(amount);
      cost += (Number(amount) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
    }
    if (unpriced || cost <= 0) {
      console.log(`${tag} skipped: ${unpriced ?? "zero cost"}`);
      continue;
    }
    const edge = (dollars - cost) / cost;
    if (edge * 10_000 < EDGE_BPS) {
      console.log(`${tag} cost $${cost.toFixed(2)}, edge ${(edge * 100).toFixed(2)}%, waiting`);
      continue;
    }

    // Defence 5: simulate the exact signed transaction and check what it does to the filler's accounts.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: filler.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          createAtaIdempotent(order.cashMint, filler.publicKey, order.cashProgram),
          fillIx(order, basket),
        ],
      }).compileToV0Message(),
    );
    tx.sign([filler]);
    const watched = [fillerCash, ...fillerComponents];
    const sim = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: watched.map((k) => k.toBase58()) },
    });
    const plan = `fill ${Number(shares) / 1e6} shares for $${dollars.toFixed(2)} at cost $${cost.toFixed(2)}, edge ${(edge * 100).toFixed(2)}%`;
    if (sim.value.err) {
      const why = (sim.value.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
      console.log(`${tag} skipped: simulation failed (${why.slice(0, 160)})${DRY_RUN ? `; would ${plan}` : ""}`);
      continue;
    }
    const after = sim.value.accounts.map((a) => (a ? Buffer.from(a.data[0], "base64") : null));
    const cashGain = tokenAmount(after[0]) - tokenAmount(fillerCashInfo?.data);
    if (cashGain < payoutNet) {
      console.log(`${tag} skipped: simulation pays ${cashGain} raw, expected at least ${payoutNet}`);
      continue;
    }
    const overdrawn = basket.components.findIndex(
      (c, i) => tokenAmount(holdingInfos[i]?.data) - tokenAmount(after[i + 1]) > deliver[i],
    );
    if (overdrawn > -1) {
      console.log(`${tag} skipped: simulation takes more ${basket.components[overdrawn].mint.toBase58()} than priced`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`${tag} DRY RUN would ${plan} (simulation ok)`);
      continue;
    }
    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      console.log(`${tag} FILLED: ${plan}`, sig);
    } catch (err) {
      console.log(`${tag} fill failed:`, String(err.message ?? err).slice(0, 160));
    }
  }
}

console.log(
  `filler ${filler.publicKey.toBase58()} on ${RPC}, cash mint ${CASH_MINT.toBase58()}, edge ${EDGE_BPS} bps${DRY_RUN ? ", dry run" : ""}`,
);
do {
  await tick().catch((e) => console.log("tick failed:", e.message));
  if (!ONCE) await new Promise((r) => setTimeout(r, 5000));
} while (!ONCE);
