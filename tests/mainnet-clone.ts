/**
 * Sheaf against the real thing: TSLAx, NVDAx (Backed xStocks) and Anduril
 * (a PreStocks token), cloned from mainnet.
 *
 * How the clones are made (tests/fixtures/build.mjs, loaded through
 * [[test.validator.account]] in Anchor.toml): each mint account is read from
 * mainnet and written into the test validator byte for byte, with one change.
 * The mint authority is rewritten to a throwaway localnet key
 * (tests/fixtures/mint-authority.json), because a plain clone gives you the
 * mint but no way to hold any of it. Every extension stays exactly as the
 * issuer set it on mainnet, with the issuer's own authorities:
 *
 *   xStocks    PermanentDelegate, PausableConfig, ConfidentialTransferMint,
 *              TransferHook (no program), DefaultAccountState(initialized),
 *              ScaledUiAmountConfig, MetadataPointer, TokenMetadata, and a
 *              freeze authority
 *   PreStocks  all of the above, plus TransferFeeConfig and
 *              ConfidentialTransferFeeConfig
 *
 * So this is the code path a real basket of real stocks takes: create_basket
 * vets the issuer powers against KNOWN_ISSUERS, the token program creates
 * vault and holder accounts sized for those extensions, mint_shares deposits
 * them (grossing up the PreStock's live transfer fee), and redeem_shares hands
 * them back.
 *
 * The same fixture key also owns two program-state fixtures no instruction can
 * produce any more: a 280-byte pre-hardening plan (close_legacy_plan) and an
 * open order whose escrow holds less than it records (EscrowShort).
 */
import * as anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AccountState,
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtensionData,
  getExtensionTypes,
  getMint,
  getMintLen,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { assert } from "chai";
import type { Sheaf } from "../target/types/sheaf";

const ONE_SHARE = 1_000_000n;

/** ConfidentialTransferFeeConfig, which this spl-token's enum does not name. */
const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16 as ExtensionType;

