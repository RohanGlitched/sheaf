"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { FixtureTag, PantaSteps, PoweredByPanta, type Step } from "./panta-steps";
import { pantaGet, pantaPost, short, type PantaMode } from "@/lib/panta-client";
import { compileForSigning, signatureOf, type PantaIx } from "@/lib/panta-sign";
import { BrowserWalletName } from "@/lib/browser-wallet";

type Row = {
  marketId: string;
  title: string | null;
  category: string | null;
  side: "yes" | "no";
  shares: string;
  phase: string;
  claimable: boolean;
  claimed: boolean;
  outcome: "yes" | "no" | null;
  spot: number | null;
  valueUsdc: number | null;
};

type Claim = {
  marketId: string;
  build?: { winningShares?: string; outcome?: string; instructions?: PantaIx[]; recentBlockhash?: string; fixture?: boolean };
  sign?: { signature: string; standIn: boolean };
  report?: { status?: string; fixture?: boolean };
  busy?: "build" | "sign" | "report";
  error?: string;
};

const money = (n: number | null) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mono = (s: ReactNode) => <span className="font-mono text-[11px]">{s}</span>;

/**
 * Predictions on /portfolio: the connected wallet's Panta positions
 * (GET /positions/), valued as Panta's docs describe, with a win claim built
 * through POST /claim/build/, signed in the wallet (never sent) and reported
 * through POST /trades/. Requires the connected wallet; nothing is quoted on
 * anyone else's behalf.
 */
