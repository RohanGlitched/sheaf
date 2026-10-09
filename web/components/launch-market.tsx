"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  FEATURED_LAUNCH,
  METEORA_DOCS_URL,
  PRESET_NAMES,
  PRESET_URL,
  RETIRED_METADATA_MINTS,
  dammV2PoolAddress,
  preIpoCompanies,
  launchFor,
  pickLaunch,
  readDbcState,
  scanLaunch,
  type DbcPoolInfo,
  type DbcState,
  type FoundLaunch,
  CURVE_FULL,
} from "@/lib/dbc";
import {
  CREATOR_FEE_PERCENT,
  GRADUATION_MULTIPLE,
  LAUNCH_FEE,
  METEORA_FEE_PERCENT,
  OPEN_MULTIPLE,
  TREASURY_FEE_PERCENT,
} from "@/lib/launch";
import lifecycle from "@/lib/meteora-lifecycle.json";
import preset from "@/lib/meteora-preset.json";
import { explorerAddress, explorerTx } from "@/lib/config";
import { count, money, percent, quantity, shortAddress, timeAgo } from "@/lib/format";
import { useMeasure } from "@/lib/use-measure";
import { explainError } from "@/lib/tx";
import { ConnectButton } from "./connect-button";
import { confirmSignature } from "@/lib/confirm";

/**
 * Buy sizes. One test-SOL grant is 0.05 SOL, and a curve buy also pays about
 * 0.004 SOL of account rent (the launch token's account and a temporary wSOL
 * account) plus the network fee, so the largest buy one grant pays for is 0.04.
 */
const AMOUNTS = [0.005, 0.01, 0.04, 0.1];
const SELL_SHARES = [25, 50, 100];
/** SOL a buy leaves in the wallet for rent and the network fee: buttons above balance minus this are off. */
const BUY_RESERVE = 0.006;
/** The buy size the graduation line counts in: what one test-SOL grant pays for. */
const GRANT_BUY = 0.04;
const TEST_SOL_FAUCET = "https://faucet.solana.com";

/** SOL a new launch raises before it graduates, per SOL of NAV, from the SDK's own curve builder. */
const THRESHOLD_PER_NAV = preset.measured.thresholdSolPerNavSol;
/** How long the opening bot tax lasts at its full rate: one scheduler period. */
const FIRST_FEE_SECONDS = LAUNCH_FEE.totalDurationSeconds / LAUNCH_FEE.numberOfPeriod;

/** Shown when a wallet cannot pay; the card adds a Get test SOL button and a faucet.solana.com link under it. */
const NO_SOL =
  "Not enough devnet SOL. A buy needs its amount plus about 0.006 SOL for account rent and the network fee. Get test SOL below (one grant per wallet), or use faucet.solana.com with this wallet's address.";

/** The Meteora-specific failures first, then the site's shared reading of everything else. */
function explain(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/insufficient lamports|insufficient funds|no record of a prior credit/i.test(raw)) return NO_SOL;
  if (/slippage|ExceededSlippage/i.test(raw)) return "The price moved while you were signing. Try again.";
  if (/already in use/i.test(raw)) {
    return "Something took this launch's address while you were signing. Try again: the next free address is used.";
  }
  if (/PoolIsCompleted|pool is completed/i.test(raw)) return CURVE_FULL;
  const text = explainError(error);
  return text === "The transaction failed. Try again in a moment." ? fallback : text;
}

/** SOL the curve took in. A graduated curve raised exactly its threshold, whatever its reserve reads now. */
const raisedOf = (state: DbcState) => (state.migrated ? state.threshold : state.raised);

/** An amount of SOL: three significant figures under 0.1 SOL, so a small raise never reads as 0. */
function solText(value: number): string {
  if (value > 0 && value < 0.1) return value.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  return quantity(value, value < 10 ? 3 : 2);
}

/** Who gets what of every curve fee, from the published preset. */
const FEE_SPLIT = `Of every fee a trader pays, Meteora keeps ${METEORA_FEE_PERCENT}%, the basket's creator gets ${CREATOR_FEE_PERCENT}% and Sheaf's treasury ${TREASURY_FEE_PERCENT}%.`;

type LaunchBasketProps = {
  address: string;
  name: string;
  symbol: string;
  creator: string;
  /** Present on basket pages; used to warn about pre-IPO components. */
  components?: { mint: string }[];
};

/** What /api/launch/<basket> says about the curve's anchor: opened at half of NAV or not. */
type Anchor = {
  status: "verified" | "mismatch" | "unverifiable";
  reason: string | null;
  deviationPct: number | null;
  closeDay: string | null;
  navProof: string | null;
};

/** A pool's preset, linked to where it is published: v2 to its JSON, v1 to the write-up that retires it. */
function PresetLink({ state }: { state: DbcState }) {
  if (!state.preset) return null;
  const href = state.preset === "v2" ? PRESET_URL : `${METEORA_DOCS_URL}#2-curve-and-fee-rationale-preset-sheaf-nav-shelf-v2`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
    >
      Curve preset {state.preset} ({PRESET_NAMES[state.preset]})
    </a>
  );
}

/**
 * Where a basket's launch lives, and its live state once opened. A pool counts
 * only if it passes all three checks: `checkLaunch` (opened by the basket's
 * creator, on the published terms, fees and leftovers to Sheaf's treasury, no
 * mint authority) and the server's price check (the curve opened at half the
 * basket's NAV, within 10%). Anything else found at the basket's launch
 * addresses comes back in `unofficial` and is never traded from here. While the
 * price check has no answer for a listed basket, the card stays read-only.
 */
