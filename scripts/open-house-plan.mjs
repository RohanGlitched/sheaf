// Opens the house's demo plan: test dollars into a basket every few minutes, so
// /plans always has a live plan to show. The house is both the plan's owner and
// its filler, so each run's dollars come straight back to it on the fill.
//   node scripts/open-house-plan.mjs [basket] [dollarsPerRun] [periodSecs] [runs]
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

const basket = new PublicKey(process.argv[2] ?? "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ");
const dollars = Number(process.argv[3] ?? 25);
const periodSecs = Number(process.argv[4] ?? 300);
const runs = Number(process.argv[5] ?? 2000);
const SITE = "https://sheaf-index.vercel.app";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(house), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

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
    new anchor.BN(periodSecs <= 300 ? 240 : 1800),
    new anchor.BN(minRef.toString()),
    new anchor.BN(maxRef.toString()),
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
console.log(`plan ${plan.toBase58()} opened: $${dollars} every ${periodSecs}s, ${runs} runs, nav ${nav}`, sig);
