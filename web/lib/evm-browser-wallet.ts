import {
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  http,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DEPLOYED } from "./chains";
import { evmChain } from "./evm";

/**
 * An EVM wallet that lives in this browser, for the chain pages.
 *
 * The Solana side has lib/browser-wallet.ts; this is the same idea for the EVM
 * testnets, so a judge on a clean browser can mint, redeem and place a dollar
 * order without installing MetaMask. A secp256k1 key is generated here with
 * viem (which uses the browser's random source), kept in this browser's
 * localStorage, and exposed as a small EIP-1193 provider: the page's existing
 * wallet code (components/evm-wallet.tsx) drives it exactly as it drives an
 * injected wallet. Each transaction is signed locally and sent through the
 * chain's public RPC with viem's http transport; the key never leaves the page.
 *
 * It signs without a prompt. That is acceptable only because every chain it
 * knows is a testnet Sheaf is deployed to, and it refuses any other chain.
 */

const KEY = "sheaf:evm-browser-wallet";
/** Set while the visitor has chosen this wallet over an injected one. */
const CHOICE = "sheaf:evm-wallet-choice";
const CHAIN = "sheaf:evm-browser-wallet:chain";
/** Fired on window when the wallet is created, chosen, left or forgotten. */
export const EVM_BROWSER_WALLET_EVENT = "sheaf:evm-browser-wallet";

type Stored = { v: 1; privateKey: Hex; createdAt: string };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAccount(): PrivateKeyAccount | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Stored;
    return /^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey) ? privateKeyToAccount(parsed.privateKey) : null;
  } catch {
    return null;
  }
}

function announce() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVM_BROWSER_WALLET_EVENT));
}

/** The address of the EVM wallet saved in this browser, if there is one. */
export function storedEvmBrowserAddress(): Address | null {
  return readAccount()?.address ?? null;
}

/** True while the visitor is using the browser wallet rather than an injected one. */
export function evmBrowserWalletChosen(): boolean {
  return storage()?.getItem(CHOICE) === "browser" && readAccount() != null;
}

/** The private key as 0x hex, which MetaMask and Rabby accept under "Import account". */
export function exportEvmBrowserKey(): Hex | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as Stored).privateKey;
  } catch {
    return null;
  }
}

/** Make the wallet if there is none, and use it. Returns its address. */
export function chooseEvmBrowserWallet(): Address | null {
  const store = storage();
  if (!store) return null;
  let account = readAccount();
  if (!account) {
    const privateKey = generatePrivateKey();
    const stored: Stored = { v: 1, privateKey, createdAt: new Date().toISOString() };
    store.setItem(KEY, JSON.stringify(stored));
    account = privateKeyToAccount(privateKey);
  }
  store.setItem(CHOICE, "browser");
  provider?.emit("accountsChanged", [account.address]);
  announce();
  return account.address;
}

/** Stop using it (the key stays, so it can be picked again). */
export function leaveEvmBrowserWallet() {
  storage()?.removeItem(CHOICE);
  provider?.emit("accountsChanged", []);
  announce();
}

/** Delete the key. Without an export first, the wallet and its test funds are gone for good. */
export function forgetEvmBrowserWallet() {
  const store = storage();
  store?.removeItem(KEY);
  store?.removeItem(CHOICE);
  provider?.emit("accountsChanged", []);
  announce();
}

// ------------------------------------------------------------------ provider

const DEPLOYMENTS = DEPLOYED.map((c) => c.deployment!).filter(Boolean);

function chainFor(chainId: number): { chain: Chain; rpc: string } | null {
  const d = DEPLOYMENTS.find((x) => x.chainId === chainId);
  if (d) return { chain: evmChain(d), rpc: d.rpc };
  return null;
}

function currentChainId(): number {
  const saved = Number(storage()?.getItem(CHAIN));
  if (saved && chainFor(saved)) return saved;
  return DEPLOYMENTS[0]?.chainId ?? 421614;
}

