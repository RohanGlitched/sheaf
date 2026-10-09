/**
 * One Sheaf launch, its whole life, on devnet: three throwaway wallets buy out
 * the BIG5A curve (one sells a slice back on the way), anyone graduates it into
 * Meteora DAMM v2, the token trades there, and then everyone with a claim
 * takes it: the creator's curve fees, the partner's curve fees, the partner's
 * migration fee, surplus and leftover supply, and both locked LP positions'
 * fees.
 *
 * Every signature is written to web/lib/meteora-lifecycle.json as it lands, and
 * a re-run skips the steps already there, so a failure halfway is resumable.
 * Devnet SOL only: the house (faucet) key funds the wallets.
 *
 *   wsl -e bash -lc 'source ~/.nvm/nvm.sh; cd /mnt/i/Programs/sheaf && node scripts/meteora-lifecycle.mjs'
 */
import fs from "node:fs";
import path from "node:path";
import {
  BASKETS,
  BN,
  ROOT,
  connection,
  cpamm,
  dbc,
  houseKey,
  launchInfo,
  send,
  sol,
  treasuryKey,
  web3,
} from "./meteora-lib.mjs";

const { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = web3;
const BASKET = process.env.BASKET ?? BASKETS.BIG5;
const OUT = path.join(ROOT, "web", "lib", "meteora-lifecycle.json");
const WALLETS = path.join(ROOT, ".keys", "lifecycle-wallets.json");
const U64_MAX = new BN("18446744073709551615");

const house = houseKey();
const treasury = treasuryKey();
const info = launchInfo(BASKET);
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const amm = new cpamm.CpAmm(connection);

const record = fs.existsSync(OUT)
  ? JSON.parse(fs.readFileSync(OUT, "utf8"))
  : {
      cluster: "devnet",
      basket: BASKET,
      launch: { symbol: "BIG5A", pool: info.pool.toBase58(), config: info.config.toBase58(), mint: info.mint.toBase58(), dammPool: info.damm.toBase58() },
      steps: [],
    };
const save = () => fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
const done = (id) => record.steps.find((s) => s.id === id);

/** Runs a step once: skipped if its signature is already recorded, recorded the moment it lands. */
async function step(id, title, detail, run) {
  if (done(id)) {
    console.log(`- ${id}: already done (${done(id).signature})`);
    return done(id).signature;
  }
  console.log(`- ${id}: ${title}`);
  const result = await run();
  if (!result) {
    console.log("  skipped (nothing to do)");
    return null;
  }
  const { signature, detail: extra } = typeof result === "string" ? { signature: result } : result;
  record.steps.push({ id, title, detail: extra ?? detail, signature, at: new Date().toISOString() });
  save();
  return signature;
}

function wallets() {
  if (fs.existsSync(WALLETS)) {
    return JSON.parse(fs.readFileSync(WALLETS, "utf8")).map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  }
  const fresh = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  fs.writeFileSync(WALLETS, JSON.stringify(fresh.map((k) => Array.from(k.secretKey))));
  return fresh;
}

async function curveState() {
  const virtualPool = await client.state.getPool(info.pool);
  const config = await client.state.getPoolConfig(info.config);
  return { virtualPool, pool: virtualPool.poolState, config };
}

async function tokenBalance(owner) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: info.mint });
  return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function curveSwap(wallet, side, amount, mode) {
  const { virtualPool, config } = await curveState();
  const swapBaseForQuote = side === "sell";
  const amountIn = new BN(amount.toString());
  const quote = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote,
    swapMode: mode,
    amountIn,
    slippageBps: 300,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await dbc.getCurrentPoint(connection, config.activationType),
  });
  const tx = await client.pool.swap2({
    owner: wallet.publicKey,
    pool: info.pool,
    swapMode: mode,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
    swapBaseForQuote,
    referralTokenAccount: null,
  });
  tx.feePayer = wallet.publicKey;
  return { tx, quote };
}