function useLaunch(basket: LaunchBasketProps) {
  const { connection } = useConnection();
  const [info, setInfo] = useState<DbcPoolInfo | null>(null);
  const [state, setState] = useState<DbcState | null | undefined>(undefined);
  const [unofficial, setUnofficial] = useState<FoundLaunch[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [rejected, setRejected] = useState<ReadonlyMap<string, string>>(new Map());
  const [anchorUnknown, setAnchorUnknown] = useState(false);
  const { address, name, symbol, creator } = basket;

  const load = useCallback(async () => {
    try {
      const scan = await scanLaunch(connection, { address, name, symbol, creator });
      // The anchor check needs prices from outside the chain, so the server does it, over
      // every pool on the published terms in slot order: it names the launch and the pools it refused.
      const provenance: {
        pool: string | null;
        anchor: Anchor | null;
        rejected?: { pool: string; reason: string }[];
        checking?: boolean;
      } | null =
        scan.candidates.length > 0
          ? await fetch(`/api/launch/${address}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => d?.provenance ?? null)
              .catch(() => null)
          : null;
      const refused = new Map((provenance?.rejected ?? []).map((r) => [r.pool, r.reason] as const));
      const found = pickLaunch(scan, refused);
      // The official launch if there is one, else where the creator would open it.
      const next = found.launch?.info ?? found.free ?? (await launchFor({ address, name, symbol }));
      setInfo(next);
      setUnofficial(found.unofficial);
      setRejected(refused);
      // Without the server's price check the card cannot tell a refused pool from the launch, so it stays
      // read-only; so it does while the check is still unanswered on a basket of listed holdings.
      setAnchorUnknown(scan.candidates.length > 0 && (provenance == null || provenance.checking === true));
      setAnchor(found.launch && provenance?.pool === found.launch.info.pool ? provenance.anchor : null);
      setState(found.launch ? await readDbcState(connection, next, creator) : null);
      setReadError(null);
    } catch (err) {
      const text = explainError(err);
      setReadError(text.startsWith("The site's connection") ? text : "The pool could not be read just now. Reload to try again.");
    }
  }, [connection, address, name, symbol, creator]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { info, state, unofficial, readError, anchor, rejected, anchorUnknown, reload: load };
}

/** "20 × NAV", read off a pool's own open and graduation caps, so old and new curves both say the truth. */
function graduationMultiple(state: DbcState): number {
  return Math.round((state.graduationCap / state.openCap) * OPEN_MULTIPLE);
}

/**
 * The curve's base fee right now, from the published anti-snipe scheduler:
 * exponential, falling by `reductionFactor` / 10,000 each period from the
 * starting fee to the ending one. v2 pools count in seconds, v1 in slots
 * (`slotNow` is needed for those). The dynamic fee can add a little on top in
 * volatile minutes, so the card says "about". Null when it cannot be told.
 */
function curveFeeNow(
  state: DbcState,
  nowSec: number,
  slotNow: number | null,
): { bps: number; settledAt: number | null } | null {
  if (state.migrated) return null;
  const v1 = state.preset === "v1";
  const s = v1 ? preset.previous.antiSnipe : LAUNCH_FEE;
  const duration = v1 ? preset.previous.antiSnipe.totalDurationSlots : LAUNCH_FEE.totalDurationSeconds;
  const elapsed = state.activation === "timestamp" ? nowSec - state.activationPoint : slotNow != null ? slotNow - state.activationPoint : null;
  if (elapsed == null) return null;
  const period = Math.min(s.numberOfPeriod, Math.max(0, Math.floor(elapsed / (duration / s.numberOfPeriod))));
  const bps = Math.max(s.endingFeeBps, s.startingFeeBps * (1 - s.reductionFactor / 10_000) ** period);
  const settledAt = state.activation === "timestamp" ? state.activationPoint + duration : null;
  return { bps: period >= s.numberOfPeriod ? s.endingFeeBps : bps, settledAt };
}

/** "24%", "1.6%", "1%": a fee in basis points as a short percentage. */
function feeText(bps: number): string {
  const pct = bps / 100;
  return `${pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1))}%`;
}

export function LaunchMarket() {
  const launch = useLaunch(FEATURED_LAUNCH.basket);
  return (
    <div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <div className="max-w-[40ch] self-center">
          <p className="text-xs tracking-wide text-bind">Launch market on Meteora</p>
          <h2 className="display mt-3 text-title text-ink">
            A launch market, priced from the basket&rsquo;s own value.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            A basket&rsquo;s creator can open a Meteora bonding curve beside it: a
            separate launch token whose curve starts at half the basket&rsquo;s NAV
            and graduates into a permanent Meteora DAMM v2 pool at {GRADUATION_MULTIPLE} times
            it, with every LP position locked for good. The launch token is not a
            share. The vault does not back it, and it cannot be redeemed for the
            stocks.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-3">
            This one stands in front of {FEATURED_LAUNCH.basket.name}. It graduates once about{" "}
            {THRESHOLD_PER_NAV.toFixed(2)} times NAV in SOL has gone in, and a quarter of the
            supply goes into the graduated pool. Any basket&rsquo;s creator can open one from the
            basket page in a single signature. {FEE_SPLIT} Every figure here is read from the
            pool account on each load, and{" "}
            <a
              href={PRESET_URL}
              target="_blank"
              rel="noreferrer"
              className="text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              the curve is a published preset
            </a>
            .
          </p>
        </div>
        <FeaturedLaunch launch={launch} />
      </div>
      <LaunchLifecycle />
    </div>
  );
}

/** The featured launch, on its own: the home page and How it works both show it. */
export function FeaturedLaunch({ launch: given }: { launch?: ReturnType<typeof useLaunch> } = {}) {
  return given ? <FeaturedCard launch={given} /> : <OwnFeaturedLaunch />;
}

function OwnFeaturedLaunch() {
  return <FeaturedCard launch={useLaunch(FEATURED_LAUNCH.basket)} />;
}

function FeaturedCard({ launch }: { launch: ReturnType<typeof useLaunch> }) {
  if (!launch.info) {
    return launch.readError ? (
      <p className="flex h-[420px] items-center justify-center border border-line bg-raised px-6 text-center text-sm text-ink-3">
        {launch.readError}
      </p>
    ) : (
      <LaunchSkeleton />
    );
  }
  return (
    <LaunchCard
      basketAddress={FEATURED_LAUNCH.basket.address}
      info={launch.info}
      state={launch.state ?? null}
      readError={launch.readError}
      anchor={launch.anchor}
      onTraded={launch.reload}
      readOnly={launch.anchorUnknown ? CHECKING : null}
      refused={launch.unofficial}
    />
  );
}

const CHECKING = "Checking this launch's opening price against the basket's NAV. Trading opens once the check answers; reload in a minute.";

function LaunchSkeleton() {
  return <div className="h-[420px] animate-pulse border border-line bg-raised" />;
}

/**
 * A basket's launch market on its own page: the live curve once it is open, the
 * button that opens it for the basket's creator, and nothing for anyone else.
 */
export function BasketLaunch({
  basket,
  navUsd,
}: {
  basket: LaunchBasketProps;
  navUsd: number | null;
}) {
  const launch = useLaunch(basket);
  const preIpo = preIpoCompanies(basket);
  const { publicKey } = useWallet();
  const isCreator = publicKey?.toBase58() === basket.creator;
  const ready = launch.info != null && launch.state !== undefined;

  // The section renders after a read, so the browser's own jump to #launch has
  // already happened by the time there is anything to jump to.
  useEffect(() => {
    if (ready && window.location.hash === "#launch") {
      document.getElementById("launch")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [ready, isCreator]);

  if (!launch.info || launch.state === undefined) return null;
  if (launch.state) {
    return (
      <section id="launch" className="mt-12 scroll-mt-24">
        <div className="mb-5 max-w-[62ch]">
          <p className="text-xs tracking-wide text-bind">Launch market on Meteora</p>
          <h2 className="display mt-2 text-xl text-ink">{basket.symbol} has a launch market</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            {launch.info.baseSymbol} is a separate token priced off {basket.symbol}&rsquo;s NAV: the
            curve opened at half of it and{" "}
            {launch.state.migrated
              ? `raised ${solText(launch.state.threshold)} SOL, then graduated at ${graduationMultiple(launch.state)} times it into a Meteora DAMM v2 pool, where it trades now with its liquidity locked.`
              : `graduates at ${graduationMultiple(launch.state)} times it, once ${solText(launch.state.threshold)} SOL has gone in, into a Meteora DAMM v2 pool with its liquidity locked.`}{" "}
            It is not a share of {basket.symbol}: the vault does not back it, and it cannot be
            redeemed for the stocks.
          </p>
          {preIpo.length > 0 && <PreIpoWarning companies={preIpo} />}
        </div>
        <LaunchCard
          basketAddress={basket.address}
          info={launch.info}
          state={launch.state}
          readError={launch.readError}
          anchor={launch.anchor}
          onTraded={launch.reload}
          onBasketPage
          preIpo={preIpo.length > 0}
          readOnly={launch.anchorUnknown ? CHECKING : null}
          refused={launch.unofficial}
        />
      </section>
    );
  }
  // A pool squatting this basket's launch address is named as such, never traded from here.
  const squatted = launch.unofficial.length > 0 && (
    <p className="mb-5 max-w-[62ch] border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">
      <span className="text-ink">An unofficial pool sits at one of {basket.symbol}&rsquo;s launch addresses.</span>{" "}
      {launch.unofficial[0].check.reason} Sheaf does not treat it as this basket&rsquo;s launch and
      will not trade it.{" "}
      <a
        href={explorerAddress(launch.unofficial[0].info.pool)}
        target="_blank"
        rel="noreferrer"
        className="underline decoration-line-strong underline-offset-4 hover:text-ink"
      >
        The pool on Explorer
      </a>
    </p>
  );
  if (!isCreator) {
    return squatted ? (
      <section id="launch" className="mt-12 scroll-mt-24">
        {squatted}
      </section>
    ) : null;
  }
  return (
    <section id="launch" className="mt-12 scroll-mt-24">
      {squatted}
      <OpenLaunch basket={basket} info={launch.info} navUsd={navUsd} rejected={launch.rejected} onOpened={launch.reload} />
    </section>
  );
}

function OpenLaunch({
  basket,
  info,
  navUsd,
  onOpened,
  rejected,
}: {
  basket: { address: string; name: string; symbol: string };
  info: DbcPoolInfo;
  navUsd: number | null;
  onOpened: () => Promise<void>;
  /** Pools the anchor check refused: their slots count as used, not as the launch. */
  rejected: ReadonlyMap<string, string>;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void import("@/lib/launch")
      .then(({ solUsd }) => solUsd())
      .then((price) => live && setSol(price))
      .catch(() => live && setError("Could not read a live SOL price. Reload to try again."));
    return () => {
      live = false;
    };
  }, []);

  const navSol = navUsd != null && sol ? navUsd / sol : null;

  async function open() {
    if (!publicKey || navSol == null) return;
    setBusy(true);
    setError(null);
    try {
      const { buildLaunch } = await import("@/lib/launch");
      const transaction = await buildLaunch({ connection, creator: publicKey, basket, navSol, rejected });
      const sig = await sendTransaction(transaction, connection);
      await confirmSignature(connection, sig);
      await onOpened();
    } catch (err) {
      setError(explain(err, "The launch could not be opened."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-line bg-raised">
      <div className="px-6 py-6">
        <p className="text-xs tracking-wide text-bind">Launch market on Meteora</p>
        <h2 className="display mt-2 text-xl text-ink">Open a launch market for {basket.symbol}</h2>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          {info.baseSymbol} would be a separate token on a Meteora curve priced from this
          basket&rsquo;s own value: not a share, not backed by the vault and not redeemable. It
          opens at half the NAV and graduates into a Meteora DAMM v2 pool, liquidity locked for
          good, at{" "}
          {GRADUATION_MULTIPLE} times it. About a quarter of the supply goes into that pool, so
          it is a real market on the day it opens, and the first fifth of the money in buys
          about a third of the supply, so no single early wallet takes half the token. It
          graduates once about {THRESHOLD_PER_NAV.toFixed(2)} times NAV in SOL has gone in.{" "}
          {FEE_SPLIT} After it opens, the site checks the opening price against the
          basket&rsquo;s NAV at the last close and SOL&rsquo;s price that hour.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-px border-y border-line bg-line sm:grid-cols-3">
        <Fact
          label="Opens at"
          value={navSol != null ? `${quantity(navSol * OPEN_MULTIPLE, 2)} SOL` : "—"}
          note={navUsd != null ? `½ × NAV of ${money(navUsd)}` : "reading NAV"}
        />
        <Fact
          label="Graduates at"
          value={navSol != null ? `${quantity(navSol * GRADUATION_MULTIPLE, 2)} SOL` : "—"}
          note={
            navSol != null
              ? `${GRADUATION_MULTIPLE} × NAV, after about ${quantity(navSol * THRESHOLD_PER_NAV, 2)} SOL in`
              : `${GRADUATION_MULTIPLE} × NAV, into Meteora DAMM v2`
          }
        />
        <Fact
          label="Your share of fees"
          value={`${CREATOR_FEE_PERCENT}%`}
          note={`of every curve fee (Meteora ${METEORA_FEE_PERCENT}%, Sheaf ${TREASURY_FEE_PERCENT}%). The fee is ${LAUNCH_FEE.startingFeeBps / 100}% in the first ${FIRST_FEE_SECONDS} seconds, ${LAUNCH_FEE.endingFeeBps / 100}% after ${LAUNCH_FEE.totalDurationSeconds / 60} minutes`}
        />
      </dl>
      <div className="px-6 py-5">
        <button
          type="button"
          onClick={open}
          disabled={busy || navSol == null}
          className="bg-bind px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-50 rounded-[var(--radius-control)]"
        >
          {busy ? "Opening the market…" : "Open the launch market"}
        </button>
        {error && (
          <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          One signature and about 0.02 SOL of rent. The token is fixed once it exists: no mint
          authority, no edits, and one launch per basket. The opening fee is a bot tax: a buy
          in the first {FIRST_FEE_SECONDS} seconds pays {LAUNCH_FEE.startingFeeBps / 100}% of its
          order in fees ({CREATOR_FEE_PERCENT}% of that to you, {TREASURY_FEE_PERCENT}% to the treasury,{" "}
          {METEORA_FEE_PERCENT}% to Meteora), falling to{" "}
          {LAUNCH_FEE.endingFeeBps / 100}% over {LAUNCH_FEE.totalDurationSeconds / 60} minutes.
        </p>
      </div>
    </div>
  );
}

/**
 * Why a graduated pool's market cap sits far under its graduation figure. The
 * graduation figure is the market cap at the curve's last price, not the SOL
 * raised; after graduation the price is the DAMM v2 pool's, and a thin pool
 * moves a long way on one sell.
 */
function GraduationNote({ state, symbol }: { state: DbcState; symbol: string }) {
  if (!state.migrated || state.cap >= state.graduationCap * 0.5) return null;
  return (
    <p className="mt-3 border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-ink-2">
      <span className="text-ink">
        Market cap now {quantity(state.cap, 2)} SOL, against {quantity(state.graduationCap, 2)} SOL at graduation.
      </span>{" "}
      The graduation figure is the market cap at the curve&rsquo;s last price; the curve itself raised{" "}
      {solText(state.threshold)} SOL. Since then the price is the DAMM v2 pool&rsquo;s.
      {state.preset === "v1" && (
        <>
          {" "}On the first curve only {preset.previous.measured.supplyInGraduatedPoolPercent}% of the supply
          went into that pool, so it is thin
          {symbol === lifecycle.launch.symbol
            ? ": one sell of 4.6% of the supply right after graduation, in our own lifecycle test, took it from 18.5 to about 6.2 SOL"
            : ""}
          . That is why launches now open on the v2 curve, which puts a quarter of the supply into the
          pool.{" "}
          <a
            href={`${METEORA_DOCS_URL}#1-the-whole-life-of-a-launch-on-devnet`}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            What the run taught us
          </a>
        </>
      )}
    </p>
  );
}