const REAL = {
  TSLAx: new PublicKey("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
  NVDAx: new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
  ANDURIL: new PublicKey("PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB"),
};
const BACKED_ISSUER = new PublicKey("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq");
const BACKED_PAUSER = new PublicKey("JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs");
const PRESTOCKS_ISSUER = new PublicKey("WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc");

// Must match tests/fixtures/build.mjs.
const SYMBOL = "XSTK";
const LEGACY_PLAN = new PublicKey("GqH2ndNzTMG4BifGTeHAPTgQw5AGJRyFrr6zZHeWJaLV");
const SHORT_ORDER = new PublicKey("8bt3HAKTjXFFbxbqHmQdFBKZePT9StUafAGycFdygjgQ");

describe("real xStocks and PreStocks (mainnet clones)", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const program = anchor.workspace.sheaf as anchor.Program<Sheaf>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  /** The throwaway key the fixtures' mint authority was rewritten to. */
  const me = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/mint-authority.json"), "utf8")),
    ),
  );

  const T22 = TOKEN_2022_PROGRAM_ID;
  const components = [REAL.TSLAx, REAL.NVDAx, REAL.ANDURIL];
  // 0.04 TSLAx, 0.03 NVDAx (8 decimals) and 0.02 Anduril (9 decimals) a share.
  const units = [4_000_000n, 3_000_000n, 20_000_000n];
  const weights = [4_000, 4_000, 2_000];

  const basket = PublicKey.findProgramAddressSync(
    [Buffer.from("basket"), me.publicKey.toBuffer(), Buffer.from(SYMBOL)],
    program.programId,
  )[0];
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, T22);
  const raw = async (account: PublicKey) =>
    (await getAccount(connection, account, "processed", T22)).amount;
  const bn = (n: bigint | number) => new anchor.BN(n.toString());
  const send = (ixs: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers]);

  /** The 32-byte authority slot leading an extension's data. */
  async function authorityOf(mint: PublicKey, ext: ExtensionType) {
    const info = await getMint(connection, mint, "processed", T22);
    const data = getExtensionData(ext, info.tlvData);
    assert.isNotNull(data, `${mint.toBase58()} carries extension ${ext}`);
    return new PublicKey(data!.subarray(0, 32));
  }

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (err: any) {
      const text = `${err}\n${(err.logs ?? []).join("\n")}`;
      assert.include(text, code);
      return;
    }
    assert.fail(`expected ${code}`);
  }

  let shareMint: PublicKey;
  const myShares = () => ata(shareMint, me.publicKey);

  before(async () => {
    await connection.confirmTransaction(
      await connection.requestAirdrop(me.publicKey, 10_000_000_000),
      "confirmed",
    );
  });

  it("loads the real mints with every issuer power intact", async () => {
    const xstock = [
      ExtensionType.PermanentDelegate,
      ExtensionType.PausableConfig,
      ExtensionType.ConfidentialTransferMint,
      ExtensionType.TransferHook,
      ExtensionType.DefaultAccountState,
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
    ];
    const prestock = [
      ...xstock,
      ExtensionType.TransferFeeConfig,
      CONFIDENTIAL_TRANSFER_FEE_CONFIG,
    ];
    for (const [mint, want] of [
      [REAL.TSLAx, xstock],
      [REAL.NVDAx, xstock],
      [REAL.ANDURIL, prestock],
    ] as const) {
      const info = await getMint(connection, mint, "processed", T22);
      const have = getExtensionTypes(info.tlvData);
      for (const e of want) assert.include(have, e, `${mint.toBase58()} has extension ${e}`);
      assert.equal(info.mintAuthority!.toBase58(), me.publicKey.toBase58(), "the one rewritten field");
      const hook = getExtensionData(ExtensionType.TransferHook, info.tlvData)!;
      assert.isTrue(hook.subarray(32, 64).every((b) => b === 0), "no hook program");
    }
    for (const mint of [REAL.TSLAx, REAL.NVDAx]) {
      assert.equal((await authorityOf(mint, ExtensionType.PermanentDelegate)).toBase58(), BACKED_ISSUER.toBase58());
      assert.equal((await authorityOf(mint, ExtensionType.PausableConfig)).toBase58(), BACKED_PAUSER.toBase58());
      assert.equal((await authorityOf(mint, ExtensionType.TransferHook)).toBase58(), BACKED_ISSUER.toBase58());
      const info = await getMint(connection, mint, "processed", T22);
      assert.equal(info.freezeAuthority!.toBase58(), BACKED_PAUSER.toBase58());
    }
    for (const ext of [ExtensionType.PermanentDelegate, ExtensionType.PausableConfig, ExtensionType.TransferFeeConfig]) {
      assert.equal((await authorityOf(REAL.ANDURIL, ext)).toBase58(), PRESTOCKS_ISSUER.toBase58());
    }
  });

  it("creates a basket of real TSLAx, NVDAx and Anduril", async () => {
    // A Token-2022 share mint with metadata, handed to the basket PDA.
    const mint = Keypair.generate();
    const space = getMintLen([ExtensionType.MetadataPointer]);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: T22,
        }),
        createInitializeMetadataPointerInstruction(mint.publicKey, me.publicKey, mint.publicKey, T22),
        createInitializeMint2Instruction(mint.publicKey, 6, me.publicKey, null, T22),
        createSetAuthorityInstruction(mint.publicKey, me.publicKey, AuthorityType.MintTokens, basket, [], T22),
      ],
      [mint, me],
    );
    shareMint = mint.publicKey;

    await program.methods
      .createBasket(
        "Real Stocks",
        SYMBOL,
        0,
        components.map((m, i) => ({ mint: m, unitsPerShare: bn(units[i]), weightBps: weights[i] })),
      )
      .accountsPartial({
        creator: me.publicKey,
        basket,
        shareMint,
        componentTokenProgram: T22,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(components.map((m) => ({ pubkey: m, isSigner: false, isWritable: false })))
      .signers([me])
      .rpc();

    const b = await program.account.basket.fetch(basket, "processed");
    assert.equal(b.componentCount, 3);
    assert.deepEqual(
      b.components.slice(0, 3).map((c) => [c.mint.toBase58(), c.decimals]),
      [
        [REAL.TSLAx.toBase58(), 8],
        [REAL.NVDAx.toBase58(), 8],
        [REAL.ANDURIL.toBase58(), 9],
      ],
    );
  });

  it("mints shares against real balances, netting the vault exactly the recipe", async () => {
    // Holder and vault accounts, sized by the token program for every
    // account-side extension these mints imply (transfer-hook, pausable,
    // transfer-fee and immutable-owner state).
    const setup: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, myShares(), me.publicKey, shareMint, T22),
    ];
    for (const m of components) {
      setup.push(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(m, me.publicKey), me.publicKey, m, T22),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(m, basket), basket, m, T22),
        createMintToInstruction(m, ata(m, me.publicKey), me.publicKey, 10n ** 10n, [], T22),
      );
    }
    await send(setup, [me]);

    const before = await Promise.all(components.map((m) => raw(ata(m, me.publicKey))));
    const shares = 2n * ONE_SHARE;
    await program.methods
      .mintShares(bn(shares))
      .accountsPartial({
        basket,
        shareMint,
        depositor: me.publicKey,
        depositorShareAccount: myShares(),
        creatorShareAccount: myShares(),
        shareTokenProgram: T22,
        componentTokenProgram: T22,
      })
      .remainingAccounts(
        components.flatMap((m) => [
          { pubkey: m, isSigner: false, isWritable: false },
          { pubkey: ata(m, me.publicKey), isSigner: false, isWritable: true },
          { pubkey: ata(m, basket), isSigner: false, isWritable: true },
        ]),
      )
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([me])
      .rpc();

    assert.equal((await raw(myShares())).toString(), shares.toString());
    for (let i = 0; i < components.length; i++) {
      const recipe = (units[i] * shares) / ONE_SHARE;
      assert.equal((await raw(ata(components[i], basket))).toString(), recipe.toString(), `vault ${i}`);
      const paid = before[i] - (await raw(ata(components[i], me.publicKey)));
      if (components[i].equals(REAL.ANDURIL)) {
        // The live PreStocks fee schedule (3% at this validator's epoch) is
        // grossed up, so the holder pays more and the vault nets the recipe.
        const fee = getTransferFeeConfig(await getMint(connection, REAL.ANDURIL, "processed", T22))!;
        assert.isAbove(Number(fee.olderTransferFee.transferFeeBasisPoints), 0);
        assert.isTrue(paid > recipe, "the deposit was grossed up for the transfer fee");
      } else {
        assert.equal(paid.toString(), recipe.toString(), `component ${i} paid`);
      }
    }
  });

  it("redeems shares for the real tokens", async () => {
    const before = await Promise.all(components.map((m) => raw(ata(m, me.publicKey))));
    await program.methods
      .redeemShares(bn(ONE_SHARE))
      .accountsPartial({
        basket,
        shareMint,
        owner: me.publicKey,
        ownerShareAccount: myShares(),
        shareTokenProgram: T22,
        componentTokenProgram: T22,
      })
      .remainingAccounts(
        components.flatMap((m) => [
          { pubkey: m, isSigner: false, isWritable: false },
          { pubkey: ata(m, basket), isSigner: false, isWritable: true },
          { pubkey: ata(m, me.publicKey), isSigner: false, isWritable: true },
        ]),
      )
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([me])
      .rpc();

    assert.equal((await raw(myShares())).toString(), ONE_SHARE.toString());
    for (let i = 0; i < components.length; i++) {
      assert.equal((await raw(ata(components[i], basket))).toString(), units[i].toString(), `vault ${i} keeps one share`);
      const got = (await raw(ata(components[i], me.publicKey))) - before[i];
      if (components[i].equals(REAL.ANDURIL)) {
        // Out of the vault goes the recipe; the token program withholds its
        // fee from what arrives, as for any other holder of the token.
        assert.isTrue(got < units[i] && got > 0n, "the redeemer receives the recipe net of the fee");
      } else {
        assert.equal(got.toString(), units[i].toString(), `component ${i} returned`);
      }
    }
  });

  it("refuses a look-alike whose issuer powers belong to the basket creator", async () => {
    // Same extension set as an xStock, but the delegate, pause, hook and
    // confidential-transfer authorities are the creator's own key.
    const creator = me.publicKey;
    const fake = Keypair.generate();
    const exts = [
      ExtensionType.PermanentDelegate,
      ExtensionType.PausableConfig,
      ExtensionType.TransferHook,
      ExtensionType.DefaultAccountState,
    ];
    const space = getMintLen(exts);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: fake.publicKey,
          space,
          lamports: await connection.getMinimumBalanceForRentExemption(space),
          programId: T22,
        }),
        createInitializePermanentDelegateInstruction(fake.publicKey, creator, T22),
        createInitializePausableConfigInstruction(fake.publicKey, creator, T22),
        createInitializeTransferHookInstruction(fake.publicKey, creator, PublicKey.default, T22),
        createInitializeDefaultAccountStateInstruction(fake.publicKey, AccountState.Initialized, T22),
        createInitializeMint2Instruction(fake.publicKey, 8, creator, BACKED_PAUSER, T22),
      ],
      [fake],
    );

    const symbol = "XFAKE";
    const pda = PublicKey.findProgramAddressSync(
      [Buffer.from("basket"), me.publicKey.toBuffer(), Buffer.from(symbol)],
      program.programId,
    )[0];
    const share = Keypair.generate();
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: share.publicKey,
          space: getMintLen([]),
          lamports: await connection.getMinimumBalanceForRentExemption(getMintLen([])),
          programId: T22,
        }),
        createInitializeMint2Instruction(share.publicKey, 6, pda, null, T22),
      ],
      [share],
    );
    await expectError(
      program.methods
        .createBasket("Fake", symbol, 0, [
          { mint: REAL.TSLAx, unitsPerShare: bn(1), weightBps: 5_000 },
          { mint: fake.publicKey, unitsPerShare: bn(1), weightBps: 5_000 },
        ])
        .accountsPartial({
          creator: me.publicKey,
          basket: pda,
          shareMint: share.publicKey,
          componentTokenProgram: T22,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          [REAL.TSLAx, fake.publicKey].map((m) => ({ pubkey: m, isSigner: false, isWritable: false })),
        )
        .signers([me])
        .rpc(),
      "ComponentIssuerAuthority",
    );
  });

  it("refuses to fill an order whose escrow holds less than it records (EscrowShort)", async () => {
    // The fixture order records 1,000,000 raw units of cash (its cash mint is
    // TSLAx, which fill_order does not vet); its escrow exists but is empty,
    // as if a seize power on the cash mint had emptied it after the order was
    // placed. No filler should deliver stocks against cash that is not there.
    const order = await program.account.order.fetch(SHORT_ORDER, "processed");
    assert.equal(order.basket.toBase58(), basket.toBase58());
    assert.equal(order.cashAmount.toString(), "1000000");
    const escrow = ata(REAL.TSLAx, SHORT_ORDER);
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, escrow, SHORT_ORDER, REAL.TSLAx, T22),
    ]);
    assert.equal((await raw(escrow)).toString(), "0");

    await expectError(
      program.methods
        .fillOrder()
        .accountsPartial({
          filler: me.publicKey,
          order: SHORT_ORDER,
          basket,
          shareMint,
          buyer: me.publicKey,
          buyerShareAccount: myShares(),
          creatorShareAccount: null,
          cashMint: REAL.TSLAx,
          escrow,
          fillerCashAccount: ata(REAL.TSLAx, me.publicKey),
          rentPayer: me.publicKey,
          plan: null,
          shareTokenProgram: T22,
          componentTokenProgram: T22,
          cashTokenProgram: T22,
        })
        .remainingAccounts(
          components.flatMap((m) => [
            { pubkey: m, isSigner: false, isWritable: false },
            { pubkey: ata(m, me.publicKey), isSigner: false, isWritable: true },
            { pubkey: ata(m, basket), isSigner: false, isWritable: true },
          ]),
        )
        .signers([me])
        .rpc(),
      "EscrowShort",
    );
    assert.isNotNull(await connection.getAccountInfo(SHORT_ORDER, "processed"), "the order is untouched");
  });

  it("closes a 280-byte pre-hardening plan, revoking its allowance and returning the rent", async () => {
    const cash = ata(REAL.TSLAx, me.publicKey);
    // The legacy plan still holds a live allowance on the owner's account.
    await send([createApproveCheckedInstruction(cash, REAL.TSLAx, LEGACY_PLAN, me.publicKey, 5_000_000n, 8, [], T22)], [me]);
    assert.equal((await getAccount(connection, cash, "processed", T22)).delegate?.toBase58(), LEGACY_PLAN.toBase58());

    const plan = await connection.getAccountInfo(LEGACY_PLAN, "processed");
    assert.equal(plan!.data.length, 280);
    assert.isTrue(plan!.owner.equals(program.programId));
    const ownerBefore = BigInt(await connection.getBalance(me.publicKey, "processed"));

    // A stranger cannot close it.
    const stranger = Keypair.generate();
    await expectError(
      program.methods
        .closeLegacyPlan()
        .accountsPartial({ owner: stranger.publicKey, plan: LEGACY_PLAN, ownerCashAccount: cash, cashTokenProgram: T22 })
        .signers([stranger])
        .rpc(),
      "PlanAccountMismatch",
    );

    await program.methods
      .closeLegacyPlan()
      .accountsPartial({ owner: me.publicKey, plan: LEGACY_PLAN, ownerCashAccount: cash, cashTokenProgram: T22 })
      .signers([me])
      .rpc();

    assert.isNull(await connection.getAccountInfo(LEGACY_PLAN, "processed"), "plan account closed");
    const ownerAfter = BigInt(await connection.getBalance(me.publicKey, "processed"));
    assert.equal((ownerAfter - ownerBefore).toString(), plan!.lamports.toString(), "rent back to the owner");
    const after = await getAccount(connection, cash, "processed", T22);
    assert.isNull(after.delegate, "allowance revoked");
    assert.equal(after.delegatedAmount.toString(), "0");
  });
});
