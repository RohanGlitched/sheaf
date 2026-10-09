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
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  type Transaction,
  type TransactionVersion,
  type VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SHEAF_PROGRAM_ID, WRITE_CLUSTER } from "./config";
import { removalMessage, voiceMessage } from "./voices-message";

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
 * It signs without a prompt only what Sheaf itself builds: transactions whose
 * every instruction calls a program on the allow-list below, and the two /voices
 * messages. System and token instructions are read one by one as well, since
 * those programs can move funds on their own: a plain SOL or token transfer to
 * another address, an approval, a burn, or closing an account to someone else
 * all ask first (see `concern`). Anything else goes to a confirm step that names
 * the programs or the destination (or shows the message) and is refused unless
 * the person agrees. Sheaf writes to a
 * test cluster (devnet, or localnet in development) and the funds are test funds,
 * but the same key would be valid on mainnet, so the list is kept tight.
 */

export const BrowserWalletName = "Browser wallet" as WalletName<"Browser wallet">;

/** One key for the wallet itself. */
const STORAGE_KEY = "sheaf:browser-wallet";
/** Fired on window when the stored wallet is created or forgotten. */
export const BROWSER_WALLET_EVENT = "sheaf:browser-wallet";

type Stored = { v: 1; secretKey: string; createdAt: string };

/** Fired on window after each signature, with a one-line summary as detail. */
export const BROWSER_WALLET_SIGNED_EVENT = "sheaf:browser-wallet-signed";

/** Programs Sheaf's own flows call. Signing for these needs no confirm step. */
export const ALLOWED_PROGRAMS: Record<string, string> = {
  [SHEAF_PROGRAM_ID]: "Sheaf",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated token account",
  "11111111111111111111111111111111": "System",
  ComputeBudget111111111111111111111111111111: "Compute budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address lookup table",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora dynamic bonding curve",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  Ed25519SigVerify111111111111111111111111111: "Ed25519 signature check",
};

export type SignRequest =
  | { kind: "transaction"; count: number; unknown: string[]; known: string[]; reasons: string[] }
  | { kind: "message"; text: string | null; bytes: number }
  /** The EVM browser wallet's requests (lib/evm-browser-wallet.ts), already described. */
  | { kind: "evm"; title: string; intro: string; items: string[]; text?: string | null };

type Confirmer = (request: SignRequest) => Promise<boolean>;
let confirmer: Confirmer | null = null;

/**
 * The page's own confirm dialog (components/browser-wallet-confirm.tsx) registers
 * here. Without one, the browser's confirm() asks instead.
 */
export function setBrowserWalletConfirm(fn: Confirmer | null) {
  confirmer = fn;
}

/** Ask the person; the answer defaults to no. Shared with the EVM browser wallet. */
export async function askToSign(request: SignRequest): Promise<boolean> {
  if (confirmer) return confirmer(request);
  if (typeof window === "undefined") return false;
  const what =
    request.kind === "transaction"
      ? [...request.unknown.map((id) => `a program Sheaf does not call itself: ${id}`), ...request.reasons].join("\n")
      : request.kind === "message"
        ? `a message that is not one of Sheaf's:\n${(request.text ?? `${request.bytes} bytes of binary data`).slice(0, 400)}`
        : `${request.intro}\n${request.items.join("\n")}${request.text ? `\n${request.text.slice(0, 400)}` : ""}`;
  return window.confirm(`The browser wallet is asked to sign:\n${what}\n\nSign it?`);
}

// ------------------------------------------------- instruction-level checks

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const LOOKUP_TABLE = "AddressLookupTab1e1111111111111111111111111";
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
/** A new mint or token account costs well under this in rent; more than this is not rent. */
const MAX_NEW_ACCOUNT_LAMPORTS = 50_000_000;
/** spl_token_metadata_interface:initialize_account, the metadata a new share mint carries. */
const METADATA_INITIALIZE = [210, 225, 30, 162, 88, 184, 77, 141];

type Ix = { program: string; keys: (string | null)[]; data: Uint8Array };

function instructionsOf(tx: Transaction | VersionedTransaction): Ix[] {
  if (isVersionedTransaction(tx)) {
    const keys = tx.message.staticAccountKeys;
    // A program id must be a static key; an account from a lookup table cannot be
    // checked here, so it reads as null and never counts as "this wallet".
    return tx.message.compiledInstructions.map((ci) => ({
      program: keys[ci.programIdIndex]?.toBase58() ?? "(from a lookup table)",
      keys: ci.accountKeyIndexes.map((i) => keys[i]?.toBase58() ?? null),
      data: ci.data,
    }));
  }
  return tx.instructions.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((k) => k.pubkey.toBase58()),
    data: Uint8Array.from(ix.data ?? []),
  }));
}

