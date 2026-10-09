import {
  createPublicClient,
  createWalletClient,
  hexToBigInt,
  hexToBytes,
  http,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { DEPLOYED } from "./chains";
import { TEMPO_PATH_USD, evmChain } from "./evm";
import { askToSign, isSheafMessage } from "./browser-wallet";

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
 * It signs without a prompt only what Sheaf's own pages build, the same rule as
 * the Solana browser wallet: a transaction to one of the deployment's own
 * contracts or tokens (and an ERC-20 approval only to one of those contracts), a
 * typed-data signature whose domain is a Sheaf testnet and contract, and the
 * /voices messages. Anything else goes to the same confirm dialog
 * (components/browser-wallet-confirm.tsx), which defaults to no. It knows only
 * the testnets Sheaf is deployed to and refuses any other chain.
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

/** Keys whose addresses are people, not contracts: never a target to sign for. */
const NOT_TARGETS = new Set(["deployer", "keeperKey", "treasury", "runs", "smoke", "buyer", "owner", "creator"]);

const targetsByChain = new Map<number, Set<string>>();

/**
 * Every contract and token a deployment names: factory, desks v1 to v3, plan
 * desks, baskets, component tokens, the dollar, and Tempo's pathUSD precompile.
 * Read from the deployment record itself, so a new desk is covered when it is.
 */
function targets(chainId: number): Set<string> {
  let set = targetsByChain.get(chainId);
  if (set) return set;
  set = new Set<string>();
  const d = DEPLOYMENTS.find((x) => x.chainId === chainId);
  const walk = (value: unknown, key: string) => {
    if (NOT_TARGETS.has(key)) return;
    if (typeof value === "string") {
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) set!.add(value.toLowerCase());
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  if (d) {
    walk(d, "");
    if (d.network === "tempoTestnet") set.add(TEMPO_PATH_USD.toLowerCase());
  }
  targetsByChain.set(chainId, set);
  return set;
}

const SELECTOR = {
  approve: "0x095ea7b3",
  increaseAllowance: "0x39509351",
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  setApprovalForAll: "0xa22cb465",
};

/** Why a transaction should be confirmed by the person, or an empty list when Sheaf's own steps would send it. */
function transactionConcerns(chainId: number, tx: { to?: Address; data?: Hex; value?: Hex }): string[] {
  const allowed = targets(chainId);
  const reasons: string[] = [];
  const data = (tx.data ?? "0x").toLowerCase();
  const arg = (n: number) => `0x${data.slice(10 + 64 * n + 24, 10 + 64 * (n + 1))}`;
  if (!tx.to) reasons.push("Deploy a new contract");
  else if (!allowed.has(tx.to.toLowerCase())) reasons.push(`Call ${tx.to}, which is not one of Sheaf's contracts or tokens on this chain`);
  if (tx.value && hexToBigInt(tx.value) > 0n) reasons.push(`Send ${Number(hexToBigInt(tx.value)) / 1e18} of the chain's coin with it`);
  const selector = data.slice(0, 10);
  if ((selector === SELECTOR.approve || selector === SELECTOR.increaseAllowance) && !allowed.has(arg(0))) {
    reasons.push(`Let ${arg(0)} spend this wallet's tokens`);
  }
  if (selector === SELECTOR.setApprovalForAll) reasons.push(`Let ${arg(0)} move every token of a collection`);
  if (selector === SELECTOR.transfer && !allowed.has(arg(0))) reasons.push(`Send tokens to ${arg(0)}`);
  if (selector === SELECTOR.transferFrom) reasons.push(`Move tokens from ${arg(0)} to ${arg(1)}`);
  return reasons;
}

function declined(): Error {
  return Object.assign(new Error("Declined in the browser wallet."), { code: 4001 });
}

function messageBytes(raw: unknown): Uint8Array {
  const value = String(raw ?? "");
  return /^0x([0-9a-fA-F]{2})*$/.test(value) ? hexToBytes(value as Hex) : new TextEncoder().encode(value);
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
        const reasons = transactionConcerns(currentChainId(), tx);
        if (
          reasons.length &&
          !(await askToSign({
            kind: "evm",
            title: "Send a transaction Sheaf did not build?",
            intro: "Sheaf's own steps never do this. It would:",
            items: reasons,
          }))
        ) {
          throw declined();
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
        const bytes = messageBytes(args[0]);
        if (!isSheafMessage(bytes)) {
          let text: string | null;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            text = null;
          }
          const ok = await askToSign({
            kind: "evm",
            title: "Sign a message Sheaf did not write?",
            intro: "It is not one of the /voices messages. This is the exact text:",
            items: [],
            text: text ?? `${bytes.length} bytes of binary data, not text.`,
          });
          if (!ok) throw declined();
        }
        return account.signMessage({ message: { raw: bytes } });
      }
      case "eth_signTypedData_v4": {
        const account = this.account();
        const typed = (typeof args[1] === "string" ? JSON.parse(args[1] as string) : args[1]) as {
          domain?: { chainId?: number | string; verifyingContract?: string };
          primaryType?: string;
        };
        // A typed-data signature carries its own chain: a permit for chain 1 would
        // be valid on mainnet. Only Sheaf's testnets and contracts pass silently.
        const chainId = Number(typed?.domain?.chainId);
        const contract = typed?.domain?.verifyingContract?.toLowerCase();
        const sheafChain = !!chainFor(chainId);
        const sheafContract = !contract || targets(chainId).has(contract);
        if (!sheafChain || !sheafContract) {
          const ok = await askToSign({
            kind: "evm",
            title: "Sign typed data Sheaf did not ask for?",
            intro: "Sheaf's pages never ask for this signature. It is for:",
            items: [
              `Chain ${Number.isFinite(chainId) ? chainId : "not stated"}${sheafChain ? "" : ", not one of Sheaf's testnets: it could be valid on a real network"}`,
              `Contract ${contract ?? "not stated"}${sheafContract ? "" : ", not one of Sheaf's"}`,
              `Kind ${typed?.primaryType ?? "unknown"}`,
            ],
            text: JSON.stringify(typed, null, 2).slice(0, 2000),
          });
          if (!ok) throw declined();
        }
        return account.signTypedData(typed as never);
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
