/**
 * Lay a few baskets on the write cluster.
 *
 * The app can do all of this from a browser wallet, but a fresh cluster with an
 * empty program is a bad first impression and a worse demo. This script lays three
 * recognisable baskets, priced from live mainnet quotes, and creates some shares in
 * each so the vault-coverage table on the basket page has something to show.
 *
 *   node scripts/seed-baskets.mjs [--url http://127.0.0.1:8899] [--keypair PATH]
 *
 * Idempotent: a basket whose PDA already exists is left alone, and shares are only
 * created if the supply is still zero.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { resilientConnection, sendResilient } from "./lib/rpc.mjs";

/**
 * Every send in this script goes through the resilient wrapper.
 *
 * Shadowing the web3.js name keeps the call sites below unchanged and makes it
 * impossible to reach the raw version by accident, which matters because there
 * are six of them and missing one puts the whole run back at the mercy of a
 * throttled endpoint.
 */
const sendAndConfirmTransaction = (conn, tx, signers, options) =>
  sendResilient(conn, tx, signers, options);
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createSetAuthorityInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  AuthorityType,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";

const ROOT = path.resolve(import.meta.dirname, "..");
const ONE_SHARE = 1_000_000n;
const SHARE_DECIMALS = 6;

// ------------------------------------------------------------------------ args

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://127.0.0.1:8899");
const keypairPath = arg(
  "keypair",
  path.join(os.homedir(), ".config", "solana", "id.json"),
);

// --------------------------------------------------------------- generated data

/** Slice a TS module's exported array or object literal out without importing it. */
function readLiteral(file, marker) {
  const source = fs.readFileSync(file, "utf8");
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`${marker} not found in ${file}`);
  // Start after the marker: the type annotation in it contains brackets of its own.
  const from = at + marker.length;
  const openChar = source[from] === "[" ? "[" : "{";
  const open = source.indexOf(openChar, from);
  const closeChar = openChar === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === openChar) depth++;
    else if (source[i] === closeChar) {
      depth--;
      if (depth === 0) {
        // The generated modules use unquoted keys, so this is a JS literal rather
        // than JSON. Both files are written by scripts in this repository.
        return new Function(`return ${source.slice(open, i + 1)}`)();
      }
    }
  }
  throw new Error(`unterminated literal for ${marker}`);
}

const MIRROR = readLiteral(
  path.join(ROOT, "web/lib/mirror.generated.ts"),
  "export const MIRROR: Record<string, MirrorEntry> = ",
);
const XSTOCKS = readLiteral(
  path.join(ROOT, "web/lib/universe.ts"),
  "export const XSTOCKS: XStock[] = ",
);
const PRESTOCKS = readLiteral(
  path.join(ROOT, "web/lib/prestocks.ts"),
  "export const PRESTOCKS: PreStock[] = ",
);
const PRESTOCKS_MIRROR = readLiteral(
  path.join(ROOT, "web/lib/mirror-prestocks.generated.ts"),
  "export const PRESTOCKS_MIRROR: Record<string, PreStockMirrorEntry> = ",
);

// xStocks and PreStocks, merged by symbol. A recipe names either kind the same
// way; only the mint each one settles against on the write cluster differs.
const BY_SYMBOL = new Map([
  ...XSTOCKS.map((s) => [s.symbol, s]),
  ...PRESTOCKS.map((s) => [s.symbol, s]),
]);
const ALL_MIRROR = { ...MIRROR, ...PRESTOCKS_MIRROR };

const idl = JSON.parse(
  fs.readFileSync(path.join(ROOT, "web/lib/sheaf-idl.json"), "utf8"),
);
const PROGRAM_ID = new PublicKey(idl.address);

// ------------------------------------------------------------------- the recipes

/** Weights are basis points and have to add to exactly 10,000. */
const RECIPES = [
  {
    name: "The Big Five",
    symbol: "BIG5",
    feeBps: 25,
    sharePrice: 100,
    shares: 12,
    components: [
      ["NVDAx", 2600],
      ["AAPLx", 2000],
      ["MSFTx", 2000],
      ["GOOGLx", 1800],
      ["METAx", 1600],
    ],
  },
  {
    name: "Bitcoin, by proxy",
    symbol: "PROXY",
    feeBps: 50,
    sharePrice: 50,
    shares: 30,
    components: [
      ["MSTRx", 5000],
      ["COINx", 3000],
      ["HOODx", 2000],
    ],
  },
  {
    name: "Index of indices",
    symbol: "IDX",
    feeBps: 10,
    sharePrice: 250,
    shares: 4,
    components: [
      ["SPYx", 5000],
      ["QQQx", 3500],
      ["GLDx", 1500],
    ],
  },
  {
    name: "Frontier Labs",
    symbol: "FRNTR",
    feeBps: 75,
    sharePrice: 500,
    shares: 3,
    // PreStocks pre-IPO tokens, not xStocks. ANTHROPIC and OPENAI carry a live
    // transfer fee, which is exactly what the gross-up in mint_shares is for.
    components: [
      ["ANTHROPIC", 3500],
      ["OPENAI", 3000],
      ["SPACEX", 2000],
      ["ANDURIL", 1500],
    ],
  },
];

