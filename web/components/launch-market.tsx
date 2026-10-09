"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  FEATURED_BASKET,
  dammV2PoolAddress,
  findLaunch,
  launchFor,
  readDbcState,
  type DbcPoolInfo,
  type DbcState,
  type FoundLaunch,
  CURVE_FULL,
} from "@/lib/dbc";
import { GRADUATION_MULTIPLE, LAUNCH_FEE, OPEN_MULTIPLE } from "@/lib/launch";
import lifecycle from "@/lib/meteora-lifecycle.json";
import preset from "@/lib/meteora-preset.json";
import { explorerAddress, explorerTx } from "@/lib/config";
import { count, money, percent, quantity } from "@/lib/format";
import { useMeasure } from "@/lib/use-measure";
import { explainError } from "@/lib/tx";
import { ConnectButton } from "./connect-button";
import { confirmSignature } from "@/lib/confirm";

const AMOUNTS = [0.01, 0.05, 0.1];
const SELL_SHARES = [25, 50, 100];

/** SOL a new launch raises before it graduates, per SOL of NAV, from the SDK's own curve builder. */
const THRESHOLD_PER_NAV = preset.measured.thresholdSolPerNavSol;
/** How long the opening bot tax lasts at its full rate: one scheduler period. */
const FIRST_FEE_SECONDS = LAUNCH_FEE.totalDurationSeconds / LAUNCH_FEE.numberOfPeriod;

/** The Meteora-specific failures first, then the site's shared reading of everything else. */
function explain(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/insufficient lamports|insufficient funds|no record of a prior credit/i.test(raw)) {
    return "Not enough SOL on devnet. Switch the wallet to devnet, or get some at faucet.solana.com.";
  }
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

type LaunchBasketProps = { address: string; name: string; symbol: string; creator: string };

/**
 * Where a basket's launch lives, and its live state once opened. Only a pool
 * that passes `checkLaunch` (opened by the basket's creator, fees to Sheaf's
 * treasury) counts; anything else found at the basket's launch addresses comes
 * back in `unofficial` and is never traded from here.
 */
