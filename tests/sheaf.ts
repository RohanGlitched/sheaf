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
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AccountState,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createThawAccountInstruction,
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
  createInitializeAccount3Instruction,
  getTransferFeeAmount,
  ACCOUNT_SIZE,
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
  /** PROTOCOL_FEE_BPS: every basket created by this program carries it. */
  const PROTOCOL_BPS = 10;
  const TREASURY = new PublicKey("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");

  /** (creator, protocol) fee shares on `shares` created, as fee_split computes them. */
  function feeSplit(shares: bigint, creatorBps = FEE_BPS, protocolBps = PROTOCOL_BPS): [bigint, bigint] {
    const total = (shares * BigInt(creatorBps + protocolBps)) / 10_000n;
    const protocol = (shares * BigInt(protocolBps)) / 10_000n;
    return [total - protocol, protocol];
  }

  /** Protocol-fee shares a basket has accrued and not yet minted. */
  const accruedOf = async (b: PublicKey) =>
    BigInt((await program.account.basket.fetch(b, "processed")).protocolFeeAccrued.toString());

  /** What the vault must back: every share in circulation plus the accrued protocol fee. */
  const owedShares = async (b: PublicKey, mint: PublicKey) =>
    (await getMint(provider.connection, mint, "processed", TOKEN_2022_PROGRAM_ID)).supply + (await accruedOf(b));

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
    assert.equal(account.protocolFeeBps, PROTOCOL_BPS, "the protocol fee is written in at creation");
    assert.equal(account.protocolFeeAccrued.toString(), "0");
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

    // 2.5 shares: 0.30% creator (7,500) and 0.10% protocol (2,500).
    const [fee, protocol] = feeSplit(BigInt(shares.toString()));
    assert.equal(fee.toString(), "7500");
    assert.equal(protocol.toString(), "2500");
    assert.equal(
      (await rawBalance(holderShareAta)).toString(),
      (BigInt(shares.toString()) - fee - protocol).toString(),
      "holder shares are net of both fees",
    );
    assert.equal(
      (await rawBalance(creatorShareAta)).toString(),
      fee.toString(),
      "creator receives the fee in shares",
    );
    assert.equal((await accruedOf(basket)).toString(), protocol.toString(), "the protocol's share is accrued, not minted");
  });

  it("keeps the vault fully backing every outstanding share", async () => {
    const mintInfo = await getMint(
      provider.connection,
      shareMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const outstanding = mintInfo.supply + (await accruedOf(basket));
    for (let i = 0; i < components.length; i++) {
      const held = await rawBalance(vaultFor(basket, components[i]));
      const owed =
        (BigInt(unitsPerShare[i].toString()) * outstanding) /
        BigInt(ONE_SHARE);
      assert.isTrue(
        held >= owed,
        `component ${i}: vault holds ${held}, shares and accrued fee claim ${owed}`,
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
      // No fee-config authority: a component's fee may be set only by its
      // issuer (or nobody), never by the basket creator.
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        null,
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
      const supply = await owedShares(basket, shareMint);
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
    const outstanding = mintInfo.supply + (await accruedOf(basket));
    for (let i = 0; i < components.length; i++) {
      const held = await rawBalance(vaultFor(basket, components[i]));
      const owed =
        (BigInt(unitsPerShare[i].toString()) * outstanding) /
        BigInt(ONE_SHARE);
      assert.isTrue(held >= owed, `component ${i} still covered`);
    }
  });

  // ------------------------------------------------------------ protocol fee

  describe("protocol fee", () => {
    const treasuryShares = () =>
      getAssociatedTokenAddressSync(shareMint, TREASURY, true, TOKEN_2022_PROGRAM_ID);
    const claim = (to = treasuryShares(), treasury = TREASURY, b = basket, mint = shareMint) =>
      program.methods
        .claimProtocolFee()
        .accountsPartial({
          basket: b,
          shareMint: mint,
          treasury,
          treasuryShareAccount: to,
          shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    const expectFail = async (p: Promise<unknown>, code: string) => {
      try {
        await p;
      } catch (err: any) {
        assert.include(`${err}\n${(err.logs ?? []).join("\n")}`, code);
        return;
      }
      assert.fail(`expected ${code}`);
    };

    it("takes nothing below 1,000 raw share units, and accrues exactly 0.10% above", async () => {
      const mintOf = (shares: bigint) =>
        program.methods
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
      for (const shares of [999n, 1_000n, 1_234_567n]) {
        const [fee, protocol] = feeSplit(shares);
        const before = { accrued: await accruedOf(basket), holder: await rawBalance(holderShareAta), creator: await rawBalance(creatorShareAta) };
        await mintOf(shares);
        assert.equal(((await accruedOf(basket)) - before.accrued).toString(), protocol.toString(), `accrued on ${shares}`);
        assert.equal(((await rawBalance(holderShareAta)) - before.holder).toString(), (shares - fee - protocol).toString());
        assert.equal(((await rawBalance(creatorShareAta)) - before.creator).toString(), fee.toString());
      }
      assert.deepEqual(feeSplit(999n).map(String), ["3", "0"], "0.999 of a raw unit floors to nothing for the protocol");
      assert.deepEqual(feeSplit(1_234_567n).map(String), ["3704", "1234"], "one rounding for the pair: the creator keeps the slack (its own floor is 3,703)");
    });

    it("mints the accrued fee to the treasury's share account, once, and stays fully backed", async () => {
      const accrued = await accruedOf(basket);
      assert.isTrue(accrued > 0n);
      const supplyBefore = (await getMint(provider.connection, shareMint, "processed", TOKEN_2022_PROGRAM_ID)).supply;
      const owedBefore = await owedShares(basket, shareMint);

      // Only the treasury's own associated account can receive it.
      await expectFail(claim(creatorShareAta), "account: treasury_share_account");
      await expectFail(claim(getAssociatedTokenAddressSync(shareMint, holder.publicKey, true, TOKEN_2022_PROGRAM_ID), holder.publicKey), "TreasuryMismatch");

      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasuryShares(), TREASURY, shareMint, TOKEN_2022_PROGRAM_ID),
        ),
        [payer],
      );
      // Permissionless: the payer here is neither creator, holder nor treasury.
      await claim();
      assert.equal((await rawBalance(treasuryShares())).toString(), accrued.toString());
      assert.equal((await accruedOf(basket)).toString(), "0");
      const supplyAfter = (await getMint(provider.connection, shareMint, "processed", TOKEN_2022_PROGRAM_ID)).supply;
      assert.equal((supplyAfter - supplyBefore).toString(), accrued.toString(), "supply grew by exactly the accrued fee");
      assert.equal((await owedShares(basket, shareMint)).toString(), owedBefore.toString(), "what the vault must back is unchanged");
      for (let i = 0; i < components.length; i++) {
        const held = await rawBalance(vaultFor(basket, components[i]));
        assert.isTrue(held >= (BigInt(unitsPerShare[i].toString()) * supplyAfter) / BigInt(ONE_SHARE), `component ${i} backs the claimed fee`);
      }
      await expectFail(claim(), "NothingToClaim");
    });
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
          // No fee-config authority: nobody can raise the fee on an open
          // order (a cash mint whose fee someone could change is refused).
          createInitializeTransferFeeConfigInstruction(
            mint.publicKey,
            null,
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
    const planOrderPda = (plan: PublicKey, nonce: number) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("plan_order"), plan.toBuffer(), u64le(nonce)],
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
      const net_of = (x: bigint) => x - feeSplit(x)[0] - feeSplit(x)[1];
      while (net_of(g) < net) g++;
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
        accrued: await accruedOf(basket),
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
      const [fee, protocol] = feeSplit(gross);
      assert.equal((after.creator - before.creator).toString(), fee.toString(), "creator fee shares");
      assert.equal((after.accrued - before.accrued).toString(), protocol.toString(), "protocol fee accrued");
      assert.equal(
        fee + protocol,
        gross - received,
        "the fees are exactly mint_shares' fees on the gross delivered",
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
      // A side account the stranger opened in the buyer's name is the buyer's,
      // but not where any client looks: a third party's refund must use the ATA.
      const side = Keypair.generate();
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: stranger.publicKey,
            newAccountPubkey: side.publicKey,
            space: ACCOUNT_SIZE,
            lamports: await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeAccount3Instruction(side.publicKey, cashMint, buyer.publicKey, TOKEN_PROGRAM_ID),
        ),
        [stranger, side],
      );
      await expectError(
        cancel(expiredOrder, { by: stranger, refundTo: side.publicKey }),
        "RefundNotToBuyerAta",
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

    // ---------------------------------------------------------- sell desk

    describe("sell orders", () => {
      const sellPda = (seller: PublicKey, nonce: number) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from("sell"), basket.toBuffer(), seller.toBuffer(), u64le(nonce)],
          program.programId,
        )[0];
      const shareEscrow = (order: PublicKey) =>
        getAssociatedTokenAddressSync(shareMint, order, true, TOKEN_2022_PROGRAM_ID);
      const holderCash = () => getAssociatedTokenAddressSync(cashMint, holder.publicKey, true, TOKEN_PROGRAM_ID);
      let sellNonce = 9_000;

      async function placeSell(o: { shares: bigint; start: bigint; end: bigint; t0: number; t1: number; nonce?: number }) {
        const nonce = o.nonce ?? sellNonce++;
        const order = sellPda(holder.publicKey, nonce);
        const sig = await program.methods
          .placeSellOrder(bn(nonce), bn(o.shares), bn(o.start), bn(o.end), bn(o.t0), bn(o.t1))
          .accountsPartial({
            seller: holder.publicKey,
            basket,
            sellOrder: order,
            shareMint,
            sellerShareAccount: holderShareAta,
            escrow: shareEscrow(order),
            cashMint,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            cashTokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([holder])
          .rpc();
        return { order, sig };
      }

      const fillSell = (order: PublicKey, post: TransactionInstruction[] = []) =>
        program.methods
          .fillSellOrder()
          .accountsPartial({
            filler: filler.publicKey,
            sellOrder: order,
            basket,
            shareMint,
            escrow: shareEscrow(order),
            fillerShareAccount: fillerShareAta,
            seller: holder.publicKey,
            sellerCashAccount: holderCash(),
            cashMint,
            fillerCashAccount: fillerCash,
            rentPayer: holder.publicKey,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            cashTokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([CU])
          .postInstructions(post)
          .signers([filler])
          .rpc();

      const cancelSell = (order: PublicKey, by: Keypair, to = holderShareAta) =>
        program.methods
          .cancelSellOrder()
          .accountsPartial({
            caller: by.publicKey,
            sellOrder: order,
            basket,
            shareMint,
            escrow: shareEscrow(order),
            seller: holder.publicKey,
            sellerShareAccount: to,
            rentPayer: holder.publicKey,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([by])
          .rpc();

      it("escrows exactly the shares offered", async () => {
        const now = await chainNow();
        const before = await rawBalance(holderShareAta);
        const { order } = await placeSell({ shares: 300_000n, start: 40n * USDC, end: 30n * USDC, t0: now, t1: now + 600 });
        assert.equal((before - (await rawBalance(holderShareAta))).toString(), "300000");
        assert.equal((await rawBalance(shareEscrow(order))).toString(), "300000");
        const o = await program.account.sellOrder.fetch(order);
        assert.equal(o.shares.toString(), "300000");
        assert.equal(o.endCash.toString(), (30n * USDC).toString(), "the seller's floor");
        await cancelSell(order, holder);
      });

      it("refuses a rising or floorless sell auction, and an empty one", async () => {
        const now = await chainNow();
        await expectError(placeSell({ shares: 1n, start: 1n, end: 2n, t0: now, t1: now + 60 }), "BadAuctionShares");
        await expectError(placeSell({ shares: 1n, start: 1n, end: 0n, t0: now, t1: now + 60 }), "BadAuctionShares");
        await expectError(placeSell({ shares: 0n, start: 2n, end: 1n, t0: now, t1: now + 60 }), "ZeroShares");
      });

      it("pays the seller exactly the auction's cash into a cash account the filler opens, and the filler can redeem in kind in the same transaction", async () => {
        const now = await chainNow();
        const shares = 500_000n;
        const o = { s: 60n * USDC, e: 50n * USDC, t0: now - 5, t1: now + 600 };
        const { order } = await placeSell({ shares, start: o.s, end: o.e, t0: o.t0, t1: o.t1 });
        assert.isTrue(await gone(holderCash()), "the seller has no cash account yet");

        const fillerCashBefore = await balance(fillerCash);
        const fillerComponents = await Promise.all(fillerComponentAtas.map((a) => rawBalance(a)));
        const fillerSharesBefore = await rawBalance(fillerShareAta);
        const holderLamports = await lamports(holder.publicKey);
        const rent = (await lamports(order)) + (await lamports(shareEscrow(order)));
        // Redeem what the fill hands over, in the same transaction.
        const redeem = await program.methods
          .redeemShares(bn(shares))
          .accountsPartial({
            basket,
            shareMint,
            owner: filler.publicKey,
            ownerShareAccount: fillerShareAta,
            shareTokenProgram: TOKEN_2022_PROGRAM_ID,
            componentTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(
            components.flatMap((mint, i) => [
              { pubkey: mint, isSigner: false, isWritable: false },
              { pubkey: vaultFor(basket, mint), isSigner: false, isWritable: true },
              { pubkey: fillerComponentAtas[i], isSigner: false, isWritable: true },
            ]),
          )
          .instruction();
        const sig = await fillSell(order, [redeem]);
        const ev = await eventOf(sig, "SellOrderFilled");
        const due = requiredAt(o, Number(ev.filledAt));
        assert.equal(ev.cash.toString(), due.toString(), "the auction's count at the fill");
        assert.isTrue(due < o.s && due > o.e, "between the endpoints");
        assert.equal((await balance(holderCash())).toString(), due.toString(), "the seller nets it");
        assert.equal((fillerCashBefore - (await balance(fillerCash))).toString(), due.toString());
        assert.equal((await rawBalance(fillerShareAta)).toString(), fillerSharesBefore.toString(), "taken and redeemed");
        for (let i = 0; i < components.length; i++) {
          assert.equal(
            ((await rawBalance(fillerComponentAtas[i])) - fillerComponents[i]).toString(),
            ((BigInt(unitsPerShare[i].toString()) * shares) / BigInt(ONE_SHARE)).toString(),
            `component ${i} redeemed`,
          );
        }
        assert.isTrue(await gone(order), "order closed");
        assert.isTrue(await gone(shareEscrow(order)), "escrow closed");
        // The order's and escrow's rent went back to the seller who paid it.
        assert.equal(((await lamports(holder.publicKey)) - holderLamports).toString(), rent.toString());
      });

      it("returns the shares: to the seller at any time, and after expiry to anyone, but only into the seller's own share account", async () => {
        let now = await chainNow();
        const mine = await placeSell({ shares: 1_000n, start: 2n * USDC, end: USDC, t0: now, t1: now + 600 });
        await expectError(cancelSell(mine.order, stranger), "OrderNotExpired");
        const before = await rawBalance(holderShareAta);
        await cancelSell(mine.order, holder);
        assert.equal(((await rawBalance(holderShareAta)) - before).toString(), "1000");

        now = await chainNow();
        const { order } = await placeSell({ shares: 2_000n, start: 2n * USDC, end: USDC, t0: now, t1: now + 2 });
        await waitUntil(now + 3);
        await expectError(fillSell(order), "OrderExpired");
        // A side share account the stranger opens in the seller's name.
        const side = Keypair.generate();
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(
            SystemProgram.createAccount({
              fromPubkey: stranger.publicKey,
              newAccountPubkey: side.publicKey,
              space: ACCOUNT_SIZE,
              lamports: await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
              programId: TOKEN_2022_PROGRAM_ID,
            }),
            createInitializeAccount3Instruction(side.publicKey, shareMint, holder.publicKey, TOKEN_2022_PROGRAM_ID),
          ),
          [stranger, side],
        );
        await expectError(cancelSell(order, stranger, side.publicKey), "RefundNotToSellerAta");
        const back = await rawBalance(holderShareAta);
        const sig = await cancelSell(order, stranger);
        assert.equal(((await rawBalance(holderShareAta)) - back).toString(), "2000");
        const ev = await eventOf(sig, "SellOrderCancelled");
        assert.isTrue(ev.expired);
        assert.isTrue(await gone(order));
      });
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
        min: 2_000_000n, // never accept fewer than 0.002 shares per raw cash unit ($500 a share)
        max: 8_000_000n,
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
          .openPlan(bn(planId), bn(p.cash), bn(p.period), p.runs, bn(p.ref), Number(p.band), bn(p.auction), bn(p.min), bn(p.max))
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
        const order = planOrderPda(p, nonce);
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
        await expectError(openPlan(93, { cash: 1n, ref: 1n, min: 1n, max: 1n }), "PlanAmountTooSmall");
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
        // A plan opened today trails: its bounds move to ±6% of the new reference.
        assert.equal(p.minRefSharesPerCashE9.toString(), ((rate * 9_400n) / 10_000n).toString(), "trailing floor");
        assert.equal(p.maxRefSharesPerCashE9.toString(), ((rate * 10_600n) / 10_000n).toString(), "trailing ceiling");
        const raw = (await provider.connection.getAccountInfo(plan, "processed"))!.data;
        assert.equal(raw.length, 304, "296-byte plan plus its 8-byte tail");
        assert.equal(raw.readUInt16LE(296), 600, "trail_step_bps");
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

      // ========================================================== hardening
      //
      // Negative tests for the hardening release: every mint the program
      // accepts is vetted for extensions that would give someone a lever over
      // other people's value, plans have owner-set rate bounds and can be
      // re-centred, and plan orders live in their own namespace.
      describe("hardening", () => {
        const hodler = Keypair.generate();
        let hodlerCash: PublicKey;

        type Ext = {
          name: string;
          type: ExtensionType;
          init: (mint: PublicKey) => TransactionInstruction;
          freeze?: boolean;
        };
        /**
         * A real issuer in KNOWN_ISSUERS (PreStocks), so these tests pass on
         * the default build as well as the devnet one. Only its public key is
         * needed: these extensions take their authority as a plain key at
         * initialisation.
         */
        const KNOWN_ISSUER = new PublicKey("WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");
        /**
         * The basket creator's own key, as the authority of a power it should
         * not be able to bring in. A fresh key rather than the test wallet:
         * on a devnet build the deploy wallet is itself a stand-in issuer.
         */
        const CREATOR_KEY = Keypair.generate().publicKey;
        /** The issuer powers every real xStock carries, held by `who`. */
        const issuerPowers = (who: PublicKey): Ext[] => [
          {
            name: "PermanentDelegate",
            type: ExtensionType.PermanentDelegate,
            init: (m) => createInitializePermanentDelegateInstruction(m, who, TOKEN_2022_PROGRAM_ID),
          },
          {
            name: "Pausable",
            type: ExtensionType.PausableConfig,
            init: (m) => createInitializePausableConfigInstruction(m, who, TOKEN_2022_PROGRAM_ID),
          },
          {
            name: "TransferHook(no program)",
            type: ExtensionType.TransferHook,
            init: (m) => createInitializeTransferHookInstruction(m, who, PublicKey.default, TOKEN_2022_PROGRAM_ID),
          },
        ];
        const feeUnder = (who: PublicKey | null): Ext => ({
          name: "TransferFeeConfig",
          type: ExtensionType.TransferFeeConfig,
          init: (m) =>
            createInitializeTransferFeeConfigInstruction(m, who, payer.publicKey, 10, 1_000_000n, TOKEN_2022_PROGRAM_ID),
        });
        const EXT: Record<string, Ext> = {
          permanentDelegate: {
            name: "PermanentDelegate",
            type: ExtensionType.PermanentDelegate,
            init: (m) => createInitializePermanentDelegateInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID),
          },
          pausable: {
            name: "Pausable",
            type: ExtensionType.PausableConfig,
            init: (m) => createInitializePausableConfigInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID),
          },
          closeAuthority: {
            name: "MintCloseAuthority",
            type: ExtensionType.MintCloseAuthority,
            init: (m) => createInitializeMintCloseAuthorityInstruction(m, payer.publicKey, TOKEN_2022_PROGRAM_ID),
          },
          transferHook: {
            name: "TransferHook",
            type: ExtensionType.TransferHook,
            // Any program id will do: the point is that one is set.
            init: (m) =>
              createInitializeTransferHookInstruction(m, payer.publicKey, Keypair.generate().publicKey, TOKEN_2022_PROGRAM_ID),
          },
          scaled: {
            name: "ScaledUiAmount",
            type: ExtensionType.ScaledUiAmountConfig,
            init: (m) => createInitializeScaledUiAmountConfigInstruction(m, payer.publicKey, 2, TOKEN_2022_PROGRAM_ID),
          },
          nonTransferable: {
            name: "NonTransferable",
            type: ExtensionType.NonTransferable,
            init: (m) => createInitializeNonTransferableMintInstruction(m, TOKEN_2022_PROGRAM_ID),
          },
          frozenByDefault: {
            name: "DefaultAccountState(Frozen)",
            type: ExtensionType.DefaultAccountState,
            init: (m) => createInitializeDefaultAccountStateInstruction(m, AccountState.Frozen, TOKEN_2022_PROGRAM_ID),
            freeze: true,
          },
          openByDefault: {
            name: "DefaultAccountState(Initialized)",
            type: ExtensionType.DefaultAccountState,
            init: (m) => createInitializeDefaultAccountStateInstruction(m, AccountState.Initialized, TOKEN_2022_PROGRAM_ID),
            freeze: true,
          },
        };

        /**
         * A bare Token-2022 mint carrying exactly the given extensions. Mints
         * whose extensions need a freeze authority get `freezer` (the payer
         * unless told otherwise).
         */
        async function mintWith(exts: Ext[], decimals: number, authority: PublicKey, freezer = payer.publicKey) {
          const mint = Keypair.generate();
          const space = getMintLen(exts.map((e) => e.type));
          const tx = new Transaction().add(
            SystemProgram.createAccount({
              fromPubkey: payer.publicKey,
              newAccountPubkey: mint.publicKey,
              space,
              lamports: await provider.connection.getMinimumBalanceForRentExemption(space),
              programId: TOKEN_2022_PROGRAM_ID,
            }),
            ...exts.map((e) => e.init(mint.publicKey)),
            createInitializeMint2Instruction(
              mint.publicKey,
              decimals,
              authority,
              exts.some((e) => e.freeze) ? freezer : null,
              TOKEN_2022_PROGRAM_ID,
            ),
          );
          await sendAndConfirmTransaction(provider.connection, tx, [payer, mint]);
          return mint.publicKey;
        }

        async function createBasketWith(
          symbol: string,
          share: PublicKey,
          componentMints: PublicKey[],
          componentProgram = TOKEN_2022_PROGRAM_ID,
        ) {
          const weights = componentMints.map((_, i) =>
            i === 0 ? 10_000 - 1_000 * (componentMints.length - 1) : 1_000,
          );
          return program.methods
            .createBasket(
              `Hardening ${symbol}`,
              symbol,
              0,
              componentMints.map((mint, i) => ({ mint, unitsPerShare: bn(1_000_000), weightBps: weights[i] })),
            )
            .accountsPartial({
              creator: payer.publicKey,
              basket: basketPda(payer.publicKey, symbol),
              shareMint: share,
              componentTokenProgram: componentProgram,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(componentMints.map((m) => ({ pubkey: m, isSigner: false, isWritable: false })))
            .rpc();
        }

        /** A Token-2022 cash mint with `exts`, and a funded, usable account for `owner`. */
        async function hostileCash(exts: Ext[], owner: PublicKey) {
          const mint = await mintWith(exts, CASH_DECIMALS, payer.publicKey);
          const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
          const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID),
          );
          if (exts.some((e) => e.freeze)) {
            tx.add(createThawAccountInstruction(ata, mint, payer.publicKey, [], TOKEN_2022_PROGRAM_ID));
          }
          tx.add(createMintToInstruction(mint, ata, payer.publicKey, 1_000n * USDC, [], TOKEN_2022_PROGRAM_ID));
          await sendAndConfirmTransaction(provider.connection, tx, [payer]);
          return { mint, ata };
        }

        before(async () => {
          await airdrop(hodler.publicKey);
          hodlerCash = await fundToken(cashMint, hodler.publicKey, 1_000n * USDC, TOKEN_PROGRAM_ID);
          await fundToken(shareMint, hodler.publicKey, 0n, TOKEN_2022_PROGRAM_ID);
        });

        // ---------------------------------------------------- share mints (H1)

        it("refuses a share mint carrying any extension beyond metadata", async () => {
          const banned = [
            EXT.permanentDelegate,
            EXT.pausable,
            EXT.closeAuthority,
            EXT.transferHook,
            EXT.scaled,
            EXT.nonTransferable,
          ];
          for (let i = 0; i < banned.length; i++) {
            const symbol = `SX${i}`;
            const share = await mintWith([banned[i]], 6, basketPda(payer.publicKey, symbol));
            await expectError(createBasketWith(symbol, share, [components[0]]), "ShareMintExtension");
          }
        });

        it("refuses a share mint that is not a mint of a token program", async () => {
          // A token account is owned by the token program and long enough to
          // look like a mint; it must still be refused.
          await expectError(
            createBasketWith("SXTA", holderComponentAtas[0], [components[0]]),
            "MalformedMint",
          );
          await expectError(
            createBasketWith("SXSYS", Keypair.generate().publicKey, [components[0]]),
            "ShareMintProgram",
          );
        });

        it("refuses a legacy SPL Token share mint: shares are always Token-2022", async () => {
          const symbol = "SXSPL";
          const mint = Keypair.generate();
          await sendAndConfirmTransaction(
            provider.connection,
            new Transaction().add(
              SystemProgram.createAccount({
                fromPubkey: payer.publicKey,
                newAccountPubkey: mint.publicKey,
                space: MINT_SIZE,
                lamports: await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE),
                programId: TOKEN_PROGRAM_ID,
              }),
              createInitializeMint2Instruction(mint.publicKey, 6, basketPda(payer.publicKey, symbol), null, TOKEN_PROGRAM_ID),
            ),
            [payer, mint],
          );
          await expectError(createBasketWith(symbol, mint.publicKey, [components[0]]), "ShareMintNotToken2022");
        });

        // ------------------------------------------------ component mints (M8)

        it("refuses component mints that could drain, pause or brick the vault", async () => {
          // One valid share mint, reused: a refused create_basket consumes nothing.
          const symbol = "CXT";
          const share = await mintWith([], 6, basketPda(payer.publicKey, symbol));
          // Never acceptable, whoever holds them.
          for (const bad of [EXT.frozenByDefault, EXT.transferHook, EXT.nonTransferable, EXT.closeAuthority]) {
            const mint = await mintWith([bad], 8, payer.publicKey);
            await expectError(
              createBasketWith(symbol, share, [components[0], mint]),
              "ComponentMintExtension",
            );
          }
          // Issuer powers held by the basket creator (or anyone but a known
          // stock issuer): a permanent delegate, a pause switch, a hook
          // authority that could later set a hook program, a transfer-fee
          // authority that could raise the fee, a freeze authority.
          for (const power of [...issuerPowers(CREATOR_KEY), feeUnder(CREATOR_KEY)]) {
            const mint = await mintWith([power], 8, payer.publicKey);
            await expectError(
              createBasketWith(symbol, share, [components[0], mint]),
              "ComponentIssuerAuthority",
            );
          }
          const creatorFreezes = await mintWith([EXT.openByDefault], 8, payer.publicKey, CREATOR_KEY);
          await expectError(
            createBasketWith(symbol, share, [components[0], creatorFreezes]),
            "ComponentIssuerAuthority",
          );
          // A token account posing as a component mint.
          await expectError(
            createBasketWith(symbol, share, [components[0], holderComponentAtas[1]]),
            "MalformedMint",
          );
          // What xStocks and PreStocks carry (metadata, ScaledUiAmount,
          // TransferFee, an "initialised" default state) is fine, and so are
          // the issuer powers when a known issuer holds every one of them.
          const issued = await mintWith(
            [...issuerPowers(KNOWN_ISSUER), EXT.openByDefault],
            8,
            payer.publicKey,
            KNOWN_ISSUER,
          );
          await createBasketWith(symbol, share, [components[0], components[2], issued]);
        });

        // ----------------------------------------------------- cash mints (H2)

        it("refuses cash a third party could seize, freeze or block, at place_order", async () => {
          const now = await chainNow();
          for (const bad of [EXT.permanentDelegate, EXT.pausable, EXT.frozenByDefault, EXT.transferHook]) {
            const { mint, ata } = await hostileCash([bad], hodler.publicKey);
            await expectError(
              place({
                who: hodler,
                from: ata,
                mint,
                cashProgram: TOKEN_2022_PROGRAM_ID,
                cash: 10n * USDC,
                start: 50_000n,
                end: 40_000n,
                t0: now,
                t1: now + 600,
              }),
              "CashMintExtension",
            );
          }
        });

        it("refuses cash whose transfer fee or hook someone other than a known issuer could change", async () => {
          const now = await chainNow();
          const order = (mint: PublicKey, ata: PublicKey) =>
            place({
              who: hodler,
              from: ata,
              mint,
              cashProgram: TOKEN_2022_PROGRAM_ID,
              cash: 10n * USDC,
              start: 50_000n,
              end: 40_000n,
              t0: now,
              t1: now + 600,
            });
          // A fee authority could raise the fee to 100% after the order is
          // placed and take the filler's payout; a hook authority could set a
          // hook program and brick the order.
          for (const bad of [feeUnder(CREATOR_KEY), issuerPowers(CREATOR_KEY)[2]]) {
            const { mint, ata } = await hostileCash([bad], hodler.publicKey);
            await expectError(order(mint, ata), "CashMintAuthority");
            await expectError(
              openPlan(510, {}, hodler, () => ata, () => mint, TOKEN_2022_PROGRAM_ID),
              "CashMintAuthority",
            );
          }
          // Nobody, or a known issuer, holding those powers is fine.
          for (const ok of [feeUnder(null), feeUnder(KNOWN_ISSUER), issuerPowers(KNOWN_ISSUER)[2]]) {
            const { mint, ata } = await hostileCash([ok], hodler.publicKey);
            const placed = await order(mint, ata);
            await cancel(placed.order, {
              by: hodler,
              owner: hodler.publicKey,
              refundTo: ata,
              mint,
              cashProgram: TOKEN_2022_PROGRAM_ID,
            });
          }
        });

        it("refuses the same cash mints at open_plan", async () => {
          for (const bad of [EXT.permanentDelegate, EXT.pausable, EXT.frozenByDefault]) {
            const { mint, ata } = await hostileCash([bad], hodler.publicKey);
            await expectError(
              openPlan(500, {}, hodler, () => ata, () => mint, TOKEN_2022_PROGRAM_ID),
              "CashMintExtension",
            );
          }
        });

        // --------------------------------------------------- window bounds (H3)

        it("refuses orders and plan auctions that close more than 30 days out", async () => {
          const now = await chainNow();
          const DAY = 24 * 60 * 60;
          await expectError(
            place({ who: hodler, from: hodlerCash, cash: USDC, start: 2n, end: 1n, t0: now, t1: now + 31 * DAY }),
            "BadAuctionWindow",
          );
          await expectError(openPlan(501, { auction: 31 * DAY }, hodler, () => hodlerCash), "BadPlanSchedule");
        });

        // ----------------------------------------------- plan rate bounds (M1)

        it("requires 0 < min <= reference <= max", async () => {
          const who = hodler;
          const acct = () => hodlerCash;
          await expectError(openPlan(502, { min: 0n }, who, acct), "BadReferenceBounds");
          await expectError(openPlan(503, { min: PLAN.ref + 1n }, who, acct), "BadReferenceBounds");
          await expectError(openPlan(504, { max: PLAN.ref - 1n }, who, acct), "BadReferenceBounds");
        });

        it("never lets a run's auction end below the owner's floor, nor a fill push the reference past the ceiling", async () => {
          // A ±30% band would end the auction at 280,000 shares per 100 USDC;
          // the owner's floor of 0.0036 lifts it to 360,000. The ceiling is
          // the reference itself, so a fill at a richer rate cannot raise it.
          const id = 60;
          const p = planPda(hodler.publicKey, id);
          await openPlan(id, { band: 3_000n, min: 3_600_000n, max: PLAN.ref }, hodler, () => hodlerCash);
          const { order } = await runPlan(p, 6001, () => hodlerCash);
          const o = await program.account.order.fetch(order);
          assert.equal(o.endShares.toString(), "360000", "the floor, not the band");
          assert.equal(o.startShares.toString(), "520000");

          const sig = await fill(order, { owner: hodler.publicKey, rentPayer: cranker.publicKey, plan: p });
          const ev = await eventOf(sig, "OrderFilled");
          const filledRate = (BigInt(ev.shares.toString()) * 1_000_000_000n) / PLAN.cash;
          assert.isTrue(filledRate > PLAN.ref, "filled richer than the reference");
          const after = await program.account.plan.fetch(p);
          assert.equal(after.refSharesPerCashE9.toString(), PLAN.ref.toString(), "clamped to the ceiling");
          assert.equal(ev.planRefSharesPerCashE9.toString(), PLAN.ref.toString());
          await closePlan(p, hodler, () => hodlerCash);
        });

        // ------------------------------------------------- update_plan (M2)

        it("lets only the owner re-centre a plan, under open_plan's rules, and the next run follows", async () => {
          const id = 61;
          const p = planPda(hodler.publicKey, id);
          await openPlan(id, {}, hodler, () => hodlerCash);
          const update = (by: Keypair, ref: bigint, band: number, auction: number, min: bigint, max: bigint) =>
            program.methods
              .updatePlan(bn(ref), band, bn(auction), bn(min), bn(max))
              .accountsPartial({ owner: by.publicKey, plan: p })
              .signers([by])
              .rpc();

          await expectError(update(stranger, 5_000_000n, 1_000, 60, 4_500_000n, 6_000_000n), "PlanAccountMismatch");
          await expectError(update(hodler, 5_000_000n, 1_000, 60, 5_500_000n, 6_000_000n), "BadReferenceBounds");
          await expectError(update(hodler, 5_000_000n, 6_000, 60, 4_500_000n, 6_000_000n), "BandTooWide");

          const sig = await update(hodler, 5_000_000n, 1_000, 60, 4_500_000n, 6_000_000n);
          const ev = await eventOf(sig, "PlanUpdated");
          assert.equal(ev.refSharesPerCashE9.toString(), "5000000");
          const after = await program.account.plan.fetch(p);
          assert.equal(after.refSharesPerCashE9.toString(), "5000000");
          assert.equal(after.bandBps, 1_000);
          assert.equal(after.auctionSecs.toNumber(), 60);
          assert.equal(after.minRefSharesPerCashE9.toString(), "4500000");
          assert.equal(after.maxRefSharesPerCashE9.toString(), "6000000");
          assert.equal(after.runsLeft, PLAN.runs, "schedule untouched");

          // The next run uses the new terms: 100 USDC × 0.005 ± 10%.
          // Plan orders and the owner's own orders no longer share nonces.
          const { order } = await runPlan(p, 4242, () => hodlerCash);
          const o = await program.account.order.fetch(order);
          assert.equal(o.startShares.toString(), "550000");
          assert.equal(o.endShares.toString(), "450000");
          assert.equal(o.endTs.toNumber() - o.startTs.toNumber(), 60);
          const now = await chainNow();
          const mine = await place({
            who: hodler,
            from: hodlerCash,
            nonce: 4242,
            cash: USDC,
            start: 2n,
            end: 1n,
            t0: now,
            t1: now + 600,
          });
          assert.notEqual(mine.order.toBase58(), order.toBase58(), "same nonce, separate namespaces");
          assert.equal(order.toBase58(), planOrderPda(p, 4242).toBase58());

          // Tidy up: the owner can cancel both.
          const refund = { by: hodler, owner: hodler.publicKey, refundTo: hodlerCash };
          await cancel(order, { ...refund, rentPayer: cranker.publicKey });
          await cancel(mine.order, refund);
          await closePlan(p, hodler, () => hodlerCash);
        });

        it("does not let an order placed before a re-centre undo it when it fills", async () => {
          const id = 64;
          const p = planPda(hodler.publicKey, id);
          await openPlan(id, {}, hodler, () => hodlerCash);
          const { order } = await runPlan(p, 6401, () => hodlerCash);
          const placedAt = (await program.account.order.fetch(order)).createdAt.toNumber();
          await waitUntil(placedAt + 1);
          await program.methods
            .updatePlan(bn(5_000_000n), 1_000, bn(60), bn(4_500_000n), bn(6_000_000n))
            .accountsPartial({ owner: hodler.publicKey, plan: p })
            .signers([hodler])
            .rpc();
          const updated = await program.account.plan.fetch(p);
          assert.isAbove(updated.createdAt.toNumber(), placedAt, "the update starts a new terms epoch");

          const sig = await fill(order, { owner: hodler.publicKey, rentPayer: cranker.publicKey, plan: p });
          const ev = await eventOf(sig, "OrderFilled");
          assert.isNull(ev.planRefSharesPerCashE9, "the pre-update order did not move the reference");
          const after = await program.account.plan.fetch(p);
          assert.equal(after.refSharesPerCashE9.toString(), "5000000", "the owner's re-centre stands");
          assert.equal(after.fills, 0);
          await closePlan(p, hodler, () => hodlerCash);
        });

        // ---------------------------------------------- stale plan orders (L1)

        it("does not let an order from a closed plan steer the plan reopened under the same id", async () => {
          const id = 62;
          const p = planPda(hodler.publicKey, id);
          await openPlan(id, {}, hodler, () => hodlerCash);
          const { order } = await runPlan(p, 6201, () => hodlerCash);
          const placedAt = (await program.account.order.fetch(order)).createdAt.toNumber();
          await closePlan(p, hodler, () => hodlerCash);
          await waitUntil(placedAt + 1);
          await openPlan(id, {}, hodler, () => hodlerCash);

          const sig = await fill(order, { owner: hodler.publicKey, rentPayer: cranker.publicKey, plan: p });
          const ev = await eventOf(sig, "OrderFilled");
          assert.isNull(ev.planRefSharesPerCashE9, "the stale order did not touch the new plan");
          const reopened = await program.account.plan.fetch(p);
          assert.equal(reopened.refSharesPerCashE9.toString(), PLAN.ref.toString());
          assert.equal(reopened.fills, 0);
          await closePlan(p, hodler, () => hodlerCash);
        });

        it("refuses close_legacy_plan on a current-layout plan", async () => {
          const id = 63;
          const p = planPda(hodler.publicKey, id);
          await openPlan(id, {}, hodler, () => hodlerCash);
          await expectError(
            program.methods
              .closeLegacyPlan()
              .accountsPartial({
                owner: hodler.publicKey,
                plan: p,
                ownerCashAccount: hodlerCash,
                cashTokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([hodler])
              .rpc(),
            "NotLegacyPlan",
          );
          await closePlan(p, hodler, () => hodlerCash);
        });
      });
    });
  });
});
