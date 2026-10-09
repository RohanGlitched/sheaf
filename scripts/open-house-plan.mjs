// Opens the house's demo plan: test dollars into a basket every few minutes, so
// /plans always has a live plan to show. The house is both the plan's owner and
// its filler, so each run's dollars come straight back to it on the fill.
//   node scripts/open-house-plan.mjs [basket] [dollarsPerRun] [periodSecs] [runs] [auctionSecs] [trailStepBps] [--close <old plan>]
//   node scripts/open-house-plan.mjs [basket] [dollarsPerRun] --cadence month|week|demo [--runs N] [--close <old plan>]
// trailStepBps 0 (default) keeps the 6% bounds fixed; a step lets the plan
// follow the market inside them.
// --cadence writes exactly the terms the plan form gives that cadence
// (CADENCE in components/plan-form.tsx): its period and auction, its band, a
// trailing step equal to the band, and hard limits as a price either side of
// today's (25% monthly, 15% weekly, 10% at demo speed). The reference is net of
// the basket's creator and protocol fees, as the form's is.
// --close first closes an earlier house plan (revoking its allowance), so only
// one house demo plan runs at a time.
// Run in WSL (Windows node breaks @solana/web3.js). Devnet only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const idl = JSON.parse(fs.readFileSync(path.join(root, "web/lib/sheaf-idl.json"), "utf8"));
const cashMint = new PublicKey(
  fs.readFileSync(path.join(root, "web/lib/cash.generated.ts"), "utf8").match(/CASH_MINT[^"]*"([1-9A-HJ-NP-Za-km-z]{32,44})"/)[1],
);
const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(root, ".keys/faucet-key.json"), "utf8"))));

// Mirrors CADENCE in components/plan-form.tsx; keep the two in step.
const CADENCE = {
  month: { secs: 30 * 24 * 3600, auctionSecs: 1800, bandBps: 1500, hardBps: 2500, runs: 12 },
  week: { secs: 7 * 24 * 3600, auctionSecs: 1800, bandBps: 1000, hardBps: 1500, runs: 52 },
  demo: { secs: 300, auctionSecs: 240, bandBps: 200, hardBps: 1000, runs: 2000 },
};
const FLAGS = ["--close", "--cadence", "--runs"];
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at > -1 ? process.argv[at + 1] : undefined;
};
const closePlan = flag("--close") ? new PublicKey(flag("--close")) : null;
const cadence = flag("--cadence") ? CADENCE[flag("--cadence")] : null;
if (flag("--cadence") && !cadence) throw new Error(`--cadence must be one of ${Object.keys(CADENCE).join(", ")}`);
const positional = process.argv.slice(2).filter((_, i, all) => !FLAGS.includes(all[i]) && !FLAGS.includes(all[i - 1]));
const basket = new PublicKey(positional[0] ?? "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ");
const dollars = Number(positional[1] ?? 25);
const periodSecs = cadence ? cadence.secs : Number(positional[2] ?? 300);
const runs = Number(flag("--runs") ?? (cadence ? cadence.runs : (positional[3] ?? 2000)));
const auctionSecs = cadence ? cadence.auctionSecs : Number(positional[4] ?? (periodSecs <= 300 ? 240 : 1800));
const trailStepBps = cadence ? cadence.bandBps : Number(positional[5] ?? 0);
const bandBps = cadence ? cadence.bandBps : 200;
const SITE = "https://sheaf.world";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(house), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

if (closePlan) {
  const old = await program.account.plan.fetch(closePlan);
  const closed = await program.methods
    .closePlan()
    .accounts({ owner: house.publicKey, plan: closePlan, ownerCashAccount: old.cashAccount, cashTokenProgram: old.cashTokenProgram })
    .rpc();
  console.log(`closed plan ${closePlan.toBase58()} (${old.runsLeft} runs left)`, closed);
}

const nav = (await (await fetch(`${SITE}/api/nav/${basket.toBase58()}`)).json()).navPerShare.recipe;
let ref, minRef, maxRef;
if (cadence) {
  // planTerms in plan-form.tsx: shares received per dollar after both fees, and
  // hard limits h either side of today's price (ref / (1 ± h)).
  const fees = (await (await fetch(`${SITE}/api/baskets`)).json()).find((b) => b.address === basket.toBase58());
  if (!fees) throw new Error("basket not found on /api/baskets");
  const feeBps = BigInt((fees.creatorFeeBps ?? 0) + (fees.protocolFeeBps ?? 0));
  const gross = BigInt(Math.floor(1e9 / nav));
  ref = gross - (gross * feeBps) / 10_000n;
  minRef = (ref * 10_000n) / BigInt(10_000 + cadence.hardBps);
  maxRef = (ref * 10_000n) / BigInt(10_000 - cadence.hardBps);
} else {
  // The older demo terms: reference at today's recipe value, 2% band, 6% bounds.
  ref = BigInt(Math.floor(1e9 / nav));
  minRef = (ref * 9_400n) / 10_000n;
  maxRef = (ref * 10_600n) / 10_000n;
}
const cashPerRun = BigInt(Math.round(dollars * 1e6));
const planId = BigInt(Date.now());

// The house mints test dollars for a few runs; fills pay them back.
const ata = getAssociatedTokenAddressSync(cashMint, house.publicKey, false, TOKEN_2022_PROGRAM_ID);
const top = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(house.publicKey, ata, house.publicKey, cashMint, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(cashMint, ata, house.publicKey, cashPerRun * BigInt(Math.min(runs, 20)), [], TOKEN_2022_PROGRAM_ID),
);
console.log("top up", await provider.sendAndConfirm(top));

const [plan] = PublicKey.findProgramAddressSync(
  [Buffer.from("plan"), basket.toBuffer(), house.publicKey.toBuffer(), new anchor.BN(planId.toString()).toArrayLike(Buffer, "le", 8)],
  program.programId,
);
const sig = await program.methods
  .openPlan(
    new anchor.BN(planId.toString()),
    new anchor.BN(cashPerRun.toString()),
    new anchor.BN(periodSecs),
    runs,
    new anchor.BN(ref.toString()),
    bandBps,
    new anchor.BN(auctionSecs),
    new anchor.BN(minRef.toString()),
    new anchor.BN(maxRef.toString()),
    trailStepBps,
  )
  .accounts({
    owner: house.publicKey,
    basket,
    plan,
    cashMint,
    ownerCashAccount: ata,
    cashTokenProgram: TOKEN_2022_PROGRAM_ID,
  })
  .rpc();
console.log(
  `plan ${plan.toBase58()} opened: $${dollars} every ${periodSecs}s, auction ${auctionSecs}s, ${runs} runs, band ${bandBps} bps, trail ${trailStepBps} bps, ` +
    `pays $${(1e9 / Number(maxRef)).toFixed(2)}-$${(1e9 / Number(minRef)).toFixed(2)} a share, nav ${nav}`,
  sig,
);