function useLaunch(basket: LaunchBasketProps) {
  const { connection } = useConnection();
  const [info, setInfo] = useState<DbcPoolInfo | null>(null);
  const [state, setState] = useState<DbcState | null | undefined>(undefined);
  const [unofficial, setUnofficial] = useState<FoundLaunch[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const { address, name, symbol, creator } = basket;

  const load = useCallback(async () => {
    try {
      const found = await findLaunch(connection, { address, name, symbol, creator });
      // The official launch if there is one, else where the creator would open it.
      const next = found.launch?.info ?? found.free ?? (await launchFor({ address, name, symbol }));
      setInfo(next);
      setUnofficial(found.unofficial);
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

  return { info, state, unofficial, readError, reload: load };
}

/** "20 × NAV", read off a pool's own open and graduation caps, so old and new curves both say the truth. */
function graduationMultiple(state: DbcState): number {
  return Math.round((state.graduationCap / state.openCap) * OPEN_MULTIPLE);
}

export function LaunchMarket() {
  const launch = useLaunch(FEATURED_BASKET);
  // The featured curve predates the current preset, so its multiple is read off the pool, never assumed.
  const featuredMultiple = launch.state ? graduationMultiple(launch.state) : null;
  return (
    <div>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <div className="max-w-[40ch] self-center">
          <p className="text-xs tracking-wide text-bind">Meteora Dynamic Bonding Curve</p>
          <h2 className="display mt-3 text-title text-ink">
            A basket can trade before anyone has built a share.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-2">
            A new basket starts with no shares, and nobody wants to be first to
            assemble every component. So a bonding curve opens in front of it: a
            token priced along a curve that starts at half the basket&rsquo;s NAV
            and graduates into a permanent Meteora DAMM v2 pool at a fixed
            multiple of it, with every LP position locked for good.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-3">
            Any basket&rsquo;s creator can open one from the basket page in a single
            signature, and earns half of its trading fees.{" "}
            {featuredMultiple != null && featuredMultiple !== GRADUATION_MULTIPLE
              ? `This one stands in front of the Frontier Labs basket and graduates at ${featuredMultiple} times NAV; launches opened now use a gentler curve that graduates at ${GRADUATION_MULTIPLE} times, after raising about ${THRESHOLD_PER_NAV.toFixed(2)} times NAV in SOL, and puts a quarter of the supply into the graduated pool.`
              : `Launches open at half of NAV and graduate at ${GRADUATION_MULTIPLE} times it, after raising about ${THRESHOLD_PER_NAV.toFixed(2)} times NAV in SOL, with a quarter of the supply going into the graduated pool.`}{" "}
            Every figure here is read from the pool account on each load.
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
  return <FeaturedCard launch={useLaunch(FEATURED_BASKET)} />;
}

function FeaturedCard({ launch }: { launch: ReturnType<typeof useLaunch> }) {
  if (!launch.info) return <LaunchSkeleton />;
  return (
    <LaunchCard
      basketAddress={FEATURED_BASKET.address}
      info={launch.info}
      state={launch.state ?? null}
      readError={launch.readError}
      onTraded={launch.reload}
    />
  );
}

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
  basket: { address: string; name: string; symbol: string; creator: string };
  navUsd: number | null;
}) {
  const launch = useLaunch(basket);
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
          <p className="text-xs tracking-wide text-bind">Meteora Dynamic Bonding Curve</p>
          <h2 className="display mt-2 text-xl text-ink">{basket.symbol} has a launch market</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            {launch.info.baseSymbol} is a separate token priced off {basket.symbol}&rsquo;s NAV: the
            curve opened at half of it and{" "}
            {launch.state.migrated
              ? `raised ${quantity(launch.state.threshold, 2)} SOL, then graduated at ${graduationMultiple(launch.state)} times it into a Meteora DAMM v2 pool, where it trades now with its liquidity locked.`
              : `graduates at ${graduationMultiple(launch.state)} times it, once ${quantity(launch.state.threshold, 2)} SOL has gone in, into a Meteora DAMM v2 pool with its liquidity locked.`}{" "}
            Buy and sell it here either way. It is a bet on the basket, not a redemption right into it.
          </p>
        </div>
        <LaunchCard
          basketAddress={basket.address}
          info={launch.info}
          state={launch.state}
          readError={launch.readError}
          onTraded={launch.reload}
          onBasketPage
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
      <OpenLaunch basket={basket} info={launch.info} navUsd={navUsd} onOpened={launch.reload} />
    </section>
  );
}

function OpenLaunch({
  basket,
  info,
  navUsd,
  onOpened,
}: {
  basket: { address: string; name: string; symbol: string };
  info: DbcPoolInfo;
  navUsd: number | null;
  onOpened: () => Promise<void>;
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
      const transaction = await buildLaunch({ connection, creator: publicKey, basket, navSol });
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
        <p className="text-xs tracking-wide text-bind">Meteora Dynamic Bonding Curve</p>
        <h2 className="display mt-2 text-xl text-ink">Open a launch market for {basket.symbol}</h2>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Give people a way in before anyone has assembled a share. {info.baseSymbol} trades on
          a Meteora curve priced from this basket&rsquo;s own value: it opens at half the NAV and
          graduates into a Meteora DAMM v2 pool, liquidity locked for good, at{" "}
          {GRADUATION_MULTIPLE} times it. About a quarter of the supply goes into that pool, so
          it is a real market on the day it opens, and the first fifth of the money in buys
          about a third of the supply, so no single early wallet takes half the token. It
          graduates once about {THRESHOLD_PER_NAV.toFixed(2)} times NAV in SOL has gone in.
          You earn half of every trading fee on the curve.
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
          value={`${preset.fees.creatorTradingFeePercentage}%`}
          note={`The fee is ${LAUNCH_FEE.startingFeeBps / 100}% in the first ${FIRST_FEE_SECONDS} seconds, ${LAUNCH_FEE.endingFeeBps / 100}% after ${LAUNCH_FEE.totalDurationSeconds / 60} minutes`}
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
          order in fees, split between you and the treasury, falling to{" "}
          {LAUNCH_FEE.endingFeeBps / 100}% over {LAUNCH_FEE.totalDurationSeconds / 60} minutes.
        </p>
      </div>
    </div>
  );
}

/** The live curve and a buy, for one launch. */
export function LaunchCard({
  basketAddress,
  info,
  state,
  readError,
  onTraded,
  onBasketPage = false,
}: {
  basketAddress: string;
  info: DbcPoolInfo;
  state: DbcState | null;
  readError: string | null;
  onTraded: () => Promise<void>;
  onBasketPage?: boolean;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [held, setHeld] = useState<{ ui: number; raw: bigint } | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(AMOUNTS[1]);
  const [sellShare, setSellShare] = useState(SELL_SHARES[0]);
  const [busy, setBusy] = useState<"trade" | "claim" | "graduate" | "poolClaim" | null>(null);
  const [position, setPosition] = useState<{ feeSol: number; feeToken: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ what: string; signature: string } | null>(null);
  const isCreator = publicKey != null && state?.creator === publicKey.toBase58();

  const loadHeld = useCallback(async () => {
    if (!publicKey) {
      setHeld(null);
      return;
    }
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        mint: new PublicKey(info.baseMint),
      });
      setHeld(
        accounts.value.reduce(
          (sum, a) => {
            const t = a.account.data.parsed.info.tokenAmount;
            return { ui: sum.ui + (t.uiAmount ?? 0), raw: sum.raw + BigInt(t.amount) };
          },
          { ui: 0, raw: 0n },
        ),
      );
    } catch {
      setHeld(null);
    }
  }, [connection, info.baseMint, publicKey]);

  useEffect(() => {
    void Promise.resolve().then(loadHeld);
  }, [loadHeld]);

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
        ? BigInt(Math.round(amount * 1e9))
        : ((held?.raw ?? 0n) * BigInt(sellShare)) / 100n;
    if (amountIn <= 0n) return;
    setBusy("trade");
    setError(null);
    setDone(null);
    try {
      // Loaded on the click, so neither Meteora SDK sits on the page load.
      const { buildTrade } = await import("@/lib/trade");
      const transaction = await buildTrade({
        connection,
        owner: publicKey,
        info,
        side,
        amount: amountIn,
        graduated: state.migrated,
      });
      const sig = await sendTransaction(transaction, connection);
      await confirmSignature(connection, sig);
      setDone({ what: side === "buy" ? "Bought." : "Sold.", signature: sig });
      await Promise.all([onTraded(), loadHeld()]);
    } catch (err) {
      setError(explain(err, side === "buy" ? "The buy failed." : "The sale failed."));
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
          <span className="text-ink-2">{info.baseName}</span>
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
          note="½ × NAV"
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
                  : `${percent((state.raised / state.threshold) * 100, 2)} to graduation`
          }
        />
        <Fact
          label={state?.migrated ? "Graduated at" : "Graduates at"}
          value={state ? `${quantity(state.graduationCap, 2)} SOL` : "—"}
          note={state ? `${graduationMultiple(state)} × NAV, liquidity locked` : "reading"}
        />
      </dl>

      <div className="px-6 py-5">
        {untouched && state && (
          <p className="mb-4 text-sm leading-relaxed text-ink-2">
            <span className="text-ink">Opens at {quantity(state.openCap, 2)} SOL. Be the first buyer.</span>{" "}
            Nobody has bought yet, so the first buy gets the curve&rsquo;s lowest price; it takes{" "}
            {quantity(state.threshold, 2)} SOL in all to graduate.
          </p>
        )}
        {state?.migrated && (
          <p className="mb-4 text-sm leading-relaxed text-ink-2">
            <span className="text-ink">
              Raised {quantity(state.threshold, 2)} SOL and graduated to a Meteora DAMM v2 pool.
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
                const on = side === "buy" ? amount === value : sellShare === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => (side === "buy" ? setAmount(value) : setSellShare(value))}
                    className="tnum -ml-px border px-3 py-2.5 text-sm transition-colors first:ml-0 rounded-[var(--radius-control)]"
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
                curveFull
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
            ) : (
              side === "sell" &&
              !(held && held.raw > 0n) && (
                <p className="w-full text-xs text-ink-3">You hold no {info.baseSymbol} to sell.</p>
              )
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <ConnectButton />
            <p className="text-xs text-ink-3">
              Connect a wallet to buy or sell.
            </p>
          </div>
        )}

        {error && (
          <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>
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
                disabled={busy != null}
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

        <p className="mt-5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-3">
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
const PAD = { top: 20, right: 16, bottom: 30, left: 16 };

/**
 * Market cap against SOL raised, drawn through the pool's own segments. Within
 * a segment liquidity is constant, so SOL raised is linear in the square root
 * of price and the piece between two points is an exact parabola.
 */
function Curve({ state, error }: { state: DbcState | null; error: string | null }) {
  const { ref: measure, width } = useMeasure<HTMLDivElement>();
  const el = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      el.current = node;
      measure(node);
    },
    [measure],
  );
  // The chart usually sits below the fold, so the draw-in waits until it is seen.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setSeen(true);
    });
    observer.observe(el.current);
    return () => observer.disconnect();
  }, []);
  const progress = useTween(seen && state ? Math.min(1, raisedOf(state) / state.threshold) : 0);
  return (
    <div ref={ref} className="h-[220px]">
      {state && width > 0 ? (
        <CurvePlot state={state} W={width} progress={progress} />
      ) : (
        <p className="flex h-full items-center justify-center px-6 text-center text-xs text-ink-3">
          {error ?? "Reading the pool"}
        </p>
      )}
    </div>
  );
}

