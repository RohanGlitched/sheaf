/**
 * Build the mirror: a stand-in for every mainnet xStock on the write cluster.
 *
 * The twenty tokenised equities Sheaf composes exist only on Solana mainnet, and
 * deploying an unaudited program that takes custody of real ones would be
 * reckless. So the write cluster gets a mirror instead — a mint per ticker,
 * created with the same extensions the real ones carry:
 *
 *   8 decimals              same as every xStock
 *   Token-2022              same program
 *   MetadataPointer         self-referential, same as Backed's
 *   TokenMetadata           name and symbol, so wallets show the right thing
 *   ScaledUiAmountConfig    seeded with the multiplier the real mint has right
 *                           now, so a mirror of a dividend-paying stock starts
 *                           where the real one stands
 *
 * The one difference that matters: mint authority stays with the faucet keypair,
 * so the app can hand a visitor test shares. Everything the program touches
 * behaves identically.
 *
 *   node scripts/setup-mirror.mjs                    # localnet
 *   node scripts/setup-mirror.mjs --url devnet
 *   node scripts/setup-mirror.mjs --url devnet --refresh-multipliers
 *
 * --issuer-powers builds mirrors that match mainnet extension for extension:
 * on top of the above, each new mint carries the issuer powers every real
 * one has (permanent delegate, pause switch, confidential-transfer config,
 * a program-less transfer hook, an "initialised" default state and a freeze
 * authority), all held by the payer, which should be the stand-in issuer the
 * program lists in KNOWN_ISSUERS. These mints are recorded under their own
 * key in the state file and the generated web/lib file is left alone, so the
 * live mirrors are never touched or replaced:
 *
 *   node scripts/setup-mirror.mjs --issuer-powers               # localnet
 *   node scripts/setup-mirror.mjs --url devnet --issuer-powers --keypair .keys/faucet-key.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { resilientConnection, withRetry } from "./lib/rpc.mjs";
import { STAND_IN_ISSUER, issuerMintLen, issuerPowerInstructions } from "./lib/issuer-powers.mjs";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
  getMint,
  getScaledUiAmountConfig,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_TS = path.join(ROOT, "web/lib/mirror.generated.ts");
const STATE = path.join(ROOT, ".mirror-state.json");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const has = (name) => args.includes(`--${name}`);
const ISSUER_POWERS = has("issuer-powers");

const URLS = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};
const clusterArg = flag("url", "localnet");
const cluster = URLS[clusterArg] ? clusterArg : "custom";
const rpc = URLS[clusterArg] ?? clusterArg;

function loadKeypair(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const payerPath =
  flag("keypair") ?? path.join(os.homedir(), ".config/solana/id.json");
const payer = loadKeypair(payerPath);

// ------------------------------------------------------- read the real universe

const universeSrc = fs.readFileSync(path.join(ROOT, "web/lib/universe.ts"), "utf8");
const universeJson = universeSrc.slice(
  universeSrc.indexOf("export const XSTOCKS: XStock[] = ") +
    "export const XSTOCKS: XStock[] = ".length,
);
const XSTOCKS = JSON.parse(universeJson.slice(0, universeJson.indexOf("\n];") + 2));

/** Live multipliers, so a mirror starts where the real mint stands today. */
async function liveMultipliers() {
  const ids = XSTOCKS.map((s) => s.mint).join(",");
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`jupiter ${res.status}`);
    const data = await res.json();
    const out = new Map();
    for (const s of XSTOCKS) {
      const cfg = data[s.mint]?.scaledUiConfig;
      if (!cfg) continue;
      const stepAt = cfg.newMultiplierEffectiveAt
        ? Date.parse(cfg.newMultiplierEffectiveAt)
        : NaN;
      const current =
        cfg.newMultiplier != null && Number.isFinite(stepAt) && stepAt <= Date.now()
          ? cfg.newMultiplier
          : (cfg.multiplier ?? 1);
      out.set(s.symbol, current);
    }
    return out;
  } catch (err) {
    console.warn(`! could not read live multipliers (${err.message}); using 1.0`);
    return new Map();
  }
}

// ------------------------------------------------------------------------ main

// Public devnet answers a 20-mint run with 429 storms, and a long enough storm
// outlives the blockhash. See scripts/lib/rpc.mjs for what is safe to retry.
const connection = resilientConnection(rpc);

