/**
 * Build the mirror for the eight PreStocks pre-IPO tokens, the way
 * setup-mirror.mjs does for xStocks — a stand-in per ticker on the write
 * cluster, so an unaudited program never takes custody of the real mint.
 *
 * The one difference from an xStock mirror: several PreStocks mints carry a
 * TransferFeeConfig extension, so the mirror is created with the same fee the
 * real mint charges. Without it, a devnet basket holding one of these would
 * never actually exercise the program's gross-up path.
 *
 *   node scripts/setup-mirror-prestocks.mjs --url devnet
 *
 * --issuer-powers builds mirrors that match mainnet extension for extension:
 * each new mint also carries the issuer powers every real PreStocks mint has
 * (permanent delegate, pause switch, confidential-transfer and
 * confidential-transfer-fee configs, a program-less transfer hook, an
 * "initialised" default state, a freeze authority, and a TransferFeeConfig
 * even at 0 bps), all held by the payer, which should be the stand-in issuer
 * the program lists in KNOWN_ISSUERS. These mints are recorded under their
 * own key in the state file and the generated web/lib file is left alone, so
 * the live mirrors are never touched or replaced:
 *
 *   node scripts/setup-mirror-prestocks.mjs --issuer-powers     # localnet
 *   node scripts/setup-mirror-prestocks.mjs --url devnet --issuer-powers --keypair .keys/faucet-key.json
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
  createInitializeTransferFeeConfigInstruction,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_TS = path.join(ROOT, "web/lib/mirror-prestocks.generated.ts");
const STATE = path.join(ROOT, ".mirror-state-prestocks.json");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const ISSUER_POWERS = args.includes("--issuer-powers");

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

const universeSrc = fs.readFileSync(path.join(ROOT, "web/lib/prestocks.ts"), "utf8");
const marker = "export const PRESTOCKS: PreStock[] = ";
const from = universeSrc.indexOf(marker) + marker.length;
const literal = universeSrc.slice(from, universeSrc.indexOf("\n];", from) + 2);
// prestocks.ts is hand-written with unquoted keys, so this is JS, not JSON.
const PRESTOCKS = new Function(`return ${literal}`)();

const connection = resilientConnection(rpc);
const MAX_FEE = BigInt("18446744073709551615"); // uncapped, matching the live mints

async function ensureMint(symbol, company, decimals, transferFeeBps, existing) {
  if (existing) {
    const info = await connection.getAccountInfo(new PublicKey(existing));
    if (info) return { mint: existing, created: false };
    console.log(`  ${symbol}: recorded mint is gone from ${cluster}, recreating`);
  }

  const mint = Keypair.generate();
  const extensions = [ExtensionType.MetadataPointer];
  // Every real PreStocks mint has a TransferFeeConfig (some at 0 bps), and
  // its confidential-transfer fee config needs one.
  const withFee = Boolean(transferFeeBps) || ISSUER_POWERS;
  if (withFee) extensions.push(ExtensionType.TransferFeeConfig);
  const space = ISSUER_POWERS
    ? issuerMintLen(extensions, { confidentialFee: true })
    : getMintLen(extensions);
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
  );
  if (withFee) {
    tx.add(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        payer.publicKey,
        transferFeeBps ?? 0,
        MAX_FEE,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (ISSUER_POWERS) {
    tx.add(...issuerPowerInstructions(mint.publicKey, payer.publicKey, { confidentialFee: true }));
  }
  tx.add(
    createInitializeMint2Instruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      // A real PreStock's freeze authority is its issuer's; a plain mirror has none.
      ISSUER_POWERS ? payer.publicKey : null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await withRetry(
    `${symbol} mint`,
    async () => (await connection.getAccountInfo(mint.publicKey)) != null,
    () => sendAndConfirmTransaction(connection, tx, [payer, mint]),
  );

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
        `${company} PreStocks (mirror)`,
        symbol,
        `https://prestocks.com/logos/${symbol.toLowerCase()}.png`,
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
  if (balance < 0.2e9) {
    console.error(
      `\nNot enough SOL to create 8 mints. Fund ${payer.publicKey.toBase58()} on ${cluster} and rerun.`,
    );
    process.exit(1);
  }

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  // Issuer-power mirrors live under their own key, so they never replace
  // (or get mistaken for) the mirrors the app uses.
  const stateKey = ISSUER_POWERS ? `${cluster}+issuer-powers` : cluster;
  const perCluster = state[stateKey] ?? {};
  const saveState = () => {
    state[stateKey] = perCluster;
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  };

  const rows = [];
  for (const stock of PRESTOCKS) {
    const { mint, created } = await ensureMint(
      stock.symbol,
      stock.company,
      stock.decimals,
      stock.transferFeeBps,
      perCluster[stock.symbol]?.mint,
    );
    perCluster[stock.symbol] = { mint };
    saveState();
    rows.push({ ...stock, writeMint: mint });
    console.log(`${created ? "+" : "="} ${stock.symbol.padEnd(11)} ${mint}`);
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
        `    transferFeeBps: ${r.transferFeeBps},\n` +
        `  },`,
    )
    .join("\n");

  fs.writeFileSync(
    OUT_TS,
    `// GENERATED by scripts/setup-mirror-prestocks.mjs on ${new Date().toISOString()}
// Cluster: ${cluster}. Do not edit by hand.

export type PreStockMirrorEntry = {
  writeMint: string;
  mainnetMint: string;
  transferFeeBps: number | null;
};

export const PRESTOCKS_MIRROR_CLUSTER = ${JSON.stringify(cluster)};

export const PRESTOCKS_MIRROR: Record<string, PreStockMirrorEntry> = {
${body}
};
`,
  );

  console.log(`\nwrote ${path.relative(ROOT, OUT_TS)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
