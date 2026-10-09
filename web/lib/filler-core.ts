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
 * by the caller's margin, on live Jupiter quotes only (a fallback or snapshot
 * price means no fill). It never fills more than 1% over fair for the buyer
 * (maxOverFairBps): the auction only gets dearer from there, so such an order is
 * left to run out and be refunded. It sends each fill about 1.8 s before the
 * margin's second (leadMs), so the fill lands on that second rather than two
 * seconds past it, and reports the margin at the second the fill actually
 * executed. Before it sends, it simulates the exact signed
 * transaction and checks that its cash account grows by at least the expected
 * payout and that no component leaves it in a larger amount than was priced.
 *
 * It buys on the dollar exit too: a holder's sell order is filled once the cash
 * it asks (decaying to the seller's floor) is at most the redeemed stocks' value
 * less the margin, and the shares are redeemed in kind in the same transaction,
 * after a simulation shows the cash leaving is no more than priced and every
 * component arriving is at least what was priced.
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
/**
 * Passed as the last remaining account on every fill and sale, so the program
 * can pay into an account that requires a memo on incoming transfers.
 */
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
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

export type CoreSellOrder = {
  address: PublicKey;
  basket: PublicKey;
  seller: PublicKey;
  rentPayer: PublicKey;
  cashMint: PublicKey;
  cashProgram: PublicKey;
  nonce: bigint;
  shares: bigint;
  startCash: bigint;
  endCash: bigint;
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

/**
 * A component's price. `source` is where it came from, when the feed says: only
 * a live Jupiter quote is filled on. A fallback (GeckoTerminal) or last-good
 * snapshot price may be shown on a page but is treated as no quote at all, so a
 * component priced from one means no fill.
 */
export type Quote = { price: number; multiplier?: number; source?: string };
/** A quote the filler may fill on: present, and live from Jupiter when its source is named. */
const live = (q: Quote | undefined): q is Quote => q != null && (q.source == null || q.source === "jupiter");
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

/** `SellOrder` in programs/sheaf/src/lib.rs. */
export function decodeSellOrder(address: PublicKey, data: Uint8Array): CoreSellOrder {
  const r = reader(bytes(data), 8);
  return {
    address,
    basket: r.key(),
    seller: r.key(),
    rentPayer: r.key(),
    cashMint: r.key(),
    cashProgram: r.key(),
    nonce: r.u64(),
    shares: r.u64(),
    startCash: r.u64(),
    endCash: r.u64(),
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
  keys.push({ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false });
  return new TransactionInstruction({ programId, keys, data: Buffer.from(FILL.discriminator) });
}

/** fill_sell_order: pay the seller (their canonical cash account, opened at the filler's expense if missing), take the escrowed shares. */
export function fillSellIx(idl: FillerIdl, filler: PublicKey, order: CoreSellOrder, basket: CoreBasket) {
  const programId = new PublicKey(idl.address);
  const FILL = idl.instructions.find((ix) => ix.name === "fill_sell_order")!;
  const accounts: Record<string, PublicKey> = {
    filler,
    sell_order: order.address,
    basket: basket.address,
    share_mint: basket.shareMint,
    escrow: ata(basket.shareMint, order.address, TOKEN_2022),
    filler_share_account: ata(basket.shareMint, filler, TOKEN_2022),
    seller: order.seller,
    seller_cash_account: ata(order.cashMint, order.seller, order.cashProgram),
    cash_mint: order.cashMint,
    filler_cash_account: ata(order.cashMint, filler, order.cashProgram),
    rent_payer: order.rentPayer,
    share_token_program: TOKEN_2022,
    cash_token_program: order.cashProgram,
  };
  const keys = FILL.accounts.map((a) => ({
    pubkey: a.address ? new PublicKey(a.address) : accounts[a.name],
    isSigner: !!a.signer,
    isWritable: !!a.writable,
  }));
  keys.push({ pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false });
  return new TransactionInstruction({ programId, keys, data: Buffer.from(FILL.discriminator) });
}

/** redeem_shares: burn `shares` and take the recipe in kind, three remaining accounts per component (mint, vault, recipient). */
export function redeemIx(idl: FillerIdl, owner: PublicKey, basket: CoreBasket, shares: bigint) {
  const programId = new PublicKey(idl.address);
  const REDEEM = idl.instructions.find((ix) => ix.name === "redeem_shares")!;
  const accounts: Record<string, PublicKey> = {
    basket: basket.address,
    share_mint: basket.shareMint,
    owner,
    owner_share_account: ata(basket.shareMint, owner, TOKEN_2022),
    share_token_program: TOKEN_2022,
    component_token_program: basket.tokenProgram,
  };
  const keys = REDEEM.accounts.map((a) => ({ pubkey: a.address ? new PublicKey(a.address) : accounts[a.name], isSigner: !!a.signer, isWritable: !!a.writable }));
  for (const c of basket.components) {
    keys.push({ pubkey: c.mint, isSigner: false, isWritable: false });
    keys.push({ pubkey: ata(c.mint, basket.address, basket.tokenProgram), isSigner: false, isWritable: true });
    keys.push({ pubkey: ata(c.mint, owner, basket.tokenProgram), isSigner: false, isWritable: true });
  }
  const data = Buffer.alloc(16);
  Buffer.from(REDEEM.discriminator).copy(data, 0);
  data.writeBigUInt64LE(shares, 8);
  return new TransactionInstruction({ programId, keys, data });
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
  /**
   * The most over fair a buyer may pay (or under fair a seller may receive)
   * through this filler, in basis points (default 100). The auction only gets
   * dearer for the buyer, so an order already past it is never filled: it runs
   * out and its dollars go back.
   */
  maxOverFairBps?: number;
  /**
   * How long before the margin's second a fill is sent, in milliseconds (default
   * 1,800). The cluster clock this filler reads (the newest confirmed block's
   * time) runs about a second behind, and a transaction executes about half a
   * second after it is sent; without the lead a fill lands about two seconds, some
   * 8 bps on a 90-second auction, past the margin it waited for.
   */
  leadMs?: number;
  /** A quote for a component mint (the write-cluster mint), or undefined when unpriced. */
  quote: (mint: PublicKey) => Quote | undefined;
  /** Price and simulate, but sign nothing that is sent. */
  dryRun?: boolean;
  /** Wait inside the pass, up to this many seconds, for an order about to reach the margin. */
  waitUpToSecs?: number;
  /** Total seconds the pass may spend, waits included (default 45). */
  passBudgetSecs?: number;
  /** The basket's lookup table, for 7–8 component baskets whose fill does not fit a legacy-sized packet. */
  lookupTable?: (basket: CoreBasket) => Promise<AddressLookupTableAccount | null>;
  /** Called with what the filler is short of, before an order it would otherwise price. */
  shortOf?: (basket: CoreBasket, mints: PublicKey[]) => void;
  /** Called when a sell order is worth buying but the filler holds too few dollars. */
  shortOfCash?: (needed: bigint) => void;
  log?: (line: string) => void;
};

export type PassResult = {
  /** `landed`: the edge is the one at the second the fill executed, read from its block (else the filler's estimate). */
  filled: { side: "buy" | "sell"; order: string; basket: string; dollars: number; cost: number; edgeBps: number; signature: string; landed?: boolean }[];
  considered: number;
};

const short = (k: PublicKey) => k.toBase58().slice(0, 6);
/** A fill is only sent with at least this long left in the auction, so it lands before the end. */
const MIN_SECS_LEFT = 5;
const DEFAULT_MAX_OVER_FAIR_BPS = 100;
const DEFAULT_LEAD_MS = 1_800;

/** The cluster's clock (the newest confirmed block's time), carried forward by the wall clock, in milliseconds. */
async function chainClockMs(connection: Connection): Promise<() => number> {
  const wall = () => Date.now();
  try {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    if (t == null) return wall;
    const offset = t * 1000 - Date.now();
    return () => Date.now() + offset;
  } catch {
    return wall;
  }
}

/** The clock in milliseconds, and in whole seconds as the program reads it. */
type Clock = { ms: () => number; secs: () => number };

/** The second a confirmed transaction executed at, from its block: what the program's clock read. Null if unknown. */
async function landedAt(connection: Connection, signature: string): Promise<number | null> {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  return tx?.blockTime ?? null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFillerPass(o: PassOptions): Promise<PassResult> {
  const { connection, filler, idl, cashMint } = o;
  const log = o.log ?? (() => {});
  const result: PassResult = { filled: [], considered: 0 };
  const programId = new PublicKey(idl.address);
  const ORDER_DISC = Uint8Array.from(idl.accounts.find((a) => a.name === "Order")!.discriminator);
  const BASKET_DISC = Uint8Array.from(idl.accounts.find((a) => a.name === "Basket")!.discriminator);
  const now = Math.floor(Date.now() / 1000);
  const SELL_DISC = idl.accounts.find((a) => a.name === "SellOrder");
  const [raw, rawSells] = await Promise.all([
    connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: base58(ORDER_DISC) } }] }),
    SELL_DISC
      ? connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: base58(Uint8Array.from(SELL_DISC.discriminator)) } }] })
      : Promise.resolve([]),
  ]);
  const orders = raw.map((a) => decodeOrder(a.pubkey, a.account.data)).filter((x) => x.endTs > now + 3);
  const sells = rawSells
    .map((a) => decodeSellOrder(a.pubkey, a.account.data))
    .filter((x) => x.endTs > now + 3 && !x.seller.equals(filler.publicKey) && x.cashMint.equals(cashMint));
  if (!orders.length && !sells.length) {
    log("no open orders");
    return result;
  }

  // Defence 1: one cash mint. Everything else is skipped before any other work.
  const accepted = orders.filter((x) => {
    if (x.cashMint.equals(cashMint)) return true;
    log(`${short(x.address)} skipped: unknown cash mint ${x.cashMint.toBase58()}`);
    return false;
  });
  if (!accepted.length && !sells.length) return result;
  result.considered = accepted.length + sells.length;

  // Defences 2 and 3: decimals and transfer fee from the mint itself, read fresh every pass.
  const [{ epoch }, clockMs] = await Promise.all([connection.getEpochInfo(), chainClockMs(connection)]);
  const clock: Clock = { ms: clockMs, secs: () => Math.floor(clockMs() / 1000) };
  const leadMs = o.leadMs ?? DEFAULT_LEAD_MS;
  let cash: MintInfo;
  try {
    cash = readMint(await connection.getAccountInfo(cashMint), epoch);
  } catch (e) {
    log(`skipped all: cash mint ${cashMint.toBase58()} unreadable (${(e as Error).message})`);
    return result;
  }

  const basketKeys = [...new Set([...accepted, ...sells].map((x) => x.basket.toBase58()))].map((k) => new PublicKey(k));
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

  // Every order is priced first. One that clears the margin within the wait window
  // is queued, soonest first, and waited for under one shared deadline, then
  // re-checked: still open, and still worth it.
  const passDeadline = Date.now() + (o.passBudgetSecs ?? 45) * 1000;
  const pending: { dueAt: number; lead: boolean; run: (opts: PassOptions) => Promise<Priced>; address: PublicKey; id: string }[] = [];
  const take = (r: Priced, run: (opts: PassOptions) => Promise<Priced>, address: PublicKey, id: string) => {
    // Due at chain second `at`: sent `leadMs` before the clock reads it, so it lands on it.
    if (r && "at" in r) pending.push({ dueAt: Date.now() + (r.at * 1000 - (r.lead ? leadMs : 0) - clock.ms()), lead: r.lead, run, address, id });
    else if (r) result.filled.push(r);
  };
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
      const run = (opts: PassOptions) => priceAndFill(opts, order, basket, cash, epoch, clock, log);
      take(await run(o), run, order.address, id);
    } catch (err) {
      // One bad order never ends the pass.
      log(`${id} failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  for (const order of sells) {
    const id = short(order.address);
    try {
      const basket = baskets.get(order.basket.toBase58());
      if (!basket) {
        log(`sell ${id} skipped: basket ${order.basket.toBase58()} not readable on chain`);
        continue;
      }
      if (!order.cashProgram.equals(cash.program)) {
        log(`sell ${id} skipped: cash program ${order.cashProgram.toBase58()} is not the mint's owner`);
        continue;
      }
      const run = (opts: PassOptions) => priceAndFillSell(opts, order, basket, cash, epoch, clock, log);
      take(await run(o), run, order.address, `sell ${id}`);
    } catch (err) {
      log(`sell ${id} failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  pending.sort((x, y) => x.dueAt - y.dueAt);
  for (const job of pending) {
    if (job.dueAt > passDeadline) {
      log(`${job.id} skipped: its margin comes after this pass's deadline`);
      continue;
    }
    if (job.dueAt > Date.now()) await sleep(job.dueAt - Date.now());
    try {
      // Cancelled or filled by someone else during the wait: nothing to do.
      if (!(await connection.getAccountInfo(job.address))) {
        log(`${job.id} gone during the wait`);
        continue;
      }
      const r = await job.run({ ...o, waitUpToSecs: 0, leadMs: job.lead ? leadMs : 0 });
      if (r && !("at" in r)) result.filled.push(r);
    } catch (err) {
      log(`${job.id} failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  return result;
}

/**
 * A priced order: filled, due at chain second `at` (sent early when `lead`, which
 * is only when landing a second early would still not lose money), or nothing to do.
 */
type Priced = PassResult["filled"][number] | { at: number; lead: boolean } | null;

/**
 * The second a fill sent now should land on: with the lead, the clock reads
 * about `leadMs` before it; never earlier than the clock's own second.
 */
const landingSecond = (clock: Clock, leadMs: number) => Math.floor((clock.ms() + leadMs) / 1000);

/** The cash a sell order owes its seller at `t`: start_cash decaying to end_cash, rounded in the seller's favour. */
export const requiredCash = (o: Pick<CoreSellOrder, "startCash" | "endCash" | "startTs" | "endTs">, t: number) =>
  required({ startShares: o.startCash, endShares: o.endCash, startTs: o.startTs, endTs: o.endTs }, t);

async function priceAndFillSell(
  o: PassOptions,
  order: CoreSellOrder,
  basket: CoreBasket,
  cash: MintInfo,
  epoch: number,
  clock: Clock,
  log: (line: string) => void,
): Promise<Priced> {
  const { connection, filler, idl, edgeBps } = o;
  const id = `sell ${short(order.address)}`;
  const fillerCash = ata(order.cashMint, filler.publicKey, order.cashProgram);
  const fillerShares = ata(basket.shareMint, filler.publicKey, TOKEN_2022);
  const fillerComponents = basket.components.map((c) => ata(c.mint, filler.publicKey, basket.tokenProgram));
  const sellerCash = ata(order.cashMint, order.seller, order.cashProgram);
  const [sellerCashInfo, fillerCashInfo, fillerShareInfo, ...rest] = await connection.getMultipleAccountsInfo([
    sellerCash,
    fillerCash,
    fillerShares,
    ...basket.components.map((c) => c.mint),
    ...fillerComponents,
  ]);
  // The seller must hold the dollar account already: the program would open a
  // missing one at the filler's expense, rent the seller could close and keep.
  if (!sellerCashInfo) {
    log(`${id} skipped: the seller has no dollar account to be paid into`);
    return null;
  }
  const mintInfos = rest.slice(0, basket.components.length);
  const holdingInfos = rest.slice(basket.components.length);
  const mints: MintInfo[] = [];
  for (const [i, c] of basket.components.entries()) {
    try {
      mints.push(readMint(mintInfos[i] as AccountInfo<Buffer> | null, epoch));
    } catch (e) {
      log(`${id} ${basket.symbol} skipped: component ${c.mint.toBase58()} unreadable (${(e as Error).message})`);
      return null;
    }
  }
  // Defence 4, the other way round: what the shares redeem for, from the on-chain
  // recipe, net of each component's own transfer fee on the way out of the vault.
  const receive: bigint[] = [];
  let value = 0;
  for (const [i, c] of basket.components.entries()) {
    const q = o.quote(c.mint);
    if (!live(q)) {
      log(`${id} skipped: no live quote for ${c.mint.toBase58()}`);
      return null;
    }
    const units = (c.unitsPerShare * order.shares) / ONE_SHARE;
    const net = units - transferFee(units, mints[i].fee);
    receive.push(net);
    value += (Number(net) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
  }
  const tag = `${id} ${basket.symbol} ${Number(order.shares) / 1e6} shares worth $${value.toFixed(2)}`;
  // What the filler pays at `t`: the cash owed, grossed up for the cash mint's own fee.
  const payAt = (t: number) => preFeeAmount(requiredCash(order, t), cash.fee);
  const edgeAt = (t: number) => {
    const paid = Number(payAt(t)) / 10 ** cash.decimals;
    return paid > 0 ? (value - paid) / paid : -1;
  };
  // The cash only decays, and the clock runs behind the cluster's, so the amount
  // owed at the clock now is the most the fill can cost.
  const t = clock.secs();
  if (edgeAt(t) * 10_000 < edgeBps && o.waitUpToSecs) {
    for (let dt = 1; dt <= o.waitUpToSecs && t + dt <= order.endTs - MIN_SECS_LEFT; dt++) {
      if (edgeAt(t + dt) * 10_000 >= edgeBps) {
        log(`${tag}: margin in ${dt}s, queued`);
        return { at: t + dt, lead: edgeAt(t + dt - 1) >= 0 };
      }
    }
  }
  if (order.endTs - t < MIN_SECS_LEFT) {
    log(`${tag}: skipped, auction ends in under ${MIN_SECS_LEFT}s`);
    return null;
  }
  // Priced where it should land; if landing a second early would lose money, only once the clock itself says so.
  let tLand = Math.max(t, landingSecond(clock, o.leadMs ?? DEFAULT_LEAD_MS));
  if (edgeAt(tLand - 1) < 0) tLand = t;
  const edge = edgeAt(tLand);
  const pay = payAt(t);
  const dollars = Number(payAt(tLand)) / 10 ** cash.decimals;
  if (edge * 10_000 < edgeBps) {
    log(`${tag}: asks $${dollars.toFixed(2)}, edge ${(edge * 100).toFixed(2)}%, waiting`);
    return null;
  }
  if (edge * 10_000 > (o.maxOverFairBps ?? DEFAULT_MAX_OVER_FAIR_BPS)) {
    log(`${tag}: skipped, priced ${(edge * 100).toFixed(2)}% below fair; left to run out`);
    return null;
  }
  const heldCash = tokenAmount(fillerCashInfo?.data);
  if (heldCash < pay) {
    o.shortOfCash?.(pay - heldCash);
    log(`${tag}: skipped, holds $${(Number(heldCash) / 10 ** cash.decimals).toFixed(2)} of the $${dollars.toFixed(2)} it would pay`);
    return null;
  }

  // Defence 5: simulate the exact signed transaction: no more cash out than priced, every component in.
  // Six components and up need the basket's table to fit one packet; with one, the
  // compute limit is raised too. Below six the default limit is ample (fills use
  // 55 to 90 thousand units), so the instruction is left out to save the bytes.
  const table = basket.components.length >= 6 && o.lookupTable ? await o.lookupTable(basket) : null;
  const computeLimit = table ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })] : [];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const ixs = [
    ...computeLimit,
    ...(fillerShareInfo ? [] : [createAtaIdempotent(filler.publicKey, basket.shareMint, filler.publicKey, TOKEN_2022)]),
    ...basket.components.flatMap((c, i) => (holdingInfos[i] ? [] : [createAtaIdempotent(filler.publicKey, c.mint, filler.publicKey, basket.tokenProgram)])),
    fillSellIx(idl, filler.publicKey, order, basket),
    redeemIx(idl, filler.publicKey, basket, order.shares),
  ];
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: filler.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(table ? [table] : []),
  );
  tx.sign([filler]);
  const sim = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [fillerCash, ...fillerComponents].map((k) => k.toBase58()) },
  });
  const plan = `buy ${Number(order.shares) / 1e6} shares for $${dollars.toFixed(2)} and redeem them for $${value.toFixed(2)} of stocks, edge ${(edge * 100).toFixed(2)}%`;
  if (sim.value.err) {
    const why = (sim.value.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
    log(`${tag}: simulation failed (${why.slice(0, 160)})${o.dryRun ? `; would ${plan}` : ""}`);
    return null;
  }
  const after = (sim.value.accounts ?? []).map((a) => (a ? Buffer.from(a.data[0], "base64") : null));
  const cashOut = heldCash - tokenAmount(after[0]);
  if (cashOut > pay) {
    log(`${tag}: simulation pays ${cashOut} raw, priced at most ${pay}`);
    return null;
  }
  const shortChange = basket.components.findIndex((_, i) => tokenAmount(after[i + 1]) - tokenAmount(holdingInfos[i]?.data) < receive[i]);
  if (shortChange > -1) {
    log(`${tag}: simulation returns less ${basket.components[shortChange].mint.toBase58()} than priced`);
    return null;
  }
  if (o.dryRun) {
    log(`${tag}: DRY RUN would ${plan} (simulation ok)`);
    return null;
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(JSON.stringify(res.value.err));
  log(`${tag}: FILLED: ${plan} ${signature}`);
  // What it actually paid: the amount owed at the second the fill executed.
  const at = await landedAt(connection, signature);
  const paidNow = at != null ? Number(payAt(at)) / 10 ** cash.decimals : dollars;
  const landedEdge = at != null ? edgeAt(at) : edge;
  return { side: "sell", order: order.address.toBase58(), basket: basket.symbol, dollars: paidNow, cost: value, edgeBps: Math.round(landedEdge * 100_000) / 10, signature, landed: at != null };
}

async function priceAndFill(
  o: PassOptions,
  order: CoreOrder,
  basket: CoreBasket,
  cash: MintInfo,
  epoch: number,
  clock: Clock,
  log: (line: string) => void,
): Promise<Priced> {
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
      if (!live(q)) return { error: `no live quote for ${c.mint.toBase58()}` } as const;
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
  // `p` is the count owed at the clock now, which runs behind the cluster's: the
  // most the fill can need, so it is what the filler must hold and what the
  // simulation may take. `l` is the count where the fill should land, which is
  // what the margin is judged on.
  const t = clock.secs();
  const p = priceAt(t);
  if ("error" in p) {
    log(`${tag} skipped: ${p.error}`);
    return null;
  }
  const edgeOf = (x: ReturnType<typeof priceAt>) => ("error" in x ? -1 : x.edge);
  if (p.edge * 10_000 < edgeBps && o.waitUpToSecs) {
    // The auction only decays, so find the first second inside the wait window that clears the margin.
    for (let dt = 1; dt <= o.waitUpToSecs && t + dt <= order.endTs - MIN_SECS_LEFT; dt++) {
      if (edgeOf(priceAt(t + dt)) * 10_000 >= edgeBps) {
        log(`${tag} margin in ${dt}s, queued`);
        return { at: t + dt, lead: edgeOf(priceAt(t + dt - 1)) >= 0 };
      }
    }
  }
  if (order.endTs - t < MIN_SECS_LEFT) {
    log(`${tag} skipped: auction ends in under ${MIN_SECS_LEFT}s`);
    return null;
  }
  // Where it should land; if landing a second early would lose money, only once the clock itself says so.
  let tLand = Math.max(t, landingSecond(clock, o.leadMs ?? DEFAULT_LEAD_MS));
  if (edgeOf(priceAt(tLand - 1)) < 0) tLand = t;
  const l = priceAt(tLand);
  if ("error" in l) return null;
  if (l.edge * 10_000 < edgeBps) {
    log(`${tag} cost $${l.cost.toFixed(2)}, edge ${(l.edge * 100).toFixed(2)}%, waiting`);
    return null;
  }
  if (l.edge * 10_000 > (o.maxOverFairBps ?? DEFAULT_MAX_OVER_FAIR_BPS)) {
    log(`${tag} skipped: run priced ${(l.edge * 100).toFixed(2)}% above fair; left to run out and be refunded`);
    return null;
  }
  const missing = basket.components.filter((_, i) => tokenAmount(holdingInfos[i]?.data) < p.deliver[i]).map((c) => c.mint);
  if (missing.length) {
    o.shortOf?.(basket, missing);
    log(`${tag} skipped: holds too little of ${missing.map((m) => short(m)).join(", ")}`);
    return null;
  }

  // Defence 5: simulate the exact signed transaction and check what it does to the filler's accounts.
  // Six components and up need the basket's table to fit one packet; with one, the
  // compute limit is raised too. Below six the default limit is ample (fills use
  // 55 to 90 thousand units), so the instruction is left out to save the bytes.
  const table = basket.components.length >= 6 && o.lookupTable ? await o.lookupTable(basket) : null;
  const computeLimit = table ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })] : [];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: filler.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ...computeLimit,
        ...(fillerCashInfo ? [] : [createAtaIdempotent(filler.publicKey, order.cashMint, filler.publicKey, order.cashProgram)]),
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
  const plan = `fill ${Number(l.shares) / 1e6} shares for $${dollars.toFixed(2)} at cost $${l.cost.toFixed(2)}, edge ${(l.edge * 100).toFixed(2)}%`;
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
  // What it actually delivered: the count at the second the fill executed.
  const at = await landedAt(connection, signature);
  const landed = at != null ? priceAt(at) : l;
  const final = "error" in landed ? l : landed;
  return { side: "buy", order: order.address.toBase58(), basket: basket.symbol, dollars, cost: final.cost, edgeBps: Math.round(final.edge * 100_000) / 10, signature, landed: final !== l };
}
