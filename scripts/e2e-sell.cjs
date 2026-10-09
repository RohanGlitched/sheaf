// End to end for the dollar exit: one of the fixed test wallets sells shares of a
// basket on a sell order, and the site's fillers are asked to buy them.
//   TEST_WALLET_INDEX=2 node scripts/e2e-sell.cjs [base] [basket] [shares] [house|filler2]
// If the wallet holds fewer shares than it means to sell, it first buys some with
// a small dollar order. The last argument picks who is asked to fill the sale
// (default filler2, the second filler; "house" asks /api/keeper).
// Run in WSL (it signs with @solana/web3.js). Devnet only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const web3 = require(path.join(__dirname, "../web/node_modules/@solana/web3.js"));
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = web3;

const BASE = process.argv[2] || "http://localhost:3900";
const BASKET = new PublicKey(process.argv[3] || "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ");
const SELL_SHARES = BigInt(Math.round(Number(process.argv[4] || 0.1) * 1e6));
const WHO = process.argv[5] === "house" ? "house" : "filler2";
const INDEX = Number.isInteger(Number(process.env.TEST_WALLET_INDEX)) && process.env.TEST_WALLET_INDEX !== "" ? Number(process.env.TEST_WALLET_INDEX) : 2;
const idl = require("../web/lib/sheaf-idl.json");
const PROGRAM = new PublicKey(idl.address);
const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ata = (mint, owner, program) => PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const le64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const ix = (name, accounts, args) => {
  const def = idl.instructions.find((x) => x.name === name);
  const keys = def.accounts.map((a) => ({ pubkey: a.address ? new PublicKey(a.address) : accounts[a.name], isSigner: !!a.signer, isWritable: !!a.writable }));
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([Buffer.from(def.discriminator), ...args]) });
};
const createAta = (payer, mint, owner, program) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(mint, owner, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
const amount = async (c, key) => {
  const info = await c.getAccountInfo(key);
  return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `account` closes, nudging the chosen filler; returns the closing transaction. */
async function waitClosed(c, account, label) {
  for (let i = 0; i < 40; i++) {
    const r = await post(WHO === "house" ? "/api/keeper" : "/api/filler2").catch((e) => ({ error: e.message }));
    const mine = (r.log ?? []).filter((l) => String(l).includes(account.toBase58().slice(0, 6))).slice(-1)[0];
    console.log(`  ${label} pass ${i + 1} (${WHO}):`, mine ?? JSON.stringify(r).slice(0, 200));
    if (!(await c.getAccountInfo(account))) {
      const sigs = await c.getSignaturesForAddress(account, { limit: 3 });
      for (const s of sigs) {
        const t = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        const logs = (t?.meta?.logMessages ?? []).join("\n");
        if (/FillSellOrder|FillOrder|CancelSellOrder|CancelOrder/i.test(logs)) {
          return { signature: s.signature, signer: t.transaction.message.staticAccountKeys[0].toBase58(), logs };
        }
      }
      return { signature: sigs[0]?.signature, signer: null, logs: "" };
    }
    await sleep(4000);
  }
  return null;
}

(async () => {
  const wallet = Keypair.fromSeed(crypto.createHash("sha256").update(`sheaf-test-wallet:${INDEX}`).digest());
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  console.log("test wallet", INDEX, wallet.publicKey.toBase58(), "asks", WHO);
  if ((await c.getBalance(wallet.publicKey)) < 0.02e9) console.log("sol", JSON.stringify(await post("/api/faucet/sol", { owner: wallet.publicKey.toBase58() })).slice(0, 120));

  const baskets = await fetch(`${BASE}/api/baskets`).then((r) => r.json());
  const basket = baskets.find((b) => b.address === BASKET.toBase58());
  const market = await fetch(`${BASE}/api/market`).then((r) => r.json());
  const mirror = fs.readFileSync(path.join(__dirname, "../web/lib/mirror.generated.ts"), "utf8");
  const symbolOf = new Map([...mirror.matchAll(/"?([A-Za-z0-9]+)"?\s*:\s*\{[^}]*?writeMint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => [m[2], m[1].replace(/x$/, "")]));
  const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));
  let nav = 0;
  for (const comp of basket.components) {
    const q = quotes.get(symbolOf.get(comp.mint)) ?? quotes.get(symbolOf.get(comp.mint) + "x");
    nav += (Number(comp.unitsPerShare) / 10 ** comp.decimals) * q.price * (q.multiplier ?? 1);
  }
  const cashMint = new PublicKey(fs.readFileSync(path.join(__dirname, "../web/lib/cash.generated.ts"), "utf8").match(/CASH_MINT\s*=\s*"([^"]+)"/)[1]);
  const cashProgram = (await c.getAccountInfo(cashMint)).owner;
  const shareMint = new PublicKey(basket.shareMint);
  const shareAta = ata(shareMint, wallet.publicKey, T22);
  console.log(`${basket.symbol} nav $${nav.toFixed(4)}`);

  // Shares to sell: bought with a small dollar order if the wallet holds too few.
  let held = await amount(c, shareAta);
  if (held < SELL_SHARES) {
    console.log("usdc", JSON.stringify(await post("/api/faucet", { owner: wallet.publicKey.toBase58(), symbols: ["USDC"] })).slice(0, 100));
    const dollars = Math.ceil(((Number(SELL_SHARES - held) / 1e6) * nav * 1.05 + 0.5) * 100) / 100;
    const fair = (dollars / nav) * 1e6;
    const nonce = BigInt(Date.now());
    const order = PublicKey.findProgramAddressSync([Buffer.from("order"), BASKET.toBuffer(), wallet.publicKey.toBuffer(), le64(nonce)], PROGRAM)[0];
    const now = Math.floor(Date.now() / 1000);
    const place = ix(
      "place_order",
      { buyer: wallet.publicKey, basket: BASKET, order, cash_mint: cashMint, buyer_cash_account: ata(cashMint, wallet.publicKey, cashProgram), escrow: ata(cashMint, order, cashProgram), cash_token_program: cashProgram },
      [le64(nonce), le64(BigInt(Math.round(dollars * 1e6))), le64(BigInt(Math.floor(fair * 1.006))), le64(BigInt(Math.floor(fair * 0.985))), i64(now), i64(now + 180)],
    );
    const sig = await web3.sendAndConfirmTransaction(c, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), createAta(wallet.publicKey, shareMint, wallet.publicKey, T22), place), [wallet], { commitment: "confirmed" });
    console.log(`bought: $${dollars} dollar order ${order.toBase58()}`, sig);
    const filled = await waitClosed(c, order, "buy");
    console.log("buy order closed:", filled);
    held = await amount(c, shareAta);
  }
  console.log(`holds ${Number(held) / 1e6} ${basket.symbol}`);

  // The sale: 180 s, from 0.3% over fair down to a 2% discount.
  const fairCash = (Number(SELL_SHARES) / 1e6) * nav;
  const startCash = BigInt(Math.floor(fairCash * 1.003 * 1e6));
  const endCash = BigInt(Math.floor(fairCash * 0.98 * 1e6));
  const nonce = BigInt(Date.now());
  const sellOrder = PublicKey.findProgramAddressSync([Buffer.from("sell"), BASKET.toBuffer(), wallet.publicKey.toBuffer(), le64(nonce)], PROGRAM)[0];
  const now = Math.floor(Date.now() / 1000);
  const place = ix(
    "place_sell_order",
    {
      seller: wallet.publicKey,
      basket: BASKET,
      sell_order: sellOrder,
      share_mint: shareMint,
      seller_share_account: shareAta,
      escrow: ata(shareMint, sellOrder, T22),
      cash_mint: cashMint,
      share_token_program: T22,
      cash_token_program: cashProgram,
    },
    [le64(nonce), le64(SELL_SHARES), le64(startCash), le64(endCash), i64(now), i64(now + 180)],
  );
  const cashBefore = await amount(c, ata(cashMint, wallet.publicKey, cashProgram));
  const sig = await web3.sendAndConfirmTransaction(c, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), place), [wallet], { commitment: "confirmed" });
  console.log(`sell order ${sellOrder.toBase58()}: ${Number(SELL_SHARES) / 1e6} ${basket.symbol}, asking $${(Number(startCash) / 1e6).toFixed(4)} down to $${(Number(endCash) / 1e6).toFixed(4)} (fair $${fairCash.toFixed(4)})`, sig);
  const sold = await waitClosed(c, sellOrder, "sell");
  const cashAfter = await amount(c, ata(cashMint, wallet.publicKey, cashProgram));
  console.log("sell order closed:", sold && { signature: sold.signature, signer: sold.signer, redeemedInSameTx: /RedeemShares/i.test(sold.logs) });
  console.log(`seller received $${(Number(cashAfter - cashBefore) / 1e6).toFixed(4)}`);
})().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
