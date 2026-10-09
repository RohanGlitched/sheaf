/**
 * Cash orders and monthly plans, from the browser and the keeper.
 *
 * Instruction layouts, discriminators and account order come from
 * lib/sheaf-idl.json, the IDL the program emits, so this file never drifts from
 * the program: change the program, copy the new IDL, and these builders follow.
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import idl from "./sheaf-idl.json";
import { PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, tokenAccount, type Basket } from "./sheaf";

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string };
type IdlIx = { name: string; discriminator: number[]; accounts: IdlAccount[]; args: { name: string; type: string }[] };
const IXS = new Map((idl.instructions as unknown as IdlIx[]).map((ix) => [ix.name, ix]));
const ACCOUNT_DISC = new Map(
  (idl.accounts as { name: string; discriminator: number[] }[]).map((a) => [a.name, Uint8Array.from(a.discriminator)]),
);

// ---------------------------------------------------------------- encoding

function encodeArg(type: string, value: bigint | number): Uint8Array {
  const size = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8 }[type];
  if (!size) throw new Error(`Unsupported arg type ${type}`);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (type === "u8") view.setUint8(0, Number(value));
  if (type === "u16") view.setUint16(0, Number(value), true);
  if (type === "u32") view.setUint32(0, Number(value), true);
  if (type === "u64") view.setBigUint64(0, BigInt(value), true);
  if (type === "i64") view.setBigInt64(0, BigInt(value), true);
  return out;
}

function instruction(
  name: string,
  accounts: Record<string, PublicKey | null>,
  args: Record<string, bigint | number>,
  remaining: AccountMeta[] = [],
): TransactionInstruction {
  const ix = IXS.get(name);
  if (!ix) throw new Error(`Unknown instruction ${name}`);
  const keys: AccountMeta[] = ix.accounts.map((a) => {
    const given = accounts[a.name];
    if (given == null) {
      if (a.address) return { pubkey: new PublicKey(a.address), isSigner: false, isWritable: false };
      // An absent optional account is passed as the program id.
      if (a.optional) return { pubkey: PROGRAM_ID, isSigner: false, isWritable: false };
      throw new Error(`${name}: missing account ${a.name}`);
    }
    return { pubkey: given, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  const parts = [Uint8Array.from(ix.discriminator), ...ix.args.map((a) => encodeArg(a.type, args[a.name]))];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [...keys, ...remaining], data: Buffer.from(data) });
}

// DataView rather than Buffer.writeBigUInt64LE, which the browser's Buffer polyfill lacks.
const le64 = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return Buffer.from(out);
};

// ---------------------------------------------------------------- addresses

export function orderAddress(basket: PublicKey, buyer: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("order"), basket.toBuffer(), buyer.toBuffer(), le64(nonce)], PROGRAM_ID)[0];
}

/** A plan's orders live under the plan, so a cranker can never take a nonce the owner is about to use. */
export function planOrderAddress(plan: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("plan_order"), plan.toBuffer(), le64(nonce)], PROGRAM_ID)[0];
}

export function planAddress(basket: PublicKey, owner: PublicKey, planId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("plan"), basket.toBuffer(), owner.toBuffer(), le64(planId)], PROGRAM_ID)[0];
}

/** The trailing step the program suggests (open_plan takes any 0..5000; 0 = fixed bounds). */
export const PLAN_STEP_BPS = 600;
/** How far before it lands an order's auction may start (place_order / place_sell_order refuse more). */
export const MAX_START_LAG_SECS = 60;
/**
 * The SPL Memo program. Pass it as a trailing remaining account to fill_order,
 * cancel_order, fill_sell_order or cancel_sell_order when the account being
 * paid requires incoming memos; the program then writes the memo itself.
 */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** A holder's sell order: `["sell", basket, seller, nonce]`. */
export function sellOrderAddress(basket: PublicKey, seller: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("sell"), basket.toBuffer(), seller.toBuffer(), le64(nonce)], PROGRAM_ID)[0];
}

/** A sell order's escrow is its own associated (Token-2022) account for the share mint. */
export const sellEscrowAddress = (sellOrder: PublicKey, shareMint: PublicKey) =>
  tokenAccount(shareMint, sellOrder, TOKEN_2022_PROGRAM_ID);