async function dammSwap(wallet, side, amount) {
  const poolState = await amm.fetchPoolState(info.damm);
  const [inputTokenMint, outputTokenMint] = side === "buy" ? [new PublicKey(dbc.NATIVE_MINT ?? "So11111111111111111111111111111111111111112"), info.mint] : [info.mint, new PublicKey("So11111111111111111111111111111111111111112")];
  const decimals = (mint) => (mint.equals(info.mint) ? 6 : 9);
  const currentPoint = poolState.activationType === 0 ? new BN(await connection.getSlot()) : new BN(Math.floor(Date.now() / 1000));
  const amountIn = new BN(amount.toString());
  const quote = amm.getQuote2({
    inputTokenMint,
    slippage: 3,
    currentPoint,
    poolState,
    tokenADecimal: decimals(poolState.tokenAMint),
    tokenBDecimal: decimals(poolState.tokenBMint),
    hasReferral: false,
    swapMode: cpamm.SwapMode.ExactIn,
    amountIn,
  });
  const tx = await amm.swap2({
    payer: wallet.publicKey,
    pool: info.damm,
    inputTokenMint,
    outputTokenMint,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: cpamm.getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: cpamm.getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
    poolState,
    swapMode: cpamm.SwapMode.ExactIn,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
  });
  tx.feePayer = wallet.publicKey;
  return { tx, quote };
}

async function claimLp(owner, label) {
  const [positions, poolState] = await Promise.all([amm.getUserPositionByPool(info.damm, owner.publicKey), amm.fetchPoolState(info.damm)]);
  if (positions.length === 0) throw new Error(`${label} holds no position in the DAMM v2 pool`);
  let feeSol = 0;
  const tx = new Transaction();
  for (const { position, positionNftAccount, positionState } of positions) {
    const { feeTokenB } = cpamm.getUnClaimLpFee(poolState, positionState);
    feeSol += Number(feeTokenB.toString()) / 1e9;
    const claim = await amm.claimPositionFee({
      owner: owner.publicKey,
      position,
      pool: info.damm,
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: cpamm.getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: cpamm.getTokenProgram(poolState.tokenBFlag),
    });
    tx.add(...claim.instructions);
  }
  tx.feePayer = owner.publicKey;
  const signature = await send(tx, [owner], `${label} LP fee claim`);
  return { signature, detail: `${feeSol.toFixed(6)} SOL of locked-LP fees to the ${label.toLowerCase()}` };
}

// ---------------------------------------------------------------------------

const [w1, w2, w3] = wallets();
console.log(`BIG5A pool ${info.pool.toBase58()}`);
console.log(`house ${house.publicKey.toBase58()} ${sol(await connection.getBalance(house.publicKey)).toFixed(3)} SOL`);
console.log(`treasury key ${treasury ? "found" : "absent"}`);
record.wallets = [w1, w2, w3].map((w) => w.publicKey.toBase58());
save();

const start = await curveState();
if (!start.pool.creator.equals(house.publicKey)) throw new Error("The house is not this launch's creator.");
const threshold = BigInt(start.config.migrationQuoteThreshold.toString());
console.log(`threshold ${sol(threshold)} SOL, raised ${sol(start.pool.quoteReserve)} SOL`);

await step("fund", "House funds three throwaway wallets", "0.45 + 0.45 + 0.6 devnet SOL from the house key", async () => {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: w1.publicKey, lamports: 0.45 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: w2.publicKey, lamports: 0.45 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: w3.publicKey, lamports: 0.6 * LAMPORTS_PER_SOL }),
    ...(treasury && (await connection.getBalance(treasury.publicKey)) < 0.05 * LAMPORTS_PER_SOL
      ? [SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: treasury.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })]
      : []),
  );
  tx.feePayer = house.publicKey;
  return send(tx, [house], "fund");
});

