/**
 * A Wallet Standard wallet that lives in the page, for testing only.
 *
 * There is no browser extension in the automated environment, so the mint and
 * redeem paths could otherwise only be proven from Node — which skips the wallet
 * adapter entirely, and the adapter is exactly the part a real visitor uses.
 * This registers a wallet backed by one of 100 fixed test keys: wallet i is the
 * Ed25519 key whose seed is sha256("sheaf-test-wallet:" + i), derived in the page
 * with WebCrypto. Every run therefore signs as a wallet the site already lists as
 * ours (web/lib/test-wallets.generated.ts), so a test never shows up as an
 * outside wallet. They are test keys by construction: anyone can derive them.
 *
 * Paste the exported function into a page evaluation. It returns the address.
 * installTestWallet({ index: 7 }) picks wallet 7; with no index it picks one of
 * the 100 at random.
 */
export function installTestWallet(options = {}) {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  function base58(bytes) {
    let digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = "";
    for (const byte of bytes) {
      if (byte === 0) out += "1";
      else break;
    }
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }

  /** Read a shortvec length prefix. Returns [value, bytesRead]. */
  function shortvec(bytes, offset) {
    let value = 0;
    let size = 0;
    for (;;) {
      const byte = bytes[offset + size];
      value |= (byte & 0x7f) << (size * 7);
      size += 1;
      if ((byte & 0x80) === 0) break;
    }
    return [value, size];
  }

  return (async () => {
    const index =
      Number.isInteger(options.index) && options.index >= 0 && options.index < 100
        ? options.index
        : Math.floor(Math.random() * 100);
    const seed = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sheaf-test-wallet:${index}`)),
    );
    // PKCS#8 wrapping of a raw Ed25519 seed: a fixed 16-byte header, then the seed.
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
    pkcs8.set(seed, 16);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const publicKey = Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const keypair = { privateKey };
    const address = base58(publicKey);

    async function signTransaction({ transaction }) {
      const bytes = new Uint8Array(transaction);
      const [signatureCount, prefix] = shortvec(bytes, 0);
      const messageStart = prefix + signatureCount * 64;
      const message = bytes.subarray(messageStart);

      // Legacy message header, then the account keys. Our slot in the signature
      // array is our position among the required signers.
      const requiredSigners = message[0];
      const [keyCount, keyPrefix] = shortvec(message, 3);
      let slot = -1;
      for (let i = 0; i < Math.min(requiredSigners, keyCount); i++) {
        const at = 3 + keyPrefix + i * 32;
        let same = true;
        for (let j = 0; j < 32; j++) {
          if (message[at + j] !== publicKey[j]) {
            same = false;
            break;
          }
        }
        if (same) {
          slot = i;
          break;
        }
      }
      if (slot === -1) throw new Error("test wallet is not a signer here");

      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", keypair.privateKey, message),
      );
      const signed = new Uint8Array(bytes);
      signed.set(signature, prefix + slot * 64);
      return [{ signedTransaction: signed }];
    }

    const account = {
      address,
      publicKey,
      chains: [
        "solana:localnet",
        "solana:devnet",
        "solana:testnet",
        "solana:mainnet",
      ],
      features: ["solana:signTransaction"],
      label: `Test wallet ${index}`,
      icon: undefined,
    };

    const listeners = {};
    const wallet = {
      version: "1.0.0",
      name: "Sheaf Test Wallet",
      icon:
        "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#c8a44a"/></svg>',
        ),
      chains: account.chains,
      accounts: [account],
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => ({ accounts: [account] }),
        },
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: async () => {},
        },
        "standard:events": {
          version: "1.0.0",
          on: (event, listener) => {
            (listeners[event] ||= []).push(listener);
            return () => {
              listeners[event] = (listeners[event] || []).filter(
                (l) => l !== listener,
              );
            };
          },
        },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs) => {
            const out = [];
            for (const input of inputs) out.push(...(await signTransaction(input)));
            return out;
          },
        },
      },
    };

    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", {
        detail: ({ register }) => register(wallet),
      }),
    );
    // An app that loads after this script asks again; answer it too, as a real
    // wallet extension does.
    window.addEventListener("wallet-standard:app-ready", ({ detail: api }) => api.register(wallet));

    return address;
  })();
}
