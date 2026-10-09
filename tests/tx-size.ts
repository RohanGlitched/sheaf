/**
 * How big the three per-component instructions get, as v0 transactions with
 * no address lookup table, at 6, 7 and 8 components. Solana's packet limit is
 * 1,232 bytes. Nothing is sent: the instructions are built against fresh keys
 * and only serialised, with one signature (the depositor, owner or filler
 * pays) and a compute-budget instruction, as every client sends them.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import type { Sheaf } from "../target/types/sheaf";

const PACKET = 1_232;

describe("transaction sizes (v0, no lookup table)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.sheaf as anchor.Program<Sheaf>;
  const key = () => Keypair.generate().publicKey;
  const T22 = TOKEN_2022_PROGRAM_ID;

  async function size(ix: anchor.web3.TransactionInstruction, payer: PublicKey, computeBudget = true) {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: key().toBase58(),
      instructions: computeBudget ? [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix] : [ix],
    }).compileToV0Message();
    // Counted rather than serialised: web3.js refuses to serialise anything
    // over the packet limit, and the point is to see by how much it is over.
    const compact = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);
    const sigs = message.header.numRequiredSignatures;
    const keys = message.staticAccountKeys.length;
    const ixs = message.compiledInstructions.reduce(
      (total, ix) =>
        total + 1 + compact(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + compact(ix.data.length) + ix.data.length,
      0,
    );
    const bytes =
      compact(sigs) + 64 * sigs + 1 + 3 + compact(keys) + 32 * keys + 32 + compact(message.compiledInstructions.length) + ixs + compact(0);
    if (bytes <= PACKET) assert.equal(new VersionedTransaction(message).serialize().length, bytes, "the count matches web3.js");
    return bytes;
  }

  const rows: Record<string, Record<number, number>> = { mint_shares: {}, redeem_shares: {}, fill_order: {}, "fill_order (plan)": {}, "plan fill, no CU ix": {} };

  for (const n of [6, 7, 8]) {
    it(`measures ${n} components`, async () => {
      const user = key();
      const basket = key();
      const shareMint = key();
      const mints = Array.from({ length: n }, key);
      const userAccounts = mints.map(key);
      const vaults = mints.map(key);
      const triple = (a: PublicKey[], b: PublicKey[]) =>
        mints.flatMap((m, i) => [
          { pubkey: m, isSigner: false, isWritable: false },
          { pubkey: a[i], isSigner: false, isWritable: true },
          { pubkey: b[i], isSigner: false, isWritable: true },
        ]);

      const mint = await program.methods
        .mintShares(new anchor.BN(1_000_000))
        .accountsPartial({
          basket,
          shareMint,
          depositor: user,
          depositorShareAccount: key(),
          creatorShareAccount: key(),
          shareTokenProgram: T22,
          componentTokenProgram: T22,
        })
        .remainingAccounts(triple(userAccounts, vaults))
        .instruction();
      rows.mint_shares[n] = await size(mint, user);

      const redeem = await program.methods
        .redeemShares(new anchor.BN(1_000_000))
        .accountsPartial({
          basket,
          shareMint,
          owner: user,
          ownerShareAccount: key(),
          shareTokenProgram: T22,
          componentTokenProgram: T22,
        })
        .remainingAccounts(triple(vaults, userAccounts))
        .instruction();
      rows.redeem_shares[n] = await size(redeem, user);

      const fillIx = (plan: PublicKey | null) =>
        program.methods
          .fillOrder()
          .accountsPartial({
            filler: user,
            order: key(),
            basket,
            shareMint,
            buyer: key(),
            buyerShareAccount: key(),
            creatorShareAccount: key(),
            cashMint: key(),
            escrow: key(),
            fillerCashAccount: key(),
            rentPayer: key(),
            plan,
            shareTokenProgram: T22,
            componentTokenProgram: T22,
            cashTokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(triple(userAccounts, vaults))
          .instruction();
      rows.fill_order[n] = await size(await fillIx(null), user);
      const planFill = await fillIx(key());
      rows["fill_order (plan)"][n] = await size(planFill, user);
      rows["plan fill, no CU ix"][n] = await size(planFill, user, false);
    });
  }

  after(() => {
    console.log("\n      bytes (limit 1,232)   6      7      8");
    for (const [name, r] of Object.entries(rows)) {
      console.log(`      ${name.padEnd(20)} ${[6, 7, 8].map((n) => String(r[n]).padStart(6)).join(" ")}`);
    }
  });

  it("fits mint, redeem and a user-order fill in one packet at 6 components", () => {
    for (const name of ["mint_shares", "redeem_shares", "fill_order"]) assert.isAtMost(rows[name][6], PACKET, name);
  });
});
