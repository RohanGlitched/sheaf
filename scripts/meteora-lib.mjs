/**
 * Shared helpers for the Meteora scripts (meteora-check, meteora-lifecycle,
 * meteora-partner). Devnet only: every script refuses any other RPC.
 *
 * The SDKs live in web/node_modules, so they are resolved from there. Run in
 * WSL (Windows node 21 cannot load @solana/web3.js):
 *
 *   wsl -e bash -lc 'source ~/.nvm/nvm.sh; cd /mnt/i/Programs/sheaf && node scripts/meteora-check.mjs'
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "web", "package.json"));

export const web3 = require("@solana/web3.js");
export const BN = require("bn.js");
export const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
export const cpamm = require("@meteora-ag/cp-amm-sdk");
export const splToken = require("@solana/spl-token");
const bs58mod = require("bs58");
const bs58 = bs58mod.default ?? bs58mod;

const { Connection, Keypair, PublicKey } = web3;

/** Helius devnet when web/.env.local has a key (the public RPC rate-limits a full lifecycle), else the public endpoint. */
function devnetRpc() {
  if (process.env.DEVNET_RPC) return process.env.DEVNET_RPC;
  const env = path.join(ROOT, "web", ".env.local");
  const key = fs.existsSync(env) ? fs.readFileSync(env, "utf8").match(/^HELIUS_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") : null;
  return key ? `https://devnet.helius-rpc.com/?api-key=${key}` : "https://api.devnet.solana.com";
}
export const RPC = devnetRpc();
if (!/devnet/.test(RPC)) throw new Error(`Refusing to run against a non-devnet RPC: ${RPC}`);
export const connection = new Connection(RPC, "confirmed");

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111112");
export const TREASURY = new PublicKey("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");
export const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

export const BASKETS = {
  BIG5: "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ",
  FRNTR: "6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv",
};

/** The house key: created BIG5 and FRNTR, so it is their launches' pool creator. */
export function houseKey() {
  const file = path.join(ROOT, ".keys", "faucet-key.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/** The treasury (partner / fee claimer) key, if it is on this machine. Never printed. */
export function treasuryKey() {
  const candidates = [
    path.join(ROOT, ".env.treasury"),
    path.join(ROOT, "..", "tessera", ".env.treasury"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const match = fs.readFileSync(file, "utf8").match(/TREASURY_SECRET_KEY=(.*)/);
    if (!match) continue;
    const secret = match[1].trim().replace(/^["']|["']$/g, "");
    const kp = secret.startsWith("[")
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)))
      : Keypair.fromSecretKey(bs58.decode(secret));
    if (kp.publicKey.equals(TREASURY)) return kp;
  }
  return null;
}

/** Same derivation as web/lib/dbc.ts `seeded()`: slot 0 is the v1 key, later slots are salted. */
export function launchKey(basket, role, slot = 0) {
  const label = slot === 0 ? `sheaf-launch-v1:${role}:${basket}` : `sheaf-launch-v2:${role}:${basket}:${slot}`;
  return Keypair.fromSeed(createHash("sha256").update(label).digest());
}

export function poolPda(program, config, baseMint) {
  const quoteFirst = NATIVE_SOL.toBuffer().compare(baseMint.toBuffer()) > 0;
  const [a, b] = quoteFirst ? [NATIVE_SOL, baseMint] : [baseMint, NATIVE_SOL];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), config.toBuffer(), a.toBuffer(), b.toBuffer()], program)[0];
}

export function launchInfo(basket, slot = 0) {
  const config = launchKey(basket, "config", slot).publicKey;
  const mint = launchKey(basket, "mint", slot).publicKey;
  return {
    config,
    mint,
    pool: poolPda(DBC_PROGRAM, config, mint),
    damm: poolPda(DAMM_V2_PROGRAM, DAMM_V2_CUSTOMIZABLE_CONFIG, mint),
  };
}

export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** Sign and send a legacy transaction, confirm it, and return the signature. */
export async function send(tx, signers, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} ${sig}`);
  console.log(`  ${label}: ${sig}`);
  return sig;
}

export const sol = (lamports) => Number(lamports) / 1e9;
