/**
 * Lay "The Magnificent Seven" (MAG7): a house basket created after the
 * protocol-fee upgrade, so it carries the fixed 0.10% protocol creation fee,
 * and with seven components, so its desk fills go through the basket's address
 * lookup table (v0) rather than a legacy transaction.
 *
 *   node scripts/fee-basket.mjs                 # create MAG7 and mint 10 shares in kind
 *   node scripts/fee-basket.mjs --claim         # claim the accrued protocol fee to the
 *                                               # treasury and record it in web/lib/fee-receipts.json
 *
 * Devnet only. The house key (.keys/faucet-key.json) is the creator, the mirror
 * mint authority and the depositor. Run in WSL (Windows node breaks web3.js).
 * Idempotent: an existing basket is reused, and shares are only minted while the
 * supply is zero.
 */
import fs from "node:fs";
import path from "node:path";
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID as T22,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  tokenMetadataInitializeWithRentTransfer,
} from "@solana/spl-token";
import { resilientConnection, sendResilient } from "./lib/rpc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = "https://api.devnet.solana.com";
const ONE_SHARE = 1_000_000n;
const TREASURY = new PublicKey("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");
const RECEIPTS = path.join(ROOT, "web/lib/fee-receipts.json");

const NAME = "The Magnificent Seven";
const SYMBOL = "MAG7";
const CREATOR_FEE_BPS = 25;
const SHARE_PRICE = 100; // dollars of recipe per share at creation
const SHARES = 10n;
// Equal weight, rounded so the weights add to exactly 10,000.
const STOCKS = [
  ["AAPLx", 1429],
  ["MSFTx", 1429],
  ["NVDAx", 1429],
  ["GOOGLx", 1429],
  ["AMZNx", 1429],
  ["METAx", 1429],
  ["TSLAx", 1426],
];

function readLiteral(file, marker) {
  const source = fs.readFileSync(file, "utf8");
  const from = source.indexOf(marker) + marker.length;
  const openChar = source[from] === "[" ? "[" : "{";
  const closeChar = openChar === "[" ? "]" : "}";
  const open = source.indexOf(openChar, from);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === openChar) depth++;
    else if (source[i] === closeChar && --depth === 0) return new Function(`return ${source.slice(open, i + 1)}`)();
  }
  throw new Error(`unterminated literal for ${marker}`);
}

const MIRROR = readLiteral(path.join(ROOT, "web/lib/mirror.generated.ts"), "export const MIRROR: Record<string, MirrorEntry> = ");
const XSTOCKS = readLiteral(path.join(ROOT, "web/lib/universe.ts"), "export const XSTOCKS: XStock[] = ");
const BY_SYMBOL = new Map(XSTOCKS.map((s) => [s.symbol, s]));
const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "web/lib/sheaf-idl.json"), "utf8"));

const connection = resilientConnection(RPC);
const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, ".keys/faucet-key.json"), "utf8"))));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(house), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const send = (tx, signers = []) => sendResilient(connection, tx, [house, ...signers], { commitment: "confirmed" });

const basket = PublicKey.findProgramAddressSync([Buffer.from("basket"), house.publicKey.toBuffer(), Buffer.from(SYMBOL)], program.programId)[0];
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, T22);

console.log(`basket   ${SYMBOL} ${basket.toBase58()}`);
console.log(`balance  ${((await connection.getBalance(house.publicKey)) / 1e9).toFixed(3)} SOL`);

if (process.argv.includes("--claim")) {
  const b = await program.account.basket.fetch(basket);
  const shares = BigInt(b.protocolFeeAccrued.toString());
  if (shares === 0n) {
    console.log("nothing accrued yet");
    process.exit(0);
  }
  const treasuryShares = ata(b.shareMint, TREASURY);
  const signature = await program.methods
    .claimProtocolFee()
    .accountsPartial({ basket, shareMint: b.shareMint, treasury: TREASURY, treasuryShareAccount: treasuryShares, shareTokenProgram: T22 })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(house.publicKey, treasuryShares, TREASURY, b.shareMint, T22)])
    .rpc();
  const receipts = fs.existsSync(RECEIPTS)
    ? JSON.parse(fs.readFileSync(RECEIPTS, "utf8"))
    : { basket: basket.toBase58(), symbol: SYMBOL, protocolFeeBps: b.protocolFeeBps, treasury: TREASURY.toBase58(), treasuryShareAccount: treasuryShares.toBase58(), claims: [] };
  receipts.claims.push({ signature, shares: shares.toString(), at: new Date().toISOString() });
  fs.writeFileSync(RECEIPTS, `${JSON.stringify(receipts, null, 2)}\n`);
  console.log(`claimed  ${shares} raw share units to ${treasuryShares.toBase58()}  ${signature}`);
  process.exit(0);
}

// ----------------------------------------------------------------- the recipe

