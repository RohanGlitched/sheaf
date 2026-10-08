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

export function planAddress(basket: PublicKey, owner: PublicKey, planId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("plan"), basket.toBuffer(), owner.toBuffer(), le64(planId)], PROGRAM_ID)[0];
}

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
  };
}

async function allOf<T>(connection: Connection, name: "Order" | "Plan", decode: (a: PublicKey, d: Uint8Array) => T | null, extra: { memcmp: { offset: number; bytes: string } }[] = []) {
  const disc = ACCOUNT_DISC.get(name)!;
  const bs58 = (await import("bs58")).default;
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }, ...extra],
  });
  return accounts.map((a) => decode(a.pubkey, new Uint8Array(a.account.data))).filter((x): x is T => x != null);
}

export const fetchOrders = (connection: Connection, basket?: string) =>
  allOf(connection, "Order", decodeOrder, basket ? [{ memcmp: { offset: 8, bytes: basket } }] : []);

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

/** The creator fee on `shares`, as mint_shares charges it (floored). */
export const creatorFeeOn = (shares: bigint, feeBps: number) => (shares * BigInt(feeBps)) / 10_000n;

/** The smallest gross share count whose creator fee leaves exactly `net`: what a filler must deliver components for. */
export function grossSharesForNet(net: bigint, feeBps: number): bigint {
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
  const order = orderAddress(basket, owner, p.nonce);
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