/** Each order's escrow is the order's own associated token account for the cash mint. */
export const escrowAddress = (order: PublicKey, cashMint: PublicKey, cashProgram: PublicKey) =>
  tokenAccount(cashMint, order, cashProgram);

/** A nonce that will not collide for one buyer: milliseconds, which also orders them. */
export const freshNonce = () => BigInt(Date.now());

// ---------------------------------------------------------------- decoding

export type Order = {
  address: string;
  basket: string;
  buyer: string;
  rentPayer: string;
  cashMint: string;
  cashTokenProgram: string;
  plan: string | null;
  nonce: bigint;
  cashAmount: bigint;
  startShares: bigint;
  endShares: bigint;
  startTs: number;
  endTs: number;
  createdAt: number;
};

export type Plan = {
  address: string;
  owner: string;
  basket: string;
  cashMint: string;
  cashTokenProgram: string;
  cashAccount: string;
  planId: bigint;
  cashPerRun: bigint;
  periodSecs: number;
  runsTotal: number;
  runsLeft: number;
  nextRunTs: number;
  refSharesPerCashE9: bigint;
  bandBps: number;
  auctionSecs: number;
  lastOrder: string | null;
  fills: number;
  lastFillTs: number;
  createdAt: number;
  /** Bounds the reference rate may never leave. Null on a plan from before they existed. */
  minRef: bigint | null;
  maxRef: bigint | null;
  /** A plan opened before the hardening release: it can only be closed, with close_legacy_plan. */
  legacy: boolean;
  /**
   * How far a fill may move the reference, in bps: after every fill the
   * working bounds become `ref × (1 ± step)` intersected with the owner's
   * hard limits. Chosen at open_plan (0 = fixed bounds); 0 for plans opened
   * before trailing bounds existed.
   */
  trailStepBps: number;
  /**
   * The owner's hard limits, which no fill can move the reference past (set at
   * open_plan and update_plan). Null on plans opened before they existed.
   */
  hardMinRef: bigint | null;
  hardMaxRef: bigint | null;
};

export type SellOrder = {
  address: string;
  basket: string;
  seller: string;
  rentPayer: string;
  cashMint: string;
  cashTokenProgram: string;
  nonce: bigint;
  /** Shares escrowed. */
  shares: bigint;
  /** Cash the seller must receive at startTs, decaying linearly to endCash (the seller's floor) at endTs. */
  startCash: bigint;
  endCash: bigint;
  startTs: number;
  endTs: number;
  createdAt: number;
};

class Reader {
  private o = 8;
  constructor(private readonly d: Uint8Array) {}
  private v = () => new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength);
  key() {
    const k = new PublicKey(this.d.slice(this.o, this.o + 32)).toBase58();
    this.o += 32;
    return k;
  }
  optKey() {
    const some = this.d[this.o++] === 1;
    return some ? this.key() : null;
  }
  u8() {
    return this.d[this.o++];
  }
  u16() {
    const x = this.v().getUint16(this.o, true);
    this.o += 2;
    return x;
  }
  u32() {
    const x = this.v().getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  u64() {
    const x = this.v().getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = Number(this.v().getBigInt64(this.o, true));
    this.o += 8;
    return x;
  }
}

const hasDisc = (data: Uint8Array, name: string) => {
  const d = ACCOUNT_DISC.get(name)!;
  return data.length >= 8 && d.every((b, i) => data[i] === b);
};

export function decodeOrder(address: PublicKey, data: Uint8Array): Order | null {
  if (!hasDisc(data, "Order")) return null;
  const r = new Reader(data);
  return {
    address: address.toBase58(),
    basket: r.key(),
    buyer: r.key(),
    rentPayer: r.key(),
    cashMint: r.key(),
    cashTokenProgram: r.key(),
    plan: r.optKey(),
    nonce: r.u64(),
    cashAmount: r.u64(),
    startShares: r.u64(),
    endShares: r.u64(),
    startTs: r.i64(),
    endTs: r.i64(),
    createdAt: r.i64(),
  };
}