export function PantaPositions() {
  const { publicKey, signTransaction, wallet, select, connect } = useWallet();
  const { connection } = useConnection();
  const me = publicKey?.toBase58() ?? null;
  const [mode, setMode] = useState<PantaMode | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fixture, setFixture] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fixtureMarket, setFixtureMarket] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);

  const load = useCallback(async () => {
    if (!me) {
      // Walletless: only the mode, so the preview knows whether Panta is configured.
      const r = await pantaGet<{ mode: PantaMode }>("/api/panta");
      setMode(r.ok ? r.data.mode : "off");
      return;
    }
    const r = await pantaGet<{ mode: PantaMode; fixture?: boolean; positions: Row[] }>(`/api/panta/positions?wallet=${me}`);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setMode(r.data.mode);
    setRows(r.data.positions ?? []);
    setFixture(!!r.data.fixture);
    setError(null);
    if (r.data.mode === "sandbox") {
      const m = await pantaGet<{ markets: { marketId: string }[] }>("/api/panta");
      if (m.ok) setFixtureMarket(m.data.markets[0]?.marketId ?? null);
    }
  }, [me]);

  useEffect(() => {
    void load();
  }, [load]);

  async function step(marketId: string) {
    const c: Claim = claim?.marketId === marketId ? claim : { marketId };
    const next = !c.build ? "build" : !c.sign ? "sign" : !c.report ? "report" : null;
    if (!next || !me) {
      setClaim({ marketId });
      return;
    }
    setClaim({ ...c, busy: next, error: undefined });
    try {
      if (next === "build") {
        const r = await pantaPost<NonNullable<Claim["build"]>>({ kind: "claim-build", wallet: me, marketId });
        if (!r.ok) throw new Error(r.error);
        setClaim({ ...c, build: r.data });
      } else if (next === "sign") {
        if (!publicKey || !signTransaction) throw new Error("This wallet cannot sign without sending.");
        const compiled = await compileForSigning({
          payer: publicKey,
          instructions: c.build?.instructions,
          recentBlockhash: c.build?.recentBlockhash,
          memo: "Sheaf x Panta sandbox: win claim. Signed to show the flow; never sent.",
          connection,
        });
        const signed = await signTransaction(compiled.tx);
        setClaim({ ...c, sign: { signature: signatureOf(signed), standIn: compiled.standIn } });
      } else {
        const r = await pantaPost<NonNullable<Claim["report"]>>({ kind: "buy-report", wallet: me, marketId, signature: c.sign?.signature });
        if (!r.ok) throw new Error(r.error);
        setClaim({ ...c, report: r.data });
      }
    } catch (err) {
      setClaim({ ...c, error: (err as Error).message || "Something went wrong." });
    }
  }

  if (mode === "off") return null;

  // No wallet yet: show what this section is and how to fill it, rather than nothing.
  if (!me) {
    const startBrowserWallet = () => {
      if (wallet?.adapter.name !== BrowserWalletName) {
        select(BrowserWalletName);
        return;
      }
      void connect().catch(() => {
        /* the wallet reports its own rejection */
      });
    };
    return (
      <section className="mt-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="display text-title text-ink">Predictions</h2>
            <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
              Your shares in Panta prediction markets, such as whether a basket beats SPY this week, appear
              here: valued at the side&apos;s current price, and claimable here once a market resolves in
              your favor.
            </p>
          </div>
          <PoweredByPanta />
        </div>
        <div className="mt-7 border border-dashed border-line-strong/60 px-6 py-8">
          <p className="text-ink">Connect a wallet to read its Panta positions.</p>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            Sheaf asks Panta <code className="text-xs">GET /positions/?wallet=&lt;your address&gt;</code> and
            shows what comes back. With no wallet app, one click makes a devnet wallet in this browser, with
            test funds only, and the whole Panta flow on a basket page works with it.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={startBrowserWallet}
              className="rounded-[var(--radius-control)] bg-bind px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep"
            >
              Use a wallet in this browser
            </button>
            <span className="text-xs text-ink-3">or connect Phantom, Solflare or Backpack from the top bar</span>
          </div>
        </div>
      </section>
    );
  }

  const claimSteps = (c: Claim): Step[] => [
    {
      key: "build",
      title: "Build the claim",
      call: "POST /claim/build/",
      state: c.busy === "build" ? "running" : c.build ? "done" : c.error && !c.build ? "error" : "todo",
      facts: c.build
        ? [
            ["Winning shares", <>{c.build.winningShares ?? "—"} {c.build.outcome ? `on ${c.build.outcome}` : ""}<FixtureTag show={c.build.fixture} /></>],
            ["Instructions", <>{c.build.instructions?.length ?? 0}<FixtureTag show={c.build.fixture} /></>],
          ]
        : undefined,
    },
    {
      key: "sign",
      title: "Sign in your wallet",
      call: "wallet.signTransaction, not sent",
      state: c.busy === "sign" ? "running" : c.sign ? "done" : c.error && c.build && !c.sign ? "error" : "todo",
      facts: c.sign
        ? [
            ["Signature", mono(short(c.sign.signature, 10, 6))],
            ["Signed", c.sign.standIn ? "memo-only stand-in (the sandbox returned no instructions)" : "Panta's claim instructions"],
          ]
        : undefined,
    },
    {
      key: "report",
      title: "Report the claim",
      call: "POST /trades/",
      state: c.busy === "report" ? "running" : c.report ? "done" : c.error && c.sign ? "error" : "todo",
      facts: c.report ? [["Status", <>{c.report.status}<FixtureTag show={c.report.fixture} /></>]] : undefined,
    },
  ];

  const claimPanel = (marketId: string) => {
    const c = claim?.marketId === marketId ? claim : { marketId };
    const done = !!c.report;
    return (
      <div className="mt-4 rounded-[var(--radius-control)] border border-line bg-page/40 p-4">
        <PantaSteps steps={claimSteps(c)} label="Claiming winnings" />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void step(marketId)}
            disabled={c.busy != null || mode !== "sandbox"}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-sm font-medium text-page transition-colors hover:bg-[#23382c] disabled:opacity-60"
          >
            {c.busy ? "Asking Panta…" : done ? "Run it again" : !c.build ? "Build the claim" : !c.sign ? "Sign (not sent)" : "Report the claim"}
          </button>
          {mode !== "sandbox" && <span className="text-xs text-ink-3">Claims build in the sandbox only; Sheaf never builds a live transaction.</span>}
        </div>
        {c.error && <p className="mt-3 text-sm text-loss">{c.error}</p>}
      </div>
    );
  };

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-title text-ink">Predictions</h2>
          <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-ink-2">
            Your shares in Panta prediction markets, such as whether a basket beats SPY this week. Open
            positions are valued at the side&apos;s current price; a resolved winner is worth about $1 a
            share, and a winning side can be claimed here.
          </p>
        </div>
        <PoweredByPanta />
      </div>

      {error && <p className="mt-6 text-sm text-loss">{error}</p>}
      {rows == null && !error && <div className="mt-7 h-20 rounded skeleton" />}

      {rows && rows.length > 0 && (
        <div className="mt-7 divide-y divide-line border border-line">
          {rows.map((r) => (
            <div key={`${r.marketId}:${r.side}`} className="px-5 py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-ink">{r.title ?? short(r.marketId, 8, 6)}</p>
                  <p className="tnum mt-0.5 text-xs text-ink-3">
                    {r.shares} {r.side === "yes" ? "Yes" : "No"} shares · {r.phase}
                    {r.outcome ? ` · resolved ${r.outcome}` : ""}
                    {r.spot != null && !r.outcome ? ` · ${Math.round(r.spot * 100)}¢ now` : ""}
                    {r.claimed ? " · claimed" : ""}
                  </p>
                </div>
                <p className="tnum display text-lg text-ink">{money(r.valueUsdc)}</p>
              </div>
              {r.claimable && !r.claimed && claimPanel(r.marketId)}
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 0 && (
        <div className="mt-7 border border-dashed border-line-strong/60 px-6 py-8">
          <p className="text-ink">
            No Panta positions for this wallet.
            <FixtureTag show={fixture} />
          </p>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-2">
            Panta read <code className="text-xs">GET /positions/?wallet={short(me, 4, 4)}</code> and found
            nothing.
            {mode === "sandbox" &&
              " The sandbox never holds positions, because nothing it builds is broadcast. The claim flow can still be run end to end against Panta's fixture market."}
          </p>
          {mode === "sandbox" && fixtureMarket && claimPanel(fixtureMarket)}
        </div>
      )}
    </section>
  );
}
