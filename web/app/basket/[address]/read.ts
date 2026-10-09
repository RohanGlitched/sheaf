import { cache } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, WRITE_RPC } from "@/lib/config";
import { fetchBasketAt } from "@/lib/sheaf";

/** Read once per request: the layout, the metadata and the page all ask. */
export const readBasket = cache(fetchBasketAt);

/**
 * True only when the chain itself says there is no basket here: the address is
 * not a key, or the account does not exist or belongs to another program. A
 * failed read is not proof of absence, so it leaves the page to retry in the
 * browser rather than answering 404.
 */
export const definitelyMissing = cache(async (address: string): Promise<boolean> => {
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    return true;
  }
  try {
    const info = await new Connection(WRITE_RPC, "confirmed").getAccountInfo(key);
    return !info || info.owner.toBase58() !== SHEAF_PROGRAM_ID;
  } catch {
    return false;
  }
});
