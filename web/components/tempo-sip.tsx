"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient, http, publicActions, type Address, type Hex } from "viem";
import { tempoModerato } from "viem/chains";
import { Account, Actions, P256, WebAuthnP256 } from "viem/tempo";
import type { Deployment } from "@/lib/chains";
import { BASKET_ABI, ERC20_ABI, TEMPO_PATH_USD, TEMPO_SIP, fromRaw } from "@/lib/evm";
import { quantity, shortAddress } from "@/lib/format";

/**
 * A monthly plan that the chain enforces, on Tempo.
 *
 * Tempo access keys let an account hand a second key a recurring TIP-20 spending
 * limit and a call scope. A Sheaf SIP is one of those: the investor signs once,
 * the keeper may spend 25 AlphaUSD every 30 days, and only on AlphaUSD.approve
 * (with the desk as spender) and CreationDesk.placeOrder. Anything past the
 * budget or outside the scope is refused by the chain itself, not by our code.
 *
 * Two halves: the run recorded by evm/scripts/tempo-sip.mjs, with its
 * transactions and a live read of that key's remaining budget; and the same thing
 * run in this browser, with a passkey as the investor and the house as keeper.
 */

const chain = tempoModerato.extend({ feeToken: TEMPO_PATH_USD });
const fmt = (v: bigint | null | undefined) => (v == null ? "—" : quantity(fromRaw(v, 6), 2));
const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";

function readClient(d: Deployment) {
  return createClient({ chain, transport: http(d.rpc, { timeout: 15_000 }) }).extend(publicActions);
}

type Budget = { remaining: bigint; periodEnd?: bigint; revoked?: boolean; expiry?: bigint } | null;

function useBudget(d: Deployment, account: Address | null | undefined, key: Address | null | undefined, tick = 0) {
  const [budget, setBudget] = useState<Budget>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!account || !key) return;
    let live = true;
    const client = readClient(d);
    const alpha = d.stable.address as Address;
    void Promise.all([
      Actions.accessKey.getRemainingLimit(client, { account, accessKey: key, token: alpha }),
      Actions.accessKey.getMetadata(client, { account, accessKey: key }).catch(() => null),
    ])
      .then(([lim, meta]) => {
        if (!live) return;
        setBudget({ remaining: lim.remaining, periodEnd: lim.periodEnd, revoked: meta?.isRevoked, expiry: meta?.expiry });
        setError(false);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [d, account, key, tick]);
  return { budget, error };
}