export function decodePlan(address: PublicKey, data: Uint8Array): Plan | null {
  if (!hasDisc(data, "Plan")) return null;
  const r = new Reader(data);
  return {
    address: address.toBase58(),
    owner: r.key(),
    basket: r.key(),
    cashMint: r.key(),
    cashTokenProgram: r.key(),
    cashAccount: r.key(),
    planId: r.u64(),
    cashPerRun: r.u64(),
    periodSecs: r.i64(),
    runsTotal: r.u32(),
    runsLeft: r.u32(),
    nextRunTs: r.i64(),
    refSharesPerCashE9: r.u64(),
    bandBps: r.u16(),
    auctionSecs: r.i64(),
    lastOrder: r.optKey(),
    fills: r.u32(),
    lastFillTs: r.i64(),
    createdAt: r.i64(),
    ...(data.length >= 296
      ? (() => {
          r.u8(); // bump
          const minRef = r.u64();
          const maxRef = r.u64();
          // The tail after the struct (byte 296): trail_step_bps u16, 6 reserved,
          // then the owner's hard limits (u64, u64) on plans opened since they existed.
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const trailStepBps = data.length >= 298 ? view.getUint16(296, true) : 0;
          const hard = data.length >= 320;
          return {
            minRef,
            maxRef,
            legacy: false,
            trailStepBps,
            hardMinRef: hard ? view.getBigUint64(304, true) : null,
            hardMaxRef: hard ? view.getBigUint64(312, true) : null,
          };
        })()
      : { minRef: null, maxRef: null, legacy: true, trailStepBps: 0, hardMinRef: null, hardMaxRef: null }),
  };
}

export function decodeSellOrder(address: PublicKey, data: Uint8Array): SellOrder | null {
  if (!hasDisc(data, "SellOrder")) return null;
  const r = new Reader(data);
  return {
    address: address.toBase58(),
    basket: r.key(),
    seller: r.key(),
    rentPayer: r.key(),
    cashMint: r.key(),
    cashTokenProgram: r.key(),
    nonce: r.u64(),
    shares: r.u64(),
    startCash: r.u64(),
    endCash: r.u64(),
    startTs: r.i64(),
    endTs: r.i64(),
    createdAt: r.i64(),
  };
}

async function allOf<T>(connection: Connection, name: "Order" | "Plan" | "SellOrder", decode: (a: PublicKey, d: Uint8Array) => T | null, extra: { memcmp: { offset: number; bytes: string } }[] = []) {
  const disc = ACCOUNT_DISC.get(name)!;
  const bs58 = (await import("bs58")).default;
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }, ...extra],
  });
  return accounts.map((a) => decode(a.pubkey, new Uint8Array(a.account.data))).filter((x): x is T => x != null);
}

export const fetchOrders = (connection: Connection, basket?: string) =>
  allOf(connection, "Order", decodeOrder, basket ? [{ memcmp: { offset: 8, bytes: basket } }] : []);

/** Open sell orders, optionally for one basket (offset 8) or one seller (offset 40). */
export const fetchSellOrders = (connection: Connection, filter: { basket?: string; seller?: string } = {}) =>
  allOf(connection, "SellOrder", decodeSellOrder, [
    ...(filter.basket ? [{ memcmp: { offset: 8, bytes: filter.basket } }] : []),
    ...(filter.seller ? [{ memcmp: { offset: 40, bytes: filter.seller } }] : []),
  ]);

export const fetchPlans = (connection: Connection, owner?: string) =>
  allOf(connection, "Plan", decodePlan, owner ? [{ memcmp: { offset: 8, bytes: owner } }] : []);

// ---------------------------------------------------------------- auction math

/** Shares the buyer receives if the order is filled at `now`, exactly as the program computes it. */
export function requiredShares(o: Pick<Order, "startShares" | "endShares" | "startTs" | "endTs">, now: number): bigint {
  if (now <= o.startTs) return o.startShares;
  if (now >= o.endTs) return o.endShares;
  const span = BigInt(o.endTs - o.startTs);
  const elapsed = BigInt(now - o.startTs);
  const drop = ((o.startShares - o.endShares) * elapsed) / span;
  return o.startShares - drop;
}