const u32 = (d: Uint8Array, at: number) => (d.length >= at + 4 ? new DataView(d.buffer, d.byteOffset + at, 4).getUint32(0, true) : -1);
const u64 = (d: Uint8Array, at: number) => (d.length >= at + 8 ? new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true) : 0n);
const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 6 })} SOL`;

function ataOf(owner: string, mint: string, program: string): string | null {
  try {
    return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, new PublicKey(program)).toBase58();
  } catch {
    return null;
  }
}

/**
 * Why one instruction should be confirmed by the person, or null when it is one
 * Sheaf's own flows send. Only System, the token programs, the ATA program and
 * the lookup-table program are read here: those can move funds by themselves.
 * Sheaf's and Meteora's programs move funds only under their own rules.
 */
function concern(ix: Ix, self: string): string | null {
  const { program, keys, data } = ix;
  if (program === SYSTEM) {
    const tag = u32(data, 0);
    if (tag === 0) {
      // CreateAccount: rent for a new mint or token account, owned by a token program or Sheaf.
      const owner = data.length >= 52 ? bs58.encode(data.subarray(20, 52)) : "";
      const lamports = u64(data, 4);
      if ((owner === TOKEN || owner === TOKEN_2022 || owner === SHEAF_PROGRAM_ID) && lamports <= BigInt(MAX_NEW_ACCOUNT_LAMPORTS)) return null;
      return `Create an account holding ${sol(lamports)}, owned by ${owner || "an unknown program"}`;
    }
    if (tag === 2) {
      // Transfer: only to this wallet itself, or into its own wrapped-SOL account.
      const to = keys[1];
      if (to && (to === self || to === ataOf(self, NATIVE_MINT, TOKEN) || to === ataOf(self, NATIVE_MINT, TOKEN_2022))) return null;
      return `Send ${sol(u64(data, 4))} to ${to ?? "an address from a lookup table"}`;
    }
    return "Run a System instruction Sheaf's flows never send (assign, allocate, nonce or seeded account)";
  }
  if (program === TOKEN || program === TOKEN_2022) {
    if (data.length >= 8 && METADATA_INITIALIZE.every((b, i) => data[i] === b)) return null;
    const tag = data[0];
    switch (tag) {
      case 0: // InitializeMint
      case 1: // InitializeAccount
      case 7: // MintTo
      case 14: // MintToChecked
      case 16: // InitializeAccount2
      case 17: // SyncNative
      case 18: // InitializeAccount3
      case 20: // InitializeMint2
      case 22: // InitializeImmutableOwner
        return null;
      case 39: // MetadataPointer extension: only its Initialize
        return data[1] === 0 ? null : "Change a token's metadata pointer";
      case 6: {
        // SetAuthority: a new share mint hands its mint authority to the basket. Nothing else.
        if (data[1] === 0) return null;
        const to = data[2] === 1 && data.length >= 35 ? bs58.encode(data.subarray(3, 35)) : "nobody";
        return `Hand a token account's ${["mint", "freeze", "owner", "close"][data[1]] ?? "an"} authority to ${to}`;
      }
      case 9: {
        const to = keys[1];
        return to === self ? null : `Close a token account and send its SOL to ${to ?? "an address from a lookup table"}`;
      }
      case 3:
        return `Move ${u64(data, 1)} raw token units to ${keys[1] ?? "an address from a lookup table"}`;
      case 12: {
        const [, mint, to] = keys;
        if (mint && to && to === ataOf(self, mint, program)) return null;
        const amount = Number(u64(data, 1)) / 10 ** (data[9] ?? 0);
        return `Send ${amount.toLocaleString("en-US", { maximumFractionDigits: 9 })} of token ${mint ?? "?"} to ${to ?? "an address from a lookup table"}`;
      }
      case 4:
        return `Let ${keys[1] ?? "an address from a lookup table"} spend tokens from this wallet`;
      case 13:
        return `Let ${keys[2] ?? "an address from a lookup table"} spend tokens from this wallet`;
      case 8:
      case 15:
        return "Burn tokens from this wallet";
      default:
        return `Run a token instruction Sheaf's flows never send (#${tag})`;
    }
  }
  if (program === ATA) {
    // Create (empty or 0) and CreateIdempotent (1) only pay rent for this wallet's own account.
    return data.length === 0 || data[0] === 0 || data[0] === 1 ? null : "Recover a nested token account";
  }
  if (program === LOOKUP_TABLE && u32(data, 0) === 4) {
    const to = keys[2];
    return to === self ? null : `Close a lookup table and send its SOL to ${to ?? "an address from a lookup table"}`;
  }
  return null;
}

