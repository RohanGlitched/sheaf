"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  FEATURED_DBC,
  dammV2PoolAddress,
  launchFor,
  readDbcState,
  type DbcPoolInfo,
  type DbcState,
} from "@/lib/dbc";
import { explorerAddress, explorerTx } from "@/lib/config";
import { count, money, percent, quantity } from "@/lib/format";
import { useMeasure } from "@/lib/use-measure";
import { ConnectButton } from "./connect-button";
import { confirmSignature } from "@/lib/confirm";

const AMOUNTS = [0.01, 0.05, 0.1];
const SELL_SHARES = [25, 50, 100];

function explain(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/User rejected|rejected the request|declined/i.test(raw)) {
    return "You cancelled the transaction.";
  }
  if (/insufficient lamports|insufficient funds|no record of a prior credit/i.test(raw)) {
    return "Not enough SOL on devnet. Switch the wallet to devnet, or get some at faucet.solana.com.";
  }
  if (/slippage/i.test(raw)) return "The price moved while you were signing. Try again.";
  if (/block height exceeded/i.test(raw)) {
    return "The transaction expired before it was signed. Try again.";
  }
  if (/already in use/i.test(raw)) return "This basket's launch market is already open.";
  return raw.split("\n")[0] || fallback;
}

/** Where a basket's launch lives, and its live state once opened. */
function useLaunch(basket: { address: string; name: string; symbol: string }) {
  const { connection } = useConnection();
  const [info, setInfo] = useState<DbcPoolInfo | null>(null);
  const [state, setState] = useState<DbcState | null | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const { address, name, symbol } = basket;

  const load = useCallback(async () => {
    try {
      const next = await launchFor({ address, name, symbol });
      setInfo(next);
      setState(await readDbcState(connection, next));
      setReadError(null);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "The pool could not be read.");
    }
  }, [connection, address, name, symbol]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return { info, state, readError, reload: load };
}

export function LaunchMarket() {
  return (
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
          and graduates into a permanent Meteora pool at twenty times it. The
          curve opens on a shelf, so early money gets nearly the same price, and
          steepens only once a basket has proven it has takers.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-ink-3">
          Any basket&rsquo;s creator can open one from the basket page in a single
          signature, and earns half of its trading fees. This one stands in front
          of the Frontier Labs basket: buy a little and the dot moves, because
          every figure here is read from the pool account on each load.
        </p>
      </div>
      <FeaturedLaunch />
    </div>
  );
}

