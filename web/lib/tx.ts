"use client";

import sheafIdl from "./sheaf-idl.json";

/**
 * Transaction builders.
 *
 * Three flows, and each one wants to be a single transaction: a visitor who has to
 * approve three prompts to create one basket will abandon halfway. But Solana caps
 * a transaction at 1,232 bytes and every account it touches costs 32 of them, so an
 * eight-component basket does not fit — creating one came to 1,260 bytes. Each flow
 * is therefore described as an ordered list of groups, and `packSteps` puts as many
 * groups into each transaction as will actually fit. Small baskets still take one
 * signature; the largest take two.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  AuthorityType,
  createInitializeMint2Instruction,
  createInitializeMetadataPointerInstruction,
  createSetAuthorityInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import {
  PROGRAM_ID,
  basketAddress,
  createBasketInstruction,
  mintSharesInstruction,
  redeemSharesInstruction,
  tokenAccount,
  type Basket,
  type ComponentArg,
} from "./sheaf";
import { SHARE_DECIMALS } from "./config";
import { confirmSignature } from "./confirm";

export { PROGRAM_ID };

// ------------------------------------------------------------------ packing

/** What a validator will accept in one packet, signatures and all. */
const PACKET_LIMIT = 1232;

/** One wallet approval. */
export type TxStep = {
  /** Names what this transaction does, for the progress line while it is signed. */
  label: string;
  transaction: Transaction;
  /** Keypairs beyond the wallet that have to sign. */
  signers: Keypair[];
};

/** An indivisible piece of a flow. Groups keep their order. */
type Group = {
  label: string;
  instructions: TransactionInstruction[];
  signers?: Keypair[];
};

/**
 * Measure a transaction the way the network will.
 *
 * Size does not depend on the value of the blockhash, only its presence, so a
 * placeholder is enough to compile — and it has to be a throwaway transaction,
 * because a real one must reach the wallet adapter with no blockhash set so the
 * adapter fills in a fresh one.
 *
 * The message is measured rather than serialised, because `serialize` throws on
 * anything over the limit and the whole point here is to ask how big it is. A
 * signature is 64 bytes and their count is a one-byte prefix at these numbers.
 */
function sizeOf(instructions: TransactionInstruction[], feePayer: PublicKey): number {
  const probe = new Transaction();
  probe.add(...instructions);
  probe.feePayer = feePayer;
  probe.recentBlockhash = PublicKey.default.toBase58();
  const message = probe.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}

/**
 * Fill transactions with as many groups as fit, in order.
 *
 * Greedy rather than optimal on purpose: the groups are already ordered by
 * dependency, so the first transaction has to hold a prefix of them.
 */
function packSteps(groups: Group[], feePayer: PublicKey): TxStep[] {
  const steps: TxStep[] = [];

  for (const group of groups) {
    if (group.instructions.length === 0) continue;

    const open = steps[steps.length - 1];
    if (
      open &&
      sizeOf([...open.transaction.instructions, ...group.instructions], feePayer) <=
        PACKET_LIMIT
    ) {
      open.transaction.add(...group.instructions);
      open.signers.push(...(group.signers ?? []));
      open.label = `${open.label}, then ${group.label}`;
      continue;
    }

    const transaction = new Transaction().add(...group.instructions);
    if (sizeOf(group.instructions, feePayer) > PACKET_LIMIT) {
      // No amount of splitting helps here: one indivisible group is too big.
      throw new Error(
        `${group.label} needs ${sizeOf(group.instructions, feePayer)} bytes and a Solana transaction holds ${PACKET_LIMIT}. Use fewer components.`,
      );
    }
    steps.push({
      label: group.label,
      transaction,
      signers: [...(group.signers ?? [])],
    });
  }

  return steps;
}