/** Cash the seller must receive if the sell order is filled at `now`, exactly as the program computes it. */
export const requiredCash = (o: Pick<SellOrder, "startCash" | "endCash" | "startTs" | "endTs">, now: number): bigint =>
  requiredShares({ startShares: o.startCash, endShares: o.endCash, startTs: o.startTs, endTs: o.endTs }, now);

/**
 * A plan after a fill at `rate`, as the program's `apply_plan_fill` records
 * it: the rate is clamped into the working bounds and becomes the reference;
 * with a trailing step the working bounds then move to `rate × (1 ± step)`
 * (floored), intersected with the owner's hard limits when the plan has them.
 * Fixed-bound plans keep their bounds.
 */
export function planAfterFill(
  plan: Pick<Plan, "minRef" | "maxRef" | "trailStepBps"> & Partial<Pick<Plan, "hardMinRef" | "hardMaxRef">>,
  rate: bigint,
) {
  const lo = plan.minRef ?? 0n;
  const hi = plan.maxRef ?? rate;
  const ref = rate < lo ? lo : rate > hi ? hi : rate;
  if (!plan.trailStepBps) return { ref, minRef: lo, maxRef: hi };
  const step = BigInt(plan.trailStepBps);
  let minRef = (ref * (10_000n - step)) / 10_000n;
  let maxRef = (ref * (10_000n + step)) / 10_000n;
  if (minRef < 1n) minRef = 1n;
  if (maxRef < ref) maxRef = ref;
  if (plan.hardMinRef != null && minRef < plan.hardMinRef) minRef = plan.hardMinRef;
  if (plan.hardMaxRef != null && maxRef > plan.hardMaxRef) maxRef = plan.hardMaxRef;
  return { ref, minRef: minRef < ref ? minRef : ref, maxRef: maxRef > ref ? maxRef : ref };
}

/** The plan's next order bounds, as run_plan sets them. */
export function planBounds(cash: bigint, refE9: bigint, bandBps: number): { start: bigint; end: bigint } {
  // One rounding, as plan_bounds does: cash × ref × (1 ± band) / (10^9 × 10^4).
  const base = cash * refE9;
  const denom = 1_000_000_000n * 10_000n;
  return {
    start: (base * BigInt(10_000 + bandBps)) / denom,
    end: (base * BigInt(10_000 - bandBps)) / denom,
  };
}

/** A single fee on `shares`, floored. With no protocol fee this is exactly the creator fee mint_shares charges. */
export const creatorFeeOn = (shares: bigint, feeBps: number) => (shares * BigInt(feeBps)) / 10_000n;

/**
 * The (creator, protocol) fee shares on `shares` created, exactly as the
 * program's `fee_split`: the pair is floored once at `creatorBps +
 * protocolBps`, the protocol takes `floor(shares × protocolBps / 10^4)`, and
 * the creator the rest. The protocol's share is accrued in the basket and
 * minted to the treasury later; the depositor receives `shares − creator −
 * protocol`. Baskets created before the protocol fee have `protocolBps = 0`.
 */
export function feeSplit(shares: bigint, creatorBps: number, protocolBps = 0): { creator: bigint; protocol: bigint } {
  const total = creatorFeeOn(shares, creatorBps + protocolBps);
  const protocol = creatorFeeOn(shares, protocolBps);
  return { creator: total - protocol, protocol };
}

/** What a depositor receives for `shares` created: net of both fees. */
export const netSharesFor = (shares: bigint, creatorBps: number, protocolBps = 0) => {
  const { creator, protocol } = feeSplit(shares, creatorBps, protocolBps);
  return shares - creator - protocol;
};

/**
 * The smallest gross share count whose fees leave exactly `net`: what a filler
 * must deliver components for. Pass the basket's `protocolFeeBps` as well as
 * its creator fee (the pair is what the program charges a fill).
 */
