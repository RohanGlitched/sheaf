"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

type Market = {
  marketId: string;
  title: string;
  phase: string;
  yesPrice: string | null;
  noPrice: string | null;
  volumeUsdc: string;
  endTime: string;
};

type CreateQuote = {
  paymentUsdc: string;
  liquidityInjectionUsdc?: string;
  platformRevenueUsdc?: string;
  draft: { question: string; resolutionRule: string; sourcesOfTruth: string[]; startTime: number; endTime: number };
  mode: "live" | "sandbox";
};

type BuyQuote = { shares: string; amountUsdc: string; feeUsdc: string; side: "yes" | "no"; mode: "live" | "sandbox" };

const usdc = (base: string | undefined) => (base ? (Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—");
const cents = (p: string | null) => (p == null ? "—" : `${Math.round(Number(p) * 100)}¢`);
const day = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/**
 * "Will this basket beat SPY this week?" as a Panta prediction market.
 *
 * Sheaf writes the question and a resolution rule anyone can check (the vault's
 * value against SPY's close), and asks Panta what opening it would cost and what a
 * buy would get. Quotes never sign or spend anything.
 */
export function BasketPredict({ basket, name, symbol, creator }: { basket: string; name: string; symbol: string; creator: string }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? creator;
  const [mode, setMode] = useState<"live" | "sandbox" | "off" | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [create, setCreate] = useState<CreateQuote | null>(null);
  const [buy, setBuy] = useState<BuyQuote | null>(null);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("20");
  const [busy, setBusy] = useState<"create" | "buy" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/panta")
      .then((r) => r.json())
      .then((j: { mode: typeof mode; markets: Market[] }) => {
        if (!live) return;
        setMode(j.mode);
        setMarket(j.markets.find((m) => m.title.toLowerCase().includes(name.toLowerCase())) ?? j.markets[0] ?? null);
      })
      .catch(() => live && setMode("off"));
    return () => {
      live = false;
    };
  }, [name]);

  async function post<T>(payload: Record<string, string>): Promise<T | null> {
    setError(null);
    const res = await fetch("/api/panta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json();
    if (!res.ok) {
      setError(j.error ?? "Panta did not answer.");
      return null;
    }
    return j as T;
  }

  async function quoteCreate() {
    setBusy("create");
    const q = await post<CreateQuote>({ kind: "create", wallet, basket, name, symbol });
    if (q) setCreate(q);
    setBusy(null);
  }

  async function quoteBuy() {
    if (!market) return;
    setBusy("buy");
    const q = await post<BuyQuote>({ kind: "buy", wallet, marketId: market.marketId, side, amountUsdc: amount });
    if (q) setBuy(q);
    setBusy(null);
  }

  if (mode === "off") return null;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
      <div>
        <p className="text-sm text-bind">Prediction market</p>
        <h2 className="display mt-2 text-title max-w-[18ch] text-ink">Will {name} beat SPY this week?</h2>
        <p className="mt-5 max-w-[44ch] text-base leading-relaxed text-ink-2">
          A basket has a value anyone can read from its vault, so a bet on it can be settled without
          trusting anyone&apos;s price. Sheaf writes the question and the rule. Panta runs the market on
          Solana, priced on a bonding curve and paid in USDC.
        </p>
        <a
          href="https://panta.market"
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-3.5 py-1.5 text-sm text-ink hover:border-ink-3"
        >
          <span className="size-2 rounded-full bg-ink" aria-hidden />
          Powered by Panta
        </a>
        {mode === "sandbox" && (
          <p className="mt-4 max-w-[46ch] text-xs leading-relaxed text-ink-3">
            Running against Panta&apos;s sandbox: every quote below is a real API answer from Panta&apos;s test
            fixtures, and nothing reaches mainnet or spends USDC.
          </p>
        )}
      </div>

      <div className="rounded-[var(--radius-panel)] border border-line bg-surface">
        <div className="border-b border-line p-6">
          <p className="text-xs text-ink-3">The question</p>
          <p className="mt-1.5 text-lg text-ink">Will the {name} basket ({symbol}) beat SPY this week?</p>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Resolves YES if one {symbol} share, valued from its vault at the close, rose more than SPY
            over the same week.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={quoteCreate}
              disabled={busy != null}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2.5 text-sm font-medium text-page transition-colors hover:bg-[#23382c] disabled:opacity-60"
            >
              {busy === "create" ? "Asking Panta…" : create ? "Quote it again" : "Price this market"}
            </button>
            {create && (
              <p className="tnum text-sm text-ink-2">
                Opening it costs <span className="text-ink">{usdc(create.paymentUsdc)} USDC</span>:{" "}
                {usdc(create.liquidityInjectionUsdc)} seeds the curve, {usdc(create.platformRevenueUsdc)} to Panta.
                Runs {day(create.draft.startTime)} to {day(create.draft.endTime)}.
              </p>
            )}
          </div>
        </div>

        {market && (
          <div className="p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-xs text-ink-3">
                {mode === "sandbox" ? "Sandbox market" : "Live market"} · {market.title}
              </p>
              <p className="tnum text-xs text-ink-3">{usdc(String(Number(market.volumeUsdc) * 1e6))} USDC traded</p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Side">
              {(["yes", "no"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  onClick={() => {
                    setSide(s);
                    setBuy(null);
                  }}
                  className={`rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors ${
                    side === s ? "border-bind bg-bind-wash" : "border-line hover:border-line-strong"
                  }`}
                >
                  <span className="block text-sm text-ink">{s === "yes" ? "Yes, it beats SPY" : "No, it trails SPY"}</span>
                  <span className={`tnum mt-1 block text-2xl ${s === "yes" ? "text-gain" : "text-loss"}`}>
                    {cents(s === "yes" ? market.yesPrice : market.noPrice)}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm">
                <span className="text-ink-3">$</span>
                <input
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                    setBuy(null);
                  }}
                  inputMode="decimal"
                  className="tnum w-16 bg-transparent text-ink outline-none"
                  aria-label="Amount in USDC"
                />
              </label>
              <button
                type="button"
                onClick={quoteBuy}
                disabled={busy != null}
                className="rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-60"
              >
                {busy === "buy" ? "Asking Panta…" : `Quote ${side === "yes" ? "Yes" : "No"}`}
              </button>
              {buy && (
                <p className="tnum text-sm text-ink-2">
                  ${buy.amountUsdc} buys <span className="text-ink">{buy.shares} shares</span>, fee ${buy.feeUsdc}
                </p>
              )}
            </div>
          </div>
        )}
        {error && <p className="border-t border-line px-6 py-4 text-sm text-loss">{error}</p>}
      </div>
    </div>
  );
}