/**
 * Eases a value towards its target over 800ms, so the curve draws itself on
 * first view and the marker slides along it after a buy instead of jumping.
 */
function useTween(target: number): number {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const frame = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(frame);
    }
    const start = performance.now();
    const begin = from.current;
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

function CurvePlot({ state, W, progress }: { state: DbcState; W: number; progress: number }) {
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
  // While the marker is moving it sits on the curve itself; at rest it sits at the pool's own price.
  const settled = Math.abs(progress - Math.min(1, raisedOf(state) / state.threshold)) < 0.0005;
  const raised = settled ? raisedOf(state) : progress * state.threshold;
  // A graduated pool's live price is off this chart, so its marker stays at the curve's end.
  const cap = settled && !state.migrated ? state.cap : capAt(raised);
  const filled = `${line(0, progress)} L${x(progress * state.threshold).toFixed(1)},${base} L${x(0)},${base} Z`;
  const px = x(Math.min(raised, state.threshold));

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
          : `Bonding curve: ${quantity(state.raised, 4)} of ${quantity(state.threshold, 2)} SOL raised, market cap ${quantity(state.cap, 2)} SOL`
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
        x={progress > 0.6 ? px - 12 : px + 12}
        y={progress > 0.6 ? y(cap) + 20 : y(cap) - 10}
        fill="var(--color-ink)"
        fontSize="13"
        textAnchor={progress > 0.6 ? "end" : "start"}
      >
        {state.migrated
          ? `graduated · raised ${quantity(state.threshold, 2)} SOL`
          : state.raised === 0
            ? "opens here · be the first buyer"
            : `now · ${quantity(raised, 4)} SOL in`}
      </text>
      <circle cx={x(state.threshold)} cy={y(state.graduationCap)} r="4" fill="none" stroke="var(--color-ink-2)" strokeWidth="1.5" />
      {progress < 0.85 && (
        <text x={x(state.threshold) - 10} y={y(state.graduationCap) + 4} fill="var(--color-ink-2)" fontSize="12" textAnchor="end">
          graduates to Meteora DAMM v2
        </text>
      )}
      <text x={x(0)} y={H - 8} fill="var(--color-ink-3)" fontSize="12">
        0 SOL raised
      </text>
      <text x={x(state.threshold)} y={H - 8} fill="var(--color-ink-3)" fontSize="12" textAnchor="end">
        {quantity(state.threshold, 2)} SOL
      </text>
    </svg>
  );
}
