import "server-only";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { CASH_MINT } from "./cash.generated";
import { SHEAF_PROGRAM_ID } from "./config";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, tokenAccount, type Basket } from "./sheaf";

/**
 * Address lookup tables for the big baskets.
 *
 * A fill or a mint names three accounts per component. At seven or eight
 * components the legacy transaction passes Solana's 1,232-byte packet limit, so
 * those baskets get one lookup table each, holding every account that is the same
 * for everybody: the basket, its share mint, each component's mint and vault, the
 * programs and the test dollar. A v0 transaction then names each of them in one
 * byte instead of thirty-two.
 *
 * The house key creates and owns the tables. They need no registry: the basket is
 * always a table's first address, so a scan of the lookup-table program for
 * authority = house finds them again after any restart.
 */

/** Below this a legacy transaction fits, and no table is made. */
export const ALT_MIN_COMPONENTS = 7;
/** Rent for a table is small, but the house key also pays the keeper's rent: never below this. */
const ALT_FLOOR_LAMPORTS = 1.5e9;
/** Addresses per extend instruction, so each transaction stays well inside the packet limit. */
const EXTEND_CHUNK = 20;
/** Lookup-table account layout: authority option tag at 21, key at 22, addresses from 56. */
const AUTHORITY_OFFSET = 22;

export type AltInfo = { alt: string | null; addresses: string[] };

/** Every address a fill or a mint on this basket shares with every other caller, basket first. */
export function altAddressesFor(basket: Basket): PublicKey[] {
  const key = new PublicKey(basket.address);
  const componentProgram = new PublicKey(basket.tokenProgram);
  const out: PublicKey[] = [
    key,
    new PublicKey(basket.shareMint),
    componentProgram,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    new PublicKey(SHEAF_PROGRAM_ID),
    new PublicKey(CASH_MINT),
  ];
  for (const c of basket.components) {
    const mint = new PublicKey(c.mint);
    out.push(mint, tokenAccount(mint, key, componentProgram));
  }
  const seen = new Set<string>();
  return out.filter((k) => (seen.has(k.toBase58()) ? false : (seen.add(k.toBase58()), true)));
}

const cache = new Map<string, AddressLookupTableAccount>();
let scanned: Promise<void> | null = null;

/** One scan per instance: every table the house owns, by the basket it serves. */
function scanHouseTables(connection: Connection, house: PublicKey): Promise<void> {
  if (!scanned) {
    scanned = connection
      .getProgramAccounts(AddressLookupTableProgram.programId, {
        filters: [{ memcmp: { offset: AUTHORITY_OFFSET, bytes: house.toBase58() } }],
      })
      .then((accounts) => {
        for (const { pubkey, account } of accounts) {
          const state = AddressLookupTableAccount.deserialize(new Uint8Array(account.data));
          if (state.deactivationSlot !== BigInt("18446744073709551615") || state.addresses.length === 0) continue;
          const basket = state.addresses[0].toBase58();
          const prev = cache.get(basket);
          if (!prev || prev.state.addresses.length < state.addresses.length) {
            cache.set(basket, new AddressLookupTableAccount({ key: pubkey, state }));
          }
        }
      })
      .catch((err) => {
        scanned = null;
        throw err;
      });
  }
  return scanned;
}

/** The house's table for this basket, if it has one, without creating anything. */
export async function findAlt(connection: Connection, house: PublicKey, basket: Basket): Promise<AddressLookupTableAccount | null> {
  if (basket.components.length < ALT_MIN_COMPONENTS) return null;
  await scanHouseTables(connection, house);
  return cache.get(basket.address) ?? null;
}

const building = new Map<string, Promise<AddressLookupTableAccount>>();

async function sendV0(connection: Connection, payer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`lookup table transaction failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

/**
 * The basket's table, created or extended by the house on first need, and only
 * returned once the chain will resolve every address in it.
 */
export async function ensureAlt(connection: Connection, house: Keypair, basket: Basket): Promise<AddressLookupTableAccount | null> {
  if (basket.components.length < ALT_MIN_COMPONENTS) return null;
  const existing = await findAlt(connection, house.publicKey, basket);
  const wanted = altAddressesFor(basket);
  const missing = (t: AddressLookupTableAccount | null) => {
    const have = new Set((t?.state.addresses ?? []).map((a) => a.toBase58()));
    return wanted.filter((a) => !have.has(a.toBase58()));
  };
  if (existing && missing(existing).length === 0) return existing;

  const inFlight = building.get(basket.address);
  if (inFlight) return inFlight;
  const job = (async () => {
    if ((await connection.getBalance(house.publicKey)) < ALT_FLOOR_LAMPORTS) {
      throw new Error("The house key is too low on SOL to open a lookup table.");
    }
    let table = existing?.key;
    let todo = missing(existing);
    if (!table) {
      // The slot must be one the lookup-table program finds in SlotHashes. A
      // slot from getSlot can be skipped (no block) or not yet in the bank
      // that runs the transaction ("is not a recent slot"), so take one a few
      // entries deep from the sysvar itself.
      const slotHashes = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed");
      const entries = slotHashes ? Number(slotHashes.data.readBigUInt64LE(0)) : 0;
      const recentSlot =
        slotHashes && entries > 8
          ? Number(slotHashes.data.readBigUInt64LE(8 + 8 * 40))
          : (await connection.getSlot("finalized")) - 8;
      const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: house.publicKey, payer: house.publicKey, recentSlot });
      const first = todo.slice(0, EXTEND_CHUNK);
      await sendV0(connection, house, [
        create,
        AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: house.publicKey, payer: house.publicKey, addresses: first }),
      ]);
      table = address;
      todo = todo.slice(EXTEND_CHUNK);
    }
    for (let i = 0; i < todo.length; i += EXTEND_CHUNK) {
      await sendV0(connection, house, [
        AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: house.publicKey, payer: house.publicKey, addresses: todo.slice(i, i + EXTEND_CHUNK) }),
      ]);
    }
    // New entries resolve from the slot after the one that added them.
    for (let i = 0; i < 20; i++) {
      const [res, slot] = await Promise.all([connection.getAddressLookupTable(table, { commitment: "confirmed" }), connection.getSlot("confirmed")]);
      if (res.value && res.value.state.lastExtendedSlot < slot && missing(res.value).length === 0) {
        cache.set(basket.address, res.value);
        return res.value;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("The lookup table did not settle in time.");
  })();
  building.set(basket.address, job);
  try {
    return await job;
  } finally {
    building.delete(basket.address);
  }
}

export function altInfo(t: AddressLookupTableAccount | null): AltInfo {
  return { alt: t ? t.key.toBase58() : null, addresses: t ? t.state.addresses.map((a) => a.toBase58()) : [] };
}
