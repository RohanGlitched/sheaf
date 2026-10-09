"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, encodeFunctionData, http, publicActions, zeroAddress, type Address, type Hex } from "viem";
import { tempoModerato } from "viem/chains";
import { sendTransactionSync } from "viem/actions";
import { Account, Actions, P256, WebAuthnP256 } from "viem/tempo";
import type { Deployment } from "@/lib/chains";
import {
  BASKET_ABI,
  ERC20_ABI,
  PLAN_DESK_ABI,
  PLAN_DESK_V3_ABI,
  TEMPO_PATH_USD,
  TEMPO_SIP_V3,
  explainEvmError,
  fromRaw,
  readDeskOrderV2,
  readPlansOf,
  readPlansOfV3,
  tempoSipV3Scopes,
  v2Of,
  v3Of,
} from "@/lib/evm";
import { quantity, shortAddress } from "@/lib/format";

/**
 * A monthly plan that the chain enforces, on Tempo.
 *
 * Two contracts and one key authorization. The investor's root key opens a plan on
 * PlanDeskV3: the cash per run, the interval, a trailing step and hard bounds (the
 * fewest and most shares a run may buy, set at signing). Then it signs one Tempo key
 * authorization that lets the keeper spend 25 AlphaUSD every 30 days on two calls
 * only: AlphaUSD.approve with the plan desk as spender, and its instalment. The key
 * signs as the investor, so it can run the plan but never rewrite it: opening,
 * re-centring and closing plans are outside its scope. Each run's fair count must sit
 * within 10% of what the last run filled at and inside the hard bounds, so the plan
 * follows normal price moves; each run posts a Dutch auction that never ends below the
 * hard floor, and any filler can fill it.
 *
 * Two halves: the run recorded by evm/scripts/tempo-sip-v3.mjs (two runs, the second
 * re-centred on the first's fill, and five refusals) with a live read of that key's
 * budget; and the same thing run in this browser, with the visitor as the investor
 * (a passkey, or a key made in the browser) and the house key as keeper. Accounts
 * that signed a v2 plan before v3 keep seeing and running it.
 */

