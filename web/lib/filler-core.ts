/**
 * The reference filler's decision code, shared by scripts/filler.mjs (anyone's
 * filler, run from a terminal) and /api/filler2 (the second filler the site runs
 * on its own key), so the two can never drift.
 *
 * It depends on @solana/web3.js only and is written in plain, erasable
 * TypeScript, so Node 22.18+ runs it directly (type stripping) and Next bundles
 * it like any other module. The script imports web3 from here too, so both use
 * one copy of the library.
 *
 * A pass reads every open order, keeps the ones in the accepted cash mint,
 * prices the stocks the auction asks for at the caller's quotes (with every
 * Token-2022 transfer fee grossed up), and fills when the dollars beat that cost
 * by the caller's margin. Before it sends, it simulates the exact signed
 * transaction and checks that its cash account grows by at least the expected
 * payout and that no component leaves it in a larger amount than was priced.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";

export { AddressLookupTableAccount, Connection, Keypair, PublicKey };

export const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ONE_SHARE = 1_000_000n;

/** The parts of the program's IDL a filler needs. */
export type FillerIdl = {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  instructions: { name: string; discriminator: number[]; accounts: { name: string; address?: string; optional?: boolean; signer?: boolean; writable?: boolean }[] }[];
};

export type CoreOrder = {
  address: PublicKey;
  basket: PublicKey;
  buyer: PublicKey;
  rentPayer: PublicKey;
  cashMint: PublicKey;
  cashProgram: PublicKey;
  plan: PublicKey | null;
  nonce: bigint;
  cashAmount: bigint;
  startShares: bigint;
  endShares: bigint;
  startTs: number;
  endTs: number;
};

export type CoreComponent = { mint: PublicKey; unitsPerShare: bigint; weightBps: number; decimals: number };
export type CoreBasket = {
  address: PublicKey;
  creator: PublicKey;
  shareMint: PublicKey;
  tokenProgram: PublicKey;
  name: string;
  symbol: string;
  creatorFeeBps: number;
  protocolFeeBps: number;
  components: CoreComponent[];
};

export type Quote = { price: number; multiplier?: number };
type Fee = { bps: bigint; max: bigint };
type MintInfo = { program: PublicKey; decimals: number; fee: Fee };