for (const [id, wallet, lamports] of [
  ["buy-1", w1, 300_000_000n],
  ["buy-2", w2, 350_000_000n],
]) {
  await step(id, `Wallet ${id.slice(-1)} buys on the curve`, `${sol(lamports)} SOL in, DBC swap2`, async () => {
    const { tx, quote } = await curveSwap(wallet, "buy", lamports, dbc.SwapMode.ExactIn);
    const signature = await send(tx, [wallet], id);
    return { signature, detail: `${sol(lamports)} SOL for ${(Number(quote.outputAmount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} BIG5A on the curve (DBC swap2, ExactIn)` };
  });
}

await step("sell-curve", "Wallet 1 sells a fifth back to the curve", "DBC swap2, base for quote", async () => {
  const held = await tokenBalance(w1.publicKey);
  const amount = held / 5n;
  const { tx, quote } = await curveSwap(w1, "sell", amount, dbc.SwapMode.ExactIn);
  const signature = await send(tx, [w1], "sell-curve");
  return { signature, detail: `${(Number(amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} BIG5A back to the curve for ${sol(quote.outputAmount).toFixed(4)} SOL (DBC swap2)` };
});

await step("buy-out", "Wallet 3 buys out the rest of the curve", "DBC swap2 PartialFill: takes what is left, refunds the rest", async () => {
  const { pool } = await curveState();
  const left = threshold - BigInt(pool.quoteReserve.toString());
  // Fees come off the input, and the dynamic fee rises with volatility, so overpay; PartialFill refunds the excess.
  const amount = (left * 115n) / 100n + 10_000_000n;
  const balance = BigInt(await connection.getBalance(w3.publicKey));
  if (balance < amount + 30_000_000n) {
    const top = new Transaction().add(SystemProgram.transfer({ fromPubkey: house.publicKey, toPubkey: w3.publicKey, lamports: amount + 30_000_000n - balance }));
    top.feePayer = house.publicKey;
    await send(top, [house], "top-up");
  }
  const { tx } = await curveSwap(w3, "buy", amount, dbc.SwapMode.PartialFill);
  const signature = await send(tx, [w3], "buy-out");
  const after = (await curveState()).pool;
  return { signature, detail: `PartialFill buy that filled the curve: ${sol(after.quoteReserve).toFixed(4)} of ${sol(threshold).toFixed(4)} SOL raised` };
});

await step("graduate", "Anyone graduates the curve into DAMM v2", "migrateToDammV2: two locked LP positions, partner and creator", async () => {
  const { pool, config } = await curveState();
  if (pool.isMigrated === 1) throw new Error("Already migrated without a recorded signature.");
  if (BigInt(pool.quoteReserve.toString()) < threshold) throw new Error("The curve is not full yet.");
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
    payer: w2.publicKey,
    pool: info.pool,
    dammConfig: dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption],
  });
  transaction.feePayer = w2.publicKey;
  const signature = await send(transaction, [w2, firstPositionNftKeypair, secondPositionNftKeypair], "graduate");
  return { signature, detail: `migrateToDammV2 signed by a buyer, not the creator: pool ${info.damm.toBase58()}` };
});

await step("damm-buy", "Wallet 2 buys on the DAMM v2 pool", "cp-amm swap2", async () => {
  const { tx, quote } = await dammSwap(w2, "buy", 50_000_000n);
  const signature = await send(tx, [w2], "damm-buy");
  return { signature, detail: `0.05 SOL for ${(Number(quote.outputAmount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} BIG5A on DAMM v2 (cp-amm swap2)` };
});

await step("damm-sell", "Wallet 3 sells on the DAMM v2 pool", "cp-amm swap2", async () => {
  const held = await tokenBalance(w3.publicKey);
  const amount = held / 4n;
  const { tx, quote } = await dammSwap(w3, "sell", amount);
  const signature = await send(tx, [w3], "damm-sell");
  return { signature, detail: `${(Number(amount) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} BIG5A for ${sol(quote.outputAmount).toFixed(4)} SOL on DAMM v2 (cp-amm swap2)` };
});

