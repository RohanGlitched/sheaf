/**
 * Sheaf program tests.
 *
 * These exercise the two properties the design rests on:
 *
 *  1. The vault can never end up backing fewer components than the outstanding
 *     shares claim. Deposits round up, redemptions round down.
 *  2. The ScaledUiAmount multiplier that xStocks use to accrue dividends does not
 *     disturb the recipe, because the recipe is written in raw units. Bumping a
 *     component's multiplier must not change what a share redeems for on chain,
 *     while increasing what that holding is worth to its owner.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createUpdateMultiplierDataInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSetAuthorityInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  AuthorityType,
  tokenMetadataInitializeWithRentTransfer,
  getScaledUiAmountConfig,
  createInitializeTransferFeeConfigInstruction,
  getTransferFeeAmount,
} from "@solana/spl-token";
import { assert } from "chai";
import type { Sheaf } from "../target/types/sheaf";

const ONE_SHARE = 1_000_000; // share mint has 6 decimals
const COMPONENT_DECIMALS = 8; // every xStock uses 8

describe("sheaf", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.sheaf as anchor.Program<Sheaf>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  /** Mock xStock: Token-2022, 8 decimals, metadata, and a live multiplier. */
  async function createComponentMint(symbol: string, multiplier = 1.0) {
    const mint = Keypair.generate();
    const extensions = [
      ExtensionType.MetadataPointer,
      ExtensionType.ScaledUiAmountConfig,
    ];
    const space = getMintLen(extensions);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      space + 300, // headroom for the variable-length metadata
    );

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
      createInitializeMint2Instruction(
        mint.publicKey,
        COMPONENT_DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, tx, [payer, mint]);

    await tokenMetadataInitializeWithRentTransfer(
      provider.connection,
      payer,
      mint.publicKey,
      payer.publicKey,
      payer,
      `${symbol} test`,
      symbol,
      `https://sheaf.test/${symbol}.json`,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return mint.publicKey;
  }

  /**
   * Share mint: created by the client, handed to the basket.
   *
   * Metadata has to be initialised while an ordinary keypair still holds the mint
   * authority, because the token-metadata instruction needs that authority to
   * sign and a program-derived address cannot sign a client transaction. So we
   * initialise, then hand the authority to the basket.
   */
  async function createShareMint(basket: PublicKey, name: string, symbol: string) {
    const mint = Keypair.generate();
    const space = getMintLen([ExtensionType.MetadataPointer]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      space + 400,
    );
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
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, tx, [payer, mint]);

    await tokenMetadataInitializeWithRentTransfer(
      provider.connection,
      payer,
      mint.publicKey,
      payer.publicKey,
      payer,
      name,
      symbol,
      `https://sheaf.test/basket/${symbol}.json`,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await sendAndConfirmTransaction(
      provider.connection,
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
    );
    return mint.publicKey;
  }

  async function fundHolder(mint: PublicKey, owner: PublicKey, rawAmount: bigint) {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata,
          owner,
          mint,
          TOKEN_2022_PROGRAM_ID,
        ),
        createMintToInstruction(
          mint,
          ata,
          payer.publicKey,
          rawAmount,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer],
    );
    return ata;
  }

  const basketPda = (creator: PublicKey, symbol: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("basket"), creator.toBuffer(), Buffer.from(symbol)],
      program.programId,
    )[0];

  const vaultFor = (basket: PublicKey, mint: PublicKey) =>
    getAssociatedTokenAddressSync(mint, basket, true, TOKEN_2022_PROGRAM_ID);

  const rawBalance = async (ata: PublicKey) =>
    (await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID))
      .amount;

  // ---------------------------------------------------------------- fixtures

  let components: PublicKey[];
  let unitsPerShare: anchor.BN[];
  let basket: PublicKey;
  let shareMint: PublicKey;
  const SYMBOL = "MAG3";
  const FEE_BPS = 30;

  before(async () => {
    // Three mock xStocks. The third starts with a multiplier already above 1,
    // the way a real xStock that has accrued a dividend does.
    components = [
      await createComponentMint("AAPLx"),
      await createComponentMint("NVDAx"),
      await createComponentMint("MSFTx", 1.0026642),
    ];
    // Raw units per whole share, as the front end would compute them from live
    // prices for a 50/30/20 basket.
    unitsPerShare = [new anchor.BN(15_000_000), new anchor.BN(9_000_000), new anchor.BN(4_000_000)];

    basket = basketPda(payer.publicKey, SYMBOL);
    shareMint = await createShareMint(basket, "Magnificent Three", SYMBOL);

    await program.methods
      .createBasket(
        "Magnificent Three",
        SYMBOL,
        FEE_BPS,
        components.map((mint, i) => ({
          mint,
          unitsPerShare: unitsPerShare[i],
          weightBps: [5000, 3000, 2000][i],
        })),
      )
      .accountsPartial({
        creator: payer.publicKey,
        basket,
        shareMint,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        components.map((mint) => ({
          pubkey: mint,
          isSigner: false,
          isWritable: false,
        })),
      )
      .rpc();
  });

  it("records the recipe it was given", async () => {
    const account = await program.account.basket.fetch(basket);
    assert.equal(account.name, "Magnificent Three");
    assert.equal(account.symbol, SYMBOL);
    assert.equal(account.componentCount, 3);
    assert.equal(account.creatorFeeBps, FEE_BPS);
    assert.equal(account.shareMint.toBase58(), shareMint.toBase58());
    for (let i = 0; i < 3; i++) {
      assert.equal(account.components[i].mint.toBase58(), components[i].toBase58());
      assert.isTrue(account.components[i].unitsPerShare.eq(unitsPerShare[i]));
      assert.equal(account.components[i].decimals, COMPONENT_DECIMALS);
    }
  });

  it("refuses a recipe whose weights do not add up", async () => {
    const symbol = "BADW";
    const pda = basketPda(payer.publicKey, symbol);
    const mint = await createShareMint(pda, "Bad Weights", symbol);
    try {
      await program.methods
        .createBasket("Bad Weights", symbol, 0, [
          { mint: components[0], unitsPerShare: new anchor.BN(1000), weightBps: 6000 },
          { mint: components[1], unitsPerShare: new anchor.BN(1000), weightBps: 3000 },
        ])
        .accountsPartial({
          creator: payer.publicKey,
          basket: pda,
          shareMint: mint,
          componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          components.slice(0, 2).map((m) => ({
            pubkey: m,
            isSigner: false,
            isWritable: false,
          })),
        )
        .rpc();
      assert.fail("expected the weight check to reject this");
    } catch (err: any) {
      assert.include(err.toString(), "WeightsMustSumToOne");
    }
  });

  it("refuses a creator fee above 1%", async () => {
    const symbol = "GREED";
    const pda = basketPda(payer.publicKey, symbol);
    const mint = await createShareMint(pda, "Too Greedy", symbol);
    try {
      await program.methods
        .createBasket("Too Greedy", symbol, 500, [
          { mint: components[0], unitsPerShare: new anchor.BN(1000), weightBps: 10000 },
        ])
        .accountsPartial({
          creator: payer.publicKey,
          basket: pda,
          shareMint: mint,
          componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: components[0], isSigner: false, isWritable: false },
        ])
        .rpc();
      assert.fail("expected the fee cap to reject this");
    } catch (err: any) {
      assert.include(err.toString(), "CreatorFeeTooHigh");
    }
  });

  // ------------------------------------------------------------ mint & redeem

  const holder = Keypair.generate();
  let holderComponentAtas: PublicKey[];
  let holderShareAta: PublicKey;
  let creatorShareAta: PublicKey;

  async function prepareHolder() {
    const sig = await provider.connection.requestAirdrop(
      holder.publicKey,
      2_000_000_000,
    );
    await provider.connection.confirmTransaction(sig);

    holderComponentAtas = [];
    for (const mint of components) {
      // Plenty of every component: 100 whole tokens each.
      holderComponentAtas.push(
        await fundHolder(mint, holder.publicKey, 100n * 10n ** 8n),
      );
    }

    holderShareAta = getAssociatedTokenAddressSync(
      shareMint,
      holder.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    creatorShareAta = getAssociatedTokenAddressSync(
      shareMint,
      payer.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );

    const setup = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        holderShareAta,
        holder.publicKey,
        shareMint,
        TOKEN_2022_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        creatorShareAta,
        payer.publicKey,
        shareMint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    for (const mint of components) {
      setup.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          vaultFor(basket, mint),
          basket,
          mint,
          TOKEN_2022_PROGRAM_ID,
        ),
      );
    }
    await sendAndConfirmTransaction(provider.connection, setup, [payer]);
  }

  function mintRemaining() {
    return components.flatMap((mint, i) => [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: holderComponentAtas[i], isSigner: false, isWritable: true },
      { pubkey: vaultFor(basket, mint), isSigner: false, isWritable: true },
    ]);
  }

  function redeemRemaining() {
    return components.flatMap((mint, i) => [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultFor(basket, mint), isSigner: false, isWritable: true },
      { pubkey: holderComponentAtas[i], isSigner: false, isWritable: true },
    ]);
  }

  it("takes the recipe in and issues shares, net of the creator fee", async () => {
    await prepareHolder();

    const shares = new anchor.BN(2.5 * ONE_SHARE);
    await program.methods
      .mintShares(shares)
      .accountsPartial({
        basket,
        shareMint,
        depositor: holder.publicKey,
        depositorShareAccount: holderShareAta,
        creatorShareAccount: creatorShareAta,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(mintRemaining())
      .signers([holder])
      .rpc();

    // Each vault holds exactly units_per_share x 2.5.
    for (let i = 0; i < components.length; i++) {
      const expected =
        (BigInt(unitsPerShare[i].toString()) * BigInt(shares.toString())) /
        BigInt(ONE_SHARE);
      assert.equal(
        (await rawBalance(vaultFor(basket, components[i]))).toString(),
        expected.toString(),
        `vault ${i}`,
      );
    }

    const fee = (BigInt(shares.toString()) * BigInt(FEE_BPS)) / 10_000n;
    assert.equal(
      (await rawBalance(holderShareAta)).toString(),
      (BigInt(shares.toString()) - fee).toString(),
      "holder shares are net of the fee",
    );
    assert.equal(
      (await rawBalance(creatorShareAta)).toString(),
      fee.toString(),
      "creator receives the fee in shares",
    );
  });

  it("keeps the vault fully backing every outstanding share", async () => {
    const mintInfo = await getMint(
      provider.connection,
      shareMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    for (let i = 0; i < components.length; i++) {
      const held = await rawBalance(vaultFor(basket, components[i]));
      const owed =
        (BigInt(unitsPerShare[i].toString()) * mintInfo.supply) /
        BigInt(ONE_SHARE);
      assert.isTrue(
        held >= owed,
        `component ${i}: vault holds ${held}, shares claim ${owed}`,
      );
    }
  });

  it("hands the components back on redemption", async () => {
    const before = await Promise.all(
      holderComponentAtas.map((ata) => rawBalance(ata)),
    );
    const shares = new anchor.BN(1 * ONE_SHARE);

    await program.methods
      .redeemShares(shares)
      .accountsPartial({
        basket,
        shareMint,
        owner: holder.publicKey,
        ownerShareAccount: holderShareAta,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(redeemRemaining())
      .signers([holder])
      .rpc();

    for (let i = 0; i < components.length; i++) {
      const after = await rawBalance(holderComponentAtas[i]);
      const expected =
        (BigInt(unitsPerShare[i].toString()) * BigInt(shares.toString())) /
        BigInt(ONE_SHARE);
      assert.equal(
        (after - before[i]).toString(),
        expected.toString(),
        `component ${i} returned`,
      );
    }
  });

  it("rejects a vault that is not the basket's own token account", async () => {
    const impostor = await fundHolder(components[0], holder.publicKey, 0n);
    const remaining = components.flatMap((mint, i) => [
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: holderComponentAtas[i], isSigner: false, isWritable: true },
      {
        pubkey: i === 0 ? impostor : vaultFor(basket, mint),
        isSigner: false,
        isWritable: true,
      },
    ]);
    try {
      await program.methods
        .mintShares(new anchor.BN(ONE_SHARE))
        .accountsPartial({
          basket,
          shareMint,
          depositor: holder.publicKey,
          depositorShareAccount: holderShareAta,
          creatorShareAccount: creatorShareAta,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          componentTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts(remaining)
        .signers([holder])
        .rpc();
      assert.fail("expected the vault check to reject this");
    } catch (err: any) {
      assert.include(err.toString(), "VaultMismatch");
    }
  });

  it("is unmoved by a dividend accruing into a component's multiplier", async () => {
    // MSFTx accrues a dividend: its multiplier steps up. On chain the recipe is
    // written in raw units, so redemption must return exactly the same raw
    // amount as before — while being worth more to whoever receives it.
    const target = components[2];
    const beforeMint = await getMint(
      provider.connection,
      target,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const beforeMultiplier = Number(
      getScaledUiAmountConfig(beforeMint)?.multiplier ?? 1,
    );

    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createUpdateMultiplierDataInstruction(
          target,
          payer.publicKey,
          1.05,
          0n, // effective immediately
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer],
    );

    const beforeRaw = await rawBalance(holderComponentAtas[2]);
    const shares = new anchor.BN(0.5 * ONE_SHARE);

    await program.methods
      .redeemShares(shares)
      .accountsPartial({
        basket,
        shareMint,
        owner: holder.publicKey,
        ownerShareAccount: holderShareAta,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(redeemRemaining())
      .signers([holder])
      .rpc();

    const afterRaw = await rawBalance(holderComponentAtas[2]);
    const expectedRaw =
      (BigInt(unitsPerShare[2].toString()) * BigInt(shares.toString())) /
      BigInt(ONE_SHARE);

    assert.equal(
      (afterRaw - beforeRaw).toString(),
      expectedRaw.toString(),
      "raw redemption is untouched by the multiplier",
    );
    assert.isAbove(1.05, beforeMultiplier, "the multiplier really did rise");
  });

  // PreStocks tokens carry a TransferFeeConfig extension xStocks do not: every
  // transfer skims a fee at the token-program level. A deposit has to gross up
  // for that fee, or the vault ends up backing shares by less than the recipe.
  async function createFeeComponentMint(feeBps: number) {
    const mint = Keypair.generate();
    const space = getMintLen([ExtensionType.TransferFeeConfig]);
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(space);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        payer.publicKey,
        feeBps,
        BigInt("18446744073709551615"), // uncapped, same as a live PreStocks mint
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(mint.publicKey, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    );
    await sendAndConfirmTransaction(provider.connection, tx, [payer, mint]);
    return mint.publicKey;
  }

  it("grosses up a deposit so a transfer-fee component still nets the recipe amount", async () => {
    const FEE_BPS = 50; // matches the live PreStocks fee
    const feeMint = await createFeeComponentMint(FEE_BPS);
    const unitsPerShareFee = new anchor.BN(1_000_000_000); // 1 whole token, 9 decimals

    const symbol = "FEE1";
    const pda = basketPda(payer.publicKey, symbol);
    const mint = await createShareMint(pda, "Fee Component Basket", symbol);
    await program.methods
      .createBasket("Fee Component Basket", symbol, 0, [
        { mint: feeMint, unitsPerShare: unitsPerShareFee, weightBps: 10000 },
      ])
      .accountsPartial({
        creator: payer.publicKey,
        basket: pda,
        shareMint: mint,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: feeMint, isSigner: false, isWritable: false }])
      .rpc();

    const feeHolder = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(feeHolder.publicKey, 2_000_000_000),
    );
    const holderAta = await fundHolder(feeMint, feeHolder.publicKey, 10n * 10n ** 9n);
    const holderShareAta = getAssociatedTokenAddressSync(mint, feeHolder.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const vault = vaultFor(pda, feeMint);
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          holderShareAta,
          feeHolder.publicKey,
          mint,
          TOKEN_2022_PROGRAM_ID,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          vault,
          pda,
          feeMint,
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [payer],
    );

    const before = await rawBalance(holderAta);
    await program.methods
      .mintShares(new anchor.BN(ONE_SHARE))
      .accountsPartial({
        basket: pda,
        shareMint: mint,
        depositor: feeHolder.publicKey,
        depositorShareAccount: holderShareAta,
        // No creator fee on this basket, so the program never touches this
        // account — but Anchor's client-side validation still wants one named.
        creatorShareAccount: holderShareAta,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        componentTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: feeMint, isSigner: false, isWritable: false },
        { pubkey: holderAta, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
      ])
      .signers([feeHolder])
      .rpc();

    const vaultBalance = await rawBalance(vault);
    assert.equal(
      vaultBalance.toString(),
      unitsPerShareFee.toString(),
      "the vault nets exactly the recipe amount despite the transfer fee",
    );

    const vaultAccount = await getAccount(provider.connection, vault, undefined, TOKEN_2022_PROGRAM_ID);
    const withheld = getTransferFeeAmount(vaultAccount)?.withheldAmount ?? 0n;
    const after = await rawBalance(holderAta);
    assert.equal(
      (before - after).toString(),
      (vaultBalance + withheld).toString(),
      "the holder paid the recipe amount plus exactly the fee the token program withheld",
    );
  });

  it("stays backed through forty random creations and redemptions", async () => {
    // A property rather than an example: whatever sizes people pick, in
    // whatever order, no vault ever holds less than the outstanding shares
    // claim. Sizes go down to a single raw share unit, where rounding bites
    // hardest, and the generator is seeded so a failure can be replayed.
    let seed = 0x5eed;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const backed = async (label: string) => {
      const supply = (
        await getMint(provider.connection, shareMint, undefined, TOKEN_2022_PROGRAM_ID)
      ).supply;
      for (let i = 0; i < components.length; i++) {
        const held = await rawBalance(vaultFor(basket, components[i]));
        const owed =
          (BigInt(unitsPerShare[i].toString()) * supply) / BigInt(ONE_SHARE);
        assert.isTrue(
          held >= owed,
          `${label}: component ${i} holds ${held}, shares claim ${owed}`,
        );
      }
    };

    for (let round = 0; round < 40; round++) {
      const held = await rawBalance(holderShareAta);
      if (held > 0n && random() < 0.45) {
        // Redeem anything from one raw share unit to everything held.
        const shares = 1n + BigInt(Math.floor(random() * Number(held - 1n)));
        await program.methods
          .redeemShares(new anchor.BN(shares.toString()))
          .accountsPartial({
            basket,
            shareMint,
            owner: holder.publicKey,
            ownerShareAccount: holderShareAta,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(redeemRemaining())
          .signers([holder])
          .rpc();
        await backed(`round ${round}, redeemed ${shares}`);
      } else {
        // Create between one raw unit and three whole shares, skewed small.
        const shares = 1n + BigInt(Math.floor(random() ** 3 * 3 * ONE_SHARE));
        await program.methods
          .mintShares(new anchor.BN(shares.toString()))
          .accountsPartial({
            basket,
            shareMint,
            depositor: holder.publicKey,
            depositorShareAccount: holderShareAta,
            creatorShareAccount: creatorShareAta,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(mintRemaining())
          .signers([holder])
          .rpc();
        await backed(`round ${round}, created ${shares}`);
      }
    }
  });

  it("still fully backs every share after all that", async () => {
    const mintInfo = await getMint(
      provider.connection,
      shareMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    for (let i = 0; i < components.length; i++) {
      const held = await rawBalance(vaultFor(basket, components[i]));
      const owed =
        (BigInt(unitsPerShare[i].toString()) * mintInfo.supply) /
        BigInt(ONE_SHARE);
      assert.isTrue(held >= owed, `component ${i} still covered`);
    }
  });

  // ================================================================ cash desk
  //
  // A buyer escrows cash and posts a Dutch auction for shares. A filler
  // delivers the recipe in kind for whatever the auction currently asks, the
  // buyer gets the shares, the filler gets the cash. The program never reads
  // a price; these tests pin the share arithmetic exactly against the chain's
  // own clock, which every fill reports in its event.
  describe("cash desk", () => {
    const CASH_DECIMALS = 6;
    const USDC = 1_000_000n;
    const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const parser = new anchor.EventParser(
      program.programId,
      new anchor.BorshCoder(program.idl),
    );

    const buyer = Keypair.generate();
    const filler = Keypair.generate();
    const stranger = Keypair.generate();
    let cashMint: PublicKey; // classic SPL Token, 6 decimals
    let buyerCash: PublicKey;
    let fillerCash: PublicKey;
    let strangerCash: PublicKey;
    let buyerShareAta: PublicKey;
    let fillerShareAta: PublicKey;
    let fillerComponentAtas: PublicKey[];
    let nextNonce = 1;

    // ------------------------------------------------------------ helpers

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** The cluster clock exactly as programs see it. */
    async function chainNow(): Promise<number> {
      const info = await provider.connection.getAccountInfo(
        SYSVAR_CLOCK_PUBKEY,
        "processed",
      );
      return Number(info!.data.readBigInt64LE(32));
    }

    async function waitUntil(ts: number) {
      while ((await chainNow()) < ts) await sleep(100);
    }

    async function airdrop(to: PublicKey) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(to, 5_000_000_000),
      );
    }

    async function createCashMint(programId: PublicKey, transferFeeBps?: number) {
      const mint = Keypair.generate();
      const exts = transferFeeBps === undefined ? [] : [ExtensionType.TransferFeeConfig];
      const space = programId.equals(TOKEN_PROGRAM_ID) ? MINT_SIZE : getMintLen(exts);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
          programId,
        }),
      );
      if (transferFeeBps !== undefined) {
        tx.add(
          createInitializeTransferFeeConfigInstruction(
            mint.publicKey,
            payer.publicKey,
            payer.publicKey,
            transferFeeBps,
            BigInt("18446744073709551615"),
            programId,
          ),
        );
      }
      tx.add(
        createInitializeMint2Instruction(
          mint.publicKey,
          CASH_DECIMALS,
          payer.publicKey,
          null,
          programId,
        ),
      );
      await sendAndConfirmTransaction(provider.connection, tx, [payer, mint]);
      return mint.publicKey;
    }

    async function fundToken(
      mint: PublicKey,
      owner: PublicKey,
      amount: bigint,
      programId: PublicKey,
    ) {
      const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata,
          owner,
          mint,
          programId,
        ),
      );
      if (amount > 0n) {
        tx.add(createMintToInstruction(mint, ata, payer.publicKey, amount, [], programId));
      }
      await sendAndConfirmTransaction(provider.connection, tx, [payer]);
      return ata;
    }

    const balance = async (ata: PublicKey, programId = TOKEN_PROGRAM_ID) =>
      (await getAccount(provider.connection, ata, "processed", programId)).amount;
    const lamports = async (key: PublicKey) =>
      BigInt(await provider.connection.getBalance(key, "processed"));
    const gone = async (key: PublicKey) =>
      (await provider.connection.getAccountInfo(key, "processed")) === null;

    const u64le = (n: number | bigint) =>
      new anchor.BN(n.toString()).toArrayLike(Buffer, "le", 8);
    const orderPda = (owner: PublicKey, nonce: number) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("order"), basket.toBuffer(), owner.toBuffer(), u64le(nonce)],
        program.programId,
      )[0];
    const planPda = (owner: PublicKey, planId: number) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("plan"), basket.toBuffer(), owner.toBuffer(), u64le(planId)],
        program.programId,
      )[0];
    const escrowFor = (order: PublicKey, mint: PublicKey, programId = TOKEN_PROGRAM_ID) =>
      getAssociatedTokenAddressSync(mint, order, true, programId);
    const shareAtaOf = (owner: PublicKey) =>
      getAssociatedTokenAddressSync(shareMint, owner, true, TOKEN_2022_PROGRAM_ID);
    const bn = (n: number | bigint) => new anchor.BN(n.toString());

    /** Independent of the program: walk up until the creator fee leaves `net`. */
    function grossFor(net: bigint): bigint {
      let g = net;
      while (g - (g * BigInt(FEE_BPS)) / 10_000n < net) g++;
      return g;
    }

    /** The auction line, in BigInt, decay rounded down. */
    function requiredAt(o: { s: bigint; e: bigint; t0: number; t1: number }, t: number) {
      if (t <= o.t0) return o.s;
      if (t >= o.t1) return o.e;
      return o.s - ((o.s - o.e) * BigInt(t - o.t0)) / BigInt(o.t1 - o.t0);
    }

    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

    async function events(sig: string) {
      let tx = null;
      for (let i = 0; i < 60 && tx === null; i++) {
        tx = await provider.connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (tx === null) await sleep(200);
      }
      return [...parser.parseLogs(tx!.meta!.logMessages!)];
    }
    async function eventOf(sig: string, name: string) {
      const ev = (await events(sig)).find(
        (e) => e.name.toLowerCase() === name.toLowerCase(),
      );
      assert.isDefined(ev, `${name} emitted`);
      return ev!.data as any;
    }

    async function place(opts: {
      nonce?: number;
      cash: bigint;
      start: bigint;
      end: bigint;
      t0: number;
      t1: number;
      who?: Keypair;
      from?: PublicKey;
      mint?: PublicKey;
      cashProgram?: PublicKey;
    }) {
      const who = opts.who ?? buyer;
      const nonce = opts.nonce ?? nextNonce++;
      const mint = opts.mint ?? cashMint;
      const cashProgram = opts.cashProgram ?? TOKEN_PROGRAM_ID;
      const order = orderPda(who.publicKey, nonce);
      const sig = await program.methods
        .placeOrder(bn(nonce), bn(opts.cash), bn(opts.start), bn(opts.end), bn(opts.t0), bn(opts.t1))
        .accountsPartial({
          buyer: who.publicKey,
          basket,
          order,
          cashMint: mint,
          buyerCashAccount: opts.from ?? buyerCash,
          escrow: escrowFor(order, mint, cashProgram),
          cashTokenProgram: cashProgram,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([who])
        .rpc();
      return { order, nonce, sig };
    }

    function fillerRemaining(atas = fillerComponentAtas) {
      return components.flatMap((mint, i) => [
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: atas[i], isSigner: false, isWritable: true },
        { pubkey: vaultFor(basket, mint), isSigner: false, isWritable: true },
      ]);
    }

    async function fill(
      order: PublicKey,
      opts: {
        owner?: PublicKey;
        rentPayer?: PublicKey;
        plan?: PublicKey | null;
        mint?: PublicKey;
        cashProgram?: PublicKey;
        to?: PublicKey;
        remaining?: any[];
        buyerShareAccount?: PublicKey;
        by?: Keypair;
      } = {},
    ) {
      const owner = opts.owner ?? buyer.publicKey;
      const mint = opts.mint ?? cashMint;
      const cashProgram = opts.cashProgram ?? TOKEN_PROGRAM_ID;
      const by = opts.by ?? filler;
      return program.methods
        .fillOrder()
        .accountsPartial({
          filler: by.publicKey,
          order,
          basket,
          shareMint,
          buyer: owner,
          buyerShareAccount: opts.buyerShareAccount ?? shareAtaOf(owner),
          creatorShareAccount: creatorShareAta,
          cashMint: mint,
          escrow: escrowFor(order, mint, cashProgram),
          fillerCashAccount: opts.to ?? fillerCash,
          rentPayer: opts.rentPayer ?? owner,
          plan: opts.plan ?? null,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          cashTokenProgram: cashProgram,
        })
        .remainingAccounts(opts.remaining ?? fillerRemaining())
        .preInstructions([CU])
        .signers([by])
        .rpc();
    }

    async function cancel(
      order: PublicKey,
      opts: {
        by?: Keypair;
        owner?: PublicKey;
        refundTo?: PublicKey;
        rentPayer?: PublicKey;
        mint?: PublicKey;
        cashProgram?: PublicKey;
      } = {},
    ) {
      const by = opts.by ?? buyer;
      const owner = opts.owner ?? buyer.publicKey;
      const mint = opts.mint ?? cashMint;
      const cashProgram = opts.cashProgram ?? TOKEN_PROGRAM_ID;
      return program.methods
        .cancelOrder()
        .accountsPartial({
          caller: by.publicKey,
          order,
          buyer: owner,
          cashMint: mint,
          escrow: escrowFor(order, mint, cashProgram),
          buyerCashAccount: opts.refundTo ?? buyerCash,
          rentPayer: opts.rentPayer ?? owner,
          cashTokenProgram: cashProgram,
        })
        .signers([by])
        .rpc();
    }

    async function expectError(p: Promise<unknown>, ...codes: string[]) {
      try {
        await p;
      } catch (err: any) {
        const text = `${err}\n${(err.logs ?? []).join("\n")}`;
        assert.isTrue(
          codes.some((c) => text.includes(c)),
          `expected one of ${codes.join(", ")}, got: ${text}`,
        );
        return;
      }
      assert.fail(`expected ${codes.join(" or ")}`);
    }

    /** Component vault and share balances, for before/after deltas. */
    async function snapshot(owner: PublicKey) {
      return {
        vaults: await Promise.all(components.map((m) => rawBalance(vaultFor(basket, m)))),
        owner: await rawBalance(shareAtaOf(owner)),
        creator: await rawBalance(creatorShareAta),
      };
    }

    /** A fill delivered exactly the recipe for `gross`, and split it right. */
    async function assertDelivered(
      before: Awaited<ReturnType<typeof snapshot>>,
      owner: PublicKey,
      received: bigint,
    ) {
      const gross = grossFor(received);
      const after = await snapshot(owner);
      for (let i = 0; i < components.length; i++) {
        assert.equal(
          (after.vaults[i] - before.vaults[i]).toString(),
          ceilDiv(BigInt(unitsPerShare[i].toString()) * gross, BigInt(ONE_SHARE)).toString(),
          `vault ${i} got the recipe for ${gross} gross shares, rounded up`,
        );
      }
      assert.equal((after.owner - before.owner).toString(), received.toString(), "buyer received");
      assert.equal(
        (after.creator - before.creator).toString(),
        (gross - received).toString(),
        "creator fee shares",
      );
      assert.equal(
        (gross * BigInt(FEE_BPS)) / 10_000n,
        gross - received,
        "the fee is exactly mint_shares' fee on the gross delivered",
      );
    }

    // ------------------------------------------------------------- set-up

    before(async () => {
      for (const k of [buyer, filler, stranger]) await airdrop(k.publicKey);
      cashMint = await createCashMint(TOKEN_PROGRAM_ID);
      buyerCash = await fundToken(cashMint, buyer.publicKey, 10_000n * USDC, TOKEN_PROGRAM_ID);
      fillerCash = await fundToken(cashMint, filler.publicKey, 0n, TOKEN_PROGRAM_ID);
      strangerCash = await fundToken(cashMint, stranger.publicKey, 0n, TOKEN_PROGRAM_ID);
      fillerComponentAtas = [];
      for (const mint of components) {
        fillerComponentAtas.push(
          await fundHolder(mint, filler.publicKey, 1_000n * 10n ** 8n),
        );
      }
      buyerShareAta = await fundToken(shareMint, buyer.publicKey, 0n, TOKEN_2022_PROGRAM_ID);
      fillerShareAta = await fundToken(shareMint, filler.publicKey, 0n, TOKEN_2022_PROGRAM_ID);
    });

    // ------------------------------------------------------------- orders

    let startOrder: { order: PublicKey; nonce: number; sig: string };
    const START = { cash: 250n * USDC, s: 2_000_000n, e: 1_000_000n };

    it("places an order, escrowing exactly the cash in the order's own account", async () => {
      const now = await chainNow();
      const before = await balance(buyerCash);
      startOrder = await place({
        cash: START.cash,
        start: START.s,
        end: START.e,
        t0: now + 100,
        t1: now + 200,
      });
      const o = await program.account.order.fetch(startOrder.order);
      assert.equal(o.buyer.toBase58(), buyer.publicKey.toBase58());
      assert.equal(o.rentPayer.toBase58(), buyer.publicKey.toBase58());
      assert.equal(o.basket.toBase58(), basket.toBase58());
      assert.isNull(o.plan);
      assert.equal(o.cashAmount.toString(), START.cash.toString());
      assert.equal(o.startShares.toString(), START.s.toString());
      assert.equal(o.endShares.toString(), START.e.toString());
      assert.equal(
        (await balance(escrowFor(startOrder.order, cashMint))).toString(),
        START.cash.toString(),
      );
      assert.equal((before - (await balance(buyerCash))).toString(), START.cash.toString());
      const ev = await eventOf(startOrder.sig, "OrderPlaced");
      assert.equal(ev.cashAmount.toString(), START.cash.toString());
    });

    it("rejects auctions that rise, have no floor, or have already closed", async () => {
      const now = await chainNow();
      await expectError(
        place({ cash: USDC, start: 1n, end: 2n, t0: now, t1: now + 60 }),
        "BadAuctionShares",
      );
      await expectError(
        place({ cash: USDC, start: 1n, end: 0n, t0: now, t1: now + 60 }),
        "BadAuctionShares",
      );
      await expectError(
        place({ cash: USDC, start: 2n, end: 1n, t0: now - 60, t1: now - 1 }),
        "BadAuctionWindow",
      );
      await expectError(
        place({ cash: USDC, start: 2n, end: 1n, t0: now + 60, t1: now + 60 }),
        "BadAuctionWindow",
      );
      await expectError(
        place({ cash: 0n, start: 2n, end: 1n, t0: now, t1: now + 60 }),
        "ZeroCash",
      );
    });

    it("fills at the start count before the auction opens, and pays the filler the cash", async () => {
      const before = await snapshot(buyer.publicKey);
      const fillerBefore = await balance(fillerCash);
      const escrow = escrowFor(startOrder.order, cashMint);
      const rent = (await lamports(startOrder.order)) + (await lamports(escrow));
      const buyerLamports = await lamports(buyer.publicKey);

      const sig = await fill(startOrder.order);
      const ev = await eventOf(sig, "OrderFilled");
      const meta = (
        await provider.connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })
      )!.meta!;
      console.log(`        fill_order (3 components, creator fee): ${meta.computeUnitsConsumed} CU`);
      assert.isBelow(Number(meta.computeUnitsConsumed), 400_000);

      await assertDelivered(before, buyer.publicKey, START.s);
      assert.equal(ev.shares.toString(), START.s.toString());
      assert.equal(ev.cash.toString(), START.cash.toString());
      assert.equal(
        ev.price.toString(),
        ((START.cash * BigInt(ONE_SHARE)) / START.s).toString(),
        "price is cash per whole share",
      );
      assert.equal(((await balance(fillerCash)) - fillerBefore).toString(), START.cash.toString());
      assert.isTrue(await gone(startOrder.order), "order closed");
      assert.isTrue(await gone(escrow), "escrow closed");
      assert.equal(
        ((await lamports(buyer.publicKey)) - buyerLamports).toString(),
        rent.toString(),
        "both rents go back to the buyer",
      );
    });

    it("fills mid-auction at exactly the linearly decayed count", async () => {
      const now = await chainNow();
      const o = { s: 3_000_000n, e: 1_000_000n, t0: now - 60, t1: now + 60 };
      const { order } = await place({ cash: 400n * USDC, start: o.s, end: o.e, t0: o.t0, t1: o.t1 });
      const before = await snapshot(buyer.publicKey);

      const sig = await fill(order);
      const ev = await eventOf(sig, "OrderFilled");
      const t = Number(ev.filledAt);
      const expected = requiredAt(o, t);

      assert.isAbove(t, o.t0);
      assert.isBelow(t, o.t1);
      assert.isTrue(expected < o.s && expected > o.e, "strictly inside the band");
      assert.equal(ev.shares.toString(), expected.toString(), "share count follows the line");
      await assertDelivered(before, buyer.publicKey, expected);

      // The timestamp in the event is the chain's clock for that slot.
      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      assert.isAtMost(Math.abs((tx!.blockTime ?? t) - t), 2);
    });

    it("fills at the floor count at the very end of the auction", async () => {
      // The local validator's clock cannot be warped, so aim a fill at the
      // auction's last second and retry if it lands one second late (which
      // the program must, and does, reject as expired).
      let filled: { sig: string; t1: number; order: PublicKey } | null = null;
      for (let attempt = 0; attempt < 10 && !filled; attempt++) {
        const now = await chainNow();
        const t1 = now + 2;
        const { order } = await place({ cash: 100n * USDC, start: 900_000n, end: 300_000n, t0: now - 30, t1 });
        await waitUntil(t1);
        try {
          filled = { sig: await fill(order), t1, order };
        } catch (err: any) {
          assert.include(`${err}`, "OrderExpired");
          await cancel(order, { by: stranger });
        }
      }
      assert.isNotNull(filled, "landed a fill on the closing second");
      const ev = await eventOf(filled!.sig, "OrderFilled");
      assert.equal(Number(ev.filledAt), filled!.t1);
      assert.equal(ev.shares.toString(), "300000", "the buyer's floor, exactly");
    });

    let expiredOrder: PublicKey;

    it("rejects a fill once the auction has ended", async () => {
      const now = await chainNow();
      const { order } = await place({ cash: 50n * USDC, start: 500_000n, end: 400_000n, t0: now - 10, t1: now + 3 });
      expiredOrder = order;
      await waitUntil(now + 4);
      await expectError(fill(order), "OrderExpired");
    });

    it("refuses a stranger's cancel before the auction ends", async () => {
      const now = await chainNow();
      const { order } = await place({ cash: 75n * USDC, start: 500_000n, end: 400_000n, t0: now, t1: now + 600 });
      await expectError(cancel(order, { by: stranger }), "OrderNotExpired");
      assert.isFalse(await gone(order));
    });

    it("lets the buyer cancel at any time, refunding every unit and the rent", async () => {
      const now = await chainNow();
      const { order } = await place({ cash: 80n * USDC, start: 500_000n, end: 400_000n, t0: now, t1: now + 600 });
      const escrow = escrowFor(order, cashMint);
      const cashBefore = await balance(buyerCash);
      const sig = await cancel(order);
      assert.equal(((await balance(buyerCash)) - cashBefore).toString(), (80n * USDC).toString());
      assert.isTrue((await gone(order)) && (await gone(escrow)));
      const ev = await eventOf(sig, "OrderCancelled");
      assert.isFalse(ev.expired);
      assert.equal(ev.by.toBase58(), buyer.publicKey.toBase58());
    });

    it("lets anyone cancel an expired order, but only ever refunds the buyer", async () => {
      await expectError(
        cancel(expiredOrder, { by: stranger, refundTo: strangerCash }),
        "ConstraintTokenOwner",
      );
      const cashBefore = await balance(buyerCash);
      const rent =
        (await lamports(expiredOrder)) + (await lamports(escrowFor(expiredOrder, cashMint)));
      const buyerLamports = await lamports(buyer.publicKey);
      const sig = await cancel(expiredOrder, { by: stranger });
      assert.equal(((await balance(buyerCash)) - cashBefore).toString(), (50n * USDC).toString());
      assert.equal(((await lamports(buyer.publicKey)) - buyerLamports).toString(), rent.toString());
      assert.equal((await balance(strangerCash)).toString(), "0");
      const ev = await eventOf(sig, "OrderCancelled");
      assert.isTrue(ev.expired);
      assert.equal(ev.by.toBase58(), stranger.publicKey.toBase58());
    });

    describe("fills that must fail", () => {
      let order: PublicKey;
      before(async () => {
        const now = await chainNow();
        ({ order } = await place({ cash: 60n * USDC, start: 700_000n, end: 600_000n, t0: now, t1: now + 600 }));
      });

      it("rejects a short deposit", async () => {
        const poor = Keypair.generate();
        await airdrop(poor.publicKey);
        const atas = [];
        for (const mint of components) atas.push(await fundHolder(mint, poor.publicKey, 1n));
        await expectError(fill(order, { by: poor, remaining: fillerRemaining(atas) }), "insufficient funds");
      });

      it("rejects a vault that is not the basket's own", async () => {
        const impostor = await fundHolder(components[0], filler.publicKey, 0n);
        const remaining = fillerRemaining();
        remaining[2] = { pubkey: impostor, isSigner: false, isWritable: true };
        await expectError(fill(order, { remaining }), "VaultMismatch");
      });

      it("rejects a fill that leaves a component out", async () => {
        await expectError(fill(order, { remaining: fillerRemaining().slice(0, 6) }), "AccountCountMismatch");
      });

      it("rejects sending the shares anywhere but the buyer's own share account", async () => {
        await expectError(fill(order, { buyerShareAccount: fillerShareAta }), "ConstraintAssociated", "ConstraintTokenOwner");
      });

      it("leaves the order and its cash intact after every rejection", async () => {
        assert.equal((await balance(escrowFor(order, cashMint))).toString(), (60n * USDC).toString());
        await cancel(order);
      });
    });

    it("refuses to pay a creator fee to anyone but the creator", async () => {
      await expectError(
        program.methods
          .mintShares(new anchor.BN(ONE_SHARE))
          .accountsPartial({
            basket,
            shareMint,
            depositor: filler.publicKey,
            depositorShareAccount: fillerShareAta,
            creatorShareAccount: fillerShareAta,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(fillerRemaining())
          .signers([filler])
          .rpc(),
        "CreatorShareAccountOwner",
      );
    });

    it("settles Token-2022 cash with a transfer fee, and still closes the escrow", async () => {
      const FEE = 25n; // bps
      const fee = (x: bigint) => ceilDiv(x * FEE, 10_000n);
      const mint22 = await createCashMint(TOKEN_2022_PROGRAM_ID, Number(FEE));
      const from = await fundToken(mint22, buyer.publicKey, 1_000n * USDC, TOKEN_2022_PROGRAM_ID);
      const to = await fundToken(mint22, filler.publicKey, 0n, TOKEN_2022_PROGRAM_ID);
      const now = await chainNow();
      const sent = 200n * USDC;
      const { order } = await place({
        cash: sent,
        start: 800_000n,
        end: 800_000n - 1n,
        t0: now + 300,
        t1: now + 600,
        from,
        mint: mint22,
        cashProgram: TOKEN_2022_PROGRAM_ID,
      });
      const escrowed = sent - fee(sent);
      const o = await program.account.order.fetch(order);
      assert.equal(o.cashAmount.toString(), escrowed.toString(), "records what escrow really received");

      const sig = await fill(order, { mint: mint22, cashProgram: TOKEN_2022_PROGRAM_ID, to });
      const ev = await eventOf(sig, "OrderFilled");
      assert.equal(ev.cash.toString(), escrowed.toString());
      assert.equal(
        (await balance(to, TOKEN_2022_PROGRAM_ID)).toString(),
        (escrowed - fee(escrowed)).toString(),
        "the filler nets the escrow less the outgoing fee",
      );
      assert.isTrue(await gone(escrowFor(order, mint22, TOKEN_2022_PROGRAM_ID)), "withheld fee harvested, escrow closed");
    });

    // -------------------------------------------------------------- plans

    describe("plans", () => {
      const saver = Keypair.generate();
      const cranker = Keypair.generate();
      let saverCash: PublicKey;
      let plan: PublicKey;
      const PLAN = {
        id: 1,
        cash: 100n * USDC,
        period: 4,
        runs: 2,
        ref: 4_000_000n, // 0.004 raw shares per raw cash unit: $250 a share
        band: 300n,
        auction: 120,
      };
      const bounds = (cash: bigint, ref: bigint) => ({
        s: (cash * ref * (10_000n + PLAN.band)) / (1_000_000_000n * 10_000n),
        e: (cash * ref * (10_000n - PLAN.band)) / (1_000_000_000n * 10_000n),
      });
      let order1: PublicKey;
      let order2: PublicKey;

      async function openPlan(
        planId: number,
        args: Partial<typeof PLAN> = {},
        who = saver,
        cashAccount = () => saverCash,
        mint = () => cashMint,
        cashProgram = TOKEN_PROGRAM_ID,
      ) {
        const p = { ...PLAN, ...args };
        return program.methods
          .openPlan(bn(planId), bn(p.cash), bn(p.period), p.runs, bn(p.ref), Number(p.band), bn(p.auction))
          .accountsPartial({
            owner: who.publicKey,
            basket,
            plan: planPda(who.publicKey, planId),
            cashMint: mint(),
            ownerCashAccount: cashAccount(),
            cashTokenProgram: cashProgram,
            systemProgram: SystemProgram.programId,
          })
          .signers([who])
          .rpc();
      }

      async function runPlan(
        p: PublicKey,
        nonce: number,
        cashAccount = () => saverCash,
        mint = () => cashMint,
        cashProgram = TOKEN_PROGRAM_ID,
        owner = saver.publicKey,
      ) {
        const order = orderPda(owner, nonce);
        const sig = await program.methods
          .runPlan(bn(nonce))
          .accountsPartial({
            cranker: cranker.publicKey,
            plan: p,
            order,
            cashMint: mint(),
            ownerCashAccount: cashAccount(),
            escrow: escrowFor(order, mint(), cashProgram),
            cashTokenProgram: cashProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([cranker])
          .rpc();
        return { order, sig };
      }

      async function closePlan(p: PublicKey, by = saver, cashAccount = () => saverCash, cashProgram = TOKEN_PROGRAM_ID) {
        return program.methods
          .closePlan()
          .accountsPartial({
            owner: by.publicKey,
            plan: p,
            ownerCashAccount: cashAccount(),
            cashTokenProgram: cashProgram,
          })
          .signers([by])
          .rpc();
      }

      before(async () => {
        await airdrop(saver.publicKey);
        await airdrop(cranker.publicKey);
        saverCash = await fundToken(cashMint, saver.publicKey, 1_000n * USDC, TOKEN_PROGRAM_ID);
        await fundToken(shareMint, saver.publicKey, 0n, TOKEN_2022_PROGRAM_ID);
        plan = planPda(saver.publicKey, PLAN.id);
      });

      it("rejects a band wider than 50% and a schedule with nothing in it", async () => {
        await expectError(openPlan(90, { band: 5_001n }), "BandTooWide");
        await expectError(openPlan(91, { runs: 0 }), "BadPlanSchedule");
        await expectError(openPlan(92, { ref: 0n }), "BadReferenceRate");
        await expectError(openPlan(93, { cash: 1n, ref: 1n }), "PlanAmountTooSmall");
      });

      it("opens a plan and delegates exactly cash × runs to it in the same instruction", async () => {
        const sig = await openPlan(PLAN.id);
        const acct = await getAccount(provider.connection, saverCash, "processed", TOKEN_PROGRAM_ID);
        assert.equal(acct.delegate?.toBase58(), plan.toBase58(), "the plan PDA is the delegate");
        assert.equal(acct.delegatedAmount.toString(), (PLAN.cash * BigInt(PLAN.runs)).toString());
        assert.equal(acct.amount.toString(), (1_000n * USDC).toString(), "nothing moved yet");

        const p = await program.account.plan.fetch(plan);
        assert.equal(p.runsLeft, PLAN.runs);
        assert.equal(p.refSharesPerCashE9.toString(), PLAN.ref.toString());
        assert.equal(p.cashAccount.toBase58(), saverCash.toBase58());
        assert.isNull(p.lastOrder);
        const ev = await eventOf(sig, "PlanOpened");
        assert.equal(ev.allowance.toString(), (PLAN.cash * 2n).toString());
      });

      it("will not override another live allowance on the same account", async () => {
        await expectError(openPlan(2), "DelegateInUse");
      });

      it("runs into a desk order bracketing the reference rate, pulled through the delegate", async () => {
        const before = await program.account.plan.fetch(plan);
        const { order, sig } = await runPlan(plan, 1001);
        order1 = order;
        const o = await program.account.order.fetch(order);
        const b = bounds(PLAN.cash, PLAN.ref);
        assert.equal(b.s, 412_000n);
        assert.equal(b.e, 388_000n);
        assert.equal(o.startShares.toString(), b.s.toString());
        assert.equal(o.endShares.toString(), b.e.toString());
        assert.equal(o.endTs.toNumber() - o.startTs.toNumber(), PLAN.auction);
        assert.equal(o.plan!.toBase58(), plan.toBase58());
        assert.equal(o.buyer.toBase58(), saver.publicKey.toBase58());
        assert.equal(o.rentPayer.toBase58(), cranker.publicKey.toBase58(), "the cranker fronts the rent");
        assert.equal(o.cashAmount.toString(), PLAN.cash.toString());

        const acct = await getAccount(provider.connection, saverCash, "processed", TOKEN_PROGRAM_ID);
        assert.equal(acct.amount.toString(), (900n * USDC).toString());
        assert.equal(acct.delegatedAmount.toString(), PLAN.cash.toString(), "allowance down by one run");

        const p = await program.account.plan.fetch(plan);
        assert.equal(p.runsLeft, 1);
        assert.equal(p.lastOrder!.toBase58(), order.toBase58());
        assert.equal(p.nextRunTs.toNumber(), before.nextRunTs.toNumber() + PLAN.period);
        const ev = await eventOf(sig, "PlanRun");
        assert.equal(ev.run, 1);
      });

      it("refuses to run again before the period has elapsed", async () => {
        await expectError(runPlan(plan, 1002), "PlanTooEarly");
      });

      it("insists on the order's own plan account when filling a plan order", async () => {
        await expectError(fill(order1, { owner: saver.publicKey, rentPayer: cranker.publicKey }), "MissingPlanAccount");
        await expectError(
          fill(order1, { owner: saver.publicKey, rentPayer: cranker.publicKey, plan: basket }),
          "PlanMismatch",
        );
        await expectError(
          fill(order1, { owner: saver.publicKey, plan }),
          "OrderAccountMismatch",
        );
      });

      it("fills, and the plan's reference rate moves to the rate it filled at", async () => {
        const before = await snapshot(saver.publicKey);
        const rent = (await lamports(order1)) + (await lamports(escrowFor(order1, cashMint)));
        const crankerLamports = await lamports(cranker.publicKey);
        const o = await program.account.order.fetch(order1);

        const sig = await fill(order1, { owner: saver.publicKey, rentPayer: cranker.publicKey, plan });
        const ev = await eventOf(sig, "OrderFilled");
        const shares = BigInt(ev.shares.toString());
        assert.equal(
          shares.toString(),
          requiredAt(
            { s: BigInt(o.startShares.toString()), e: BigInt(o.endShares.toString()), t0: o.startTs.toNumber(), t1: o.endTs.toNumber() },
            Number(ev.filledAt),
          ).toString(),
        );
        await assertDelivered(before, saver.publicKey, shares);

        const rate = (shares * 1_000_000_000n) / PLAN.cash;
        const p = await program.account.plan.fetch(plan);
        assert.equal(p.refSharesPerCashE9.toString(), rate.toString(), "reference follows the fill");
        assert.equal(ev.planRefSharesPerCashE9.toString(), rate.toString());
        assert.equal(p.fills, 1);
        assert.equal(
          ((await lamports(cranker.publicKey)) - crankerLamports).toString(),
          rent.toString(),
          "the cranker gets the rent it fronted back",
        );
      });

      it("runs again after the period, at the updated reference, using up the allowance", async () => {
        const p0 = await program.account.plan.fetch(plan);
        await waitUntil(p0.nextRunTs.toNumber());
        const { order } = await runPlan(plan, 1002);
        order2 = order;
        const o = await program.account.order.fetch(order);
        const b = bounds(PLAN.cash, BigInt(p0.refSharesPerCashE9.toString()));
        assert.equal(o.startShares.toString(), b.s.toString());
        assert.equal(o.endShares.toString(), b.e.toString());

        const acct = await getAccount(provider.connection, saverCash, "processed", TOKEN_PROGRAM_ID);
        assert.equal(acct.amount.toString(), (800n * USDC).toString());
        assert.equal(acct.delegatedAmount.toString(), "0");
        assert.isNull(acct.delegate, "the token program clears a spent delegate");
        assert.equal((await program.account.plan.fetch(plan)).runsLeft, 0);
      });

      it("refuses to run an exhausted plan", async () => {
        const p = await program.account.plan.fetch(plan);
        await waitUntil(p.nextRunTs.toNumber());
        await expectError(runPlan(plan, 1003), "PlanExhausted");
      });

      it("lets only the owner close the plan", async () => {
        await expectError(closePlan(plan, stranger), "PlanAccountMismatch");
        const sig = await closePlan(plan);
        assert.isTrue(await gone(plan));
        const ev = await eventOf(sig, "PlanClosed");
        assert.equal(ev.runsDone, 2);
        assert.isFalse(ev.revoked, "nothing left to revoke");
      });

      it("still fills an order a closed plan left open, without resurrecting the plan", async () => {
        const sig = await fill(order2, { owner: saver.publicKey, rentPayer: cranker.publicKey, plan });
        const ev = await eventOf(sig, "OrderFilled");
        assert.isNull(ev.planRefSharesPerCashE9);
        assert.isTrue(await gone(plan));
      });

      it("revokes the unspent allowance on close (Token-2022 cash with a transfer fee)", async () => {
        const FEE = 10n;
        const fee = (x: bigint) => ceilDiv(x * FEE, 10_000n);
        const mint22 = await createCashMint(TOKEN_2022_PROGRAM_ID, Number(FEE));
        const cash22 = await fundToken(mint22, saver.publicKey, 500n * USDC, TOKEN_2022_PROGRAM_ID);
        const id = 7;
        const p22 = planPda(saver.publicKey, id);
        const per = 50n * USDC;
        await openPlan(id, { cash: per, runs: 3 }, saver, () => cash22, () => mint22, TOKEN_2022_PROGRAM_ID);
        const { order } = await runPlan(p22, 2001, () => cash22, () => mint22, TOKEN_2022_PROGRAM_ID);

        const received = per - fee(per);
        const o = await program.account.order.fetch(order);
        assert.equal(o.cashAmount.toString(), received.toString());
        const b = bounds(received, PLAN.ref);
        assert.equal(o.startShares.toString(), b.s.toString(), "bounds come from cash actually escrowed");
        assert.equal(o.endShares.toString(), b.e.toString());

        let acct = await getAccount(provider.connection, cash22, "processed", TOKEN_2022_PROGRAM_ID);
        assert.equal(acct.delegatedAmount.toString(), (per * 2n).toString());

        const sig = await closePlan(p22, saver, () => cash22, TOKEN_2022_PROGRAM_ID);
        assert.isTrue((await eventOf(sig, "PlanClosed")).revoked);
        acct = await getAccount(provider.connection, cash22, "processed", TOKEN_2022_PROGRAM_ID);
        assert.isNull(acct.delegate);
        assert.equal(acct.delegatedAmount.toString(), "0");
        await expectError(runPlan(p22, 2002, () => cash22, () => mint22, TOKEN_2022_PROGRAM_ID), "AccountNotInitialized");

        // The owner can still pull the one open order back.
        const balBefore = acct.amount;
        await cancel(order, { by: saver, owner: saver.publicKey, refundTo: cash22, rentPayer: cranker.publicKey, mint: mint22, cashProgram: TOKEN_2022_PROGRAM_ID });
        assert.equal(
          ((await balance(cash22, TOKEN_2022_PROGRAM_ID)) - balBefore).toString(),
          (received - fee(received)).toString(),
        );
      });
    });
  });
});