/** The featured launch, on its own: the home page and How it works both show it. */
export function FeaturedLaunch() {
  const [address, info] = FEATURED_DBC;
  const launch = useLaunch({ address, name: info.baseName, symbol: info.baseSymbol });
  if (!launch.info) return <LaunchSkeleton />;
  return (
    <LaunchCard
      basketAddress={address}
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
              ? "graduated at twenty times into a Meteora DAMM v2 pool, where it trades now with its liquidity locked."
              : "graduates at twenty times into a Meteora DAMM v2 pool with its liquidity locked."}{" "}
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
  if (!isCreator) return null;
  return (
    <section id="launch" className="mt-12 scroll-mt-24">
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
    <div className="border border-bind/40 bg-raised">
      <div className="px-6 py-6">
        <p className="text-xs tracking-wide text-bind">Meteora Dynamic Bonding Curve</p>
        <h2 className="display mt-2 text-xl text-ink">Open a launch market for {basket.symbol}</h2>
        <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-2">
          Give people a way in before anyone has assembled a share. {info.baseSymbol} trades on
          a Meteora curve priced from this basket&rsquo;s own value: it opens at half the NAV and
          graduates into a Meteora DAMM v2 pool, liquidity locked for good, at twenty times it.
          The curve starts with a shelf, so the first fifth of the money in moves the price
          less than a quarter: nobody is punished for being early. You earn half of every
          trading fee on the curve.
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-px border-y border-line bg-line sm:grid-cols-3">
        <Fact
          label="Opens at"
          value={navSol != null ? `${quantity(navSol / 2, 2)} SOL` : "—"}
          note={navUsd != null ? `½ × NAV of ${money(navUsd)}` : "reading NAV"}
        />
        <Fact
          label="Graduates at"
          value={navSol != null ? `${quantity(navSol * 20, 2)} SOL` : "—"}
          note="20 × NAV, into Meteora DAMM v2"
        />
        <Fact label="Your share of fees" value="50%" note="4% at the open, 1% within the hour" />
      </dl>
      <div className="px-6 py-5">
        <button
          type="button"
          onClick={open}
          disabled={busy || navSol == null}
          className="border border-bind bg-bind px-5 py-3 text-sm text-page transition-colors hover:bg-bind-deep disabled:opacity-50"
        >
          {busy ? "Opening the market…" : "Open the launch market"}
        </button>
        {error && (
          <p className="mt-4 border-l-2 border-loss pl-3 text-sm text-loss">{error}</p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          One signature and about 0.02 SOL of rent. The token is fixed once it exists: no mint
          authority, no edits, and one launch per basket.
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

  return (
    <div className="border border-bind/40 bg-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-6 py-4">
        <p className="text-sm text-ink">
          <span className="display text-lg">{info.baseSymbol}</span>{" "}
          <span className="text-ink-2">{info.baseName}</span>
        </p>
        <p className="flex items-center gap-2 text-xs text-ink-3">
          <span className={`size-1.5 rounded-full bg-gain ${state?.migrated ? "" : "live-dot"}`} aria-hidden />
          {state?.migrated
            ? "Graduated to Meteora DAMM v2"
            : state && state.raised >= state.threshold
              ? "Curve full"
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
                : `${percent((state.raised / state.threshold) * 100, 2)} to graduation`
          }
        />
        <Fact
          label="Graduates at"
          value={state ? `${quantity(state.graduationCap, 2)} SOL` : "—"}
          note="20 × NAV, liquidity locked"
        />
      </dl>

      <div className="px-6 py-5">
        {state?.migrated && (
          <p className="mb-4 text-sm leading-relaxed text-ink-2">
            The curve filled and its liquidity moved into a Meteora DAMM v2 pool, locked for good.
            Trading carries on there, from this card.{" "}
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
                  className="-ml-px border px-3 py-2.5 text-sm capitalize transition-colors first:ml-0"
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
                    className="tnum -ml-px border px-3 py-2.5 text-sm transition-colors first:ml-0"
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
                (side === "buy" && !state.migrated && state.raised >= state.threshold)
              }
              className="border border-bind bg-bind px-5 py-2.5 text-sm text-page transition-colors hover:bg-bind-deep disabled:opacity-50"
            >
              {busy === "trade"
                ? side === "buy"
                  ? "Buying…"
                  : "Selling…"
                : `${side === "buy" ? "Buy" : "Sell"} ${info.baseSymbol}`}
            </button>
            {side === "sell" && !(held && held.raw > 0n) && (
              <p className="w-full text-xs text-ink-3">You hold no {info.baseSymbol} to sell.</p>
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
        {state && !state.migrated && state.raised >= state.threshold && (
          <div className="mt-5 border border-bind/40 bg-bind/[0.06] p-4">
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="text-ink">The curve is full.</span> Anyone can move it into its
              Meteora DAMM v2 pool, where the liquidity is locked for good and trading carries on.
            </p>
            {connected && (
              <button
                type="button"
                onClick={graduate}
                disabled={busy != null}
                className="mt-3 border border-bind bg-bind px-4 py-2.5 text-sm text-page transition-colors hover:bg-bind-deep disabled:opacity-50"
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
              className="border border-line-strong px-4 py-2 text-xs text-ink transition-colors hover:border-bind hover:text-bind disabled:cursor-not-allowed disabled:text-ink-3"
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
              className="border border-line-strong px-4 py-2 text-xs text-ink transition-colors hover:border-bind hover:text-bind disabled:cursor-not-allowed disabled:text-ink-3"
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
  const progress = useTween(seen && state ? Math.min(1, state.raised / state.threshold) : 0);
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
  const settled = Math.abs(progress - Math.min(1, state.raised / state.threshold)) < 0.0005;
  const raised = settled ? state.raised : progress * state.threshold;
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
      aria-label={`Bonding curve: ${quantity(state.raised, 4)} of ${quantity(state.threshold, 2)} SOL raised, market cap ${quantity(state.cap, 2)} SOL`}
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
        {state.migrated ? "graduated" : "now"} · {quantity(raised, 4)} SOL in
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
