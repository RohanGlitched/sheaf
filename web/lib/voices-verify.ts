import "server-only";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";

/**
 * Checks an ed25519 signature from a Solana wallet's signMessage, with Node's own
 * crypto: no extra dependency. A Solana address is the raw 32-byte public key in
 * base58, so it becomes a JWK directly.
 */

export function decodeAddress(address: unknown): Uint8Array | null {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return null;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function decodeSignature(signature: unknown): Uint8Array | null {
  if (typeof signature !== "string" || signature.length < 64 || signature.length > 100) return null;
  try {
    const bytes = bs58.decode(signature);
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

export function verifySigned(message: string, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
  } catch {
    return false;
  }
}