export function grossSharesForNet(net: bigint, creatorBps: number, protocolBps = 0): bigint {
  const feeBps = creatorBps + protocolBps;
  const netOf = (g: bigint) => g - creatorFeeOn(g, feeBps);
  let gross = (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
  for (let i = 0; i < 3; i++) {
    if (gross > net && netOf(gross - 1n) >= net) gross -= 1n;
    else break;
  }
  return gross;
}

/** The rate a fill happened at, in the plan's fixed point. */
export const sharesPerCashE9 = (shares: bigint, cash: bigint) => (shares * 1_000_000_000n) / cash;

// ---------------------------------------------------------------- builders

export function placeOrderIx(p: {
  buyer: PublicKey;
  basket: PublicKey;
  cashMint: PublicKey;
  cashProgram?: PublicKey;
  nonce: bigint;
  cashAmount: bigint;
  startShares: bigint;
  endShares: bigint;
  startTs: number;
  endTs: number;
}) {
  const cashProgram = p.cashProgram ?? TOKEN_2022_PROGRAM_ID;
  const order = orderAddress(p.basket, p.buyer, p.nonce);
  return {
    order,
    ix: instruction(
      "place_order",
      {
        buyer: p.buyer,
        basket: p.basket,
        order,
        cash_mint: p.cashMint,
        buyer_cash_account: tokenAccount(p.cashMint, p.buyer, cashProgram),
        escrow: escrowAddress(order, p.cashMint, cashProgram),
        cash_token_program: cashProgram,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
      },
      {
        nonce: p.nonce,
        cash_amount: p.cashAmount,
        start_shares: p.startShares,
        end_shares: p.endShares,
        start_ts: p.startTs,
        end_ts: p.endTs,
      },
    ),
  };
}

export function fillOrderIx(p: { filler: PublicKey; order: Order; basket: Basket }) {
  const order = new PublicKey(p.order.address);
  const cashMint = new PublicKey(p.order.cashMint);
  const cashProgram = new PublicKey(p.order.cashTokenProgram);
  const basket = new PublicKey(p.basket.address);
  const shareMint = new PublicKey(p.basket.shareMint);
  const shareProgram = TOKEN_2022_PROGRAM_ID;
  const componentProgram = new PublicKey(p.basket.tokenProgram);
  const remaining: AccountMeta[] = [];
  for (const c of p.basket.components) {
    const mint = new PublicKey(c.mint);
    remaining.push({ pubkey: mint, isSigner: false, isWritable: false });
    remaining.push({ pubkey: tokenAccount(mint, p.filler, componentProgram), isSigner: false, isWritable: true });
    remaining.push({ pubkey: tokenAccount(mint, basket, componentProgram), isSigner: false, isWritable: true });
  }
  return instruction(
    "fill_order",
    {
      filler: p.filler,
      order,
      basket,
      share_mint: shareMint,
      buyer: new PublicKey(p.order.buyer),
      buyer_share_account: tokenAccount(shareMint, new PublicKey(p.order.buyer), shareProgram),
      creator_share_account: p.basket.creatorFeeBps > 0 ? tokenAccount(shareMint, new PublicKey(p.basket.creator), shareProgram) : null,
      cash_mint: cashMint,
      escrow: escrowAddress(order, cashMint, cashProgram),
      filler_cash_account: tokenAccount(cashMint, p.filler, cashProgram),
      rent_payer: new PublicKey(p.order.rentPayer),
      plan: p.order.plan ? new PublicKey(p.order.plan) : null,
      share_token_program: shareProgram,
      component_token_program: componentProgram,
      cash_token_program: cashProgram,
    },
    {},
    remaining,
  );
}

export function cancelOrderIx(p: { caller: PublicKey; order: Order }) {
  const order = new PublicKey(p.order.address);
  const cashMint = new PublicKey(p.order.cashMint);
  const cashProgram = new PublicKey(p.order.cashTokenProgram);
  const buyer = new PublicKey(p.order.buyer);
  return instruction(
    "cancel_order",
    {
      caller: p.caller,
      order,
      buyer,
      cash_mint: cashMint,
      escrow: escrowAddress(order, cashMint, cashProgram),
      buyer_cash_account: tokenAccount(cashMint, buyer, cashProgram),
      rent_payer: new PublicKey(p.order.rentPayer),
      cash_token_program: cashProgram,
    },
    {},
  );
}

export function openPlanIx(p: {
  owner: PublicKey;
  basket: PublicKey;
  cashMint: PublicKey;
  cashProgram?: PublicKey;
  planId: bigint;
  cashPerRun: bigint;
  periodSecs: number;
  runs: number;
  refSharesPerCashE9: bigint;
  bandBps: number;
  auctionSecs: number;
  /** The owner's hard limits: the reference can never leave them, trailing or not. */
  minRef: bigint;
  maxRef: bigint;
  /**
   * 0 (the default) keeps the bounds fixed at [minRef, maxRef]. A step (e.g.
   * PLAN_STEP_BPS = 600) lets the plan follow the market inside those hard
   * limits, moving at most that far per fill; give it wide hard limits then.
   */
  trailStepBps?: number;
}) {
  const cashProgram = p.cashProgram ?? TOKEN_2022_PROGRAM_ID;
  const plan = planAddress(p.basket, p.owner, p.planId);
  return {
    plan,
    ix: instruction(
      "open_plan",
      {
        owner: p.owner,
        basket: p.basket,
        plan,
        cash_mint: p.cashMint,
        owner_cash_account: tokenAccount(p.cashMint, p.owner, cashProgram),
        cash_token_program: cashProgram,
        system_program: SystemProgram.programId,
      },
      {
        plan_id: p.planId,
        cash_per_run: p.cashPerRun,
        period_secs: p.periodSecs,
        runs: p.runs,
        ref_shares_per_cash_e9: p.refSharesPerCashE9,
        band_bps: p.bandBps,
        auction_secs: p.auctionSecs,
        min_ref_shares_per_cash_e9: p.minRef,
        max_ref_shares_per_cash_e9: p.maxRef,
        trail_step_bps: p.trailStepBps ?? 0,
      },
    ),
  };
}

export function runPlanIx(p: { cranker: PublicKey; plan: Plan; nonce: bigint }) {
  const plan = new PublicKey(p.plan.address);
  const basket = new PublicKey(p.plan.basket);
  const owner = new PublicKey(p.plan.owner);
  const cashMint = new PublicKey(p.plan.cashMint);
  const cashProgram = new PublicKey(p.plan.cashTokenProgram);
  const order = planOrderAddress(plan, p.nonce);
  return {
    order,
    ix: instruction(
      "run_plan",
      {
        cranker: p.cranker,
        plan,
        order,
        cash_mint: cashMint,
        owner_cash_account: new PublicKey(p.plan.cashAccount),
        escrow: escrowAddress(order, cashMint, cashProgram),
        cash_token_program: cashProgram,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
      },
      { nonce: p.nonce },
    ),
  };
}

export function closePlanIx(p: { owner: PublicKey; plan: Plan }) {
  return instruction(
    "close_plan",
    {
      owner: p.owner,
      plan: new PublicKey(p.plan.address),
      owner_cash_account: new PublicKey(p.plan.cashAccount),
      cash_token_program: new PublicKey(p.plan.cashTokenProgram),
    },
    {},
  );
}

export function updatePlanIx(p: { owner: PublicKey; plan: Plan; ref: bigint; bandBps: number; auctionSecs: number; minRef: bigint; maxRef: bigint }) {
  return instruction(
    "update_plan",
    { owner: p.owner, plan: new PublicKey(p.plan.address) },
    {
      ref_shares_per_cash_e9: p.ref,
      band_bps: p.bandBps,
      auction_secs: p.auctionSecs,
      min_ref_shares_per_cash_e9: p.minRef,
      max_ref_shares_per_cash_e9: p.maxRef,
    },
  );
}

/** Closes a plan opened before the hardening release and revokes its allowance. */
export function closeLegacyPlanIx(p: { owner: PublicKey; plan: Plan }) {
  return instruction(
    "close_legacy_plan",
    {
      owner: p.owner,
      plan: new PublicKey(p.plan.address),
      owner_cash_account: new PublicKey(p.plan.cashAccount),
      cash_token_program: new PublicKey(p.plan.cashTokenProgram),
    },
    {},
  );
}

// ---------------------------------------------------------------- sell desk

/** Escrow `shares` and post a Dutch auction for cash: the seller receives startCash, decaying to endCash (their floor). */
export function placeSellOrderIx(p: {
  seller: PublicKey;
  basket: Basket;
  cashMint: PublicKey;
  cashProgram?: PublicKey;
  nonce: bigint;
  shares: bigint;
  startCash: bigint;
  endCash: bigint;
  startTs: number;
  endTs: number;
  /** Defaults to the seller's canonical share account. */
  sellerShareAccount?: PublicKey;
}) {
  const cashProgram = p.cashProgram ?? TOKEN_2022_PROGRAM_ID;
  const basket = new PublicKey(p.basket.address);
  const shareMint = new PublicKey(p.basket.shareMint);
  const sellOrder = sellOrderAddress(basket, p.seller, p.nonce);
  return {
    sellOrder,
    ix: instruction(
      "place_sell_order",
      {
        seller: p.seller,
        basket,
        sell_order: sellOrder,
        share_mint: shareMint,
        seller_share_account: p.sellerShareAccount ?? tokenAccount(shareMint, p.seller, TOKEN_2022_PROGRAM_ID),
        escrow: sellEscrowAddress(sellOrder, shareMint),
        cash_mint: p.cashMint,
        share_token_program: TOKEN_2022_PROGRAM_ID,
        cash_token_program: cashProgram,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
      },
      {
        nonce: p.nonce,
        shares: p.shares,
        start_cash: p.startCash,
        end_cash: p.endCash,
        start_ts: p.startTs,
        end_ts: p.endTs,
      },
    ),
  };
}

/**
 * Fill a sell order: the filler pays the seller's canonical cash account (the
 * instruction creates it if missing, at the filler's expense) and receives the
 * shares in `fillerShareAccount` (default: the filler's canonical one, which
 * must exist). Append a redeem_shares to take the components in kind.
 */
export function fillSellOrderIx(p: { filler: PublicKey; sellOrder: SellOrder; basket: Basket; fillerShareAccount?: PublicKey }) {
  const order = new PublicKey(p.sellOrder.address);
  const cashMint = new PublicKey(p.sellOrder.cashMint);
  const cashProgram = new PublicKey(p.sellOrder.cashTokenProgram);
  const shareMint = new PublicKey(p.basket.shareMint);
  const seller = new PublicKey(p.sellOrder.seller);
  return instruction(
    "fill_sell_order",
    {
      filler: p.filler,
      sell_order: order,
      basket: new PublicKey(p.basket.address),
      share_mint: shareMint,
      escrow: sellEscrowAddress(order, shareMint),
      filler_share_account: p.fillerShareAccount ?? tokenAccount(shareMint, p.filler, TOKEN_2022_PROGRAM_ID),
      seller,
      seller_cash_account: tokenAccount(cashMint, seller, cashProgram),
      cash_mint: cashMint,
      filler_cash_account: tokenAccount(cashMint, p.filler, cashProgram),
      rent_payer: new PublicKey(p.sellOrder.rentPayer),
      share_token_program: TOKEN_2022_PROGRAM_ID,
      cash_token_program: cashProgram,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      system_program: SystemProgram.programId,
    },
    {},
  );
}

/** Return a sell order's shares: the seller at any time, anyone after endTs (then only to the seller's canonical share account). */
export function cancelSellOrderIx(p: { caller: PublicKey; sellOrder: SellOrder; basket: Basket; sellerShareAccount?: PublicKey }) {
  const order = new PublicKey(p.sellOrder.address);
  const shareMint = new PublicKey(p.basket.shareMint);
  const seller = new PublicKey(p.sellOrder.seller);
  return instruction(
    "cancel_sell_order",
    {
      caller: p.caller,
      sell_order: order,
      basket: new PublicKey(p.basket.address),
      share_mint: shareMint,
      escrow: sellEscrowAddress(order, shareMint),
      seller,
      seller_share_account: p.sellerShareAccount ?? tokenAccount(shareMint, seller, TOKEN_2022_PROGRAM_ID),
      rent_payer: new PublicKey(p.sellOrder.rentPayer),
      share_token_program: TOKEN_2022_PROGRAM_ID,
    },
    {},
  );
}
