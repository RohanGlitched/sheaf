/**
 * The Sheaf program, from the browser.
 *
 * Anchor's client is a dependency of the workspace but not of this file, and that
 * is deliberate. Reading a basket needs no provider and no wallet, and encoding
 * three instructions by hand is a hundred lines against several hundred kilobytes
 * of runtime in the bundle. The discriminators and the field order below are
 * copied from target/idl/sheaf.json, which the program itself emits; if the
 * program's layout changes, that file changes and so must this one.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, ONE_SHARE, SHARE_DECIMALS, WRITE_RPC } from "./config";

export const PROGRAM_ID = new PublicKey(SHEAF_PROGRAM_ID);

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const IX_CREATE_BASKET = Uint8Array.from([47, 105, 155, 148, 15, 169, 202, 211]);
const IX_MINT_SHARES = Uint8Array.from([24, 196, 132, 0, 183, 158, 216, 142]);
const IX_REDEEM_SHARES = Uint8Array.from([239, 154, 224, 89, 240, 196, 42, 187]);
const BASKET_DISCRIMINATOR = Uint8Array.from([
  219, 79, 107, 135, 231, 243, 218, 248,
]);

// ------------------------------------------------------------------- addresses

export function basketAddress(creator: PublicKey, symbol: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("basket"),
      creator.toBuffer(),
      Buffer.from(symbol, "utf8"),
    ],
    PROGRAM_ID,
  )[0];
}

/** The canonical associated token account, which the program insists on. */
export function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// -------------------------------------------------------------------- decoding

export type BasketComponent = {
  mint: string;
  /** Raw units of this component behind one whole share. */
  unitsPerShare: bigint;
  /** Weight the creator asked for, in basis points, at creation. */
  weightBps: number;
  decimals: number;
};

export type Basket = {
  address: string;
  creator: string;
  shareMint: string;
  tokenProgram: string;
  name: string;
  symbol: string;
  creatorFeeBps: number;
  components: BasketComponent[];
  createdAt: number;
  mintCount: bigint;
  redeemCount: bigint;
  /**
   * The protocol's creation fee, fixed when the basket was created: 10 bps
   * (0.10% of shares created, minted to the treasury) for baskets created
   * since it existed, 0 for older ones. Redemption is free either way.
   */
  protocolFeeBps: number;
  /** Protocol-fee shares created and backed in the vault, not yet minted to the treasury. */
  protocolFeeAccrued: bigint;
};

class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}
  private view() {
    return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
  skip(n: number) {
    this.offset += n;
  }
  u8() {
    return this.data[this.offset++];
  }
  u16() {
    const v = this.view().getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u64() {
    const v = this.view().getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64() {
    const v = this.view().getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  pubkey() {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  string() {
    const len = this.view().getUint32(this.offset, true);
    this.offset += 4;
    const bytes = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }
}

/**
 * Decode a Basket account.
 *
 * Name and symbol are variable-length and sit before the fixed tail, so the whole
 * record has to be walked in order rather than read at offsets. Returns null on
 * anything that does not look like a basket, so a foreign account in the program
 * cannot crash a page.
 */
export function decodeBasket(address: PublicKey, data: Uint8Array): Basket | null {
  try {
    for (let i = 0; i < 8; i++) {
      if (data[i] !== BASKET_DISCRIMINATOR[i]) return null;
    }
    const r = new Reader(data);
    r.skip(8);
    const creator = r.pubkey();
    const shareMint = r.pubkey();
    const tokenProgram = r.pubkey();
    const name = r.string();
    const symbol = r.string();
    const creatorFeeBps = r.u16();
    const componentCount = r.u8();
    if (componentCount < 1 || componentCount > 8) return null;

    const components: BasketComponent[] = [];
    for (let i = 0; i < 8; i++) {
      const mint = r.pubkey();
      const unitsPerShare = r.u64();
      const weightBps = r.u16();
      const decimals = r.u8();
      r.skip(5); // padding
      if (i < componentCount) {
        components.push({
          mint: mint.toBase58(),
          unitsPerShare,
          weightBps,
          decimals,
        });
      }
    }

    const createdAt = Number(r.i64());
    const mintCount = r.u64();
    const redeemCount = r.u64();
    r.skip(1); // bump
    // Appended into the account's headroom: an older basket reads zeros here.
    const protocolFeeBps = r.u16();
    const protocolFeeAccrued = r.u64();

    return {
      address: address.toBase58(),
      creator: creator.toBase58(),
      shareMint: shareMint.toBase58(),
      tokenProgram: tokenProgram.toBase58(),
      name,
      symbol,
      creatorFeeBps,
      components,
      createdAt,
      mintCount,
      redeemCount,
      protocolFeeBps,
      protocolFeeAccrued,
    };
  } catch {
    return null;
  }
}

/** Every basket the program knows about, newest first. */
export async function fetchBaskets(connection: Connection): Promise<Basket[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: bs58Encode(BASKET_DISCRIMINATOR),
        },
      },
    ],
  });
  const baskets: Basket[] = [];
  for (const { pubkey, account } of accounts) {
    const decoded = decodeBasket(pubkey, new Uint8Array(account.data));
    if (decoded) baskets.push(decoded);
  }
  baskets.sort((a, b) => b.createdAt - a.createdAt);
  return baskets;
}

