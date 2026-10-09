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

/**
 * The same terms check as `checkTerms` in web/lib/dbc.ts, on raw PoolConfig
 * bytes: all graduated LP permanently locked and split 50/50, an immutable
 * Token-2022 token, curve fees in SOL split 50/50 after Meteora's 20%, a
 * migration fee of at most 1% and none to the creator, no vesting supply, the
 * preset's volatility fee, and a curve and fee schedule that are v1 or v2.
 * Returns { preset, reason }. Keep the two in step.
 */
const PRESET = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "lib", "meteora-preset.json"), "utf8"));
const presetTerms = (activation, fee, periodLength, migratedFeeBps, migratedFeeMode, caps, weights) => ({
  activation,
  cliff: BigInt(fee.startingFeeBps) * 100_000n,
  first: fee.numberOfPeriod,
  second: BigInt(periodLength),
  third: BigInt(fee.reductionFactor),
  migratedFeeBps,
  migratedFeeMode,
  caps: caps.slice(1),
  weights: weights.map((w) => w / weights[0]),
});
const PRESET_TERMS = {
  v2: presetTerms(
    1,
    PRESET.fees.antiSnipe,
    PRESET.fees.antiSnipe.totalDurationSeconds / PRESET.fees.antiSnipe.numberOfPeriod,
    PRESET.migration.dammV2.startingFeeBps,
    4,
    PRESET.curve.capMultiplesOfOpen,
    PRESET.curve.liquidityWeights,
  ),
  v1: presetTerms(
    0,
    PRESET.previous.antiSnipe,
    PRESET.previous.antiSnipe.totalDurationSlots / PRESET.previous.antiSnipe.numberOfPeriod,
    PRESET.previous.migratedPoolFeeBps,
    0,
    PRESET.previous.capMultiplesOfOpen,
    PRESET.previous.liquidityWeights,
  ),
};
const near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.002;
const u64le = (d, at) => d.readBigUInt64LE(at);
const u128le = (d, at) => u64le(d, at) | (u64le(d, at + 8) << 64n);

export function launchTerms(c) {
  const no = (reason) => ({ preset: null, reason });
  const unlocked = c[240] + c[242] + c[185] + c[201];
  if (unlocked > 0) return no(`${unlocked}% of its graduated liquidity is not permanently locked and can be withdrawn after graduation.`);
  if (c[239] !== 50 || c[241] !== 50) return no("Its locked liquidity is not split evenly between the creator and Sheaf's treasury.");
  if (c[246] !== 1) return no("Its token is not immutable: someone keeps an update or a mint authority.");
  if (c[237] !== 1) return no("Its token is not Token-2022.");
  if (c[232] !== 0) return no("Its curve fees are not collected in SOL.");
  if (c[245] !== PRESET.fees.creatorTradingFeePercentage) {
    return no(`It gives the creator ${c[245]}% of curve fees after Meteora's share, not ${PRESET.fees.creatorTradingFeePercentage}%.`);
  }
  if (c[243] !== 6 || c[247] > PRESET.migration.migrationFeePercentage || c[248] !== 0) {
    return no("Its migration fee is not Sheaf's: at most 1% of the raise, none of it to the creator.");
  }
  if (u64le(c, 296) !== 0n || u64le(c, 328) !== 0n) return no("It reserves supply for vesting outside the curve.");
  if (c[136] !== 1 || c.readUInt32LE(144) !== 14_460_000 || c.readUInt32LE(148) !== 956) return no("Its volatility fee is not the preset's.");
  const start = Number(u128le(c, 392));
  const caps = [];
  const liquidity = [];
  for (let i = 0; i < 20; i++) {
    const sp = u128le(c, 408 + i * 32);
    if (sp === 0n) break;
    caps.push((Number(sp) / start) ** 2);
    liquidity.push(Number(u128le(c, 424 + i * 32)));
  }
  const migration = (Number(u128le(c, 280)) / start) ** 2;
  for (const id of ["v2", "v1"]) {
    const t = PRESET_TERMS[id];
    if (c[234] !== t.activation) continue;
    if (u64le(c, 104) !== t.cliff || c.readUInt16LE(128) !== t.first || u64le(c, 112) !== t.second || u64le(c, 120) !== t.third || c[130] !== 1) continue;
    if (c.readUInt16LE(362) !== t.migratedFeeBps || c[364] !== t.migratedFeeMode) continue;
    if (caps.length !== t.caps.length || !caps.every((v, i) => near(v, t.caps[i]))) continue;
    if (!near(migration, t.caps[t.caps.length - 1])) continue;
    if (!liquidity.every((l, i) => near(l / liquidity[0], t.weights[i]))) continue;
    return { preset: id, reason: null };
  }
  return no("Its curve or fee schedule is not one of Sheaf's published presets.");
}
