import "server-only";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { faucetKeypair } from "./faucet-server";

/**
 * The house's keys, one job each, all read from the server environment, never
 * sent anywhere. Each env var holds a secret key as base58 or as a JSON array of
 * 64 numbers (the solana-keygen file format).
 *
 *   FAUCET_SECRET_KEY  the house: mint authority of the stand-in stocks and
 *                      dollars, the keeper, and the house filler
 *   FAUCET_KEY         the faucet's own wallet: pays the SOL it hands out and
 *                      the rent for visitors' new token accounts
 *   FILLER2_KEY        a second, independent filler running the reference
 *                      filler's code; it holds only what any outsider can get
 *
 * Without FAUCET_KEY the faucet falls back to the house, as before.
 */

function parse(secret: string | undefined): Keypair | null {
  if (!secret) return null;
  try {
    const s = secret.trim();
    return s.startsWith("[") ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : Keypair.fromSecretKey(bs58.decode(s));
  } catch {
    return null;
  }
}

let filler2: Keypair | null | undefined;
let payer: Keypair | null | undefined;

export function filler2Keypair(): Keypair | null {
  if (filler2 === undefined) filler2 = parse(process.env.FILLER2_KEY);
  return filler2;
}

export const filler2Address = () => filler2Keypair()?.publicKey.toBase58() ?? null;

/** Who pays for the faucet: its own key when configured, else the house. */
export function faucetPayerKeypair(): Keypair | null {
  if (payer === undefined) payer = parse(process.env.FAUCET_KEY);
  return payer ?? faucetKeypair();
}

/** True when the faucet has a wallet of its own, apart from the house. */
export const faucetHasOwnKey = () => {
  faucetPayerKeypair();
  return payer != null;
};