async function ensureMint(symbol, company, multiplier, existing) {
  if (existing) {
    const info = await connection.getAccountInfo(new PublicKey(existing));
    if (info) return { mint: existing, created: false };
    console.log(`  ${symbol}: recorded mint is gone from ${cluster}, recreating`);
  }

  const mint = Keypair.generate();
  const extensions = [
    ExtensionType.MetadataPointer,
    ExtensionType.ScaledUiAmountConfig,
  ];
  const space = ISSUER_POWERS ? issuerMintLen(extensions) : getMintLen(extensions);
  // Headroom for the variable-length metadata, which is appended after init.
  const lamports = await connection.getMinimumBalanceForRentExemption(space + 320);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      payer.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeScaledUiAmountConfigInstruction(
      mint.publicKey,
      payer.publicKey,
      multiplier,
      TOKEN_2022_PROGRAM_ID,
    ),
    ...(ISSUER_POWERS ? issuerPowerInstructions(mint.publicKey, payer.publicKey) : []),
    createInitializeMint2Instruction(
      mint.publicKey,
      8,
      payer.publicKey,
      // A real xStock's freeze authority is its issuer's; a plain mirror has none.
      ISSUER_POWERS ? payer.publicKey : null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await withRetry(
    `${symbol} mint`,
    async () => (await connection.getAccountInfo(mint.publicKey)) != null,
    () => sendAndConfirmTransaction(connection, tx, [payer, mint]),
  );

  // Metadata is appended into the mint account itself, so an init that landed
  // shows up as an account longer than the bare extension layout.
  await withRetry(
    `${symbol} metadata`,
    async () => {
      const info = await connection.getAccountInfo(mint.publicKey);
      return info != null && info.data.length > space;
    },
    () =>
      tokenMetadataInitializeWithRentTransfer(
        connection,
        payer,
        mint.publicKey,
        payer.publicKey,
        payer,
        `${company} xStock (mirror)`,
        symbol,
        `https://xstocks-metadata.backed.fi/logos/tokens/${symbol}.png`,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      ),
  );

  return { mint: mint.publicKey.toBase58(), created: true };
}

async function main() {
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`cluster   ${cluster} (${rpc})`);
  console.log(`payer     ${payer.publicKey.toBase58()}`);
  console.log(`balance   ${(balance / 1e9).toFixed(4)} SOL`);
  if (ISSUER_POWERS) {
    console.log("mode      issuer powers (new mints only; live mirrors untouched)");
    if (!payer.publicKey.equals(STAND_IN_ISSUER)) {
      console.warn(
        `! payer is not the stand-in issuer ${STAND_IN_ISSUER.toBase58()}: the program will refuse these mints as components`,
      );
    }
  }
  if (balance < 0.5e9) {
    console.error(
      `\nNot enough SOL to create 20 mints. Fund ${payer.publicKey.toBase58()} on ${cluster} and rerun.`,
    );
    process.exit(1);
  }

  const multipliers = await liveMultipliers();
  const state = fs.existsSync(STATE)
    ? JSON.parse(fs.readFileSync(STATE, "utf8"))
    : {};
  // Issuer-power mirrors live under their own key, so they never replace
  // (or get mistaken for) the mirrors the app uses.
  const stateKey = ISSUER_POWERS ? `${cluster}+issuer-powers` : cluster;
  const perCluster = state[stateKey] ?? {};

  // Written after every mint, not once at the end. A run that throws partway
  // through has already paid rent on the mints it created, and their addresses
  // are unrecoverable if they only ever existed in memory.
  const saveState = () => {
    state[stateKey] = perCluster;
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  };

  const rows = [];
  for (const stock of XSTOCKS) {
    const multiplier = multipliers.get(stock.symbol) ?? 1;
    const { mint, created } = await ensureMint(
      stock.symbol,
      stock.company,
      multiplier,
      perCluster[stock.symbol]?.mint,
    );
    perCluster[stock.symbol] = { mint, multiplier };
    saveState();

    if (!created && has("refresh-multipliers") && multiplier > 1) {
      const onChain = await getMint(
        connection,
        new PublicKey(mint),
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      const current = Number(getScaledUiAmountConfig(onChain)?.multiplier ?? 1);
      if (Math.abs(current - multiplier) > 1e-9) {
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(
            createUpdateMultiplierDataInstruction(
              new PublicKey(mint),
              payer.publicKey,
              multiplier,
              0n,
              [],
              TOKEN_2022_PROGRAM_ID,
            ),
          ),
          [payer],
        );
        console.log(
          `  ${stock.symbol}: multiplier ${current} -> ${multiplier}`,
        );
      }
    }

    rows.push({ ...stock, writeMint: mint, multiplier });
    console.log(
      `${created ? "+" : "="} ${stock.symbol.padEnd(7)} ${mint}  x${multiplier.toFixed(7)}`,
    );

    // A beat between creations. The public endpoint is markedly happier for it,
    // and 20 mints is not a run worth optimising.
    if (created) await new Promise((resolve) => setTimeout(resolve, 400));
  }

  saveState();

  if (ISSUER_POWERS) {
    console.log(`\nstate ${path.relative(ROOT, STATE)} under "${stateKey}"; ${path.relative(ROOT, OUT_TS)} left as is`);
    return;
  }

  const body = rows
    .map(
      (r) =>
        `  ${JSON.stringify(r.symbol)}: {\n` +
        `    writeMint: ${JSON.stringify(r.writeMint)},\n` +
        `    mainnetMint: ${JSON.stringify(r.mint)},\n` +
        `    seededMultiplier: ${r.multiplier},\n` +
        `  },`,
    )
    .join("\n");

  fs.writeFileSync(
    OUT_TS,
    `// GENERATED by scripts/setup-mirror.mjs on ${new Date().toISOString()}
// Cluster: ${cluster}. Do not edit by hand.
//
// Each entry pairs a mainnet xStock with its stand-in on the write cluster. Prices
// and multipliers on screen come from the mainnet mint; mint and redeem transactions
// go to the write mint. Both are shown wherever it could matter.

export type MirrorEntry = {
  writeMint: string;
  mainnetMint: string;
  /** The mainnet multiplier the mirror was seeded with. */
  seededMultiplier: number;
};

export const MIRROR_CLUSTER = ${JSON.stringify(cluster)};

export const MIRROR: Record<string, MirrorEntry> = {
${body}
};

export const HAS_MIRROR = true;
`,
  );

  console.log(`\nwrote ${path.relative(ROOT, OUT_TS)}`);
  console.log(`state ${path.relative(ROOT, STATE)} (keeps mints stable across runs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