type Listener = (...args: unknown[]) => void;

class BrowserEvmProvider {
  readonly isSheafBrowserWallet = true;
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  removeListener(event: string, fn: Listener) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch {
        /* a listener's own problem */
      }
    });
  }

  private account(): PrivateKeyAccount {
    const account = evmBrowserWalletChosen() ? readAccount() : null;
    if (!account) throw Object.assign(new Error("The browser wallet is not connected."), { code: 4100 });
    return account;
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const args = (Array.isArray(params) ? params : []) as unknown[];
    switch (method) {
      case "eth_accounts":
        return evmBrowserWalletChosen() ? [readAccount()!.address] : [];
      case "eth_requestAccounts": {
        const address = chooseEvmBrowserWallet();
        if (!address) throw Object.assign(new Error("This browser does not allow saving a wallet here."), { code: 4001 });
        return [address];
      }
      case "eth_chainId":
        return numberToHex(currentChainId());
      case "net_version":
        return String(currentChainId());
      case "wallet_switchEthereumChain": {
        const id = Number((args[0] as { chainId?: string })?.chainId);
        if (!chainFor(id)) {
          throw Object.assign(new Error("The browser wallet only knows the testnets Sheaf is deployed to."), { code: 4902 });
        }
        if (id !== currentChainId()) {
          storage()?.setItem(CHAIN, String(id));
          this.emit("chainChanged", numberToHex(id));
        }
        return null;
      }
      case "wallet_addEthereumChain":
        // Only Sheaf's own testnets: adding anything else is refused.
        if (!chainFor(Number((args[0] as { chainId?: string })?.chainId))) {
          throw Object.assign(new Error("The browser wallet only works on Sheaf's testnets."), { code: 4001 });
        }
        return null;
      case "wallet_getCapabilities":
      case "wallet_sendCalls":
        throw Object.assign(new Error("Not supported by the browser wallet."), { code: 4200 });
      case "eth_sendTransaction": {
        const account = this.account();
        const tx = (args[0] ?? {}) as { from?: Address; to?: Address; data?: Hex; value?: Hex; gas?: Hex };
        if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
          throw Object.assign(new Error("That is not this wallet's address."), { code: 4100 });
        }
        const target = chainFor(currentChainId())!;
        const wallet = createWalletClient({ account, chain: target.chain, transport: http(target.rpc, { timeout: 20_000, retryCount: 2 }) });
        return wallet.sendTransaction({
          account,
          chain: target.chain,
          to: tx.to,
          data: tx.data,
          value: tx.value ? hexToBigInt(tx.value) : undefined,
          gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
        });
      }
      case "personal_sign": {
        const account = this.account();
        return account.signMessage({ message: { raw: args[0] as Hex } });
      }
      case "eth_signTypedData_v4": {
        const account = this.account();
        const typed = typeof args[1] === "string" ? JSON.parse(args[1] as string) : args[1];
        return account.signTypedData(typed);
      }
      case "eth_sign":
      case "eth_signTransaction":
        throw Object.assign(new Error("Not supported by the browser wallet."), { code: 4200 });
      default: {
        // Reads go straight to the chain's public RPC.
        const target = chainFor(currentChainId())!;
        const client = createPublicClient({ chain: target.chain, transport: http(target.rpc, { timeout: 15_000, retryCount: 2 }) });
        return client.request({ method, params } as never);
      }
    }
  }
}

let provider: BrowserEvmProvider | null = null;

/** The one provider for this page. */
export function evmBrowserProvider(): EIP1193Provider {
  if (!provider) provider = new BrowserEvmProvider();
  return provider as unknown as EIP1193Provider;
}

/** Whether a provider is this browser wallet. */
export function isEvmBrowserProvider(p: unknown): boolean {
  return !!(p as { isSheafBrowserWallet?: boolean } | null)?.isSheafBrowserWallet;
}