const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${STOCKS.map(([s]) => BY_SYMBOL.get(s).mint).join(",")}`);
const prices = await res.json();
const components = STOCKS.map(([symbol, weightBps]) => {
  const stock = BY_SYMBOL.get(symbol);
  const q = prices[stock.mint];
  if (!q?.usdPrice) throw new Error(`no price for ${symbol}`);
  const cfg = q.scaledUiConfig;
  const multiplier =
    cfg?.newMultiplier && cfg.newMultiplierEffectiveAt && Date.parse(cfg.newMultiplierEffectiveAt) <= Date.now()
      ? cfg.newMultiplier
      : (cfg?.multiplier ?? 1);
  const perRaw = (q.usdPrice * multiplier) / 10 ** stock.decimals;
  const units = BigInt(Math.max(1, Math.round((SHARE_PRICE * weightBps) / 10_000 / perRaw)));
  return { symbol, mint: new PublicKey(MIRROR[symbol].writeMint), weightBps, units };
});
for (const c of components) console.log(`  ${c.symbol.padEnd(7)} ${c.mint.toBase58()}  ${c.units} raw/share  ${c.weightBps} bps`);

// ------------------------------------------------------------- the basket

if (!(await connection.getAccountInfo(basket))) {
  const mint = Keypair.generate();
  const space = getMintLen([ExtensionType.MetadataPointer]);
  await send(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: house.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(space + 400),
        programId: T22,
      }),
      createInitializeMetadataPointerInstruction(mint.publicKey, house.publicKey, mint.publicKey, T22),
      createInitializeMint2Instruction(mint.publicKey, 6, house.publicKey, null, T22),
    ),
    [mint],
  );
  await tokenMetadataInitializeWithRentTransfer(connection, house, mint.publicKey, house.publicKey, house, NAME, SYMBOL, `https://sheaf.fund/basket/${SYMBOL}.json`, undefined, undefined, T22);
  await send(new Transaction().add(createSetAuthorityInstruction(mint.publicKey, house.publicKey, AuthorityType.MintTokens, basket, [], T22)));
  const sig = await program.methods
    .createBasket(NAME, SYMBOL, CREATOR_FEE_BPS, components.map((c) => ({ mint: c.mint, unitsPerShare: new anchor.BN(c.units.toString()), weightBps: c.weightBps })))
    .accountsPartial({ creator: house.publicKey, basket, shareMint: mint.publicKey, componentTokenProgram: T22, systemProgram: SystemProgram.programId })
    .remainingAccounts(components.map((c) => ({ pubkey: c.mint, isSigner: false, isWritable: false })))
    .rpc();
  console.log(`created  ${sig}`);
} else {
  console.log("basket already exists");
}

const b = await program.account.basket.fetch(basket);
console.log(`fees     creator ${b.creatorFeeBps} bps, protocol ${b.protocolFeeBps} bps`);
const recipe = b.components.slice(0, b.componentCount);
const supply = (await connection.getTokenSupply(b.shareMint)).value.amount;
if (supply !== "0") {
  console.log(`supply   ${Number(supply) / 1e6} shares already, not minting`);
  process.exit(0);
}

// ------------------------------------------------------------ create shares

const shares = SHARES * ONE_SHARE;
const fund = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(house.publicKey, ata(b.shareMint, house.publicKey), house.publicKey, b.shareMint, T22));
for (const c of recipe) {
  const need = (BigInt(c.unitsPerShare.toString()) * shares + ONE_SHARE - 1n) / ONE_SHARE;
  fund.add(
    createAssociatedTokenAccountIdempotentInstruction(house.publicKey, ata(c.mint, house.publicKey), house.publicKey, c.mint, T22),
    createAssociatedTokenAccountIdempotentInstruction(house.publicKey, ata(c.mint, basket), basket, c.mint, T22),
    createMintToInstruction(c.mint, ata(c.mint, house.publicKey), house.publicKey, need * 2n, [], T22),
  );
}
// Twenty-two instructions do not fit one packet: send them in two halves.
const half = Math.ceil(fund.instructions.length / 2);
await send(new Transaction().add(...fund.instructions.slice(0, half)));
await send(new Transaction().add(...fund.instructions.slice(half)));

const sig = await program.methods
  .mintShares(new anchor.BN(shares.toString()))
  .accountsPartial({
    basket,
    shareMint: b.shareMint,
    depositor: house.publicKey,
    depositorShareAccount: ata(b.shareMint, house.publicKey),
    creatorShareAccount: ata(b.shareMint, house.publicKey),
    shareTokenProgram: T22,
    componentTokenProgram: T22,
  })
  .remainingAccounts(
    recipe.flatMap((c) => [
      { pubkey: c.mint, isSigner: false, isWritable: false },
      { pubkey: ata(c.mint, house.publicKey), isSigner: false, isWritable: true },
      { pubkey: ata(c.mint, basket), isSigner: false, isWritable: true },
    ]),
  )
  .rpc();
const after = await program.account.basket.fetch(basket);
console.log(`minted   ${SHARES} shares in kind  ${sig}`);
console.log(`accrued  ${after.protocolFeeAccrued} raw protocol-fee share units`);