export async function fetchBasket(
  connection: Connection,
  address: PublicKey,
): Promise<Basket | null> {
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  return decodeBasket(address, new Uint8Array(info.data));
}

/** For server code, which has no wallet-adapter connection to borrow. */
export async function fetchBasketAt(address: string): Promise<Basket | null> {
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    return null;
  }
  return fetchBasket(new Connection(WRITE_RPC, "confirmed"), key).catch(() => null);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let out = "";
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

// -------------------------------------------------------------------- encoding

function u16le(value: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value, true);
  return b;
}
function u32le(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}
function u64le(value: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, value, true);
  return b;
}
function borshString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(u32le(bytes.length), bytes);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const meta = (
  pubkey: PublicKey,
  isWritable: boolean,
  isSigner = false,
): AccountMeta => ({ pubkey, isWritable, isSigner });

export type ComponentArg = {
  mint: PublicKey;
  unitsPerShare: bigint;
  weightBps: number;
};

/**
 * create_basket.
 *
 * The share mint has to exist already, with six decimals, no supply, no freeze
 * authority, and the basket address as its mint authority. Component mints are
 * passed as remaining accounts in recipe order so the program can read each one's
 * decimals for itself rather than trusting the caller.
 */
export function createBasketInstruction(params: {
  creator: PublicKey;
  shareMint: PublicKey;
  name: string;
  symbol: string;
  creatorFeeBps: number;
  components: ComponentArg[];
  componentTokenProgram?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = params.componentTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const basket = basketAddress(params.creator, params.symbol);

  const args = concat(
    IX_CREATE_BASKET,
    borshString(params.name),
    borshString(params.symbol),
    u16le(params.creatorFeeBps),
    u32le(params.components.length),
    ...params.components.map((c) =>
      concat(c.mint.toBytes(), u64le(c.unitsPerShare), u16le(c.weightBps)),
    ),
  );

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.from(args),
    keys: [
      meta(params.creator, true, true),
      meta(basket, true),
      meta(params.shareMint, false),
      meta(tokenProgram, false),
      meta(SystemProgram.programId, false),
      ...params.components.map((c) => meta(c.mint, false)),
    ],
  });
}

/**
 * mint_shares.
 *
 * Remaining accounts are three per component, in recipe order:
 * the component mint, the depositor's token account, the basket's vault.
 */
export function mintSharesInstruction(params: {
  basket: PublicKey;
  shareMint: PublicKey;
  depositor: PublicKey;
  creator: PublicKey;
  components: { mint: PublicKey }[];
  shares: bigint;
  componentTokenProgram?: PublicKey;
  shareTokenProgram?: PublicKey;
}): TransactionInstruction {
  const componentProgram = params.componentTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const shareProgram = params.shareTokenProgram ?? TOKEN_2022_PROGRAM_ID;

  const remaining: AccountMeta[] = [];
  for (const c of params.components) {
    remaining.push(meta(c.mint, false));
    remaining.push(meta(tokenAccount(c.mint, params.depositor, componentProgram), true));
    remaining.push(meta(tokenAccount(c.mint, params.basket, componentProgram), true));
  }

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.from(concat(IX_MINT_SHARES, u64le(params.shares))),
    keys: [
      meta(params.basket, true),
      meta(params.shareMint, true),
      meta(params.depositor, false, true),
      meta(tokenAccount(params.shareMint, params.depositor, shareProgram), true),
      meta(tokenAccount(params.shareMint, params.creator, shareProgram), true),
      meta(shareProgram, false),
      meta(componentProgram, false),
      ...remaining,
    ],
  });
}

/**
 * redeem_shares.
 *
 * Remaining accounts are three per component, in recipe order:
 * the component mint, the basket's vault, the recipient's token account.
 */
