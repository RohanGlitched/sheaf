"use client";

import { useState } from "react";
import { encodeFunctionData, formatEther, parseEventLogs, type Address, type Hex } from "viem";
import type { ChainBasket, Deployment } from "@/lib/chains";
import {
  BASKET_ABI,
  DESK_ABI,
  ERC20_ABI,
  MIRROR_ABI,
  ONE_SHARE,
  explainEvmError,
  fromRaw,
  gasSymbol,
  isTempo,
  mintAmounts,
  redeemAmounts,
  toShares,
} from "@/lib/evm";
import { money, quantity, shortAddress } from "@/lib/format";
import { EvmConnect, StepList, type EvmWallet, type Step, type StepState } from "./evm-wallet";
import type { BasketReads } from "./evm-basket";

type Mode = "tokens" | "create" | "redeem" | "cash";

const TABS: { mode: Mode; label: string }[] = [
  { mode: "tokens", label: "Test tokens" },
  { mode: "create", label: "In kind" },
  { mode: "redeem", label: "Redeem" },
  { mode: "cash", label: "With dollars" },
];

/** The house drips gas on these; elsewhere a visitor brings their own. */
const DRIP_CHAINS = new Set(["robinhoodTestnet", "arbitrumSepolia", "baseSepolia"]);
const MIRROR_FAUCET_SHARES = 2n * ONE_SHARE;
const MIRROR_DOLLARS = 50_000_000n; // 50 test dollars, 6 decimals
/** A dollar order offers this much over the live value, so a filler is not short by a tick. */
const CASH_BUFFER = 1.01;

const inAnHour = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

type KeeperResult = { status: "filled" | "skipped" | "failed"; reason?: string; hash?: Hex };

