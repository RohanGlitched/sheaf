// Opens the house's demo plan: test dollars into a basket every few minutes, so
// /plans always has a live plan to show. The house is both the plan's owner and
// its filler, so each run's dollars come straight back to it on the fill.
//   node scripts/open-house-plan.mjs [basket] [dollarsPerRun] [periodSecs] [runs] [auctionSecs] [trailStepBps] [--close <old plan>]
// trailStepBps 0 (default) keeps the 6% bounds fixed; a step lets the plan
// follow the market inside them.
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

const closeAt = process.argv.indexOf("--close");
const closePlan = closeAt > -1 ? new PublicKey(process.argv[closeAt + 1]) : null;
const positional = process.argv.slice(2).filter((_, i, all) => all[i] !== "--close" && all[i - 1] !== "--close");
const basket = new PublicKey(positional[0] ?? "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ");
const dollars = Number(positional[1] ?? 25);
const periodSecs = Number(positional[2] ?? 300);
const runs = Number(positional[3] ?? 2000);
const auctionSecs = Number(positional[4] ?? (periodSecs <= 300 ? 240 : 1800));
const trailStepBps = Number(positional[5] ?? 0);
const SITE = "https://sheaf-index.vercel.app";

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

// The same terms the plan form writes: reference at today's recipe value, 2% band, 6% bounds.
const nav = (await (await fetch(`${SITE}/api/nav/${basket.toBase58()}`)).json()).navPerShare.recipe;
const ref = BigInt(Math.floor(1e9 / nav));
const minRef = (ref * 9_400n) / 10_000n;
const maxRef = (ref * 10_600n) / 10_000n;
const cashPerRun = BigInt(Math.round(dollars * 1e6));
const planId = BigInt(Date.now());

// The house mints test dollars for a few runs; fills pay them back.
const ata = getAssociatedTokenAddressSync(cashMint, house.publicKey, false, TOKEN_2022_PROGRAM_ID);
const top = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(house.publicKey, ata, house.publicKey, cashMint, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(cashMint, ata, house.publicKey, cashPerRun * 20n, [], TOKEN_2022_PROGRAM_ID),
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
    200,
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
console.log(`plan ${plan.toBase58()} opened: $${dollars} every ${periodSecs}s, auction ${auctionSecs}s, ${runs} runs, nav ${nav}`, sig);