/** What in these transactions needs the person's yes, one line per instruction. */
export function transactionConcerns(txs: (Transaction | VersionedTransaction)[], self: PublicKey): string[] {
  const me = self.toBase58();
  return [...new Set(txs.flatMap(instructionsOf).map((ix) => concern(ix, me)).filter((r): r is string => r != null))];
}

function programIds(tx: Transaction | VersionedTransaction): string[] {
  if (isVersionedTransaction(tx)) {
    const keys = tx.message.staticAccountKeys;
    // A program id must be a static key; one that is not cannot be checked, so it counts as unknown.
    return tx.message.compiledInstructions.map((ci) => keys[ci.programIdIndex]?.toBase58() ?? "(from a lookup table)");
  }
  return tx.instructions.map((ix) => ix.programId.toBase58());
}

/** Programs in these transactions that are not on the allow-list, and the names of those that are. */
export function unknownPrograms(txs: (Transaction | VersionedTransaction)[]): { unknown: string[]; known: string[] } {
  const ids = [...new Set(txs.flatMap(programIds))];
  return {
    unknown: ids.filter((id) => !ALLOWED_PROGRAMS[id]),
    known: ids.filter((id) => ALLOWED_PROGRAMS[id]).map((id) => ALLOWED_PROGRAMS[id]),
  };
}

/** The first line of each /voices message, read from the builders so a wording change follows along. */
function voicesHeaders(): string[] {
  try {
    const sample = voiceMessage({ wallet: "", platform: "x", handle: "", quote: "", ref: null, date: "", walletKind: "browser" } as Parameters<typeof voiceMessage>[0]);
    return [sample.split("\n")[0], removalMessage("", "").split("\n")[0]].filter((h) => h.startsWith("Sheaf"));
  } catch {
    return [];
  }
}

function messageText(message: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(message);
  } catch {
    return null;
  }
}

/** True for the two messages /voices asks for, which are signed without a confirm step. */
export function isSheafMessage(message: Uint8Array): boolean {
  const text = messageText(message);
  return text != null && voicesHeaders().some((h) => text.startsWith(`${h}\n`));
}

function announceSigned(summary: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BROWSER_WALLET_SIGNED_EVENT, { detail: summary }));
  }
}

/** For callers that want to say which wallet signed, e.g. a /voices marker. */
export function isBrowserWallet(adapter: { name: string } | null | undefined): boolean {
  return adapter?.name === BrowserWalletName;
}

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
  /** Lets code holding only the adapter tell this wallet from an installed one. */
  readonly isBrowserWallet = true;
  name = BrowserWalletName;
  url = "https://sheaf.world";
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

  /**
   * Ask before signing anything that calls a program outside the allow-list, or
   * a System or token instruction that could move funds somewhere else.
   */
  private async approveTransactions(txs: (Transaction | VersionedTransaction)[], self: PublicKey) {
    const { unknown, known } = unknownPrograms(txs);
    const reasons = transactionConcerns(txs, self);
    if ((unknown.length || reasons.length) && !(await askToSign({ kind: "transaction", count: txs.length, unknown, known, reasons }))) {
      throw new WalletSignTransactionError("Declined in the browser wallet.");
    }
  }

  async signTransaction<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(
    transaction: T,
  ): Promise<T> {
    return (await this.signAllTransactions([transaction]))[0];
  }

  async signAllTransactions<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(
    transactions: T[],
  ): Promise<T[]> {
    try {
      const keypair = this.signer();
      await this.approveTransactions(transactions as (Transaction | VersionedTransaction)[], keypair.publicKey);
      const signed = transactions.map((transaction) => {
        try {
          if (isVersionedTransaction(transaction)) transaction.sign([keypair]);
          else transaction.partialSign(keypair);
          return transaction;
        } catch (err) {
          throw new WalletSignTransactionError((err as Error)?.message, err);
        }
      });
      announceSigned(
        transactions.length === 1 ? `Signed a transaction on ${WRITE_CLUSTER}` : `Signed ${transactions.length} transactions on ${WRITE_CLUSTER}`,
      );
      return signed;
    } catch (error) {
      this.emit("error", error as WalletSignTransactionError);
      throw error;
    }
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const keypair = this.signer();
      if (!isSheafMessage(message)) {
        const text = messageText(message);
        if (!(await askToSign({ kind: "message", text, bytes: message.length }))) {
          throw new WalletSignMessageError("Declined in the browser wallet.");
        }
      }
      let signature: Uint8Array;
      try {
        signature = ed25519Sign(message, keypair.secretKey);
      } catch (err) {
        throw new WalletSignMessageError((err as Error)?.message, err);
      }
      announceSigned("Signed a message, not a transaction");
      return signature;
    } catch (error) {
      this.emit("error", error as WalletSignMessageError);
      throw error;
    }
  }
}