const chain = tempoModerato.extend({ feeToken: TEMPO_PATH_USD });
/** One date format, in UTC: "8 Nov 2026". */
const day = (secs: bigint | number) =>
  new Date(Number(secs) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmt = (v: bigint | null | undefined) => (v == null ? "—" : quantity(fromRaw(v, 6), 2));
const sh = (v: bigint | string | null | undefined) => (v == null ? "—" : quantity(fromRaw(BigInt(v)), 4));
const link = "underline decoration-line-strong underline-offset-4 hover:text-ink";
const CASH = fromRaw(TEMPO_SIP_V3.cashPerRun, 6).toFixed(2);
const STEP_PCT = TEMPO_SIP_V3.stepBps / 100;
const FLOOR_PCT = TEMPO_SIP_V3.hardMinBps / 100;
const CEIL_PCT = TEMPO_SIP_V3.hardMaxBps / 100;
/** Refusals that come from the plan contract, not from the chain's access-key rules. */
const PLAN_REFUSALS = /\b(FairOutOfBounds|TooSoon|NotAllowed|PlanClosedAlready)\b/;

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
  if (!v3Of(d)) return null;
  return (
    <div>
      <div className="max-w-[60rem]">
        <p className="text-xs text-ink-3">Tempo-native</p>
        <h2 className="display mt-2 text-title text-ink">A monthly plan the chain enforces</h2>
        <p className="mt-4 max-w-[66ch] text-base leading-relaxed text-ink-2">
          On Tempo a monthly plan is not an allowance a server promises to respect. You write the plan on chain: {CASH} AlphaUSD a run, once
          every 30 days, and the fewest and most shares a run may buy. Then you sign one access key that may spend{" "}
          {fromRaw(TEMPO_SIP_V3.limit, 6)} AlphaUSD every 30 days on two calls only, <span className="tnum">AlphaUSD.approve</span> with the plan
          desk as spender and <span className="tnum">PlanDeskV3.instalment</span>. Gas is paid in pathUSD, a dollar, because Tempo has no gas token.
        </p>
        <p className="mt-3 max-w-[66ch] text-sm leading-relaxed text-ink-3">
          The plan follows the price. Each run&apos;s fair share count must sit within {STEP_PCT}% of what the last run filled at, so a normal
          monthly move doesn&apos;t stop it. It must also stay inside the hard bounds you sign, {FLOOR_PCT}% to {CEIL_PCT}% of today&apos;s count,
          and no run&apos;s auction ever ends below that floor. A bigger move pauses the plan until you re-centre it with your own key.
        </p>
        <p className="mt-3 max-w-[66ch] text-sm leading-relaxed text-ink-3">
          The keeper is the house key, and the house also fills. It can only run your installment, for exactly {CASH} AlphaUSD and at most once a
          period, at a fair count inside your window. It can&apos;t run early, ask for fewer shares, re-centre, rewrite or close the plan, or call
          the desk directly: the plan contract or the chain refuses. With no other filler, it can still walk your count down by up to the
          auction&apos;s 2% band each run, never below your floor. Any other filler can fill sooner, at a better count for you. The 0.10%
          protocol fee goes to a separate cold treasury, not to this key.
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
  const v3 = v3Of(d);
  const sip = v3?.sip;
  const { budget, error } = useBudget(d, d.deployer as Address | undefined, sip?.keeperKey as Address | undefined);
  if (!sip) return null;
  const rows: { label: string; detail: string; hash?: string; refused?: string }[] = [
    {
      label: "The investor (here, the house) writes the plan",
      detail: `Plan #${sip.planId} on PlanDeskV3: ${sip.cashPerRun} a run, each run within ${sip.stepPct}% of the last fill, never outside ${sip.hardMinShares} to ${sip.hardMaxShares} MAG8. A ${sip.intervalSeconds / 60}-minute interval, so the recording shows two runs.`,
      hash: sip.openPlanTx,
    },
    {
      label: "…and signs one key authorization",
      detail: `Keeper ${shortAddress(sip.keeperKey, 6, 4)} may spend ${sip.limitPerPeriod} per 30 days, scoped to ${sip.scopes.join(" and ")}.`,
      hash: sip.authorizeTx,
    },
    {
      label: "Keeper runs it at 1 raw share unit for 10.10",
      detail: "Pay the whole installment for nothing. The plan's window refuses it.",
      refused: sip.refused.dustFair,
    },
    { label: "Keeper calls CreationDeskV2.placeOrder at its own price", detail: "Outside the scope: the chain rejects it before inclusion.", refused: sip.refused.directOrder },
    { label: "Keeper opens a plan with its own terms", detail: "Outside the scope: the key can run the plan, never write one.", refused: sip.refused.rewriteTerms },
    { label: "Keeper re-centres the plan to a floor of 1 raw unit", detail: "Outside the scope: only the investor's own key can re-centre.", refused: sip.refused.recenterByKey },
    {
      label: "Run 1, filled in kind",
      detail: `Order #${sip.orderIds[0]}, an auction from 1.02 down to 0.98 MAG8. The investor received ${sip.sharesToInvestor[0]} MAG8 after the creator fee and the 0.10% protocol fee, which went to the cold treasury.`,
      hash: sip.fillTxs[0],
    },
    { label: "Keeper runs it again at once", detail: "The plan's interval refuses it.", refused: sip.refused.tooSoon },
    {
      label: "Run 2, re-centred on run 1's fill",
      detail: `After the interval the price had moved: run 2 asked ${sip.run2Fair} MAG8 for the same cash, 5% more than run 1's ${sip.recenteredOn}. The window had trailed to run 1's fill, so it ran (Recentered), and the investor received ${sip.sharesToInvestor[1]} MAG8.`,
      hash: sip.instalmentTxs[1],
    },
  ];
  return (
    <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base text-ink">The recorded run</h3>
        <span className="text-xs text-ink-3">{new Date(sip.at).toUTCString().slice(5, 22)} UTC</span>
      </div>
      <p className="mt-1 text-xs text-ink-3">evm/scripts/tempo-sip-v3.mjs, against Tempo Moderato</p>
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
                  <span className="text-loss">
                    Refused {PLAN_REFUSALS.test(r.refused ?? "") ? "by the plan" : "by the chain"}: {r.refused}
                  </span>
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
          <p className="tnum display mt-1 text-xl text-ink">{budget?.periodEnd ? day(budget.periodEnd) : "—"}</p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        Read from Tempo&apos;s AccountKeychain precompile (<span className="tnum">getRemainingLimitWithPeriod</span>) for investor{" "}
        {shortAddress(d.deployer ?? "", 6, 4)}, the house, which invested in this recording, and keeper key {shortAddress(sip.keeperKey, 6, 4)}.
        Protocol fee to the cold treasury{" "}
        <a href={`${d.explorer}/address/${v3!.treasury}`} target="_blank" rel="noreferrer" className={link}>
          {shortAddress(v3!.treasury, 6, 4)}
        </a>
        .
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

/** What /api/evm-keeper answers for `sip.action = "terms"`: a v3 plan at today's price. Bigints as strings. */
type Terms = {
  basket: Address;
  symbol: string;
  nav: number;
  planDesk: Address;
  cashPerRun: string;
  interval: string;
  auctionSecs: string;
  bandBps: number;
  stepBps: number;
  refShares: string;
  hardMin: string;
  hardMax: string;
};

/** The visitor's plan, on either plan desk: v3 (trailing window) or v2 (fixed bounds, signed before v3). */
type UiPlan = {
  version: 2 | 3;
  id: number;
  basket: Address;
  cashPerRun: bigint;
  runs: number;
  nextRunAt: number;
  active: boolean;
  hardMin: bigint;
  hardMax: bigint;
  low: bigint;
  high: bigint;
};

type KeeperFill = { status: "filled" | "skipped" | "failed"; hash?: string; reason?: string; retryInSec?: number };

/** One plain sentence for whatever a passkey prompt, the chain or our routes threw back. */
function explainSip(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "NotAllowedError" || /NotAllowedError|timed out or was not allowed/i.test(e?.message ?? "")) {
    return "The passkey prompt was closed or timed out. Try again, or use a throwaway key in this browser.";
  }
  const text = explainEvmError(err);
  // Never show a raw RPC body.
  return text.replace(/\s*[:\-]?\s*[{[].*$/s, "").slice(0, 200) || "That step failed. Try again in a moment.";
}

async function keeperPost(body: Record<string, unknown>) {
  const res = await fetch("/api/evm-keeper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "The keeper did not answer. Try again in a moment.");
  return json;
}

/** What the visitor is about to do, shown before they start so the panel says what it is for. */
const STEPS = [
  { n: 1, label: "Make your Tempo account", note: "A passkey, or a throwaway key kept in this browser" },
  { n: 2, label: "Fund it from Tempo's faucet", note: "pathUSD for fees, AlphaUSD to invest" },
  { n: 3, label: "Sign the plan, once", note: `Write it on PlanDeskV3 (${CASH} AlphaUSD a month, a ${STEP_PCT}% step, your hard bounds), then scope the keeper to two calls` },
  { n: 4, label: "The keeper tries to overpay", note: "1 raw share unit for the whole installment. The plan refuses: FairOutOfBounds" },
  { n: 5, label: "The keeper runs this month's installment", note: "An auction that never ends below your floor, filled in kind" },
  { n: 6, label: "The keeper runs it again at once", note: "The plan refuses: TooSoon" },
  { n: 7, label: "The keeper calls the desk directly", note: "Outside the scope. The chain refuses: CallNotAllowed" },
  { n: 8, label: "Re-centre at today's price (optional)", note: "Your own key; the keeper's scope can't" },
  { n: 9, label: "Revoke the key and close the plan (optional)", note: "Skip it and the keeper keeps investing once a period" },
];

function LiveSip({ d }: { d: Deployment }) {
  const v3 = v3Of(d)!;
  const v2 = v2Of(d);
  const [root, setRoot] = useState<StoredRoot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [balances, setBalances] = useState<{ alpha: bigint; path: bigint; shares: bigint } | null>(null);
  const [plan, setPlan] = useState<UiPlan | null>(null);
  const [plansRead, setPlansRead] = useState(false);
  const [paused, setPaused] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [waiting, setWaiting] = useState<{ orderId: number; version: 2 | 3; inSec?: number } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    void Promise.resolve().then(() => setRoot(loadRoot()));
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const account = useMemo(() => (root ? accountFrom(root) : null), [root]);
  const house = d.deployer as Address;
  const { budget } = useBudget(d, account?.address, house, tick);
  const basket = d.baskets.find((b) => plan && b.address.toLowerCase() === plan.basket.toLowerCase()) ?? d.baskets[0];

  const refresh = useCallback(async () => {
    if (!account) return;
    const c = readClient(d);
    const [alpha, path, shares, p3, p2] = await Promise.all([
      c.readContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      c.readContract({ address: TEMPO_PATH_USD, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
      c.readContract({ address: d.baskets[0].address as Address, abi: BASKET_ABI, functionName: "balanceOf", args: [account.address] }),
      readPlansOfV3(d, account.address).catch(() => null),
      readPlansOf(d, account.address).catch(() => null),
    ]);
    setBalances({ alpha, path, shares });
    setNow(Math.floor(Date.now() / 1000));
    if (p3 && p2) {
      const all: UiPlan[] = [
        ...p2.map((p) => ({ version: 2 as const, id: p.id, basket: p.basket, cashPerRun: p.cashPerRun, runs: p.runs, nextRunAt: p.nextRunAt, active: p.active, hardMin: p.minShares, hardMax: p.maxShares, low: p.minShares, high: p.maxShares })),
        ...p3.map((p) => ({ version: 3 as const, id: p.id, basket: p.basket, cashPerRun: p.cashPerRun, runs: p.runs, nextRunAt: p.nextRunAt, active: p.active, hardMin: p.hardMin, hardMax: p.hardMax, low: p.low, high: p.high })),
      ];
      // The newest open plan, v3 first; else the newest of any.
      setPlan([...all].reverse().find((p) => p.active && p.version === 3) ?? [...all].reverse().find((p) => p.active) ?? all[all.length - 1] ?? null);
      setPlansRead(true);
    }
    setTick((t) => t + 1);
  }, [account, d]);

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
      setError(explainSip(err));
    } finally {
      setBusy(null);
    }
  }

  const rootClient = () => createClient({ account: account!, chain, transport: http(d.rpc, { timeout: 30_000 }) }).extend(publicActions);
  const sendRoot = async (to: Address, data: Hex) =>
    (await sendTransactionSync(rootClient(), { calls: [{ to, data }] } as never)) as unknown as { transactionHash: string };

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
      setPlan(null);
      setPlansRead(false);
      setPaused(null);
      setRoot(next);
      push({ label: kind === "passkey" ? "Passkey created; its public key is the account" : "Key created in this browser", ok: true });
    });

  const fund = () =>
    step("fund", async () => {
      const json = (await keeperPostFaucet(d, account!.address)) as { txs?: { hash: string }[] };
      await new Promise((r) => setTimeout(r, 1500));
      push({ label: "Funded from Tempo's faucet (pathUSD for fees, AlphaUSD to invest)", ok: true, hash: json.txs?.[1]?.hash ?? json.txs?.[0]?.hash });
    });

  // Two signatures from the root key: the plan's terms on PlanDeskV3, then the scoped access key.
  const sign = () =>
    step("authorize", async () => {
      if (!plan?.active) {
        const t = (await keeperPost({ network: d.network, sip: { action: "terms" } })) as unknown as Terms;
        const receipt = await sendRoot(
          v3.planDesk as Address,
          encodeFunctionData({
            abi: PLAN_DESK_V3_ABI,
            functionName: "openPlan",
            args: [t.basket, BigInt(t.cashPerRun), BigInt(t.interval), BigInt(t.auctionSecs), t.bandBps, t.stepBps, BigInt(t.refShares), BigInt(t.hardMin), BigInt(t.hardMax), zeroAddress],
          }),
        );
        push({
          label: `Plan written on PlanDeskV3: ${CASH} AlphaUSD every 30 days, within ${STEP_PCT}% of the last fill, never outside ${sh(t.hardMin)} to ${sh(t.hardMax)} ${t.symbol} a run`,
          ok: true,
          hash: receipt.transactionHash,
        });
      }
      if (!authorized) {
        const res = await Actions.accessKey.authorizeSync(rootClient(), {
          accessKey: { accessKeyAddress: house, keyType: "secp256k1" },
          expiry: Math.floor(Date.now() / 1000) + 90 * 86_400,
          limits: [
            { token: d.stable.address as Address, limit: TEMPO_SIP_V3.limit, period: TEMPO_SIP_V3.period },
            { token: TEMPO_PATH_USD, limit: TEMPO_SIP_V3.feeLimit, period: TEMPO_SIP_V3.period },
          ],
          scopes: tempoSipV3Scopes(d),
        });
        push({
          label: `Keeper scoped: ${fromRaw(TEMPO_SIP_V3.limit, 6)} AlphaUSD per 30 days, approve(PlanDeskV3) and PlanDeskV3.instalment only`,
          ok: true,
          hash: res.receipt.transactionHash,
        });
      }
    });

  /** Ask the house to fill the installment's auction until it does, or the auction ends. */
  const followFill = useCallback(
    async (orderId: number, version: 2 | 3, first?: KeeperFill) => {
      let r = first;
      for (let i = 0; i < 10 && alive.current; i++) {
        if (r?.status === "filled") {
          push({
            label: `Order #${orderId} filled in kind${r.reason ? `, ${r.reason}` : " by the house"}; the ${basket.symbol} shares are in your account`,
            ok: true,
            hash: r.hash,
          });
          setWaiting(null);
          await refresh().catch(() => undefined);
          return;
        }
        if (r && r.retryInSec == null && r.status !== "failed" && i > 0) break;
        setWaiting({ orderId, version, inSec: r?.retryInSec });
        // The route waits up to 30 s for the house's price itself, so ask again a little before it.
        const pause = Math.max(2, (r?.retryInSec ?? 5) - 25) * 1000;
        await new Promise((res) => setTimeout(res, pause));
        try {
          const json = await keeperPost({ network: d.network, order: orderId, version });
          r = (json.results as KeeperFill[] | undefined)?.[0];
          if (!r || (r.status === "skipped" && /^already filled/.test(r.reason ?? ""))) {
            // No longer open: a sweep (or another filler) got there first, or it ended.
            const o = await readDeskOrderV2(d, orderId, version);
            r =
              o.status === "Filled"
                ? { status: "filled", reason: o.filler.toLowerCase() === house.toLowerCase() ? undefined : `filled by ${shortAddress(o.filler, 6, 4)}` }
                : { status: "skipped", reason: o.status === "Cancelled" ? "it ended unfilled and the dollars went back to you" : "the house did not pick it up" };
          }
        } catch {
          r = { status: "skipped", reason: "the house could not be reached", retryInSec: 20 };
        }
      }
      setWaiting(null);
      if (r && r.status !== "filled") {
        push({ label: `Order #${orderId} not filled by the house`, ok: false, note: `${r.reason ?? r.status}. It stays open for any filler; if it ends unfilled, the dollars come back to you.` });
      }
    },
    [basket.symbol, d, house, refresh],
  );

  // "instalment" is the keeper route's action name; the visitor reads "installment".
  const keeper = (action: "instalment" | "overspend" | "outOfScope" | "tooSoon") =>
    step(action, async () => {
      let json: {
        ok?: boolean;
        hash?: string;
        orderId?: number;
        planVersion?: 2 | 3;
        startShares?: string;
        endShares?: string;
        recentredOn?: string;
        refusal?: string;
        fill?: KeeperFill;
      };
      try {
        json = (await keeperPost({ network: d.network, sip: { account: account!.address, action } })) as typeof json;
      } catch (err) {
        // A price move past the plan's window pauses it: say so and offer the re-centre.
        const msg = (err as Error).message;
        if (/^Paused:/.test(msg)) {
          setPaused(msg);
          push({ label: "Keeper paused this period's installment", ok: false, note: msg });
          return;
        }
        throw err;
      }
      const label =
        action === "instalment"
          ? json.ok
            ? `Keeper ran this month's ${CASH} AlphaUSD installment: order #${json.orderId}, ${sh(json.startShares)} down to ${sh(json.endShares)} ${basket.symbol}${json.recentredOn ? `, the window first re-centred on the last fill (${sh(json.recentredOn)})` : ""}`
            : "Keeper tried this month's installment"
          : action === "overspend"
            ? `Keeper tried to pay ${CASH} AlphaUSD for 1 raw share unit`
            : action === "tooSoon"
              ? "Keeper tried a second installment this period"
              : "Keeper called CreationDeskV2.placeOrder at its own price, outside the scope";
      const by = PLAN_REFUSALS.test(json.refusal ?? "") ? "the plan" : "the chain";
      push({ label, ok: !!json.ok, hash: json.hash, note: json.ok ? undefined : `Refused by ${by}: ${json.refusal}` });
      if (json.ok) setPaused(null);
      if (json.ok && json.orderId != null) void followFill(json.orderId, json.planVersion ?? 3, json.fill);
    });

  // Owner only: move the window to today's price and reset the hard bounds around it. The keeper's scope can't call this.
  const recenter = () =>
    step("recenter", async () => {
      if (!plan || plan.version !== 3) return;
      const t = (await keeperPost({ network: d.network, sip: { action: "terms" } })) as unknown as Terms;
      const receipt = await sendRoot(
        v3.planDesk as Address,
        encodeFunctionData({ abi: PLAN_DESK_V3_ABI, functionName: "recenter", args: [BigInt(plan.id), BigInt(t.refShares), BigInt(t.hardMin), BigInt(t.hardMax)] }),
      );
      setPaused(null);
      push({
        label: `Plan #${plan.id} re-centred by you at today's price: ${sh(t.refShares)} ${t.symbol} a run, new hard bounds ${sh(t.hardMin)} to ${sh(t.hardMax)}`,
        ok: true,
        hash: receipt.transactionHash,
      });
    });

  const revoke = () =>
    step("revoke", async () => {
      if (authorized) {
        const res = await Actions.accessKey.revokeSync(rootClient(), { accessKey: house });
        push({ label: "Keeper key revoked by the investor", ok: true, hash: res.receipt.transactionHash });
      }
      if (plan?.active) {
        const desk = plan.version === 3 ? v3.planDesk : v2!.planDesk;
        const data =
          plan.version === 3
            ? encodeFunctionData({ abi: PLAN_DESK_V3_ABI, functionName: "closePlan", args: [BigInt(plan.id)] })
            : encodeFunctionData({ abi: PLAN_DESK_ABI, functionName: "closePlan", args: [BigInt(plan.id)] });
        const receipt = await sendRoot(desk as Address, data);
        push({ label: `Plan #${plan.id} closed`, ok: true, hash: receipt.transactionHash });
      }
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
    setPlan(null);
    setPlansRead(false);
    setPaused(null);
    setError(null);
    setWaiting(null);
  };

  const funded = (balances?.path ?? 0n) > 0n && (balances?.alpha ?? 0n) > 0n;
  const authorized = !!budget && !budget.revoked && (budget.expiry ?? 0n) > 0n;
  const revoked = !!budget?.revoked;
  const planOpen = !!plan?.active;
  const ready = authorized && planOpen;
  // A key the house was granted under the v1 scope (CreationDesk.placeOrder) cannot run a plan.
  const v1Key = plansRead && authorized && !plan;

  return (
    <div className="rounded-[var(--radius-panel)] border border-line-strong bg-surface p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base text-ink">Run it in this browser</h3>
        {root && (
          <button type="button" onClick={reset} className="text-xs text-ink-3 hover:text-ink">
            Start over
          </button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        You are the investor,{" "}
        {root?.kind === "passkey"
          ? "with a passkey as your Tempo account"
          : root?.kind === "local"
            ? "with a key made in this browser as your Tempo account"
            : "with a passkey or a key made in this browser as your Tempo account"}
        . The house key {shortAddress(house, 6, 4)} is the keeper: in the recorded run the house was the investor; in yours it is the
        keeper. Free testnet dollars only.
      </p>

      {!root ? (
        <>
          <ol className="mt-5 space-y-3 border-b border-line pb-5" aria-label="What you will do">
            {STEPS.map((s) => (
              <li key={s.n} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 text-sm">
                <span aria-hidden className="mt-0.5 grid size-5 place-items-center rounded-full border border-line-strong text-[10px] text-ink-3">
                  {s.n}
                </span>
                <span className="min-w-0">
                  <span className={s.n === 1 ? "text-ink" : "text-ink-3"}>{s.label}</span>
                  <span className="block text-xs text-ink-3">{s.note}</span>
                </span>
              </li>
            ))}
          </ol>
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
        </>
      ) : (
        <>
          <dl className="tnum mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Stat label="Plan account" value={shortAddress(account!.address, 6, 4)} href={`${d.explorer}/address/${account!.address}`} />
            <Stat label="Budget left" value={revoked ? "revoked" : authorized ? `${fmt(budget?.remaining)}` : "—"} />
            <Stat label="AlphaUSD in account" value={fmt(balances?.alpha)} />
            <Stat label={`${basket.symbol} held`} value={balances ? quantity(fromRaw(balances.shares), 4) : "—"} />
          </dl>
          {plan && (
            <p className="tnum mt-3 text-xs leading-relaxed text-ink-3">
              Plan #{plan.id} on{" "}
              <a href={`${d.explorer}/address/${plan.version === 3 ? v3.planDesk : v2?.planDesk}`} target="_blank" rel="noreferrer" className={link}>
                {plan.version === 3 ? "PlanDeskV3" : "PlanDesk (v2)"}
              </a>
              : {fmt(plan.cashPerRun)} AlphaUSD a run.{" "}
              {plan.version === 3
                ? `Next run between ${sh(plan.low)} and ${sh(plan.high)} ${basket.symbol}; never outside ${sh(plan.hardMin)} to ${sh(plan.hardMax)} (at most ${(fromRaw(plan.cashPerRun, 6) / fromRaw(plan.hardMin)).toFixed(2)} AlphaUSD a share).`
                : `Fixed bounds ${sh(plan.low)} to ${sh(plan.high)} ${basket.symbol}; a bigger move stops it. Close it and sign a v3 plan to follow the price.`}{" "}
              {plan.runs} run{plan.runs === 1 ? "" : "s"} so far{plan.active ? "" : "; closed"}.
            </p>
          )}
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <SipButton n={2} label="Fund from Tempo's faucet" done={funded} busy={busy === "fund"} disabled={!!busy} onClick={fund} />
            <SipButton n={3} label="Sign the plan, once" done={ready || revoked} busy={busy === "authorize"} disabled={!!busy || !funded || ready || revoked || v1Key} onClick={sign} />
            <SipButton n={4} label="Keeper: try to overpay" busy={busy === "overspend"} disabled={!!busy || !planOpen} onClick={() => keeper("overspend")} />
            <SipButton n={5} label="Keeper: this month's installment" busy={busy === "instalment"} disabled={!!busy || !planOpen || waiting != null} onClick={() => keeper("instalment")} />
            <SipButton n={6} label="Keeper: run it again at once" busy={busy === "tooSoon"} disabled={!!busy || !planOpen || (plan?.runs ?? 0) === 0} onClick={() => keeper("tooSoon")} />
            <SipButton n={7} label="Keeper: call the desk directly" busy={busy === "outOfScope"} disabled={!!busy || !(authorized || revoked)} onClick={() => keeper("outOfScope")} />
            <SipButton n={8} label="Re-centre at today's price (optional)" busy={busy === "recenter"} disabled={!!busy || !planOpen || plan?.version !== 3} onClick={recenter} quiet />
            <SipButton n={9} label="Revoke and close (optional)" done={revoked && !planOpen} busy={busy === "revoke"} disabled={!!busy || !(authorized || planOpen)} onClick={revoke} quiet />
          </div>
          {paused && (
            <p className="mt-3 text-xs leading-relaxed text-loss">
              {paused} Step 8 re-centres it with your own key; the keeper can&apos;t.
            </p>
          )}
          {v1Key && (
            <p className="mt-3 text-xs leading-relaxed text-loss">
              This account authorized the keeper under the old scope, which could only call the v1 desk. Start over to sign a plan the chain caps.
            </p>
          )}
          {waiting && (
            <p className="pulse mt-3 text-xs leading-relaxed text-ink-2">
              Order #{waiting.orderId} is a live auction. The house fills once it reaches fair value plus 0.15%
              {waiting.inSec != null ? `, in about ${waiting.inSec}s` : ""}; any filler can take it sooner, at a better count for you.
            </p>
          )}
          {ready && plan && (
            <p className="tnum mt-3 text-xs leading-relaxed text-ink-3">
              {plan.runs === 0
                ? "If you skip step 5, the keeper runs this period's installment on its own within about 20 minutes, then once every 30 days."
                : `Next installment is due ${day(plan.nextRunAt)}${now > 0 && plan.nextRunAt <= now ? " (now)" : ""}: the keeper runs it on its own.`}{" "}
              Revoke to stop it.
            </p>
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

async function keeperPostFaucet(d: Deployment, address: Address) {
  const res = await fetch("/api/evm-faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: d.network, address }),
  });
  const json = (await res.json().catch(() => ({}))) as { txs?: { hash: string }[]; error?: string };
  if (!res.ok) throw new Error(json.error ?? "Tempo's faucet did not answer. Try again in a moment.");
  return json;
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