export function redeemSharesInstruction(params: {
  basket: PublicKey;
  shareMint: PublicKey;
  owner: PublicKey;
  components: { mint: PublicKey }[];
  shares: bigint;
  componentTokenProgram?: PublicKey;
  shareTokenProgram?: PublicKey;
}): TransactionInstruction {
  const componentProgram = params.componentTokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const shareProgram = params.shareTokenProgram ?? TOKEN_2022_PROGRAM_ID;

  const remaining: AccountMeta[] = [];
  for (const c of params.components) {
    remaining.push(meta(c.mint, false));
    remaining.push(meta(tokenAccount(c.mint, params.basket, componentProgram), true));
    remaining.push(meta(tokenAccount(c.mint, params.owner, componentProgram), true));
  }

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.from(concat(IX_REDEEM_SHARES, u64le(params.shares))),
    keys: [
      meta(params.basket, true),
      meta(params.shareMint, true),
      meta(params.owner, false, true),
      meta(tokenAccount(params.shareMint, params.owner, shareProgram), true),
      meta(shareProgram, false),
      meta(componentProgram, false),
      ...remaining,
    ],
  });
}

// ---------------------------------------------------------------- recipe maths

/**
 * Turn weights and prices into raw units per share.
 *
 * A basket share is priced at `targetSharePrice` dollars at the moment of
 * creation, which is what makes two baskets comparable on a chart later. Each
 * component's dollar allocation is its weight of that, and its unit count is that
 * allocation divided by its price, in the mint's own raw units.
 *
 * The multiplier matters here. A price quoted per displayed token has to be turned
 * back into a price per raw unit before dividing, or a basket holding a
 * dividend-paying token would be short by exactly the dividends it has accrued.
 */
export function unitsForWeights(params: {
  components: {
    mint: string;
    decimals: number;
    /** Price of one displayed token, in USD. */
    price: number;
    /** ScaledUiAmount multiplier in force on the mint. */
    multiplier: number;
    weightBps: number;
  }[];
  targetSharePrice: number;
}): { mint: string; unitsPerShare: bigint; weightBps: number }[] {
  return params.components.map((c) => {
    const dollars = (params.targetSharePrice * c.weightBps) / 10_000;
    const pricePerRawUnit = (c.price * c.multiplier) / 10 ** c.decimals;
    const units = pricePerRawUnit > 0 ? dollars / pricePerRawUnit : 0;
    return {
      mint: c.mint,
      // At least one raw unit, so no component is silently weightless.
      unitsPerShare: BigInt(Math.max(1, Math.round(units))),
      weightBps: c.weightBps,
    };
  });
}

/** What one share of this basket is worth, from a set of live prices. */
export function navPerShare(
  components: BasketComponent[],
  priceOf: (mint: string) => { price: number; multiplier: number } | undefined,
): { nav: number | null; priced: number; missing: string[] } {
  let nav = 0;
  let priced = 0;
  const missing: string[] = [];
  for (const c of components) {
    const q = priceOf(c.mint);
    if (!q) {
      missing.push(c.mint);
      continue;
    }
    const perRawUnit = (q.price * q.multiplier) / 10 ** c.decimals;
    nav += Number(c.unitsPerShare) * perRawUnit;
    priced++;
  }
  return { nav: missing.length ? null : nav, priced, missing };
}

/** Raw share units for a human share count, and back. */
export const sharesToRaw = (shares: number): bigint =>
  BigInt(Math.round(shares * ONE_SHARE));
export const rawToShares = (raw: bigint): number => Number(raw) / ONE_SHARE;

export { SHARE_DECIMALS, ONE_SHARE };

/** A basket as JSON, with its big integers as strings. */
export type BasketJson = Omit<Basket, "components" | "mintCount" | "redeemCount"> & {
  components: (Omit<BasketComponent, "unitsPerShare"> & { unitsPerShare: string })[];
  mintCount: string;
  redeemCount: string;
};

export function basketToJson(b: Basket): BasketJson {
  return {
    ...b,
    components: b.components.map((c) => ({ ...c, unitsPerShare: c.unitsPerShare.toString() })),
    mintCount: b.mintCount.toString(),
    redeemCount: b.redeemCount.toString(),
  };
}

export function basketFromJson(b: BasketJson): Basket {
  return {
    ...b,
    components: b.components.map((c) => ({ ...c, unitsPerShare: BigInt(c.unitsPerShare) })),
    mintCount: BigInt(b.mintCount),
    redeemCount: BigInt(b.redeemCount),
  };
}