await step("claim-creator", "Creator claims curve trading fees", "claimCreatorTradingFee", async () => {
  const { pool } = await curveState();
  const owed = sol(pool.creatorQuoteFee);
  if (owed <= 0) return null;
  const tx = await client.creator.claimCreatorTradingFee({ creator: house.publicKey, payer: house.publicKey, pool: info.pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX });
  tx.feePayer = house.publicKey;
  const signature = await send(tx, [house], "claim-creator");
  return { signature, detail: `${owed.toFixed(6)} SOL of curve fees to the basket's creator (claimCreatorTradingFee)` };
});

await step("lp-creator", "Creator claims locked-LP fees", "cp-amm claimPositionFee", () => claimLp(house, "Creator"));

if (treasury) {
  await step("claim-partner", "Treasury claims the partner's curve fees", "claimPartnerTradingFee", async () => {
    const { pool } = await curveState();
    const owed = sol(pool.partnerQuoteFee);
    if (owed <= 0) return null;
    const tx = await client.partner.claimPartnerTradingFee({ feeClaimer: treasury.publicKey, payer: treasury.publicKey, pool: info.pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX });
    tx.feePayer = treasury.publicKey;
    const signature = await send(tx, [treasury], "claim-partner");
    return { signature, detail: `${owed.toFixed(6)} SOL of curve fees to Sheaf's treasury (claimPartnerTradingFee)` };
  });

  await step("migration-fee", "Treasury withdraws the migration fee", "partnerWithdrawMigrationFee", async () => {
    const before = await connection.getBalance(treasury.publicKey);
    const tx = await client.partner.partnerWithdrawMigrationFee({ pool: info.pool, sender: treasury.publicKey });
    tx.feePayer = treasury.publicKey;
    const signature = await send(tx, [treasury], "migration-fee");
    const after = await connection.getBalance(treasury.publicKey);
    return { signature, detail: `1% migration fee to the treasury, about ${sol(after - before + 5000).toFixed(6)} SOL (partnerWithdrawMigrationFee)` };
  });

  await step("surplus", "Treasury withdraws the partner's surplus", "partnerWithdrawSurplus", async () => {
    const { pool } = await curveState();
    if (pool.isPartnerWithdrawSurplus === 1) return null;
    const tx = await client.partner.partnerWithdrawSurplus({ feeClaimer: treasury.publicKey, pool: info.pool });
    tx.feePayer = treasury.publicKey;
    const signature = await send(tx, [treasury], "surplus");
    return { signature, detail: "The partner's share of SOL raised past the threshold (partnerWithdrawSurplus)" };
  });

  await step("leftover", "Leftover supply goes to the treasury", "withdrawLeftover", async () => {
    const { pool } = await curveState();
    if (pool.isWithdrawLeftover === 1) return null;
    const tx = await client.migration.withdrawLeftover({ payer: treasury.publicKey, pool: info.pool });
    tx.feePayer = treasury.publicKey;
    const signature = await send(tx, [treasury], "leftover");
    return { signature, detail: "The 1% leftover supply to the leftover receiver (withdrawLeftover)" };
  });

  await step("lp-partner", "Treasury claims locked-LP fees", "cp-amm claimPositionFee", () => claimLp(treasury, "Treasury"));
} else {
  console.log("No treasury key on this machine: partner claims skipped.");
}

const end = await curveState();
record.result = {
  raisedSol: sol(end.pool.quoteReserve),
  thresholdSol: sol(threshold),
  graduated: end.pool.isMigrated === 1,
  totalCurveFeesSol: sol(end.pool.metrics.totalTradingQuoteFee),
  readAt: new Date().toISOString(),
};
save();
console.log(JSON.stringify(record.result));
