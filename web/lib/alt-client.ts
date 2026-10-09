/**
 * Address lookup tables for the biggest baskets.
 *
 * A legacy Solana transaction spends 32 bytes on every account it touches, and
 * one packet holds 1,232 bytes. Measured with the real builders (sheaf.ts and
 * desk.ts), in-kind create and redeem fit at every size up to eight components,
 * though an eight-component first deposit needs a second signature for its
 * account set-up. A filler's fill_order does not fit past six (1,301 bytes at
 * seven, 1,400 at eight). A v0 transaction that reads the basket's accounts from
 * a lookup table pays one byte per account instead, which puts all of these in
 * one transaction.
 *
 * GET /api/alt?basket=<address> answers { alt, addresses }: the basket's table
 * (its mints and vaults) or null if it has none. Without a table, callers keep
 * their legacy path.
 */
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

/** What a validator accepts in one packet, signatures and all. */
export const PACKET_LIMIT = 1232;

export type BasketAlt = { alt: string | null; addresses: string[] };

/** The basket's lookup table, from the site's route, or null when it has none or the route is unreachable. */
export async function fetchBasketAlt(basket: string, base = ""): Promise<BasketAlt | null> {
  try {
    const res = await fetch(`${base}/api/alt?basket=${encodeURIComponent(basket)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<BasketAlt>;
    if (typeof json.alt !== "string" || !Array.isArray(json.addresses)) return null;
    return { alt: json.alt, addresses: json.addresses.filter((a): a is string => typeof a === "string") };
  } catch {
    return null;
  }
}

/**
 * The table as web3.js wants it. Built from the route's address list, so no
 * extra RPC read is needed; the chain checks every index against the real table
 * when the transaction lands, so a stale list fails safely rather than wrongly.
 */
export function lookupTable(alt: BasketAlt): AddressLookupTableAccount | null {
  if (!alt.alt) return null;
  return new AddressLookupTableAccount({
    key: new PublicKey(alt.alt),
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: alt.addresses.map((a) => new PublicKey(a)),
    },
  });
}

/** A v0 transaction that reads what it can from the table. Unsigned, with a fresh blockhash, ready for a wallet. */
export async function buildV0(
  connection: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  table: AddressLookupTableAccount | null,
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(
    table ? [table] : [],
  );
  return new VersionedTransaction(message);
}

/** Bytes a v0 transaction would take on the wire, for deciding whether one signature is enough. */
export function v0Size(payer: PublicKey, instructions: TransactionInstruction[], table: AddressLookupTableAccount | null): number {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(table ? [table] : []);
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}