/** Which of these accounts do not exist yet. */
async function missing(
  connection: Connection,
  keys: PublicKey[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const infos = await connection.getMultipleAccountsInfo(keys);
  const absent = new Set<string>();
  infos.forEach((info, i) => {
    if (!info) absent.add(keys[i].toBase58());
  });
  return absent;
}

type SendFn = (
  transaction: Transaction,
  connection: Connection,
  options?: { signers?: Keypair[] },
) => Promise<string>;

/**
 * Sign and confirm the steps in order.
 *
 * Each step depends on the accounts the one before it created, so every signature
 * is confirmed before the next is asked for. Returns the signatures in order; the
 * last one is the one worth linking to.
 */
export async function sendSteps(
  steps: TxStep[],
  connection: Connection,
  send: SendFn,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<string[]> {
  const signatures: string[] = [];
  for (const [index, step] of steps.entries()) {
    onProgress?.(index, steps.length, step.label);
    const signature = await send(step.transaction, connection, {
      signers: step.signers,
    });
    await confirmSignature(connection, signature);
    signatures.push(signature);
  }
  onProgress?.(steps.length, steps.length, "done");
  return signatures;
}

/**
 * Everything needed to bring a basket into existence.
 *
 * The order is forced by who is allowed to sign what. Token-2022 will only accept
 * a metadata initialisation signed by the mint authority, and a program-derived
 * address cannot sign a transaction a wallet sends. So the creator holds the mint
 * authority long enough to write the metadata, then hands it to the basket — the
 * two happen in that order in the same group, so there is never a confirmed state
 * in which the mint is both named and mintable by a person.
 */
export async function buildCreateBasket(params: {
  connection: Connection;
  creator: PublicKey;
  name: string;
  symbol: string;
  creatorFeeBps: number;
  components: ComponentArg[];
  /** Metadata URI for the share token. */
  uri?: string;
}): Promise<{
  steps: TxStep[];
  shareMint: Keypair;
  basket: PublicKey;
}> {
  const shareMint = Keypair.generate();
  const basket = basketAddress(params.creator, params.symbol);

  const metadata: TokenMetadata = {
    mint: shareMint.publicKey,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri ?? "",
    additionalMetadata: [],
  };

  const mintSpace = getMintLen([ExtensionType.MetadataPointer]);
  // The metadata lives in the mint account as a TLV entry, which Token-2022
  // reallocs into. Fund the account for the final size now, or the realloc fails.
  const TLV_HEADER = 4;
  const lamports = await params.connection.getMinimumBalanceForRentExemption(
    mintSpace + TLV_HEADER + pack(metadata).length,
  );

  const token: Group = {
    label: "the share token",
    signers: [shareMint],
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: params.creator,
        newAccountPubkey: shareMint.publicKey,
        space: mintSpace,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMetadataPointerInstruction(
        shareMint.publicKey,
        params.creator,
        shareMint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        shareMint.publicKey,
        SHARE_DECIMALS,
        params.creator,
        // No freeze authority, ever. The program refuses a freezable share mint,
        // because a basket nobody can redeem is not a basket.
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: shareMint.publicKey,
        updateAuthority: params.creator,
        mint: shareMint.publicKey,
        mintAuthority: params.creator,
        name: metadata.name,
        symbol: metadata.symbol,
        uri: metadata.uri,
      }),
      createSetAuthorityInstruction(
        shareMint.publicKey,
        params.creator,
        AuthorityType.MintTokens,
        basket,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
  };

  const recipe: Group = {
    label: "the recipe",
    instructions: [
      createBasketInstruction({
        creator: params.creator,
        shareMint: shareMint.publicKey,
        name: params.name,
        symbol: params.symbol,
        creatorFeeBps: params.creatorFeeBps,
        components: params.components,
      }),
    ],
  };

  return {
    steps: packSteps([token, recipe], params.creator),
    shareMint,
    basket,
  };
}

/**
 * Mint shares, creating any token account the transfer needs on the way.
 *
 * The program insists every vault is the basket's own canonical associated token
 * account and will not create one itself, which keeps its account handling
 * simple and its surface small. Creating them is the caller's job, so it happens
 * here: the first person to mint pays for the vaults and everyone after them pays
 * nothing. The accounts that already exist are dropped rather than created
 * idempotently, because every one left in costs bytes a big basket cannot spare.
 */
export async function buildMintShares(params: {
  connection: Connection;
  basket: Basket;
  depositor: PublicKey;
  shares: bigint;
}): Promise<TxStep[]> {
  const basketKey = new PublicKey(params.basket.address);
  const shareMint = new PublicKey(params.basket.shareMint);
  const creator = new PublicKey(params.basket.creator);
  const componentProgram = new PublicKey(params.basket.tokenProgram);

  const wanted: {
    address: PublicKey;
    owner: PublicKey;
    mint: PublicKey;
    program: PublicKey;
  }[] = [
    {
      address: getAssociatedTokenAddressSync(
        shareMint,
        params.depositor,
        true,
        TOKEN_2022_PROGRAM_ID,
      ),
      owner: params.depositor,
      mint: shareMint,
      program: TOKEN_2022_PROGRAM_ID,
    },
    {
      address: getAssociatedTokenAddressSync(
        shareMint,
        creator,
        true,
        TOKEN_2022_PROGRAM_ID,
      ),
      owner: creator,
      mint: shareMint,
      program: TOKEN_2022_PROGRAM_ID,
    },
    ...params.basket.components.map((component) => {
      const mint = new PublicKey(component.mint);
      return {
        address: tokenAccount(mint, basketKey, componentProgram),
        owner: basketKey,
        mint,
        program: componentProgram,
      };
    }),
  ];

  const absent = await missing(
    params.connection,
    wanted.map((account) => account.address),
  );

  const accounts: Group = {
    label: "the accounts it needs",
    instructions: wanted
      .filter((account) => absent.has(account.address.toBase58()))
      .map((account) =>
        createAssociatedTokenAccountIdempotentInstruction(
          params.depositor,
          account.address,
          account.owner,
          account.mint,
          account.program,
        ),
      ),
  };

  const deposit: Group = {
    label: "the deposit",
    instructions: [
      mintSharesInstruction({
        basket: basketKey,
        shareMint,
        depositor: params.depositor,
        creator,
        components: params.basket.components.map((c) => ({
          mint: new PublicKey(c.mint),
        })),
        shares: params.shares,
        componentTokenProgram: componentProgram,
      }),
    ],
  };

  return packSteps([accounts, deposit], params.depositor);
}

/** Redeem shares back into their components. */
export async function buildRedeemShares(params: {
  connection: Connection;
  basket: Basket;
  owner: PublicKey;
  shares: bigint;
}): Promise<TxStep[]> {
  const basketKey = new PublicKey(params.basket.address);
  const shareMint = new PublicKey(params.basket.shareMint);
  const componentProgram = new PublicKey(params.basket.tokenProgram);

  const wanted = params.basket.components.map((component) => {
    const mint = new PublicKey(component.mint);
    return { mint, address: tokenAccount(mint, params.owner, componentProgram) };
  });

  const absent = await missing(
    params.connection,
    wanted.map((account) => account.address),
  );

  const accounts: Group = {
    label: "the accounts to receive into",
    instructions: wanted
      .filter((account) => absent.has(account.address.toBase58()))
      .map((account) =>
        createAssociatedTokenAccountIdempotentInstruction(
          params.owner,
          account.address,
          params.owner,
          account.mint,
          componentProgram,
        ),
      ),
  };

  const redemption: Group = {
    label: "the redemption",
    instructions: [
      redeemSharesInstruction({
        basket: basketKey,
        shareMint,
        owner: params.owner,
        components: params.basket.components.map((c) => ({
          mint: new PublicKey(c.mint),
        })),
        shares: params.shares,
        componentTokenProgram: componentProgram,
      }),
    ],
  };

  return packSteps([accounts, redemption], params.owner);
}

/** Turn a program error code into the sentence the program itself wrote. */
export const SHEAF_ERRORS: Record<number, string> = {
  6000: "The name has to be between 1 and 32 characters.",
  6001: "The symbol has to be between 1 and 10 characters.",
  6002: "The creator fee cannot be more than 1%.",
  6003: "A basket needs between 1 and 8 components.",
  6004: "The weights have to add up to exactly 100%.",
  6005: "The same ticker appears twice.",
  6006: "One component has a weight of zero.",
  6007: "One component works out to zero units per share.",
  6008: "The share mint has the wrong number of decimals.",
  6009: "That share mint has already issued shares.",
  6010: "The share mint's authority is not this basket.",
  6011: "The share mint can be frozen, so it cannot be used.",
  6012: "That is not this basket's share mint.",
  6013: "Wrong token program for these mints.",
  6014: "A component account does not match the recipe.",
  6015: "The wrong number of accounts was supplied.",
  6016: "A vault account is not the basket's own.",
  6017: "A token account belongs to a different mint.",
  6018: "A mint account could not be read.",
  6019: "A token account could not be read.",
  6020: "The creator's share account is missing.",
  6021: "Zero shares.",
  6022: "That is too few shares to move any component at all.",
  6023: "The arithmetic overflowed.",
};

/** Anchor's own account errors, which a stale page meets when someone else got there first. */
const ACCOUNT_NOT_INITIALIZED = 3012; // 0xbc4

/**
 * A readable sentence for whatever a wallet or the chain threw back.
 *
 * Pass `action: "cancel"` when the transaction was returning an order's dollars:
 * then an order account that no longer exists means the dollars are already back.
 */
export function explainError(error: unknown, context?: { action?: "cancel" }): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  if (/User rejected|rejected the request|declined/i.test(raw)) {
    return "You cancelled the transaction.";
  }

  // The RPC itself refused or rate-limited a call, e.g. `403 : {"jsonrpc":"2.0",…}`.
  if (/\b(403|429)\b\s*:?\s*\{|"code"\s*:\s*(403|429)\b|Method not allowed|Too many requests|rate limit/i.test(raw)) {
    return "The site's connection refused a call. Try again in a moment.";
  }

  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(raw);
  // confirmSignature reports a landed failure as `{"InstructionError":[0,{"Custom":3012}]}`.
  const anchorCode = /Error Number: (\d+)/.exec(raw) ?? /"Custom"\s*:\s*(\d+)/.exec(raw);
  const code = custom ? parseInt(custom[1], 16) : anchorCode ? Number(anchorCode[1]) : null;
  if (code === ACCOUNT_NOT_INITIALIZED || /AccountNotInitialized/.test(raw)) {
    return context?.action === "cancel"
      ? "Already returned."
      : "That account no longer exists. Someone may have closed it already; reload to see where things stand.";
  }
  if (code != null) {
    if (SHEAF_ERRORS[code]) return SHEAF_ERRORS[code];
    // Every other program error carries its own message in the IDL.
    const fromIdl = (sheafIdl.errors as { code: number; msg?: string }[]).find((e) => e.code === code)?.msg;
    if (fromIdl) return `${fromIdl}.`;
  }
  for (const [code, message] of Object.entries(SHEAF_ERRORS)) {
    if (new RegExp(`\\b${code}\\b`).test(raw)) return message;
  }

  if (/no record of a prior credit|blockhash not found/i.test(raw)) {
    return "Your wallet looks to be on a different network. Switch it to devnet, where Sheaf settles, and try again.";
  }
  if (/insufficient lamports|insufficient funds/i.test(raw)) {
    return "Not enough SOL in the wallet to pay for this transaction.";
  }
  if (/0x1\b/.test(raw)) {
    return "Not enough of one of the component tokens. Claim test tokens and try again.";
  }
  if (/block height exceeded/i.test(raw)) {
    return "The transaction expired before it was signed. Try again.";
  }
  if (/failed to fetch|fetch failed|network ?error|ECONNRESET|timed? ?out/i.test(raw)) {
    return "The connection dropped before the network answered. Try again in a moment.";
  }
  if (/\b5\d\d\b\s*:?\s*\{|Internal error|Service unavailable/i.test(raw)) {
    return "The site's connection had a hiccup. Try again in a moment.";
  }
  // Never show a raw RPC body: keep only the sentence in front of any JSON.
  const first = raw.split("\n")[0].replace(/\s*[:\-]?\s*[{[].*$/s, "").trim();
  if (!first || /^\d+$/.test(first) || first.length > 200) return "The transaction failed. Try again in a moment.";
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
