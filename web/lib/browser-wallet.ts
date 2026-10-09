import {
  BaseMessageSignerWalletAdapter,
  WalletConnectionError,
  WalletDisconnectedError,
  WalletNotConnectedError,
  WalletReadyState,
  WalletSignMessageError,
  WalletSignTransactionError,
  isVersionedTransaction,
  type TransactionOrVersionedTransaction,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { Ed25519Program, Keypair, type PublicKey, type TransactionVersion } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * A wallet that lives in this browser.
 *
 * Most people we ask to try Sheaf have no Solana wallet, or one set to mainnet.
 * This gives them a real Ed25519 keypair, made here with the browser's own
 * random source and kept in this browser's localStorage. It is the visitor's
 * wallet: the secret never leaves the page, and Sheaf's server only ever sees the
 * public key, the same as with Phantom. It can be exported as a base58 secret and
 * imported into Phantom or Solflare later.
 *
 * It signs without a prompt, which is only acceptable because Sheaf writes to a
 * test cluster (devnet, or localnet in development) and the funds are test funds.
 */

export const BrowserWalletName = "Browser wallet" as WalletName<"Browser wallet">;

/** One key for the wallet itself. */
const STORAGE_KEY = "sheaf:browser-wallet";
/** Fired on window when the stored wallet is created or forgotten. */
export const BROWSER_WALLET_EVENT = "sheaf:browser-wallet";

type Stored = { v: 1; secretKey: string; createdAt: string };

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3438c9"/><path d="M16 7l9 9-9 9-9-9z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M16 12.5l3.5 3.5-3.5 3.5-3.5-3.5z" fill="#fff"/></svg>',
  );

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readKeypair(): Keypair | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    const secret = bs58.decode(parsed.secretKey);
    return secret.length === 64 ? Keypair.fromSecretKey(secret) : null;
  } catch {
    return null;
  }
}

function announce() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BROWSER_WALLET_EVENT));
}

/** The public address of the wallet saved in this browser, if there is one. */
export function storedBrowserWalletAddress(): string | null {
  return readKeypair()?.publicKey.toBase58() ?? null;
}

/**
 * The secret key as base58, the format Phantom and Solflare accept under
 * "Import private key". Whoever holds it controls the wallet.
 */
export function exportBrowserWalletSecret(): string | null {
  const keypair = readKeypair();
  return keypair ? bs58.encode(keypair.secretKey) : null;
}

/**
 * Delete the key from this browser. Without an export first, the wallet and
 * everything in it are gone for good. Disconnect before calling this.
 */
export function forgetBrowserWallet() {
  storage()?.removeItem(STORAGE_KEY);
  announce();
}

/**
 * web3.js signs Ed25519 internally but does not export the function, and the
 * curve libraries it uses are not resolvable from the app under pnpm. Its
 * Ed25519Program instruction builder signs the message with the given secret key
 * and lays the 64-byte signature into the instruction data at the offset its
 * header names, so read it from there. Ed25519 is deterministic, so this is the
 * same signature any other implementation would produce.
 */
function ed25519Sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const ix = Ed25519Program.createInstructionWithPrivateKey({ privateKey: secretKey, message });
  const data = ix.data;
  const signatureOffset = data[2] | (data[3] << 8);
  return Uint8Array.from(data.subarray(signatureOffset, signatureOffset + 64));
}

export class BrowserWalletAdapter extends BaseMessageSignerWalletAdapter<"Browser wallet"> {
  name = BrowserWalletName;
  url = "https://sheaf-index.vercel.app";
  icon = ICON;
  supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set<TransactionVersion>(["legacy", 0]);

  private _keypair: Keypair | null = null;
  private _connecting = false;
  private _readyState: WalletReadyState =
    typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable;

  get publicKey(): PublicKey | null {
    return this._keypair?.publicKey ?? null;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  /** Reconnect on page load only if a wallet is already saved: never make one silently. */
  async autoConnect(): Promise<void> {
    if (!readKeypair()) return;
    await this.connect();
  }

  async connect(): Promise<void> {
    if (this.connecting) return;
    // Already connected: say so again. The provider tears its listeners down and
    // marks itself disconnected on remount (React runs effects twice in
    // development), then asks again; a silent return would leave it believing
    // the wallet is not connected.
    if (this._keypair) {
      this.emit("connect", this._keypair.publicKey);
      return;
    }
    const store = storage();
    if (!store) {
      const error = new WalletConnectionError("This browser does not allow saving a wallet here.");
      this.emit("error", error);
      throw error;
    }
    this._connecting = true;
    try {
      let keypair = readKeypair();
      if (!keypair) {
        keypair = Keypair.generate();
        const stored: Stored = {
          v: 1,
          secretKey: bs58.encode(keypair.secretKey),
          createdAt: new Date().toISOString(),
        };
        store.setItem(STORAGE_KEY, JSON.stringify(stored));
        announce();
      }
      // Answer on a later tick, as an extension would, so the provider's
      // listeners are in place before the event fires.
      await new Promise((resolve) => setTimeout(resolve, 0));
      this._keypair = keypair;
      this.emit("connect", keypair.publicKey);
    } catch (err) {
      const error = err instanceof WalletConnectionError ? err : new WalletConnectionError((err as Error)?.message, err);
      this.emit("error", error);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this._keypair) return;
    this._keypair = null;
    this.emit("disconnect");
  }

  private signer(): Keypair {
    const keypair = this._keypair;
    if (!keypair) throw new WalletNotConnectedError();
    // Forgotten in another tab while this one was connected.
    if (storedBrowserWalletAddress() !== keypair.publicKey.toBase58()) {
      this._keypair = null;
      this.emit("disconnect");
      throw new WalletDisconnectedError("This browser wallet was forgotten.");
    }
    return keypair;
  }

  async signTransaction<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(
    transaction: T,
  ): Promise<T> {
    try {
      const keypair = this.signer();
      try {
        if (isVersionedTransaction(transaction)) transaction.sign([keypair]);
        else transaction.partialSign(keypair);
        return transaction;
      } catch (err) {
        throw new WalletSignTransactionError((err as Error)?.message, err);
      }
    } catch (error) {
      this.emit("error", error as WalletSignTransactionError);
      throw error;
    }
  }

  async signAllTransactions<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(
    transactions: T[],
  ): Promise<T[]> {
    const signed: T[] = [];
    for (const transaction of transactions) signed.push(await this.signTransaction(transaction));
    return signed;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const keypair = this.signer();
      try {
        return ed25519Sign(message, keypair.secretKey);
      } catch (err) {
        throw new WalletSignMessageError((err as Error)?.message, err);
      }
    } catch (error) {
      this.emit("error", error as WalletSignMessageError);
      throw error;
    }
  }
}
