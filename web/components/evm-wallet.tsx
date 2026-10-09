"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { Deployment } from "@/lib/chains";
import { evmChain, explainEvmError, isTempo, publicClientFor } from "@/lib/evm";
import { shortAddress } from "@/lib/format";

/**
 * An injected EVM wallet (MetaMask, Rabby, Coinbase Wallet, Phantom's EVM side),
 * driven through viem with no connector library. It connects, adds and switches
 * to the basket's chain, and sends a list of steps: as one EIP-5792 batch when
 * the wallet can do it atomically, otherwise one transaction at a time, each
 * waiting for the last so an approval is mined before the call that spends it.
 */

export type Step = { label: string; to: Address; data: Hex };
export type StepState = { label: string; status: "waiting" | "signing" | "pending" | "done" | "failed"; hash?: Hex };

function injected(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null) as EIP1193Provider | null;
}

export function useEvmWallet(d: Deployment) {
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = injected();
    let live = true;
    void Promise.resolve().then(() => {
      if (!live) return;
      setProvider(p);
      setReady(true);
    });
    if (!p) return;
    // Silent reads: no prompt unless the visitor already connected this site.
    void p
      .request({ method: "eth_accounts" })
      .then((a) => live && setAddress(((a as Address[])[0] ?? null) as Address | null))
      .catch(() => undefined);
    void p
      .request({ method: "eth_chainId" })
      .then((c) => live && setChainId(Number(c)))
      .catch(() => undefined);
    const onAccounts = (a: unknown) => setAddress(((a as Address[])[0] ?? null) as Address | null);
    const onChain = (c: unknown) => setChainId(Number(c));
    p.on?.("accountsChanged", onAccounts as never);
    p.on?.("chainChanged", onChain as never);
    return () => {
      live = false;
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
  }, []);

  const chain = useMemo(() => evmChain(d), [d]);

  const connect = useCallback(async () => {
    setError(null);
    const p = provider ?? injected();
    if (!p) {
      setError("No EVM wallet found in this browser. Install MetaMask or Rabby, then reload.");
      return null;
    }
    try {
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as Address[];
      setAddress(accounts[0] ?? null);
      setChainId(Number(await p.request({ method: "eth_chainId" })));
      return accounts[0] ?? null;
    } catch (err) {
      setError(explainEvmError(err));
      return null;
    }
  }, [provider]);

  const switchChain = useCallback(async () => {
    setError(null);
    const p = provider ?? injected();
    if (!p) return false;
    const hexId = numberToHex(d.chainId);
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (err) {
      const e = err as { code?: number; data?: { originalError?: { code?: number } } };
      const unknownChain = e.code === 4902 || e.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(String((err as Error).message));
      if (!unknownChain) {
        setError(explainEvmError(err));
        return false;
      }
      try {
        await p.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexId,
              chainName: d.label,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [d.rpc],
              blockExplorerUrls: [d.explorer],
            },
          ],
        });
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
      } catch (err2) {
        setError(explainEvmError(err2));
        return false;
      }
    }
    setChainId(Number(await p.request({ method: "eth_chainId" })));
    return true;
  }, [provider, d, chain]);

  /** Send steps in order. Returns the receipts, one per transaction actually sent. */
  const send = useCallback(
    async (steps: Step[], onState: (s: StepState[]) => void): Promise<TransactionReceipt[]> => {
      const p = provider ?? injected();
      if (!p || !address) throw new Error("Connect a wallet first.");
      const current = Number(await p.request({ method: "eth_chainId" }));
      if (current !== d.chainId) throw new Error(`Switch the wallet to ${d.label} first.`);
      const wallet = createWalletClient({ account: address, chain, transport: custom(p) });
      const client = publicClientFor(d);
      const states: StepState[] = steps.map((s) => ({ label: s.label, status: "waiting" }));
      const push = () => onState(states.map((s) => ({ ...s })));
      push();

      // EIP-5792: one approval in the wallet for the whole list, when it is atomic.
      if (steps.length > 1) {
        let atomic = false;
        try {
          const caps = (await wallet.getCapabilities({ account: address, chainId: d.chainId })) as { atomic?: { status?: string } };
          atomic = caps?.atomic?.status === "supported" || caps?.atomic?.status === "ready";
        } catch {
          atomic = false;
        }
        if (atomic) {
          states.forEach((s) => (s.status = "signing"));
          push();
          const { id } = await wallet.sendCalls({ account: address, chain, calls: steps.map((s) => ({ to: s.to, data: s.data })), forceAtomic: true });
          states.forEach((s) => (s.status = "pending"));
          push();
          const result = await wallet.waitForCallsStatus({ id, timeout: 120_000 });
          const receipts = (result.receipts ?? []) as unknown as TransactionReceipt[];
          const ok = result.status === "success";
          states.forEach((s) => {
            s.status = ok ? "done" : "failed";
            s.hash = receipts[0]?.transactionHash;
          });
          push();
          if (!ok) throw new Error("The batch reverted.");
          return receipts;
        }
      }

      const receipts: TransactionReceipt[] = [];
      for (const [i, s] of steps.entries()) {
        states[i].status = "signing";
        push();
        try {
          let hash: Hex | undefined;
          // A load-balanced public RPC can estimate against a node one block behind the
          // approval just mined. A revert at estimate time right after a dependent step is
          // retried twice, a few seconds apart; a refusal in the wallet never is.
          for (let attempt = 0; ; attempt++) {
            try {
              hash = await wallet.sendTransaction({ account: address, chain, to: s.to, data: s.data });
              break;
            } catch (err) {
              const msg = String((err as Error).message ?? "");
              const rejected = (err as { code?: number }).code === 4001 || /reject|denied/i.test(msg);
              if (rejected || i === 0 || attempt >= 2 || !/revert|unknown rpc error|estimate/i.test(msg)) throw err;
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          states[i].status = "pending";
          states[i].hash = hash;
          push();
          const receipt = await client.waitForTransactionReceipt({ hash: hash!, timeout: 120_000 });
          if (receipt.status !== "success") throw new Error(`${s.label} reverted on chain.`);
          states[i].status = "done";
          receipts.push(receipt);
          push();
        } catch (err) {
          states[i].status = "failed";
          push();
          throw err;
        }
      }
      return receipts;
    },
    [provider, address, chain, d],
  );

  return {
    ready,
    available: !!provider,
    address,
    chainId,
    onChain: chainId === d.chainId,
    error,
    setError,
    connect,
    switchChain,
    send,
  };
}

export type EvmWallet = ReturnType<typeof useEvmWallet>;

/** Connect, then switch: the one button a visitor needs before anything else. */
export function EvmConnect({ wallet, d }: { wallet: EvmWallet; d: Deployment }) {
  if (!wallet.ready) return <div className="h-11" />;
  if (!wallet.available) {
    return (
      <p className="text-sm leading-relaxed text-ink-2">
        No EVM wallet in this browser. Install{" "}
        <a href="https://metamask.io/download" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
          MetaMask
        </a>{" "}
        or{" "}
        <a href="https://rabby.io" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
          Rabby
        </a>
        , then reload. Everything on this page is read from the chain without one.
      </p>
    );
  }
  if (!wallet.address) {
    return (
      <button
        type="button"
        onClick={() => void wallet.connect()}
        className="w-full rounded-[var(--radius-control)] bg-bind px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
      >
        Connect an EVM wallet
      </button>
    );
  }
  if (!wallet.onChain) {
    return (
      <button
        type="button"
        onClick={() => void wallet.switchChain()}
        className="w-full rounded-[var(--radius-control)] bg-bind px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
      >
        Switch to {d.label}
      </button>
    );
  }
  return (
    <p className="flex items-center justify-between gap-3 text-xs text-ink-3">
      <span className="flex items-center gap-1.5">
        <span className="live-dot size-1.5 rounded-full bg-gain" aria-hidden />
        {shortAddress(wallet.address, 6, 4)} on {d.label}
      </span>
      {isTempo(d) && <span>fees in pathUSD</span>}
    </p>
  );
}

/** The steps of one action, each with its transaction once it exists. */
export function StepList({ steps, d }: { steps: StepState[]; d: Deployment }) {
  if (steps.length === 0) return null;
  return (
    <ol className="mt-4 space-y-1.5 text-sm">
      {steps.map((s, i) => (
        <li key={`${s.label}-${i}`} className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${
              s.status === "done"
                ? "bg-gain text-white"
                : s.status === "failed"
                  ? "bg-loss text-white"
                  : s.status === "waiting"
                    ? "border border-line-strong text-ink-3"
                    : "pulse bg-bind text-white"
            }`}
          >
            {s.status === "done" ? "✓" : s.status === "failed" ? "!" : i + 1}
          </span>
          <span className={s.status === "waiting" ? "text-ink-3" : "text-ink-2"}>{s.label}</span>
          <span className="ml-auto text-xs text-ink-3">
            {s.hash ? (
              <a href={`${d.explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer" className="tnum underline decoration-line-strong underline-offset-4 hover:text-ink">
                {shortAddress(s.hash, 6, 4)}
              </a>
            ) : s.status === "signing" ? (
              "sign in wallet"
            ) : s.status === "pending" ? (
              "confirming"
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The header's wallet button on the EVM chain pages, where a Solana wallet has
 * nothing to do. It only asks the injected wallet for an account; each basket's
 * own panel still switches to its chain. A wallet announces the new account to
 * every listener, so the panel below picks the connection up without a reload.
 */
export function EvmHeaderConnect() {
  const [provider, setProvider] = useState<EIP1193Provider | null | undefined>(undefined);
  const [address, setAddress] = useState<Address | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const p = injected();
    let live = true;
    void Promise.resolve().then(() => live && setProvider(p));
    if (!p) return;
    void p
      .request({ method: "eth_accounts" })
      .then((a) => live && setAddress(((a as Address[])[0] ?? null) as Address | null))
      .catch(() => undefined);
    const onAccounts = (a: unknown) => setAddress(((a as Address[])[0] ?? null) as Address | null);
    p.on?.("accountsChanged", onAccounts as never);
    return () => {
      live = false;
      p.removeListener?.("accountsChanged", onAccounts as never);
    };
  }, []);

  const base =
    "flex items-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink transition-colors hover:border-ink-3 disabled:opacity-60";

  if (provider === undefined) return <div className="h-9 w-36" aria-hidden />;

  if (address) {
    return (
      <span className={base} title={`${address}: connected EVM wallet`}>
        <span aria-hidden className="size-1.5 rounded-full bg-gain" />
        <span className="text-xs text-ink-3">EVM</span>
        <span className="tnum">{shortAddress(address, 6, 4)}</span>
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        className={base}
        onClick={async () => {
          setNote(null);
          if (!provider) {
            setNote("No EVM wallet in this browser. Install MetaMask or Rabby, then reload.");
            return;
          }
          setBusy(true);
          try {
            const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
            setAddress(accounts[0] ?? null);
          } catch (err) {
            setNote(explainEvmError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Connecting…" : "Connect EVM wallet"}
      </button>
      {note && (
        <p className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-[var(--radius-control)] border border-line bg-raised px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-[0_24px_48px_-24px_rgb(20_37_28/0.35)]">
          {note}
        </p>
      )}
    </div>
  );
}