export const ata = (mint: PublicKey, owner: PublicKey, program: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

const bytes = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Base58, for the getProgramAccounts memcmp filter. */
function base58(input: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (bytes(input).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of input) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// ---------------------------------------------------------------- decoding

function reader(data: Buffer, at = 0) {
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
    skip: (n: number) => (o += n),
  };
}

/** `Order` in programs/sheaf/src/lib.rs. */
export function decodeOrder(address: PublicKey, data: Uint8Array): CoreOrder {
  const r = reader(bytes(data), 8);
  const basket = r.key();
  const buyer = r.key();
  const rentPayer = r.key();
  const cashMint = r.key();
  const cashProgram = r.key();
  const plan = r.u8() === 1 ? r.key() : null;
  return {
    address,
    basket,
    buyer,
    rentPayer,
    cashMint,
    cashProgram,
    plan,
    nonce: r.u64(),
    cashAmount: r.u64(),
    startShares: r.u64(),
    endShares: r.u64(),
    startTs: r.i64(),
    endTs: r.i64(),
  };
}

/** `Basket` in programs/sheaf/src/lib.rs: the recipe the program will actually pull from the filler. */
export function decodeBasket(address: PublicKey, data: Uint8Array, discriminator: Uint8Array): CoreBasket {
  const buf = bytes(data);
  if (!buf.subarray(0, 8).equals(Buffer.from(discriminator))) throw new Error("not a basket");
  const r = reader(buf, 8);
  const creator = r.key();
  const shareMint = r.key();
  const tokenProgram = r.key();
  const name = r.str();
  const symbol = r.str();
  const creatorFeeBps = r.u16();
  const count = r.u8();
  const components: CoreComponent[] = [];
  for (let i = 0; i < 8; i++) {
    const c = { mint: r.key(), unitsPerShare: r.u64(), weightBps: r.u16(), decimals: r.u8() };
    r.skip(5);
    if (i < count) components.push(c);
  }
  r.skip(8 + 8 + 8 + 1); // created_at, mint_count, redeem_count, bump
  // The protocol fee sits in the account's headroom: older baskets read 0.
  const protocolFeeBps = r.u16();
  return { address, creator, shareMint, tokenProgram, name, symbol, creatorFeeBps, protocolFeeBps, components };
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
export function readMint(info: AccountInfo<Buffer> | null, epoch: number): MintInfo {
  if (!info) throw new Error("mint account missing");
  if (!info.owner.equals(TOKEN) && !info.owner.equals(TOKEN_2022)) throw new Error("mint not owned by a token program");
  const data = bytes(info.data);
  if (data.length < 82 || data[45] !== 1) throw new Error("not an initialised mint");
  const mint: MintInfo = { program: info.owner, decimals: data[44], fee: { bps: 0n, max: 0n } };
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
export function transferFee(amount: bigint, fee: Fee): bigint {
  if (fee.bps === 0n || amount === 0n) return 0n;
  const f = (amount * fee.bps + 9_999n) / 10_000n;
  return f < fee.max ? f : fee.max;
}

/** Token-2022 `calculate_pre_fee_amount`: what to send so `net` arrives. The program grosses deposits up this way. */
export function preFeeAmount(net: bigint, fee: Fee): bigint {
  if (fee.bps === 0n || net === 0n) return net;
  if (fee.bps === 10_000n) return net + fee.max;
  const raw = (net * 10_000n + (10_000n - fee.bps) - 1n) / (10_000n - fee.bps);
  return raw - net >= fee.max ? net + fee.max : raw;
}

/** A token account's raw amount (offset 64), or 0 if it does not exist yet. */
export const tokenAmount = (data: Uint8Array | null | undefined) => (data && data.length >= 72 ? bytes(data).readBigUInt64LE(64) : 0n);

// ---------------------------------------------------------------- program math

/** Shares the buyer receives at `t`, exactly as the program computes it. */
export function required(o: Pick<CoreOrder, "startShares" | "endShares" | "startTs" | "endTs">, t: number): bigint {
  if (t <= o.startTs) return o.startShares;
  if (t >= o.endTs) return o.endShares;
  return o.startShares - ((o.startShares - o.endShares) * BigInt(t - o.startTs)) / BigInt(o.endTs - o.startTs);
}

/**
 * The gross shares whose fees leave exactly `net`, as the program computes it.
 * `feeBps` is the creator fee plus the basket's protocol fee: the program
 * floors the pair once, so the gross depends only on their sum.
 */
export function gross(net: bigint, feeBps: number): bigint {
  const netOf = (g: bigint) => g - (g * BigInt(feeBps)) / 10_000n;
  let g = (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
  for (let i = 0; i < 3 && g > net && netOf(g - 1n) >= net; i++) g -= 1n;
  return g;
}

// ---------------------------------------------------------------- transaction

/** Create an associated token account if it is missing (associated token program, CreateIdempotent). */
export function createAtaIdempotent(payer: PublicKey, mint: PublicKey, owner: PublicKey, program: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(mint, owner, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function fillIx(idl: FillerIdl, filler: PublicKey, order: CoreOrder, basket: CoreBasket) {
  const programId = new PublicKey(idl.address);
  const FILL = idl.instructions.find((ix) => ix.name === "fill_order")!;
  const accounts: Record<string, PublicKey | null> = {
    filler,
    order: order.address,
    basket: basket.address,
    share_mint: basket.shareMint,
    buyer: order.buyer,
    buyer_share_account: ata(basket.shareMint, order.buyer, TOKEN_2022),
    creator_share_account: basket.creatorFeeBps > 0 ? ata(basket.shareMint, basket.creator, TOKEN_2022) : null,
    cash_mint: order.cashMint,
    escrow: ata(order.cashMint, order.address, order.cashProgram),
    filler_cash_account: ata(order.cashMint, filler, order.cashProgram),
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
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false };
      throw new Error(`fill_order: no value for ${a.name}`);
    }
    return { pubkey: k, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  for (const c of basket.components) {
    keys.push({ pubkey: c.mint, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(c.mint, filler, basket.tokenProgram), isSigner: false, isWritable: true });
    keys.push({ pubkey: ata(c.mint, basket.address, basket.tokenProgram), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId, keys, data: Buffer.from(FILL.discriminator) });
}

// ---------------------------------------------------------------- one pass

export type PassOptions = {
  connection: Connection;
  filler: Keypair;
  idl: FillerIdl;
  /** The only cash mint accepted; orders in any other are skipped before any other work. */
  cashMint: PublicKey;
  /** Minimum margin over cost, in basis points. */
  edgeBps: number;
  /** A quote for a component mint (the write-cluster mint), or undefined when unpriced. */
  quote: (mint: PublicKey) => Quote | undefined;
  /** Price and simulate, but sign nothing that is sent. */
  dryRun?: boolean;
  /** Wait inside the pass, up to this many seconds, for an order about to reach the margin. */
  waitUpToSecs?: number;
  /** The basket's lookup table, for 7–8 component baskets whose fill does not fit a legacy-sized packet. */
  lookupTable?: (basket: CoreBasket) => Promise<AddressLookupTableAccount | null>;
  /** Called with what the filler is short of, before an order it would otherwise price. */
  shortOf?: (basket: CoreBasket, mints: PublicKey[]) => void;
  log?: (line: string) => void;
};

export type PassResult = { filled: { order: string; basket: string; dollars: number; cost: number; edgeBps: number; signature: string }[]; considered: number };

const short = (k: PublicKey) => k.toBase58().slice(0, 6);

/** The cluster's clock (the newest block's time), carried forward by the wall clock. */
async function chainClock(connection: Connection): Promise<() => number> {
  const wall = () => Math.floor(Date.now() / 1000);
  try {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    if (t == null) return wall;
    const offset = t - wall();
    return () => wall() + offset;
  } catch {
    return wall;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFillerPass(o: PassOptions): Promise<PassResult> {
  const { connection, filler, idl, cashMint, edgeBps } = o;
  const log = o.log ?? (() => {});
  const result: PassResult = { filled: [], considered: 0 };
  const programId = new PublicKey(idl.address);
  const ORDER_DISC = Uint8Array.from(idl.accounts.find((a) => a.name === "Order")!.discriminator);
  const BASKET_DISC = Uint8Array.from(idl.accounts.find((a) => a.name === "Basket")!.discriminator);
  const now = Math.floor(Date.now() / 1000);
  const raw = await connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: base58(ORDER_DISC) } }] });
  const orders = raw.map((a) => decodeOrder(a.pubkey, a.account.data)).filter((x) => x.endTs > now + 3);
  if (!orders.length) {
    log("no open orders");
    return result;
  }

  // Defence 1: one cash mint. Everything else is skipped before any other work.
  const accepted = orders.filter((x) => {
    if (x.cashMint.equals(cashMint)) return true;
    log(`${short(x.address)} skipped: unknown cash mint ${x.cashMint.toBase58()}`);
    return false;
  });
  if (!accepted.length) return result;
  result.considered = accepted.length;

  // Defences 2 and 3: decimals and transfer fee from the mint itself, read fresh every pass.
  const [{ epoch }, clock] = await Promise.all([connection.getEpochInfo(), chainClock(connection)]);
  let cash: MintInfo;
  try {
    cash = readMint(await connection.getAccountInfo(cashMint), epoch);
  } catch (e) {
    log(`skipped all: cash mint ${cashMint.toBase58()} unreadable (${(e as Error).message})`);
    return result;
  }

  const basketKeys = [...new Set(accepted.map((x) => x.basket.toBase58()))].map((k) => new PublicKey(k));
  const basketInfos = await connection.getMultipleAccountsInfo(basketKeys);
  const baskets = new Map<string, CoreBasket>();
  basketKeys.forEach((k, i) => {
    const info = basketInfos[i];
    if (!info || !info.owner.equals(programId)) return;
    try {
      baskets.set(k.toBase58(), decodeBasket(k, info.data, BASKET_DISC));
    } catch {
      // not a basket
    }
  });

  for (const order of accepted) {
    const id = short(order.address);
    try {
      const basket = baskets.get(order.basket.toBase58());
      if (!basket) {
        log(`${id} skipped: basket ${order.basket.toBase58()} not readable on chain`);
        continue;
      }
      if (!order.cashProgram.equals(cash.program)) {
        log(`${id} skipped: cash program ${order.cashProgram.toBase58()} is not the mint's owner`);
        continue;
      }
      const fill = await priceAndFill(o, order, basket, cash, epoch, clock, log);
      if (fill) result.filled.push(fill);
    } catch (err) {
      // One bad order never ends the pass.
      log(`${id} failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  return result;
}

async function priceAndFill(
  o: PassOptions,
  order: CoreOrder,
  basket: CoreBasket,
  cash: MintInfo,
  epoch: number,
  clock: () => number,
  log: (line: string) => void,
): Promise<PassResult["filled"][number] | null> {
  const { connection, filler, idl, edgeBps } = o;
  const id = short(order.address);
  // What the filler is paid: the escrow's whole balance, less the cash mint's fee this epoch.
  const escrowKey = ata(order.cashMint, order.address, order.cashProgram);
  const fillerCash = ata(order.cashMint, filler.publicKey, order.cashProgram);
  const componentMints = basket.components.map((c) => c.mint);
  const fillerComponents = basket.components.map((c) => ata(c.mint, filler.publicKey, basket.tokenProgram));
  const [escrowInfo, fillerCashInfo, ...rest] = await connection.getMultipleAccountsInfo([escrowKey, fillerCash, ...componentMints, ...fillerComponents]);
  const mintInfos = rest.slice(0, componentMints.length);
  const holdingInfos = rest.slice(componentMints.length);
  if (!escrowInfo) {
    log(`${id} skipped: escrow missing`);
    return null;
  }
  const payoutGross = tokenAmount(escrowInfo.data);
  const payoutNet = payoutGross - transferFee(payoutGross, cash.fee);
  const dollars = Number(payoutNet) / 10 ** cash.decimals;
  const feeBps = basket.creatorFeeBps + basket.protocolFeeBps;
  const mints: MintInfo[] = [];
  for (const [i, c] of basket.components.entries()) {
    try {
      mints.push(readMint(mintInfos[i] as AccountInfo<Buffer> | null, epoch));
    } catch (e) {
      log(`${id} ${basket.symbol} skipped: component ${c.mint.toBase58()} unreadable (${(e as Error).message})`);
      return null;
    }
  }

  // Defence 4: the stocks the program will pull, from the on-chain recipe, grossed up for their own fees.
  const priceAt = (t: number) => {
    const shares = required(order, t);
    const g = gross(shares, feeBps);
    let cost = 0;
    const deliver: bigint[] = [];
    for (const [i, c] of basket.components.entries()) {
      const q = o.quote(c.mint);
      if (!q) return { error: `no quote for ${c.mint.toBase58()}` } as const;
      const target = (c.unitsPerShare * g + ONE_SHARE - 1n) / ONE_SHARE;
      const amount = preFeeAmount(target, mints[i].fee);
      deliver.push(amount);
      cost += (Number(amount) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
    }
    return { shares, cost, deliver, edge: cost > 0 ? (dollars - cost) / cost : -1 } as const;
  };
  const tag = `${id} ${basket.symbol} $${dollars.toFixed(2)} net`;
  // Priced at the cluster's own clock: the auction only decays, so the count owed
  // now is the most the fill can need when it lands a moment later.
  let t = clock();
  let p = priceAt(t);
  if ("error" in p) {
    log(`${tag} skipped: ${p.error}`);
    return null;
  }
  if (p.edge * 10_000 < edgeBps && o.waitUpToSecs) {
    // The auction only decays, so find the first second inside the wait window that clears the margin.
    for (let dt = 1; dt <= o.waitUpToSecs; dt++) {
      const q = priceAt(t + dt);
      if (!("error" in q) && q.edge * 10_000 >= edgeBps) {
        log(`${tag} margin in ${dt}s, waiting`);
        await sleep(dt * 1000);
        t = clock();
        p = priceAt(t);
        break;
      }
    }
  }
  if ("error" in p) return null;
  if (p.edge * 10_000 < edgeBps) {
    log(`${tag} cost $${p.cost.toFixed(2)}, edge ${(p.edge * 100).toFixed(2)}%, waiting`);
    return null;
  }
  const missing = basket.components.filter((_, i) => tokenAmount(holdingInfos[i]?.data) < p.deliver[i]).map((c) => c.mint);
  if (missing.length) {
    o.shortOf?.(basket, missing);
    log(`${tag} skipped: holds too little of ${missing.map((m) => short(m)).join(", ")}`);
    return null;
  }

  // Defence 5: simulate the exact signed transaction and check what it does to the filler's accounts.
  const table = basket.components.length > 6 && o.lookupTable ? await o.lookupTable(basket) : null;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: filler.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAtaIdempotent(filler.publicKey, order.cashMint, filler.publicKey, order.cashProgram),
        fillIx(idl, filler.publicKey, order, basket),
      ],
    }).compileToV0Message(table ? [table] : []),
  );
  tx.sign([filler]);
  const watched = [fillerCash, ...fillerComponents];
  const sim = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: watched.map((k) => k.toBase58()) },
  });
  const plan = `fill ${Number(p.shares) / 1e6} shares for $${dollars.toFixed(2)} at cost $${p.cost.toFixed(2)}, edge ${(p.edge * 100).toFixed(2)}%`;
  if (sim.value.err) {
    const why = (sim.value.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
    log(`${tag} skipped: simulation failed (${why.slice(0, 160)})${o.dryRun ? `; would ${plan}` : ""}`);
    return null;
  }
  const after = (sim.value.accounts ?? []).map((a) => (a ? Buffer.from(a.data[0], "base64") : null));
  const cashGain = tokenAmount(after[0]) - tokenAmount(fillerCashInfo?.data);
  if (cashGain < payoutNet) {
    log(`${tag} skipped: simulation pays ${cashGain} raw, expected at least ${payoutNet}`);
    return null;
  }
  const overdrawn = basket.components.findIndex((_, i) => tokenAmount(holdingInfos[i]?.data) - tokenAmount(after[i + 1]) > p.deliver[i]);
  if (overdrawn > -1) {
    log(`${tag} skipped: simulation takes more ${basket.components[overdrawn].mint.toBase58()} than priced`);
    return null;
  }
  if (o.dryRun) {
    log(`${tag} DRY RUN would ${plan} (simulation ok)`);
    return null;
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(JSON.stringify(res.value.err));
  log(`${tag} FILLED: ${plan} ${signature}`);
  return { order: order.address.toBase58(), basket: basket.symbol, dollars, cost: p.cost, edgeBps: Math.round(p.edge * 100_000) / 10, signature };
}
