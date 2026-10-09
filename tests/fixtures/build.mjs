/**
 * Build the mainnet-clone fixtures for tests/mainnet-clone.ts.
 *
 * Reads real xStock and PreStocks mints from mainnet (read-only, public RPC)
 * and writes each one as a `solana-test-validator --account` file, byte for
 * byte, with a single change: the mint authority is rewritten to the
 * throwaway localnet key in `mint-authority.json`, so the tests can mint
 * balances of the real token. Every extension (permanent delegate, pause
 * switch, freeze authority, confidential-transfer configs, transfer hook,
 * default account state, ScaledUiAmount, transfer fee, metadata) and every
 * extension authority stays exactly as the issuer set it on mainnet.
 *
 *   node tests/fixtures/build.mjs            # rewrite the fixtures
 *   node tests/fixtures/build.mjs --keygen   # also make a new authority key
 *
 * It also writes two program-state fixtures no instruction can create any
 * more, both owned by the program and keyed to that same authority:
 *
 *   legacy-plan.json  a 280-byte Plan in the pre-hardening layout, for the
 *                     close_legacy_plan success path
 *   short-order.json  an open Order recording more cash than its escrow will
 *                     hold, for the EscrowShort guard in fill_order
 *   old-basket.json   a Basket written before the protocol fee existed (its
 *                     tail after `bump` is zero), with its share mint in
 *   old-share-mint.json, to show such a basket never charges one
 *
 * Anchor.toml loads every file through [[test.validator.account]]. The
 * program-state fixtures need the IDL, so run `anchor build` first.
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";

const DIR = import.meta.dirname;
const RPC = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";

export const FIXTURES = {
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  ANDURIL: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
};

const keyFile = path.join(DIR, "mint-authority.json");
if (process.argv.includes("--keygen") || !fs.existsSync(keyFile)) {
  fs.writeFileSync(keyFile, JSON.stringify([...Keypair.generate().secretKey]));
}
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))),
).publicKey;

const res = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [Object.values(FIXTURES), { encoding: "base64", commitment: "finalized" }],
  }),
});
const { result } = await res.json();

Object.entries(FIXTURES).forEach(([name, address], i) => {
  const acct = result.value[i];
  if (!acct) throw new Error(`${name} ${address} not found on mainnet`);
  const data = Buffer.from(acct.data[0], "base64");
  // Mint layout: COption<Pubkey> mint_authority = u32 tag + 32 bytes.
  if (data.readUInt32LE(0) !== 1) throw new Error(`${name} has no mint authority to rewrite`);
  const before = new PublicKey(data.subarray(4, 36)).toBase58();
  authority.toBuffer().copy(data, 4);
  const out = {
    pubkey: address,
    account: {
      lamports: acct.lamports,
      data: [data.toString("base64"), "base64"],
      owner: acct.owner,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`${name.padEnd(8)} ${address}  ${data.length} bytes  mint authority ${before} -> ${authority.toBase58()}`);
});

// ------------------------------------------------------ program-state fixtures

const ROOT = path.resolve(DIR, "../..");
const idlPath = [path.join(ROOT, "target/idl/sheaf.json"), path.join(ROOT, "web/lib/sheaf-idl.json")].find(
  (p) => fs.existsSync(p),
);
const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
const programId = new PublicKey(idl.address);
const coder = new anchor.BorshAccountsCoder(idl);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const BN = (n) => new anchor.BN(n.toString());
const rentExempt = (len) => (len + 128) * 6960;

// Shared with tests/mainnet-clone.ts.
export const CLONE_SYMBOL = "XSTK";
const basket = PublicKey.findProgramAddressSync(
  [Buffer.from("basket"), authority.toBuffer(), Buffer.from(CLONE_SYMBOL)],
  programId,
)[0];
const tsla = new PublicKey(FIXTURES.TSLAx);

function writeProgramAccount(name, address, data) {
  const out = {
    pubkey: address.toBase58(),
    account: {
      lamports: rentExempt(data.length),
      data: [data.toString("base64"), "base64"],
      owner: programId.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`${name.padEnd(12)} ${address.toBase58()}  ${data.length} bytes`);
}

// A pre-hardening plan: today's Plan minus the two trailing rate bounds.
{
  const PLAN_ID = 9;
  const [plan, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("plan"), basket.toBuffer(), authority.toBuffer(), u64le(PLAN_ID)],
    programId,
  );
  const full = await coder.encode("Plan", {
    owner: authority,
    basket,
    cash_mint: tsla,
    cash_token_program: TOKEN_2022,
    cash_account: getAssociatedTokenAddressSync(tsla, authority, false, TOKEN_2022),
    plan_id: BN(PLAN_ID),
    cash_per_run: BN(1_000_000),
    period_secs: BN(86_400),
    runs_total: 12,
    runs_left: 9,
    next_run_ts: BN(0),
    ref_shares_per_cash_e9: BN(4_000_000),
    band_bps: 300,
    auction_secs: BN(600),
    last_order: plan, // Some(_), so every field sits at its fixed offset
    fills: 3,
    last_fill_ts: BN(0),
    created_at: BN(0),
    bump,
    min_ref_shares_per_cash_e9: BN(0),
    max_ref_shares_per_cash_e9: BN(0),
  });
  if (full.length !== 296) throw new Error(`Plan encodes to ${full.length} bytes, expected 296`);
  writeProgramAccount("legacy-plan", plan, full.subarray(0, 280));
}

// An open order whose escrow is short of what it records, as if a seize power
// on the cash mint had emptied it. The test creates the (empty) escrow.
{
  const NONCE = 777;
  const [order, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("order"), basket.toBuffer(), authority.toBuffer(), u64le(NONCE)],
    programId,
  );
  const enc = await coder.encode("Order", {
    basket,
    buyer: authority,
    rent_payer: authority,
    cash_mint: tsla,
    cash_token_program: TOKEN_2022,
    plan: null,
    nonce: BN(NONCE),
    cash_amount: BN(1_000_000),
    start_shares: BN(2),
    end_shares: BN(1),
    start_ts: BN(0),
    end_ts: BN(4_000_000_000),
    created_at: BN(0),
    bump,
  });
  const data = Buffer.alloc(258);
  enc.copy(data);
  writeProgramAccount("short-order", order, data);
}

// A basket from before the protocol fee: everything up to `bump` as the old
// release wrote it, then the zeroed headroom the new fields are read from.
export const OLD_SYMBOL = "OLDB";
{
  const [oldBasket, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("basket"), authority.toBuffer(), Buffer.from(OLD_SYMBOL)],
    programId,
  );
  // The share mint: a bare Token-2022 mint (82 bytes), 6 decimals, no supply,
  // mint authority = the basket, no freeze authority.
  const shareMint = PublicKey.findProgramAddressSync([Buffer.from("old-share-mint")], programId)[0];
  const mint = Buffer.alloc(82);
  mint.writeUInt32LE(1, 0);
  oldBasket.toBuffer().copy(mint, 4);
  mint[44] = 6;
  mint[45] = 1;
  fs.writeFileSync(
    path.join(DIR, "old-share-mint.json"),
    JSON.stringify(
      {
        pubkey: shareMint.toBase58(),
        account: {
          lamports: rentExempt(82),
          data: [mint.toString("base64"), "base64"],
          owner: TOKEN_2022.toBase58(),
          executable: false,
          rentEpoch: 0,
          space: 82,
        },
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`old-share-mint ${shareMint.toBase58()}  82 bytes`);

  const empty = { mint: PublicKey.default, units_per_share: BN(0), weight_bps: 0, decimals: 0, _padding: [0, 0, 0, 0, 0] };
  const enc = await coder.encode("Basket", {
    creator: authority,
    share_mint: shareMint,
    token_program: TOKEN_2022,
    name: "Old Basket",
    symbol: OLD_SYMBOL,
    creator_fee_bps: 0,
    component_count: 1,
    components: [
      { mint: tsla, units_per_share: BN(1_000_000), weight_bps: 10_000, decimals: 8, _padding: [0, 0, 0, 0, 0] },
      ...Array(7).fill(empty),
    ],
    created_at: BN(0),
    mint_count: BN(0),
    redeem_count: BN(0),
    bump,
    protocol_fee_bps: 0,
    protocol_fee_accrued: BN(0),
  });
  const SPACE = 630;
  const data = Buffer.alloc(SPACE);
  enc.copy(data);
  // What the old release wrote ends at `bump`; the 10 new bytes must be zero.
  if (!data.subarray(enc.length - 10, enc.length).every((b) => b === 0)) throw new Error("old basket tail not zero");
  writeProgramAccount("old-basket", oldBasket, data);
}