type Trade = {
  signature: string;
  at: number | null;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  market: "curve" | "damm";
};

/** The launch's recent swaps, from `/api/launches/trades`. */
function LaunchTrades({ pool, refresh }: { pool: string; refresh: string | null }) {
  const [data, setData] = useState<{ trades: Trade[] } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/launches/trades?pool=${pool}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setData(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pool, refresh]);
  if (!data || data.trades.length === 0) return null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="text-xs text-ink-3">Recent trades</p>
      <ul className="mt-1 divide-y divide-line">
        {data.trades.slice(0, 6).map((t) => (
          <li key={t.signature} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
            <span className="text-ink-2">
              <span className="mr-1.5 font-mono text-xs text-ink">
                {shortAddress(t.wallet)} {t.side}
              </span>
              <span className="text-xs text-ink-3">{t.market === "damm" ? "on DAMM v2" : "on the curve"}</span>
            </span>
            <a
              href={explorerTx(t.signature)}
              target="_blank"
              rel="noreferrer"
              className="tnum text-xs text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2"
            >
              {solText(t.sol)} SOL{t.at ? ` · ${timeAgo(t.at)}` : ""}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Every pool Sheaf found at this basket's launch addresses and refused, with
 * the reason: a squat (wrong creator), rogue terms, or a curve that did not open
 * at half the basket's NAV. None of them is listed, traded or counted. Open by
 * default when the list is short, and each row links to the metadata a wallet
 * gets for that slot ("Not an official Sheaf launch").
 */
function RefusedPools({ pools, basketAddress }: { pools: FoundLaunch[]; basketAddress: string }) {
  if (pools.length === 0) return null;
  return (
    <details open={pools.length <= 3} className="mt-5 border-t border-line pt-4 text-xs text-ink-3">
      <summary className="cursor-pointer text-ink-2 hover:text-ink">
        Pools Sheaf refused at this basket&rsquo;s addresses ({pools.length})
      </summary>
      <ul className="mt-2 divide-y divide-line">
        {pools.map((p) => {
          const slot = p.info.slot ?? 0;
          return (
            <li key={p.info.pool} className="py-2 leading-relaxed">
              <span className="tnum text-ink-2">Slot {slot}</span>{" "}
              <a
                href={explorerAddress(p.info.pool)}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline decoration-line-strong underline-offset-4 hover:text-ink-2"
              >
                {shortAddress(p.info.pool)}
              </a>
              : {p.check.reason}{" "}
              <a
                href={`/api/launch/${basketAddress}/${slot}`}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap underline decoration-line-strong underline-offset-4 hover:text-ink-2"
              >
                What a wallet sees
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * A short warning above a launch whose basket holds pre-IPO tokens. The basket
 * page states the pre-IPO risk in full above this, so it is not repeated here.
 */
function PreIpoWarning({ companies }: { companies: string[] }) {
  return (
    <p className="mt-3 border-l-2 border-loss pl-3 text-sm leading-relaxed text-ink-2">
      <span className="text-ink">Pre-IPO basket ({companies.join(", ")}): see the risk above.</span>{" "}
      This launch token is one step further away still: it is not a basket share and is not
      redeemable for anything.
    </p>
  );
}

/**
 * The three first launches point their immutable metadata at sheaf.vercel.app,
 * a domain Sheaf no longer controls, which now serves an unrelated app.
 */
function RetiredMetadataNote({ basketAddress }: { basketAddress: string }) {
  return (
    <p className="mt-4 text-xs leading-relaxed text-ink-3">
      This token&rsquo;s fixed metadata link points at sheaf.vercel.app, a domain Sheaf no longer
      controls, so any name or image a wallet shows for it did not come from Sheaf; the real record
      is at{" "}
      <a
        href={`/api/launch/${basketAddress}`}
        className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
      >
        /api/launch
      </a>
      .
    </p>
  );
}

/** The live curve and a buy, for one launch. */
export function LaunchCard({
  basketAddress,
  info,
  state,
  readError,
  anchor = null,
  onTraded,
  onBasketPage = false,
  preIpo = false,
  readOnly = null,
  refused = [],
}: {
  basketAddress: string;
  info: DbcPoolInfo;
  state: DbcState | null;
  readError: string | null;
  anchor?: Anchor | null;
  /** A pre-IPO basket's launch: shown plainly, never promoted ("be the first buyer"). */
  preIpo?: boolean;
  /** Why trading is held back right now (the price check could not be read), or null. */
  readOnly?: string | null;
  /** Pools refused at this basket's addresses, listed under the card. */
  refused?: FoundLaunch[];
  onTraded: () => Promise<void>;
  onBasketPage?: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [held, setHeld] = useState<{ ui: number; raw: bigint } | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(AMOUNTS[1]);
  /** The wallet's SOL, to switch off buy sizes it cannot pay for. Null until read. */
  const [solBalance, setSolBalance] = useState<number | null>(null);
  /** Unix seconds and the cluster's slot, for the opening fee shown next to Buy. */
  const [clock, setClock] = useState<{ now: number; slot: number | null }>({ now: 0, slot: null });
  const [lowSol, setLowSol] = useState(false);
  const [funding, setFunding] = useState<string | null>(null);
  const [sellShare, setSellShare] = useState(SELL_SHARES[0]);
  const [busy, setBusy] = useState<"trade" | "claim" | "graduate" | "poolClaim" | null>(null);
  const [position, setPosition] = useState<{ feeSol: number; feeToken: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ what: string; signature: string } | null>(null);
  const isCreator = publicKey != null && state?.creator === publicKey.toBase58();

  const loadSol = useCallback(async () => {
    if (!publicKey) {
      setSolBalance(null);
      return;
    }
    try {
      setSolBalance((await connection.getBalance(publicKey)) / 1e9);
    } catch {
      setSolBalance(null);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void Promise.resolve().then(loadSol);
  }, [loadSol]);

  // The opening fee falls every few seconds, so the clock ticks while the card is open.
  const slotCounted = state != null && !state.migrated && state.activation === "slot";
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const slot = slotCounted ? await connection.getSlot().catch(() => null) : null;
      if (live) setClock({ now: Math.floor(Date.now() / 1000), slot });
    };
    void tick();
    const timer = setInterval(tick, slotCounted ? 60_000 : 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [connection, slotCounted]);
  const fee = state && clock.now > 0 ? curveFeeNow(state, clock.now, clock.slot) : null;
  /** The most this wallet can put into a buy, leaving rent and the network fee. */
  const spendable = solBalance == null ? null : Math.max(0, Math.floor((solBalance - BUY_RESERVE) * 1000) / 1000);
  const canPay = (value: number) => spendable == null || value <= spendable + 1e-9;
  // A chosen size the wallet cannot pay for falls back to the largest one it can.
  const buyAmount = canPay(amount) ? amount : ([...AMOUNTS].reverse().find(canPay) ?? amount);

  async function getTestSol() {
    if (!publicKey) return;
    setFunding("Sending test SOL…");
    try {
      const { faucetRequest } = await import("./faucet-button");
      const response = await fetch("/api/faucet/sol", faucetRequest({ owner: publicKey.toBase58() }));
      const body = (await response.json().catch(() => ({}))) as { signature?: string; error?: string };
      if (!response.ok || !body.signature) {
        setFunding(`${body.error ?? "The faucet did not answer."} faucet.solana.com sends devnet SOL to any address.`);
        return;
      }
      await confirmSignature(connection, body.signature).catch(() => {});
      await loadSol();
      setFunding(null);
      setLowSol(false);
      setError(null);
    } catch {
      setFunding("Could not reach the faucet. faucet.solana.com sends devnet SOL to any address.");
    }
  }

  /** The wallet's launch tokens, read and stored; null when there is no wallet or the read fails. */
  const readHeld = useCallback(async (): Promise<{ ui: number; raw: bigint } | null> => {
    if (!publicKey) {
      setHeld(null);
      return null;
    }
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        mint: new PublicKey(info.baseMint),
      });
      const total = accounts.value.reduce(
        (sum, a) => {
          const t = a.account.data.parsed.info.tokenAmount;
          return { ui: sum.ui + (t.uiAmount ?? 0), raw: sum.raw + BigInt(t.amount) };
        },
        { ui: 0, raw: 0n },
      );
      setHeld(total);
      return total;
    } catch {
      setHeld(null);
      return null;
    }
  }, [connection, info.baseMint, publicKey]);

  useEffect(() => {
    void Promise.resolve().then(readHeld);
  }, [readHeld]);

  // Only a graduated launch has locked DAMM v2 positions, so only then is the SDK loaded.
  const graduated = state?.migrated ?? false;
  const loadPosition = useCallback(async () => {
    if (!publicKey || !graduated) {
      setPosition(null);
      return;
    }
    try {
      const { readPoolPosition } = await import("@/lib/trade");
      setPosition(await readPoolPosition({ connection, owner: publicKey, info }));
    } catch {
      setPosition(null);
    }
  }, [connection, graduated, info, publicKey]);

  useEffect(() => {
    void Promise.resolve().then(loadPosition);
  }, [loadPosition]);

  async function trade() {
    if (!publicKey || !state) return;
    const amountIn =
      side === "buy"
        ? BigInt(Math.round(buyAmount * 1e9))
        : ((held?.raw ?? 0n) * BigInt(sellShare)) / 100n;
    if (amountIn <= 0n) return;
    setError(null);
    setDone(null);
    setLowSol(false);
    // Checked before signing, so a wallet that cannot pay hears it here, not from a failed transaction.
    if (side === "buy" && !canPay(buyAmount)) {
      setError(
        `This wallet can spend about ${solText(spendable ?? 0)} SOL here, after about ${BUY_RESERVE} SOL for account rent and the network fee: not enough for a ${buyAmount} SOL buy. Get test SOL below (one grant per wallet), or use faucet.solana.com with this wallet's address.`,
      );
      setLowSol(true);
      return;
    }
    setBusy("trade");
    try {
      // Loaded on the click, so neither Meteora SDK sits on the page load.
      const { buildTrade } = await import("@/lib/trade");
      const { transaction, quote } = await buildTrade({
        connection,
        owner: publicKey,
        info,
        side,
        amount: amountIn,
        graduated: state.migrated,
      });
      const before = held?.raw ?? 0n;
      const sig = await sendTransaction(transaction, connection);
      await confirmSignature(connection, sig);
      const after = await readHeld();
      const unit = 10 ** info.baseDecimals;
      const feeSol = Number(quote.feeLamports) / 1e9;
      const feeLine = feeSol > 0 ? ` Fee ${solText(feeSol)} SOL, ${CREATOR_FEE_PERCENT}% of it to the basket's creator.` : "";
      if (side === "buy") {
        // What actually arrived, read back from the wallet; the quote if that read fails.
        const got = after != null && after.raw > before ? Number(after.raw - before) / unit : Number(quote.out) / unit;
        setDone({
          what: `Bought ${count(Math.floor(got))} ${info.baseSymbol} for ${solText(Number(quote.spent) / 1e9)} SOL.${feeLine}`,
          signature: sig,
        });
      } else {
        setDone({
          what: `Sold ${count(Math.floor(Number(amountIn) / unit))} ${info.baseSymbol} for about ${solText(Number(quote.out) / 1e9)} SOL.${feeLine}`,
          signature: sig,
        });
      }
      await Promise.all([onTraded(), loadSol()]);
    } catch (err) {
      const text = explain(err, side === "buy" ? "The buy failed." : "The sale failed.");
      setError(text);
      setLowSol(text === NO_SOL);
    } finally {
      setBusy(null);
    }
  }

  async function graduate() {
    if (!publicKey) return;
    setBusy("graduate");
    setError(null);
    setDone(null);
    try {
      const { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS } = await import(
        "@meteora-ag/dynamic-bonding-curve-sdk"
      );
      const client = new DynamicBondingCurveClient(connection, "confirmed");
      const config = await client.state.getPoolConfig(info.config);
      if (!config) throw new Error("The pool's config could not be read.");
      const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
        await client.migration.migrateToDammV2({
          payer: publicKey,
          pool: new PublicKey(info.pool),
          dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption],
        });
      const sig = await sendTransaction(transaction, connection, {
        signers: [firstPositionNftKeypair, secondPositionNftKeypair],
      });
      await confirmSignature(connection, sig);
      setDone({ what: "Graduated into Meteora DAMM v2.", signature: sig });
      await onTraded();
    } catch (err) {
      setError(explain(err, "The graduation failed."));
    } finally {
      setBusy(null);
    }
  }

  async function claimPool() {
    if (!publicKey || !position) return;
    setBusy("poolClaim");
    setError(null);
    setDone(null);
    try {
      const { buildPoolFeeClaim } = await import("@/lib/trade");
      const transaction = await buildPoolFeeClaim({ connection, owner: publicKey, info });
      const sig = await sendTransaction(transaction, connection);
      await confirmSignature(connection, sig);
      setDone({ what: `Claimed ${quantity(position.feeSol, 6)} SOL of pool fees.`, signature: sig });
      await loadPosition();
    } catch (err) {
      setError(explain(err, "The claim failed."));
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    if (!publicKey || !state) return;
    setBusy("claim");
    setError(null);
    setDone(null);
    try {
      const [{ DynamicBondingCurveClient }, { BN }] = await Promise.all([
        import("@meteora-ag/dynamic-bonding-curve-sdk"),
        import("@coral-xyz/anchor"),
      ]);
      const client = new DynamicBondingCurveClient(connection, "confirmed");
      const transaction = await client.creator.claimCreatorTradingFee({
        creator: publicKey,
        payer: publicKey,
        pool: new PublicKey(info.pool),
        maxBaseAmount: new BN("18446744073709551615"),
        maxQuoteAmount: new BN("18446744073709551615"),
      });
      const sig = await sendTransaction(transaction, connection);
      await confirmSignature(connection, sig);
      setDone({ what: `Claimed ${quantity(state.creatorFees, 6)} SOL.`, signature: sig });
      await onTraded();
    } catch (err) {
      setError(explain(err, "The claim failed."));
    } finally {
      setBusy(null);
    }
  }

  const curveFull = state != null && !state.migrated && state.raised >= state.threshold;
  const untouched = state != null && !state.migrated && state.raised === 0;

  return (
    <div className="border border-line bg-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-6 py-4">
        <p className="text-sm text-ink">
          <span className="display text-lg">{info.baseSymbol}</span>{" "}
          <span className="text-ink-2">launch token · {info.baseName.replace(/, early access$/, "")}</span>
        </p>
        <p className="flex items-center gap-2 text-xs text-ink-3">
          <span className={`size-1.5 rounded-full bg-gain ${state?.migrated ? "" : "live-dot"}`} aria-hidden />
          {state?.migrated
            ? "Graduated to Meteora DAMM v2"
            : curveFull
              ? "Curve full"
              : untouched
                ? "Open, no buys yet"
                : "Trading live"}
        </p>
      </div>

      <Curve state={state} error={readError} />

      <dl className="grid grid-cols-3 gap-px border-y border-line bg-line">
        <Fact
          label="Opened at"
          value={state ? `${quantity(state.openCap, 2)} SOL` : "—"}
          note={
            anchor?.status === "verified"
              ? `½ × NAV: ${anchor.deviationPct != null ? `${anchor.deviationPct < 0 && Math.abs(anchor.deviationPct) >= 0.05 ? "−" : "+"}${Math.abs(anchor.deviationPct).toFixed(1)}% vs` : "checked against"} the ${anchor.closeDay ?? "last"} close`
              : anchor?.status === "unverifiable"
                ? "½ × NAV, as set; not checkable"
                : "½ × NAV"
          }
        />
        <Fact
          label="Market cap now"
          value={state ? `${quantity(state.cap, 2)} SOL` : "—"}
          note={
            !state
              ? "reading"
              : state.migrated
                ? "live on Meteora DAMM v2"
                : untouched
                  ? "the opening price, untouched"
                  : `${percent((state.raised / state.threshold) * 100, 0)} of the way to graduation`
          }
        />
        <Fact
          label={state?.migrated ? "Graduated at" : "Graduates at"}
          value={state ? `${quantity(state.graduationCap, 2)} SOL` : "—"}
          note={state ? `market cap, ${graduationMultiple(state)} × NAV, LP locked` : "reading"}
        />
      </dl>

      <div className="px-6 py-5">
        {untouched && state && !preIpo && (
          <p className="mb-4 text-sm leading-relaxed text-ink-2">
            <span className="text-ink">Opens at {quantity(state.openCap, 2)} SOL. Be the first buyer.</span>{" "}
            Nobody has bought yet, so the first buy gets the curve&rsquo;s lowest price; it takes{" "}
            {quantity(state.threshold, 2)} SOL in all to graduate.
          </p>
        )}
        {state?.migrated && (
          <p className="mb-4 text-sm leading-relaxed text-ink-2">
            <span className="text-ink">
              Raised {solText(state.threshold)} SOL and graduated to a Meteora DAMM v2 pool.
            </span>{" "}
            The curve&rsquo;s liquidity moved there, locked for good, and trading carries on there,
            from this card.{" "}
            <a
              href={explorerAddress(dammV2PoolAddress(info.baseMint))}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-bind"
            >
              The DAMM v2 pool
            </a>
          </p>
        )}
        {state?.migrated && (
          <div className="mb-4">
            <GraduationNote state={state} symbol={info.baseSymbol} />
          </div>
        )}
        {connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Buy or sell" className="flex">
              {(["buy", "sell"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={side === value}
                  onClick={() => setSide(value)}
                  className="-ml-px border px-3 py-2.5 text-sm capitalize transition-colors first:ml-0 rounded-[var(--radius-control)]"
                  style={{
                    borderColor: side === value ? "var(--color-ink-2)" : "var(--color-line)",
                    color: side === value ? "var(--color-ink)" : "var(--color-ink-3)",
                    background: side === value ? "var(--color-sunk)" : "transparent",
                    position: side === value ? "relative" : undefined,
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
            <div
              role="radiogroup"
              aria-label={side === "buy" ? "SOL to spend" : `Share of your ${info.baseSymbol} to sell`}
              className="flex"
            >
              {(side === "buy" ? AMOUNTS : SELL_SHARES).map((value) => {
                const on = side === "buy" ? buyAmount === value : sellShare === value;
                // A buy size this wallet cannot pay for, with rent and the network fee, is switched off.
                const off = side === "buy" && !canPay(value);
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={off}
                    title={off ? `This wallet can spend about ${solText(spendable ?? 0)} SOL here` : undefined}
                    onClick={() => (side === "buy" ? setAmount(value) : setSellShare(value))}
                    className="tnum -ml-px border px-3 py-2.5 text-sm transition-colors first:ml-0 disabled:cursor-not-allowed disabled:opacity-40 rounded-[var(--radius-control)]"
                    style={{
                      borderColor: on ? "var(--color-bind)" : "var(--color-line)",
                      color: on ? "var(--color-ink)" : "var(--color-ink-3)",
                      position: on ? "relative" : undefined,
                    }}
                  >
                    {side === "buy" ? `${value} SOL` : value === 100 ? "All" : `${value}%`}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={trade}
              disabled={
                busy != null ||
                !state ||
                (side === "sell" && !(held && held.raw > 0n)) ||
                // A full curve takes neither buys nor sells until it graduates.
                curveFull ||
                // Until the price check answers, this pool may not be the basket's launch.
                readOnly != null
              }
              className="bg-bind px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-50 rounded-[var(--radius-control)]"
            >
              {busy === "trade"
                ? side === "buy"
                  ? "Buying…"
                  : "Selling…"
                : `${side === "buy" ? "Buy" : "Sell"} ${info.baseSymbol}`}
            </button>
            {curveFull ? (
              <p className="w-full text-xs text-ink-3">{CURVE_FULL}</p>
            ) : side === "sell" && !(held && held.raw > 0n) ? (
              <p className="w-full text-xs text-ink-3">You hold no {info.baseSymbol} to sell.</p>
            ) : (
              <FeeNow state={state} fee={fee} spendable={side === "buy" ? spendable : null} />
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <ConnectButton />
            <p className="max-w-[46ch] text-xs leading-relaxed text-ink-3">
              Connect a wallet to buy or sell. No wallet app? Connect, choose &ldquo;Use a wallet in
              this browser&rdquo;, get test SOL, and a 0.01 SOL buy here takes a minute. It is devnet:
              nothing costs real money.
            </p>
          </div>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>
        )}
        {connected && (lowSol || (side === "buy" && spendable != null && spendable < AMOUNTS[0])) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <button
              type="button"
              onClick={getTestSol}
              disabled={funding === "Sending test SOL…"}
              className="border border-line-strong px-3 py-2 text-ink transition-colors hover:border-bind hover:text-bind disabled:opacity-60 rounded-[var(--radius-control)]"
            >
              {funding === "Sending test SOL…" ? funding : "Get test SOL"}
            </button>
            <a
              href={TEST_SOL_FAUCET}
              target="_blank"
              rel="noreferrer"
              className="text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink-2"
            >
              faucet.solana.com
            </a>
            {funding && funding !== "Sending test SOL…" && <p className="w-full leading-relaxed text-ink-2">{funding}</p>}
          </div>
        )}
        {done && (
          <p className="mt-4 text-sm text-ink-2">
            {done.what}{" "}
            <a
              href={explorerTx(done.signature)}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-line-strong underline-offset-4 hover:text-ink"
            >
              View the transaction
            </a>
          </p>
        )}
        {curveFull && (
          <div className="mt-5 border border-line bg-bind/[0.06] p-4">
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="text-ink">The curve is full.</span> Anyone can move it into its
              Meteora DAMM v2 pool, where the liquidity is locked for good and trading carries on.
            </p>
            {connected && (
              <button
                type="button"
                onClick={graduate}
                disabled={busy != null || readOnly != null}
                className="mt-3 bg-bind px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-bind-deep disabled:opacity-50 rounded-[var(--radius-control)]"
              >
                {busy === "graduate" ? "Graduating…" : "Graduate to Meteora DAMM v2"}
              </button>
            )}
          </div>
        )}
        {isCreator && state && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="tnum text-sm text-ink-2">
              You created this market. Curve fees owed to you:{" "}
              <span className="text-ink">{quantity(state.creatorFees, 6)} SOL</span>
            </p>
            <button
              type="button"
              onClick={claim}
              disabled={busy != null || state.creatorFees <= 0}
              className="border border-line-strong px-4 py-2 text-xs text-ink transition-colors hover:border-bind hover:text-bind disabled:cursor-not-allowed disabled:text-ink-3 rounded-[var(--radius-control)]"
            >
              {busy === "claim" ? "Claiming…" : "Claim fees"}
            </button>
          </div>
        )}
        {position && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="tnum text-sm text-ink-2">
              Your locked liquidity in the DAMM v2 pool has earned{" "}
              <span className="text-ink">{quantity(position.feeSol, 6)} SOL</span> since your
              last claim.
            </p>
            <button
              type="button"
              onClick={claimPool}
              disabled={busy != null || position.feeSol <= 0}
              className="border border-line-strong px-4 py-2 text-xs text-ink transition-colors hover:border-bind hover:text-bind disabled:cursor-not-allowed disabled:text-ink-3 rounded-[var(--radius-control)]"
            >
              {busy === "poolClaim" ? "Claiming…" : "Claim pool fees"}
            </button>
          </div>
        )}
        {held != null && held.ui > 0 && (
          <p className="tnum mt-2 text-xs text-ink-3">
            You hold {count(Math.floor(held.ui))} {info.baseSymbol}
            {state && ` · about ${quantity((state.cap / info.supply) * held.ui, 4)} SOL at today's price`}
          </p>
        )}

        {readOnly && <p className="mt-4 border-l-2 border-line-strong pl-3 text-xs leading-relaxed text-ink-2">{readOnly}</p>}
        {state && !state.migrated && !untouched && !curveFull && !preIpo && state.threshold - state.raised <= 1 && (
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            {solText(state.threshold - state.raised)} SOL to graduation: about{" "}
            {Math.max(1, Math.ceil((state.threshold - state.raised) / GRANT_BUY))} buys of {GRANT_BUY} SOL, one test-SOL
            grant each. Graduate it and the pool&rsquo;s liquidity locks for good.
          </p>
        )}
        {state && <LaunchTrades pool={info.pool} refresh={done?.signature ?? null} />}
        {anchor?.status === "unverifiable" && anchor.reason && (
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            The opening price could not be checked against the basket&rsquo;s NAV: {anchor.reason}
          </p>
        )}
        {RETIRED_METADATA_MINTS.has(info.baseMint) && <RetiredMetadataNote basketAddress={basketAddress} />}

        <RefusedPools pools={refused} basketAddress={basketAddress} />

        <p className="mt-5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3">
          {state && <PresetLink state={state} />}
          {!onBasketPage && (
            <Link
              href={`/basket/${basketAddress}`}
              className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
            >
              The basket behind it
            </Link>
          )}
          <a
            href={explorerAddress(info.pool)}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
          >
            Pool on Explorer
          </a>
        </p>
      </div>
    </div>
  );
}

const PHASES: { title: string; note: string; steps: string[] }[] = [
  {
    title: "On the curve",
    note: "Three fresh wallets, funded with devnet SOL, buy and sell on the bonding curve.",
    steps: ["fund", "buy-1", "buy-2", "sell-curve", "buy-out"],
  },
  {
    title: "Graduation",
    note: "A buyer, not the creator, moves the full curve into Meteora DAMM v2.",
    steps: ["graduate"],
  },
  {
    title: "On DAMM v2",
    note: "The same token trades on the graduated pool, liquidity locked.",
    steps: ["damm-buy", "damm-sell"],
  },
  {
    title: "Everyone takes their share",
    note: "Creator and treasury claim curve fees, the migration fee, surplus, leftover supply and locked-LP fees.",
    steps: ["claim-creator", "lp-creator", "claim-partner", "migration-fee", "surplus", "leftover", "lp-partner"],
  },
];

/**
 * One launch's whole life on devnet, as receipts: BIG5A bought out from three
 * wallets, graduated, traded on DAMM v2, and every fee claimed. The signatures
 * come from `scripts/meteora-lifecycle.mjs`, which wrote them as they landed.
 */
export function LaunchLifecycle() {
  const steps = new Map(lifecycle.steps.map((s) => [s.id, s]));
  return (
    <div className="mt-16 border-t border-line pt-12">
      <div className="max-w-[62ch]">
        <p className="text-xs tracking-wide text-bind">Receipts</p>
        <h3 className="display mt-2 text-xl text-ink">The whole life of a launch</h3>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          {lifecycle.launch.symbol}, the launch in front of The Big Five, went the whole way on
          devnet: {quantity(lifecycle.result.raisedSol, 3)} SOL raised from{" "}
          {lifecycle.wallets.length} wallets, graduated into a Meteora DAMM v2 pool, traded
          there, and every party paid. Each line is a transaction you can open.
        </p>
      </div>
      <ol className="mt-8 grid gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        {PHASES.map((phase, i) => (
          <li key={phase.title} className="bg-raised px-5 py-5">
            <p className="tnum text-xs text-ink-3">{String(i + 1).padStart(2, "0")}</p>
            <p className="display mt-1 text-lg text-ink">{phase.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">{phase.note}</p>
            <ul className="mt-4 space-y-3">
              {phase.steps.map((id) => {
                const step = steps.get(id);
                if (!step) return null;
                return (
                  <li key={id} className="text-sm leading-snug">
                    <a
                      href={explorerTx(step.signature)}
                      target="_blank"
                      rel="noreferrer"
                      className="group block"
                    >
                      <span className="text-ink underline decoration-line-strong underline-offset-4 group-hover:decoration-bind">
                        {step.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-3 [overflow-wrap:anywhere]">{step.detail}</span>
                      <span className="tnum mt-0.5 block font-mono text-[11px] text-ink-3">
                        {step.signature.slice(0, 10)}…{step.signature.slice(-6)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      <p className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3">
        <a
          href={explorerAddress(lifecycle.launch.pool)}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          The curve on Explorer
        </a>
        <a
          href={explorerAddress(lifecycle.launch.dammPool)}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          The DAMM v2 pool on Explorer
        </a>
        <Link
          href={`/basket/${lifecycle.basket}#launch`}
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          Trade {lifecycle.launch.symbol} on DAMM v2
        </Link>
        <a
          href="/api/launches"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink-2"
        >
          Every launch as JSON
        </a>
      </p>
    </div>
  );
}

/**
 * The fee a trade pays right now, beside the Buy button: on a young curve the
 * anti-snipe fee is most of it, and nothing else on the card would say so.
 */
function FeeNow({
  state,
  fee,
  spendable,
}: {
  state: DbcState | null;
  fee: { bps: number; settledAt: number | null } | null;
  spendable: number | null;
}) {
  if (!state) return null;
  const v1 = state.preset === "v1";
  const floor = v1 ? preset.previous.antiSnipe.endingFeeBps : LAUNCH_FEE.endingFeeBps;
  let text: string | null = null;
  if (state.migrated) {
    text = v1
      ? `Fee right now: ${feeText(preset.previous.migratedPoolFeeBps)} on the DAMM v2 pool.`
      : `Fee right now: ${feeText(preset.migration.dammV2.endingFeeBps)} to ${feeText(preset.migration.dammV2.startingFeeBps)} on the DAMM v2 pool, falling as the price rises.`;
  } else if (fee) {
    const settles =
      fee.bps > floor && fee.settledAt != null
        ? `, ${feeText(floor)} from ${new Date(fee.settledAt * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
        : "";
    text =
      fee.bps > floor
        ? `Fee right now: about ${feeText(fee.bps)} (the opening anti-snipe fee${settles}).`
        : `Fee right now: about ${feeText(fee.bps)}.`;
  }
  if (!text && spendable == null) return null;
  return (
    <p className="tnum w-full text-xs leading-relaxed text-ink-3">
      {text}
      {spendable != null && (
        <>
          {text ? " " : ""}This wallet can spend about {solText(spendable)} SOL here.
        </>
      )}
    </p>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-raised px-4 py-4 sm:px-6">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tnum display mt-1 text-lg text-ink">{value}</dd>
      <dd className="mt-1 text-xs text-ink-3">{note}</dd>
    </div>
  );
}

const H = 220;
/** A halo in the card's colour under every label, so the curve never strikes through text. */
const HALO = { paintOrder: "stroke", stroke: "var(--color-raised)", strokeWidth: 4, strokeLinejoin: "round" } as const;
const PAD = { top: 20, right: 16, bottom: 30, left: 16 };

/**
 * Market cap against SOL raised, drawn through the pool's own segments. Within
 * a segment liquidity is constant, so SOL raised is linear in the square root
 * of price and the piece between two points is an exact parabola.
 */
function Curve({ state, error }: { state: DbcState | null; error: string | null }) {
  const { ref, width } = useMeasure<HTMLDivElement>();
  return (
    <div ref={ref} className="h-[220px]">
      {state && width > 0 ? (
        <CurvePlot state={state} W={width} />
      ) : (
        <p className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-3">
          {error ?? "Reading the pool"}
        </p>
      )}
    </div>
  );
}

/**
 * Eases a value towards its target over 800ms. It starts at the target, so the
 * first frame (and any screenshot of it) is already right; only a later change,
 * such as a buy, slides the fill along the curve.
 */
function useTween(target: number): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const begin = from.current;
    if (begin === target) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = target;
      const frame = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(frame);
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 800);
      const eased = 1 - (1 - t) ** 3;
      const next = begin + (target - begin) * eased;
      from.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function CurvePlot({ state, W }: { state: DbcState; W: number }) {
  const x = (raised: number) => PAD.left + (raised / state.threshold) * (W - PAD.left - PAD.right);
  const y = (cap: number) => H - PAD.bottom - (cap / state.graduationCap) * (H - PAD.top - PAD.bottom);
  const base = H - PAD.bottom;

  // The curve as a function of SOL raised, following each segment's parabola.
  const capAt = (raised: number) => {
    const pts = state.shape;
    for (let i = 1; i < pts.length; i++) {
      if (raised <= pts[i].raised || i === pts.length - 1) {
        const [p, q] = [pts[i - 1], pts[i]];
        const t = q.raised > p.raised ? Math.min(1, (raised - p.raised) / (q.raised - p.raised)) : 1;
        return (Math.sqrt(p.cap) + (Math.sqrt(q.cap) - Math.sqrt(p.cap)) * t) ** 2;
      }
    }
    return pts[0]?.cap ?? 0;
  };
  const line = (from: number, to: number) =>
    Array.from({ length: 97 }, (_, i) => from + ((to - from) * i) / 96)
      .map((f, i) => `${i === 0 ? "M" : "L"}${x(f * state.threshold).toFixed(1)},${y(capAt(f * state.threshold)).toFixed(1)}`)
      .join(" ");
  // The dot and its label always show the pool's settled state; only the fill animates.
  const raised = raisedOf(state);
  const fraction = Math.min(1, raised / state.threshold);
  const progress = useTween(fraction);
  // A graduated pool's live price is off this chart, so its marker stays at the curve's end.
  const cap = state.migrated ? capAt(raised) : state.cap;
  const filled = `${line(0, progress)} L${x(progress * state.threshold).toFixed(1)},${base} L${x(0)},${base} Z`;
  const px = x(Math.min(raised, state.threshold));
  const labelLeft = fraction > 0.6;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="block"
      role="img"
      aria-label={
        state.migrated
          ? `Bonding curve: raised ${quantity(state.threshold, 2)} SOL and graduated to Meteora DAMM v2, market cap ${quantity(state.cap, 2)} SOL`
          : `Bonding curve: ${solText(state.raised)} of ${quantity(state.threshold, 2)} SOL raised, market cap ${quantity(state.cap, 2)} SOL`
      }
    >
      <line x1={x(0)} x2={x(state.threshold)} y1={base} y2={base} stroke="var(--color-line)" />
      <path d={line(0, 1)} fill="none" stroke="var(--color-line-strong)" strokeWidth="2" strokeDasharray="4 4" />
      <path d={filled} fill="var(--color-bind)" fillOpacity="0.18" />
      <path d={line(0, progress)} fill="none" stroke="var(--color-bind)" strokeWidth="2.5" />
      <line x1={px} x2={px} y1={base} y2={y(cap)} stroke="var(--color-bind)" strokeDasharray="2 3" />
      <circle cx={px} cy={y(cap)} r="6" fill="var(--color-bind)" stroke="var(--color-raised)" strokeWidth="2" />
      {/* Past the middle the label sits left of the dot, so it never runs off the edge. */}
      <text
        x={labelLeft ? px - 12 : px + 12}
        y={labelLeft ? y(cap) + 20 : y(cap) - 10}
        fill="var(--color-ink)"
        fontSize="13"
        {...HALO}
        textAnchor={labelLeft ? "end" : "start"}
      >
        {state.migrated
          ? `graduated · raised ${solText(state.threshold)} SOL`
          : state.raised === 0
            ? "opens here · be the first buyer"
            : `now · ${solText(raised)} SOL in`}
      </text>
      <circle cx={x(state.threshold)} cy={y(state.graduationCap)} r="4" fill="none" stroke="var(--color-ink-2)" strokeWidth="1.5" />
      {fraction < 0.85 && (
        <text x={x(state.threshold) - 10} y={y(state.graduationCap) + 4} fill="var(--color-ink-2)" fontSize="12" textAnchor="end" {...HALO}>
          graduates to Meteora DAMM v2
        </text>
      )}
      <text x={x(0)} y={H - 8} fill="var(--color-ink-3)" fontSize="12" {...HALO}>
        {state.migrated ? "curve start" : "0 SOL raised"}
      </text>
      <text x={x(state.threshold)} y={H - 8} fill="var(--color-ink-3)" fontSize="12" textAnchor="end" {...HALO}>
        {quantity(state.threshold, 2)} SOL
      </text>
    </svg>
  );
}