export function TempoSip({ d }: { d: Deployment }) {
  return (
    <div>
      <div className="max-w-[60rem]">
        <p className="text-xs text-ink-3">Tempo-native</p>
        <h2 className="display mt-2 text-title text-ink">A monthly plan the chain enforces</h2>
        <p className="mt-4 max-w-[66ch] text-base leading-relaxed text-ink-2">
          On Tempo a monthly plan is not an allowance a server promises to respect. It is an access key: the investor signs once, the keeper may
          spend {fromRaw(TEMPO_SIP.limit, 6)} AlphaUSD every 30 days, and only on two calls, <span className="tnum">AlphaUSD.approve</span> with
          the desk as spender and <span className="tnum">CreationDesk.placeOrder</span>. Ask for more, or call anything else, and the chain refuses.
          Gas is paid in pathUSD, a dollar, because Tempo has no gas token.
        </p>
      </div>
      <div className="mt-10 grid gap-8 [&>*]:min-w-0 lg:grid-cols-2">
        <Recorded d={d} />
        <LiveSip d={d} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- recorded

function Recorded({ d }: { d: Deployment }) {
  const sip = d.sip;
  const { budget, error } = useBudget(d, d.deployer as Address | undefined, sip?.keeperKey as Address | undefined);
  if (!sip) return null;
  const rows: { label: string; detail: string; hash?: string; refused?: string }[] = [
    {
      label: "Investor signs one key authorization",
      detail: `Keeper ${shortAddress(sip.keeperKey, 6, 4)} may spend ${sip.limitPerPeriod} per 30 days, scoped to approve(desk) and placeOrder.`,
      hash: sip.authorizeTx,
    },
    {
      label: "Keeper places the month's instalment",
      detail: `approve + placeOrder in one atomic Tempo transaction: 1 MAG8 at 10.10 AlphaUSD, order #${sip.orderId}, then filled in kind.`,
      hash: sip.instalmentTx,
    },
    {
      label: "Keeper asks for 20 more",
      detail: "Only 14.90 AlphaUSD was left in the period. Rejected before it could be included, so no transaction exists.",
      refused: "SpendingLimitExceeded",
    },
    {
      label: "Keeper tries AlphaUSD.transfer",
      detail: "A call outside the scope. Rejected the same way.",
      refused: "CallNotAllowed",
    },
  ];
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base text-ink">The recorded run</h3>
        <span className="text-xs text-ink-3">{new Date(sip.at).toUTCString().slice(5, 22)} UTC</span>
      </div>
      <p className="mt-1 text-xs text-ink-3">evm/scripts/tempo-sip.mjs, against Tempo Moderato</p>
      <ol className="mt-5 space-y-4">
        {rows.map((r, i) => (
          <li key={r.label} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 text-sm">
            <span
              aria-hidden
              className={`mt-0.5 grid size-5 place-items-center rounded-full text-[10px] ${r.refused ? "bg-loss text-white" : "bg-gain text-white"}`}
            >
              {r.refused ? "×" : i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-ink">{r.label}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{r.detail}</p>
              <p className="tnum mt-1 text-xs">
                {r.hash ? (
                  <a href={`${d.explorer}/tx/${r.hash}`} target="_blank" rel="noreferrer" className={`text-ink-2 ${link}`}>
                    {shortAddress(r.hash, 10, 6)}
                  </a>
                ) : (
                  <span className="text-loss">Refused: {r.refused}</span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-control)] bg-line text-sm">
        <div className="bg-raised p-3">
          <p className="text-xs text-ink-3">Left this period, live</p>
          <p className="tnum display mt-1 text-xl text-ink">{error ? "unreadable" : budget ? `${fmt(budget.remaining)} AlphaUSD` : "reading"}</p>
        </div>
        <div className="bg-raised p-3">
          <p className="text-xs text-ink-3">Resets</p>
          <p className="tnum display mt-1 text-xl text-ink">
            {budget?.periodEnd ? new Date(Number(budget.periodEnd) * 1000).toISOString().slice(0, 10) : "—"}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        Read from Tempo&apos;s AccountKeychain precompile (<span className="tnum">getRemainingLimitWithPeriod</span>) for investor{" "}
        {shortAddress(d.deployer ?? "", 6, 4)} and that keeper key.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------- live

type StoredRoot = { kind: "passkey"; id: string; publicKey: Hex } | { kind: "local"; privateKey: Hex };
const STORE = "sheaf:tempo-sip-root";

function loadRoot(): StoredRoot | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as StoredRoot) : null;
  } catch {
    return null;
  }
}

function accountFrom(root: StoredRoot) {
  return root.kind === "passkey" ? Account.fromWebAuthnP256({ id: root.id, publicKey: root.publicKey }) : Account.fromP256(root.privateKey);
}

type LogLine = { label: string; ok: boolean; hash?: string; note?: string };

function LiveSip({ d }: { d: Deployment }) {
  const [root, setRoot] = useState<StoredRoot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [balances, setBalances] = useState<{ alpha: bigint; path: bigint; shares: bigint } | null>(null);

  useEffect(() => {
    void Promise.resolve().then(() => setRoot(loadRoot()));
  }, []);

  const account = useMemo(() => (root ? accountFrom(root) : null), [root]);
  const house = d.deployer as Address;
  const { budget } = useBudget(d, account?.address, house, tick);
  const basket = d.baskets[0];

  const refresh = useCallback(async () => {
    if (!account) return;
    const c = readClient(d);
    const [alpha, path, shares] = await Promise.all([
      c.readContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      c.readContract({ address: TEMPO_PATH_USD, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      c.readContract({ address: basket.address as Address, abi: BASKET_ABI, functionName: "balanceOf", args: [account.address] }),
    ]);
    setBalances({ alpha, path, shares });
    setTick((t) => t + 1);
  }, [account, d, basket]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh().catch(() => undefined));
  }, [refresh]);

  const push = (l: LogLine) => setLog((prev) => [...prev, l]);

  async function step(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await refresh().catch(() => undefined);
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string; details?: string };
      setError((e.details || e.shortMessage || e.message || "failed").split("\n")[0].slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  const create = (kind: "passkey" | "local") =>
    step("create", async () => {
      let next: StoredRoot;
      if (kind === "passkey") {
        const cred = await WebAuthnP256.createCredential({ label: `Sheaf SIP ${new Date().toISOString().slice(0, 10)}` });
        next = { kind: "passkey", id: cred.id, publicKey: cred.publicKey };
      } else {
        next = { kind: "local", privateKey: P256.randomPrivateKey() };
      }
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        // Private mode: the plan lives as long as the tab.
      }
      setLog([]);
      setRoot(next);
      push({ label: kind === "passkey" ? "Passkey created; its public key is the account" : "Key created in this browser", ok: true });
    });

  const fund = () =>
    step("fund", async () => {
      const res = await fetch("/api/evm-faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, address: account!.address }),
      });
      const json = (await res.json()) as { txs?: { hash: string }[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? "faucet failed");
      await new Promise((r) => setTimeout(r, 1500));
      push({ label: "Funded from Tempo's faucet (pathUSD for fees, AlphaUSD to invest)", ok: true, hash: json.txs?.[1]?.hash ?? json.txs?.[0]?.hash });
    });

  const authorize = () =>
    step("authorize", async () => {
      const client = createClient({ account: account!, chain, transport: http(d.rpc, { timeout: 30_000 }) }).extend(publicActions);
      const res = await Actions.accessKey.authorizeSync(client, {
        accessKey: { accessKeyAddress: house, keyType: "secp256k1" },
        expiry: Math.floor(Date.now() / 1000) + 90 * 86_400,
        limits: [
          { token: d.stable.address as Address, limit: TEMPO_SIP.limit, period: TEMPO_SIP.period },
          { token: TEMPO_PATH_USD, limit: TEMPO_SIP.feeLimit, period: TEMPO_SIP.period },
        ],
        scopes: [
          { address: d.stable.address as Address, selector: "approve(address,uint256)", recipients: [d.desk as Address] },
          { address: d.desk as Address, selector: "placeOrder(address,uint256,uint256,uint96)" },
        ],
      });
      push({ label: `Plan signed once: ${fromRaw(TEMPO_SIP.limit, 6)} AlphaUSD per 30 days, two calls only`, ok: true, hash: res.receipt.transactionHash });
    });

  const keeper = (action: "instalment" | "overspend" | "outOfScope") =>
    step(action, async () => {
      const res = await fetch("/api/evm-keeper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, sip: { account: account!.address, action } }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        hash?: string;
        orderId?: number;
        refusal?: string;
        fill?: { status: string; hash?: string; reason?: string };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "keeper failed");
      const label =
        action === "instalment"
          ? json.ok
            ? `Keeper placed this month's ${fromRaw(TEMPO_SIP.instalment, 6)} AlphaUSD instalment, order #${json.orderId}`
            : "Keeper tried this month's instalment"
          : action === "overspend"
            ? `Keeper asked for ${fromRaw(TEMPO_SIP.overspend, 6)} AlphaUSD more`
            : "Keeper tried AlphaUSD.transfer, outside the scope";
      push({ label, ok: !!json.ok, hash: json.hash, note: json.ok ? undefined : `Refused by the chain: ${json.refusal}` });
      if (json.fill) {
        push({
          label: json.fill.status === "filled" ? `Order filled in kind: 1 ${basket.symbol} minted to the plan` : `Fill: ${json.fill.reason ?? json.fill.status}`,
          ok: json.fill.status === "filled",
          hash: json.fill.hash,
        });
      }
    });

  const revoke = () =>
    step("revoke", async () => {
      const client = createClient({ account: account!, chain, transport: http(d.rpc, { timeout: 30_000 }) }).extend(publicActions);
      const res = await Actions.accessKey.revokeSync(client, { accessKey: house });
      push({ label: "Plan revoked by the investor", ok: true, hash: res.receipt.transactionHash });
    });

  const reset = () => {
    try {
      localStorage.removeItem(STORE);
    } catch {
      // ignore
    }
    setRoot(null);
    setLog([]);
    setBalances(null);
    setError(null);
  };

  const funded = (balances?.path ?? 0n) > 0n && (balances?.alpha ?? 0n) > 0n;
  const authorized = !!budget && !budget.revoked && (budget.expiry ?? 0n) > 0n;
  const revoked = !!budget?.revoked;

  return (
    <div className="rounded-[var(--radius-panel)] border border-ink bg-surface p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base text-ink">Run it in this browser</h3>
        {root && (
          <button type="button" onClick={reset} className="text-xs text-ink-3 hover:text-ink">
            Start over
          </button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        You are the investor, with a passkey as your Tempo account. The house key {shortAddress(house, 6, 4)} is the keeper. Free testnet dollars
        only.
      </p>

      {!root ? (
        <div className="mt-5 space-y-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void create("passkey")}
            className="w-full rounded-[var(--radius-control)] bg-bind px-4 py-3 text-sm font-medium text-white hover:bg-bind-deep disabled:opacity-50"
          >
            {busy === "create" ? "Waiting for the passkey…" : "1. Create a plan with a passkey"}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void create("local")}
            className="w-full rounded-[var(--radius-control)] border border-line-strong px-4 py-2.5 text-sm text-ink hover:border-ink-3 disabled:opacity-50"
          >
            No passkey here? Use a throwaway key in this browser
          </button>
        </div>
      ) : (
        <>
          <dl className="tnum mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Stat label="Plan account" value={shortAddress(account!.address, 6, 4)} href={`${d.explorer}/address/${account!.address}`} />
            <Stat label="Budget left" value={revoked ? "revoked" : authorized ? `${fmt(budget?.remaining)}` : "—"} />
            <Stat label="AlphaUSD" value={fmt(balances?.alpha)} />
            <Stat label={`${basket.symbol} held`} value={balances ? quantity(fromRaw(balances.shares), 2) : "—"} />
          </dl>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <SipButton n={2} label="Fund from Tempo's faucet" done={funded} busy={busy === "fund"} disabled={!!busy} onClick={fund} />
            <SipButton n={3} label="Sign the plan, once" done={authorized || revoked} busy={busy === "authorize"} disabled={!!busy || !funded || authorized || revoked} onClick={authorize} />
            <SipButton n={4} label="Keeper: this month's instalment" busy={busy === "instalment"} disabled={!!busy || !(authorized || revoked)} onClick={() => keeper("instalment")} />
            <SipButton n={5} label="Keeper: try to overspend" busy={busy === "overspend"} disabled={!!busy || !(authorized || revoked)} onClick={() => keeper("overspend")} />
            <SipButton n={6} label="Keeper: call outside the scope" busy={busy === "outOfScope"} disabled={!!busy || !(authorized || revoked)} onClick={() => keeper("outOfScope")} />
            <SipButton n={7} label="Revoke the plan" done={revoked} busy={busy === "revoke"} disabled={!!busy || !authorized} onClick={revoke} quiet />
          </div>
          {budget?.periodEnd != null && authorized && (
            <p className="tnum mt-3 text-xs text-ink-3">Budget resets {new Date(Number(budget.periodEnd) * 1000).toISOString().slice(0, 10)}.</p>
          )}
        </>
      )}

      {log.length > 0 && (
        <ol className="mt-5 space-y-2 border-t border-line pt-4 text-sm">
          {log.map((l, i) => (
            <li key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5">
              <span aria-hidden className={`mt-0.5 grid size-4 place-items-center rounded-full text-[9px] text-white ${l.ok ? "bg-gain" : "bg-loss"}`}>
                {l.ok ? "✓" : "×"}
              </span>
              <span className="min-w-0">
                <span className="text-ink-2">{l.label}</span>
                {l.note && <span className="block text-xs text-loss">{l.note}</span>}
                {l.hash && (
                  <a href={`${d.explorer}/tx/${l.hash}`} target="_blank" rel="noreferrer" className={`tnum block text-xs text-ink-3 ${link}`}>
                    {shortAddress(l.hash, 10, 6)}
                  </a>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="mt-3 text-sm text-loss">{error}</p>}
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-[8px] bg-raised px-2.5 py-2">
      <dt className="truncate text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-ink">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function SipButton({
  n,
  label,
  onClick,
  disabled,
  busy,
  done,
  quiet,
}: {
  n: number;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  done?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        quiet ? "border-line text-ink-2 hover:border-line-strong" : "border-line-strong text-ink hover:border-bind"
      }`}
    >
      <span
        aria-hidden
        className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${done ? "bg-gain text-white" : busy ? "pulse bg-bind text-white" : "border border-line-strong text-ink-3"}`}
      >
        {done ? "✓" : n}
      </span>
      {busy ? "Working…" : label}
    </button>
  );
}
