/**
 * Treasury operations for every official Sheaf launch: the partner's side of
 * Meteora DBC. For each launch listed by /api/launches (which only lists pools
 * that pass the official check), the treasury key claims what it is owed:
 *
 *   claimPartnerTradingFee      the partner half of curve fees, any time
 *   partnerWithdrawMigrationFee the 1% migration fee, after graduation
 *   partnerWithdrawSurplus      SOL raised past the threshold, after graduation
 *   withdrawLeftover            the 1% leftover supply, after graduation
 *   claimPositionFee (cp-amm)   the treasury's locked DAMM v2 LP fees
 *
 * Devnet only. Needs TREASURY_SECRET_KEY in .env.treasury (here or in
 * ../tessera); without it, it prints what is owed and exits.
 *
 *   LAUNCHES_URL=https://sheaf-index.vercel.app/api/launches node scripts/meteora-partner.mjs [--dry]
 */
import {
  BN,
  DAMM_V2_CUSTOMIZABLE_CONFIG,
  DAMM_V2_PROGRAM,
  connection,
  cpamm,
  dbc,
  poolPda,
  send,
  treasuryKey,
  web3,
} from "./meteora-lib.mjs";

const { PublicKey, Transaction } = web3;
const URL_ = process.env.LAUNCHES_URL ?? "http://localhost:3900/api/launches";
const DRY = process.argv.includes("--dry");
const U64_MAX = new BN("18446744073709551615");

const treasury = treasuryKey();
const feed = await fetch(URL_).then((r) => r.json());
if (feed.cluster !== "devnet") throw new Error(`Refusing: the feed is for ${feed.cluster}, not devnet.`);
const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
const amm = new cpamm.CpAmm(connection);

for (const l of feed.launches.filter((x) => x.open && x.official)) {
  const pool = new PublicKey(l.launch.pool);
  const virtualPool = (await client.state.getPool(pool)).poolState;
  const owed = Number(virtualPool.partnerQuoteFee.toString()) / 1e9;
  console.log(`${l.launch.symbol}  partner curve fees ${owed.toFixed(6)} SOL, graduated ${l.graduated}`);
  if (!treasury || DRY) continue;
  const run = async (label, build) => {
    try {
      const tx = await build();
      tx.feePayer = treasury.publicKey;
      await send(tx, [treasury], `${l.launch.symbol} ${label}`);
    } catch (err) {
      console.log(`  ${label}: ${String(err.message ?? err).split("\n")[0]}`);
    }
  };
  if (owed > 0) {
    await run("claimPartnerTradingFee", () =>
      client.partner.claimPartnerTradingFee({ feeClaimer: treasury.publicKey, payer: treasury.publicKey, pool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX }),
    );
  }
  if (!l.graduated) continue;
  // Already-withdrawn fees fail harmlessly; run() prints the reason and moves on.
  {
    await run("partnerWithdrawMigrationFee", () => client.partner.partnerWithdrawMigrationFee({ pool, sender: treasury.publicKey }));
  }
  if (virtualPool.isPartnerWithdrawSurplus === 0) {
    await run("partnerWithdrawSurplus", () => client.partner.partnerWithdrawSurplus({ feeClaimer: treasury.publicKey, pool }));
  }
  if (virtualPool.isWithdrawLeftover === 0) {
    await run("withdrawLeftover", () => client.migration.withdrawLeftover({ payer: treasury.publicKey, pool }));
  }
  const damm = poolPda(DAMM_V2_PROGRAM, DAMM_V2_CUSTOMIZABLE_CONFIG, new PublicKey(l.launch.mint));
  const [positions, poolState] = await Promise.all([amm.getUserPositionByPool(damm, treasury.publicKey), amm.fetchPoolState(damm)]);
  for (const { position, positionNftAccount, positionState } of positions) {
    const { feeTokenB } = cpamm.getUnClaimLpFee(poolState, positionState);
    if (feeTokenB.isZero()) continue;
    await run(`claimPositionFee (${(Number(feeTokenB.toString()) / 1e9).toFixed(6)} SOL)`, async () => {
      const claim = await amm.claimPositionFee({
        owner: treasury.publicKey,
        position,
        pool: damm,
        positionNftAccount,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAProgram: cpamm.getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: cpamm.getTokenProgram(poolState.tokenBFlag),
      });
      return new Transaction().add(...claim.instructions);
    });
  }
}
if (!treasury) console.log("No treasury key on this machine: nothing was claimed.");
