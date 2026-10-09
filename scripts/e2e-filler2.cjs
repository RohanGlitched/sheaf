// End to end for the second filler: one of the fixed test wallets places a small
// dollar order on a basket, then the site's /api/filler2 is asked to fill it, and
// the script reports who did (the second filler, the house, or nobody).
//   TEST_WALLET_INDEX=1 node scripts/e2e-filler2.cjs [base] [basket] [dollars]
// Run in WSL (it signs with @solana/web3.js). Devnet only.
const crypto = require("crypto");
const path = require("path");
const web3 = require(path.join(__dirname, "../web/node_modules/@solana/web3.js"));
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = web3;

const BASE = process.argv[2] || "http://localhost:3900";
const BASKET = new PublicKey(process.argv[3] || "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ");
const DOLLARS = Number(process.argv[4] || 10);
const INDEX = Number.isInteger(Number(process.env.TEST_WALLET_INDEX)) && process.env.TEST_WALLET_INDEX !== "" ? Number(process.env.TEST_WALLET_INDEX) : 1;
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
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

(async () => {
  // Wallet i of the 100 fixed test wallets (web/lib/test-wallets.generated.ts).
  const wallet = Keypair.fromSeed(crypto.createHash("sha256").update(`sheaf-test-wallet:${INDEX}`).digest());
  const c = new Connection("https://api.devnet.solana.com", "confirmed");
  console.log("test wallet", INDEX, wallet.publicKey.toBase58());
  if ((await c.getBalance(wallet.publicKey)) < 0.02e9) console.log("sol", JSON.stringify(await post("/api/faucet/sol", { owner: wallet.publicKey.toBase58() })).slice(0, 120));
  console.log("usdc", JSON.stringify(await post("/api/faucet", { owner: wallet.publicKey.toBase58(), symbols: ["USDC"] })).slice(0, 120));

  const baskets = await fetch(`${BASE}/api/baskets`).then((r) => r.json());
  const basket = baskets.find((b) => b.address === BASKET.toBase58());
  const market = await fetch(`${BASE}/api/market`).then((r) => r.json());
  const mirror = require("fs").readFileSync(path.join(__dirname, "../web/lib/mirror.generated.ts"), "utf8");
  const symbolOf = new Map([...mirror.matchAll(/"?([A-Za-z0-9]+)"?\s*:\s*\{[^}]*?writeMint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => [m[2], m[1].replace(/x$/, "")]));
  const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));
  let nav = 0;
  for (const comp of basket.components) {
    const q = quotes.get(symbolOf.get(comp.mint)) ?? quotes.get(symbolOf.get(comp.mint) + "x");
    nav += (Number(comp.unitsPerShare) / 10 ** comp.decimals) * q.price * (q.multiplier ?? 1);
  }
  const cash = BigInt(Math.round(DOLLARS * 1e6));
  const fair = (DOLLARS / nav) * 1e6;
  const start = BigInt(Math.floor(fair * 1.006));
  const end = BigInt(Math.floor(fair * 0.985));
  const now = Math.floor(Date.now() / 1000);
  const nonce = BigInt(Date.now());
  const order = PublicKey.findProgramAddressSync([Buffer.from("order"), BASKET.toBuffer(), wallet.publicKey.toBuffer(), le64(nonce)], PROGRAM)[0];
  const cashMint = new PublicKey(require("fs").readFileSync(path.join(__dirname, "../web/lib/cash.generated.ts"), "utf8").match(/CASH_MINT\s*=\s*"([^"]+)"/)[1]);
  const cashInfo = await c.getAccountInfo(cashMint);
  const cashProgram = cashInfo.owner;
  const shareMint = new PublicKey(basket.shareMint);
  const PLACE = idl.instructions.find((x) => x.name === "place_order");
  const accounts = {
    buyer: wallet.publicKey,
    basket: BASKET,
    order,
    cash_mint: cashMint,
    buyer_cash_account: ata(cashMint, wallet.publicKey, cashProgram),
    escrow: ata(cashMint, order, cashProgram),
    cash_token_program: cashProgram,
  };
  const keys = PLACE.accounts.map((a) => ({ pubkey: a.address ? new PublicKey(a.address) : accounts[a.name], isSigner: !!a.signer, isWritable: !!a.writable }));
  const data = Buffer.concat([Buffer.from(PLACE.discriminator), le64(nonce), le64(cash), le64(start), le64(end), i64(now), i64(now + 180)]);
  const shareAta = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata(shareMint, wallet.publicKey, T22), isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: shareMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: T22, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), shareAta, new TransactionInstruction({ programId: PROGRAM, keys, data }));
  const sig = await web3.sendAndConfirmTransaction(c, tx, [wallet], { commitment: "confirmed" });
  console.log(`placed $${DOLLARS} order ${order.toBase58()} on ${basket.symbol} (nav $${nav.toFixed(4)}), 180 s auction:`, sig);

  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${BASE}/api/filler2`, { method: "POST" }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    const mine = (r.filled ?? []).find((f) => f.order === order.toBase58());
    console.log(`  pass ${i + 1}:`, mine ? `FILLED by the second filler, edge ${mine.edgeBps} bps, ${mine.signature}` : (r.log ?? [r.error ?? JSON.stringify(r)]).filter((l) => String(l).includes(order.toBase58().slice(0, 6))).slice(-1)[0] ?? "no line");
    if (mine) return;
    if (!(await c.getAccountInfo(order))) {
      const last = (await c.getSignaturesForAddress(order, { limit: 1 }))[0];
      const t = last && (await c.getTransaction(last.signature, { maxSupportedTransactionVersion: 0 }));
      console.log("order closed by someone else; signer:", t?.transaction.message.staticAccountKeys[0].toBase58());
      return;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  console.log("not filled within the polling window");
})().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