// -------------------------------------------------------------- instruction data

const DISCRIMINATOR = Object.fromEntries(
  idl.instructions.map((ix) => [ix.name, Uint8Array.from(ix.discriminator)]),
);

function encodeCreateBasket(name, symbol, feeBps, components) {
  const parts = [];
  const str = (value) => {
    const bytes = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    parts.push(len, bytes);
  };
  parts.push(Buffer.from(DISCRIMINATOR.create_basket));
  str(name);
  str(symbol);
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(feeBps);
  parts.push(fee);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(components.length);
  parts.push(count);
  for (const component of components) {
    parts.push(component.mint.toBuffer());
    const units = Buffer.alloc(8);
    units.writeBigUInt64LE(component.unitsPerShare);
    parts.push(units);
    const weight = Buffer.alloc(2);
    weight.writeUInt16LE(component.weightBps);
    parts.push(weight);
  }
  return Buffer.concat(parts);
}

function encodeShares(name, shares) {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(shares);
  return Buffer.concat([Buffer.from(DISCRIMINATOR[name]), amount]);
}

const meta = (pubkey, isWritable, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});

// ------------------------------------------------------------------------- prices

async function fetchQuotes(symbols) {
  const mints = symbols.map((s) => BY_SYMBOL.get(s).mint);
  const response = await fetch(
    `https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`,
  );
  if (!response.ok) throw new Error(`Jupiter returned ${response.status}`);
  const body = await response.json();
  const quotes = new Map();
  for (const symbol of symbols) {
    const stock = BY_SYMBOL.get(symbol);
    const entry = body[stock.mint];
    if (!entry?.usdPrice) throw new Error(`no live price for ${symbol}`);
    const config = entry.scaledUiConfig;
    let multiplier = config?.multiplier ?? 1;
    if (
      config?.newMultiplier &&
      config.newMultiplierEffectiveAt &&
      Date.parse(config.newMultiplierEffectiveAt) <= Date.now()
    ) {
      multiplier = config.newMultiplier;
    }
    quotes.set(symbol, { price: entry.usdPrice, multiplier });
  }
  return quotes;
}

// --------------------------------------------------------------------------- main

const connection = resilientConnection(url);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
);

console.log(`cluster  ${url}`);
console.log(`payer    ${payer.publicKey.toBase58()}`);
console.log(`program  ${PROGRAM_ID.toBase58()}`);

const balance = await connection.getBalance(payer.publicKey);
console.log(`balance  ${(balance / 1e9).toFixed(3)} SOL\n`);
if (balance < 0.5e9) {
  console.error("Not enough SOL on this cluster to lay baskets.");
  process.exit(1);
}

const allSymbols = [
  ...new Set(RECIPES.flatMap((r) => r.components.map(([s]) => s))),
];
const missing = allSymbols.filter((s) => !ALL_MIRROR[s]);
if (missing.length) {
  console.error(
    `No mirror mint for ${missing.join(", ")}. Run setup-mirror / setup-mirror-prestocks first.`,
  );
  process.exit(1);
}

const quotes = await fetchQuotes(allSymbols);
console.log("live mainnet quotes");
for (const symbol of allSymbols) {
  const q = quotes.get(symbol);
  console.log(
    `  ${symbol.padEnd(7)} $${q.price.toFixed(2).padStart(9)}  x${q.multiplier}`,
  );
}
console.log();

const basketPda = (symbol) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("basket"), payer.publicKey.toBuffer(), Buffer.from(symbol)],
    PROGRAM_ID,
  )[0];

const vaultFor = (basket, mint) =>
  getAssociatedTokenAddressSync(mint, basket, true, TOKEN_2022_PROGRAM_ID);