export function EvmTradePanel({
  d,
  basket,
  wallet,
  reads,
  nav,
  onDone,
}: {
  d: Deployment;
  basket: ChainBasket;
  wallet: EvmWallet;
  reads: BasketReads | null;
  nav: number | null;
  onDone: () => void;
}) {
  const real = d.tokenSource === "real";
  const [mode, setMode] = useState<Mode>("tokens");
  const [amount, setAmount] = useState(real ? "0.1" : "1");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverTxs, setServerTxs] = useState<{ label: string; hash: Hex }[]>([]);
  const [order, setOrder] = useState<{ id: number; keeper?: KeeperResult | null } | null>(null);

  const user = reads?.user ?? null;
  const shares = toShares(amount);
  const ready = !!wallet.address && wallet.onChain;

  const reset = () => {
    setSteps([]);
    setError(null);
    setNotice(null);
    setServerTxs([]);
    setOrder(null);
  };

  async function run(build: () => Promise<Step[]> | Step[], after?: (receipts: Awaited<ReturnType<EvmWallet["send"]>>) => Promise<void> | void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const list = await build();
      if (list.length === 0) {
        setNotice("Nothing to send.");
        return;
      }
      const receipts = await wallet.send(list, setSteps);
      await after?.(receipts);
      onDone();
    } catch (err) {
      setError(explainEvmError(err));
    } finally {
      setBusy(false);
    }
  }

  async function callFaucet() {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setServerTxs([]);
    try {
      const res = await fetch("/api/evm-faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, address: wallet.address, basket: basket.symbol }),
      });
      const json = (await res.json()) as { txs?: { label: string; hash: Hex }[]; notes?: string[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `faucet failed (${res.status})`);
      setServerTxs(json.txs ?? []);
      setNotice((json.notes ?? []).join(" ") || null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- steps

  const mirrorFaucetSteps = (): Step[] => {
    const need = mintAmounts(basket, MIRROR_FAUCET_SHARES);
    const list: Step[] = basket.components.map((c, i) => ({
      label: `Mint ${quantity(fromRaw(need[i]), 4)} ${c.symbol} mirror`,
      to: c.token as Address,
      data: encodeFunctionData({ abi: MIRROR_ABI, functionName: "faucet", args: [need[i]] }),
    }));
    if (d.stable.isMirror) {
      list.push({
        label: `Mint 50 ${d.stable.symbol}`,
        to: d.stable.address as Address,
        data: encodeFunctionData({ abi: MIRROR_ABI, functionName: "faucet", args: [MIRROR_DOLLARS] }),
      });
    }
    return list;
  };

  const createSteps = (): Step[] => {
    if (!shares || !wallet.address) return [];
    const need = mintAmounts(basket, shares);
    const list: Step[] = [];
    basket.components.forEach((c, i) => {
      if ((user?.basketAllowance[i] ?? 0n) < need[i]) {
        list.push({
          label: `Approve ${c.symbol}`,
          to: c.token as Address,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [basket.address as Address, need[i]] }),
        });
      }
    });
    list.push({
      label: `Create ${amount} ${basket.symbol}`,
      to: basket.address as Address,
      data: encodeFunctionData({ abi: BASKET_ABI, functionName: "mint", args: [shares, wallet.address] }),
    });
    return list;
  };

  const redeemSteps = (): Step[] =>
    shares && wallet.address
      ? [
          {
            label: `Redeem ${amount} ${basket.symbol}`,
            to: basket.address as Address,
            data: encodeFunctionData({ abi: BASKET_ABI, functionName: "redeem", args: [shares, wallet.address] }),
          },
        ]
      : [];

  const cashCost = shares && nav != null ? BigInt(Math.ceil(nav * fromRaw(shares) * CASH_BUFFER * 10 ** d.stable.decimals)) : null;

  const cashSteps = (): Step[] => {
    if (!shares || cashCost == null) return [];
    const list: Step[] = [];
    if ((user?.deskAllowance ?? 0n) < cashCost) {
      list.push({
        label: `Approve ${fromRaw(cashCost, d.stable.decimals).toFixed(2)} ${d.stable.symbol}`,
        to: d.stable.address as Address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [d.desk as Address, cashCost] }),
      });
    }
    const expiry = inAnHour();
    list.push({
      label: `Order ${amount} ${basket.symbol} on the desk`,
      to: d.desk as Address,
      data: encodeFunctionData({ abi: DESK_ABI, functionName: "placeOrder", args: [basket.address as Address, shares, cashCost, expiry] }),
    });
    return list;
  };

  async function afterOrder(receipts: Awaited<ReturnType<EvmWallet["send"]>>) {
    const placed = receipts.flatMap((r) => parseEventLogs({ abi: DESK_ABI, logs: r.logs, eventName: "OrderPlaced" }));
    const id = placed[0] ? Number(placed[0].args.id) : null;
    if (id == null) return;
    setOrder({ id, keeper: null });
    onDone();
    try {
      const res = await fetch("/api/evm-keeper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ network: d.network, order: id }),
      });
      const json = (await res.json()) as { results?: KeeperResult[]; error?: string };
      const r = json.results?.[0] ?? { status: "skipped" as const, reason: json.error ?? "the house filler did not pick it up" };
      setOrder({ id, keeper: r });
    } catch {
      setOrder({ id, keeper: { status: "skipped", reason: "the house filler could not be reached" } });
    }
  }

  // ------------------------------------------------------------- derived

  const need = shares ? mintAmounts(basket, shares) : basket.components.map(() => 0n);
  const back = shares ? redeemAmounts(basket, shares) : basket.components.map(() => 0n);
  const short = user ? basket.components.filter((_, i) => user.components[i] < need[i]).map((c) => c.symbol) : [];
  const fee = shares ? (shares * BigInt(basket.feeBps)) / 10_000n : 0n;
  const gasLow = user ? (isTempo(d) ? user.gas < 10_000n : user.gas < 2_000_000_000_000n) : false;

  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="p-2">
        <div className="grid grid-cols-4 gap-1 rounded-[var(--radius-control)] bg-sunk p-1" role="tablist" aria-label="What to do">
          {TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={mode === tab.mode}
              onClick={() => {
                setMode(tab.mode);
                reset();
              }}
              className={`rounded-[8px] px-1.5 py-2 text-[13px] transition-all ${
                mode === tab.mode ? "bg-surface text-ink shadow-[0_1px_3px_rgb(20_37_28/0.15)]" : "text-ink-3 hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-6 pt-3">
        <EvmConnect wallet={wallet} d={d} />
        {wallet.error && <p className="mt-3 text-sm text-loss">{wallet.error}</p>}

        {ready && user && (
          <dl className="tnum mt-4 grid grid-cols-3 gap-2 text-xs">
            <Bal label={basket.symbol} value={quantity(fromRaw(user.shares), 4)} />
            <Bal label={d.stable.symbol} value={quantity(fromRaw(user.stable, d.stable.decimals), 2)} />
            <Bal
              label={`${gasSymbol(d)} for gas`}
              value={isTempo(d) ? quantity(fromRaw(user.gas, 6), 2) : Number(formatEther(user.gas)).toPrecision(2)}
              warn={gasLow}
            />
          </dl>
        )}

        {mode === "tokens" && (
          <div className="mt-5 space-y-4 text-sm leading-relaxed text-ink-2">
            {real ? (
              <>
                <p>
                  Robinhood&apos;s stock tokens can only be minted by Robinhood. The house sends a small slice of its own: enough for a quarter
                  share of {basket.symbol}, a few USDG for a dollar order, and a drip of gas if the wallet is empty.
                </p>
                <ActionButton disabled={!ready || busy} onClick={() => void callFaucet()}>
                  {busy ? "Sending…" : "Send me test tokens"}
                </ActionButton>
                <p className="text-xs text-ink-3">
                  Or bring your own:{" "}
                  <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                    Robinhood&apos;s faucet
                  </a>{" "}
                  gives 5 of each stock token a day, and this page binds them below.
                </p>
              </>
            ) : (
              <>
                <p>
                  {isTempo(d)
                    ? "First, Tempo's own faucet: pathUSD pays the fees (Tempo has no gas token) and AlphaUSD pays for dollar orders."
                    : DRIP_CHAINS.has(d.network)
                      ? "First, a drip of test ETH for gas, if the wallet is nearly empty."
                      : "Bring a little Sepolia ETH for gas; the house has none to spare here."}
                </p>
                {(isTempo(d) || DRIP_CHAINS.has(d.network)) && (
                  <ActionButton disabled={!ready || busy} onClick={() => void callFaucet()} quiet>
                    {busy ? "Asking…" : isTempo(d) ? "1. Fund from Tempo's faucet" : "1. Drip gas"}
                  </ActionButton>
                )}
                {d.network === "sepolia" && (
                  <p className="text-xs text-ink-3">
                    Sepolia faucets:{" "}
                    <a href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                      Google Cloud
                    </a>
                    ,{" "}
                    <a href="https://sepolia-faucet.pk910.de" target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                      PoW faucet
                    </a>
                    .
                  </p>
                )}
                <p>
                  Then mint the mirrors yourself: every one has a public <span className="tnum">faucet()</span>, so your own wallet calls it
                  and no key of ours is involved. Enough for two shares{d.stable.isMirror ? `, plus 50 ${d.stable.symbol}` : ""}.
                </p>
                <ActionButton disabled={!ready || busy} onClick={() => void run(mirrorFaucetSteps)}>
                  {busy ? "Working…" : `2. Mint the ${basket.components.length} mirrors${d.stable.isMirror ? " and dollars" : ""}`}
                </ActionButton>
              </>
            )}
          </div>
        )}

        {(mode === "create" || mode === "redeem" || mode === "cash") && (
          <div className="mt-5">
            <label className="block">
              <span className="text-xs text-ink-3">
                {mode === "create" ? "Shares to create" : mode === "redeem" ? "Shares to redeem" : "Shares to buy with dollars"}
              </span>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setSteps([]);
                  }}
                  className="tnum display w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-3 text-xl text-ink outline-none focus-visible:border-bind"
                />
                {mode === "redeem" && user && user.shares > 0n && (
                  <button
                    type="button"
                    onClick={() => setAmount((Math.floor(fromRaw(user.shares) * 1e6) / 1e6).toString())}
                    className="shrink-0 rounded-[var(--radius-control)] border border-line px-3 py-3 text-xs text-ink-2 hover:border-line-strong hover:text-ink"
                  >
                    All
                  </button>
                )}
              </div>
            </label>

            {mode === "create" && (
              <>
                <Rows
                  title="You deposit"
                  rows={basket.components.map((c, i) => ({ symbol: c.symbol, amount: need[i], have: user?.components[i], short: !!user && user.components[i] < need[i] }))}
                />
                <p className="tnum mt-3 text-xs text-ink-3">
                  You receive {shares ? quantity(fromRaw(shares - fee), 6) : "—"} {basket.symbol}
                  {basket.feeBps > 0 && ` after the ${basket.feeBps / 100}% creator fee`}
                  {nav != null && shares ? `, worth ${money(nav * fromRaw(shares - fee))}` : ""}.
                </p>
                <ActionButton
                  className="mt-4"
                  disabled={!ready || busy || !shares || !user || short.length > 0}
                  onClick={() => void run(createSteps)}
                >
                  {busy ? "Working…" : short.length > 0 && ready ? `Short of ${short.join(", ")}` : `Create ${basket.symbol}`}
                </ActionButton>
                <p className="mt-2 text-xs text-ink-3">
                  One approval per component the basket cannot already pull, then the mint. A wallet that batches (EIP-5792) signs it all once.
                </p>
              </>
            )}

            {mode === "redeem" && (
              <>
                <Rows title="You receive" rows={basket.components.map((c, i) => ({ symbol: c.symbol, amount: back[i] }))} />
                <ActionButton
                  className="mt-4"
                  disabled={!ready || busy || !shares || (user ? user.shares < shares : true)}
                  onClick={() => void run(redeemSteps)}
                >
                  {busy ? "Working…" : user && shares && user.shares < shares ? `You hold ${quantity(fromRaw(user.shares), 4)}` : `Redeem ${basket.symbol}`}
                </ActionButton>
                <p className="mt-2 text-xs text-ink-3">Burns the shares first, then the vault pays out, rounding down. No approval needed.</p>
              </>
            )}

            {mode === "cash" && (
              <>
                <div className="mt-5 rounded-[var(--radius-control)] bg-raised p-4 text-sm">
                  <div className="flex items-baseline justify-between">
                    <span className="text-ink-3">You escrow</span>
                    <span className="tnum display text-xl text-ink">
                      {cashCost != null ? `${fromRaw(cashCost, d.stable.decimals).toFixed(2)} ${d.stable.symbol}` : "—"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-3">
                    The live value plus 1%, held by the desk contract until a participant delivers the components in kind. The shares are minted
                    straight to you; cancel any time before then and the dollars come back.
                  </p>
                </div>
                <ActionButton
                  className="mt-4"
                  disabled={!ready || busy || !shares || cashCost == null || (user ? user.stable < cashCost : true)}
                  onClick={() => void run(cashSteps, afterOrder)}
                >
                  {busy
                    ? order
                      ? "Waiting for a filler…"
                      : "Working…"
                    : cashCost == null
                      ? "No live price to quote"
                      : user && user.stable < cashCost
                        ? `Needs ${fromRaw(cashCost, d.stable.decimals).toFixed(2)} ${d.stable.symbol}`
                        : `Order with ${d.stable.symbol}`}
                </ActionButton>
                {order && (
                  <div className="mt-4 rounded-[var(--radius-control)] border border-line p-3 text-sm">
                    <p className="text-ink">Order #{order.id} placed.</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-3">
                      {order.keeper == null ? (
                        "Asking the house filler…"
                      ) : order.keeper.status === "filled" ? (
                        <>
                          Filled by the house:{" "}
                          <a href={`${d.explorer}/tx/${order.keeper.hash}`} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:text-ink">
                            {shortAddress(order.keeper.hash ?? "", 6, 4)}
                          </a>
                          . The shares are in your wallet.
                        </>
                      ) : (
                        <>Still open for any participant: the house left it because {order.keeper.reason ?? "it could not fill it"}.</>
                      )}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <StepList steps={steps} d={d} />
        {serverTxs.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs text-ink-3">
            {serverTxs.map((t) => (
              <li key={t.hash} className="flex justify-between gap-3">
                <span>{t.label}</span>
                <a href={`${d.explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer" className="tnum underline decoration-line-strong underline-offset-4 hover:text-ink">
                  {shortAddress(t.hash, 6, 4)}
                </a>
              </li>
            ))}
          </ul>
        )}
        {notice && <p className="mt-3 text-xs leading-relaxed text-ink-3">{notice}</p>}
        {error && <p className="mt-3 text-sm text-loss">{error}</p>}
      </div>
    </div>
  );
}

function Bal({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-[8px] bg-raised px-2.5 py-2">
      <dt className="truncate text-ink-3">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm ${warn ? "text-loss" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

function Rows({ title, rows }: { title: string; rows: { symbol: string; amount: bigint; have?: bigint; short?: boolean }[] }) {
  return (
    <div className="mt-5">
      <p className="text-xs text-ink-3">{title}</p>
      <ul className="mt-2 divide-y divide-line/60 rounded-[var(--radius-control)] border border-line text-sm">
        {rows.map((r) => (
          <li key={r.symbol} className="tnum flex items-baseline justify-between gap-3 px-3 py-2">
            <span className="text-ink">{r.symbol}</span>
            <span className={r.short ? "text-loss" : "text-ink-2"}>
              {quantity(fromRaw(r.amount), 6)}
              {r.have != null && <span className="ml-2 text-xs text-ink-3">have {quantity(fromRaw(r.have), 4)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  quiet,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  quiet?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-[var(--radius-control)] px-4 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        quiet ? "border border-line-strong bg-surface text-ink hover:border-ink-3" : "bg-bind text-white hover:bg-bind-deep"
      } ${className}`}
    >
      {children}
    </button>
  );
}
