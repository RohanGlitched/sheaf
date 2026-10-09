"use client";

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Turning a Panta build answer into something a wallet can sign.
 *
 * Panta's create build returns a base64 VersionedTransaction; its buy and claim
 * builds return an instruction list plus a recent blockhash, to be compiled
 * here. The sandbox answers with an empty transaction, no instructions and a
 * placeholder blockhash, so there is nothing real to sign: Sheaf then compiles a
 * memo-only stand-in on a fresh blockhash from the write cluster, says so, and
 * asks the wallet to sign that. Either way the wallet is asked to sign only;
 * Sheaf never sends the transaction anywhere.
 */

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export type PantaIx = {
  programId: string;
  data: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
};

const isBlockhash = (s: string | undefined) => {
  if (!s) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};

export type Compiled = {
  /** Versioned for Panta's own transactions; a legacy message for the stand-in, which every wallet signs. */
  tx: VersionedTransaction | Transaction;
  /** True when Panta returned nothing to sign and this is Sheaf's memo stand-in. */
  standIn: boolean;
  instructions: number;
  blockhashFrom: "panta" | "write cluster";
};

export async function compileForSigning(opts: {
  payer: PublicKey;
  transaction?: string;
  instructions?: PantaIx[];
  recentBlockhash?: string;
  memo: string;
  connection: Connection;
}): Promise<Compiled> {
  if (opts.transaction) {
    const tx = VersionedTransaction.deserialize(Buffer.from(opts.transaction, "base64"));
    return { tx, standIn: false, instructions: tx.message.compiledInstructions.length, blockhashFrom: "panta" };
  }
  const ixs = (opts.instructions ?? []).map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, "base64"),
        keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      }),
  );
  const standIn = ixs.length === 0;
  if (standIn) {
    ixs.push(
      new TransactionInstruction({
        programId: MEMO,
        keys: [{ pubkey: opts.payer, isSigner: true, isWritable: false }],
        data: Buffer.from(opts.memo, "utf8"),
      }),
    );
  }
  const fromPanta = isBlockhash(opts.recentBlockhash);
  const recentBlockhash = fromPanta ? opts.recentBlockhash! : (await opts.connection.getLatestBlockhash("confirmed")).blockhash;
  const blockhashFrom = fromPanta ? ("panta" as const) : ("write cluster" as const);
  if (standIn) {
    const tx = new Transaction({ feePayer: opts.payer, recentBlockhash }).add(...ixs);
    return { tx, standIn, instructions: ixs.length, blockhashFrom };
  }
  const message = new TransactionMessage({ payerKey: opts.payer, recentBlockhash, instructions: ixs }).compileToV0Message();
  return { tx: new VersionedTransaction(message), standIn, instructions: ixs.length, blockhashFrom };
}

/** The fee payer's signature, base58: the transaction id it would have if sent. */
export function signatureOf(tx: VersionedTransaction | Transaction): string {
  const sig = tx instanceof Transaction ? tx.signature : tx.signatures[0];
  if (!sig) throw new Error("The wallet returned the transaction unsigned.");
  return bs58.encode(sig);
}