async function createShareMint(basket, name, symbol) {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await connection.getMinimumBalanceForRentExemption(space + 400);

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
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
      createInitializeMint2Instruction(
        mint.publicKey,
        SHARE_DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
    [payer, mint],
    { commitment: "confirmed" },
  );

  await tokenMetadataInitializeWithRentTransfer(
    connection,
    payer,
    mint.publicKey,
    payer.publicKey,
    payer,
    name,
    symbol,
    `https://sheaf.fund/basket/${symbol}.json`,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createSetAuthorityInstruction(
        mint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        basket,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
    [payer],
    { commitment: "confirmed" },
  );

  return mint.publicKey;
}

for (const recipe of RECIPES) {
  const basket = basketPda(recipe.symbol);
  const existing = await connection.getAccountInfo(basket);

  const components = recipe.components.map(([symbol, weightBps]) => {
    const entry = ALL_MIRROR[symbol];
    const quote = quotes.get(symbol);
    const decimals = BY_SYMBOL.get(symbol).decimals;
    const dollars = (recipe.sharePrice * weightBps) / 10_000;
    const pricePerRawUnit = (quote.price * quote.multiplier) / 10 ** decimals;
    return {
      symbol,
      mint: new PublicKey(entry.writeMint),
      decimals,
      weightBps,
      unitsPerShare: BigInt(Math.max(1, Math.round(dollars / pricePerRawUnit))),
    };
  });

  if (existing) {
    console.log(`${recipe.symbol.padEnd(6)} already laid at ${basket.toBase58()}`);
  } else {
    const shareMint = await createShareMint(basket, recipe.name, recipe.symbol);
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add({
        programId: PROGRAM_ID,
        keys: [
          meta(payer.publicKey, true, true),
          meta(basket, true),
          meta(shareMint, false),
          meta(TOKEN_2022_PROGRAM_ID, false),
          meta(SystemProgram.programId, false),
          ...components.map((c) => meta(c.mint, false)),
        ],
        data: encodeCreateBasket(
          recipe.name,
          recipe.symbol,
          recipe.feeBps,
          components,
        ),
      }),
      [payer],
      { commitment: "confirmed" },
    );
    console.log(`${recipe.symbol.padEnd(6)} laid  ${basket.toBase58()}`);
    console.log(`       tx    ${signature}`);
  }

  // ------------------------------------------------------------ create shares
  const record = await connection.getAccountInfo(basket);
  const shareMint = new PublicKey(record.data.subarray(40, 72));

  const supplyInfo = await connection.getAccountInfo(shareMint);
  const supply = supplyInfo.data.readBigUInt64LE(36);
  if (supply > 0n) {
    console.log(
      `       shares already outstanding (${Number(supply) / 1e6}), skipping\n`,
    );
    continue;
  }

  const shares = BigInt(recipe.shares) * ONE_SHARE;

  // Fund the payer with enough of every component, then deposit.
  const fund = new Transaction();
  for (const component of components) {
    const need = (component.unitsPerShare * shares + ONE_SHARE - 1n) / ONE_SHARE;
    const ata = getAssociatedTokenAddressSync(
      component.mint,
      payer.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    fund.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        component.mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToInstruction(
        component.mint,
        ata,
        payer.publicKey,
        need * 2n,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  await sendAndConfirmTransaction(connection, fund, [payer], {
    commitment: "confirmed",
  });

  const depositorShareAta = getAssociatedTokenAddressSync(
    shareMint,
    payer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  const mintTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      depositorShareAta,
      payer.publicKey,
      shareMint,
      TOKEN_2022_PROGRAM_ID,
    ),
    ...components.map((c) =>
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        vaultFor(basket, c.mint),
        basket,
        c.mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
    {
      programId: PROGRAM_ID,
      keys: [
        meta(basket, true),
        meta(shareMint, true),
        meta(payer.publicKey, false, true),
        meta(depositorShareAta, true),
        // Creator and depositor are the same wallet here, so the fee lands in the
        // same account the net shares do.
        meta(depositorShareAta, true),
        meta(TOKEN_2022_PROGRAM_ID, false),
        meta(TOKEN_2022_PROGRAM_ID, false),
        ...components.flatMap((c) => [
          meta(c.mint, false),
          meta(
            getAssociatedTokenAddressSync(
              c.mint,
              payer.publicKey,
              true,
              TOKEN_2022_PROGRAM_ID,
            ),
            true,
          ),
          meta(vaultFor(basket, c.mint), true),
        ]),
      ],
      data: encodeShares("mint_shares", shares),
    },
  );

  const mintSignature = await sendAndConfirmTransaction(
    connection,
    mintTx,
    [payer],
    { commitment: "confirmed" },
  );
  console.log(`       ${recipe.shares} shares created  ${mintSignature}\n`);
}

console.log("Done.");
