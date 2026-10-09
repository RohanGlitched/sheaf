import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { UNIVERSE_MINTS, fetchMarket, withChainMultipliers, type MarketSnapshot } from "@/lib/market";
import { readMints } from "@/lib/mainnet";
import { readHistory } from "@/lib/history";
import { trackRecord } from "@/lib/track";
import { stockForWriteMint } from "@/lib/mirror";
import { fetchBasketAt, tokenAccount } from "@/lib/sheaf";
import { ONE_SHARE, WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { PUBLIC_SITE, basketQuestion } from "@/lib/panta-server";
import {
  CLOSE_SETTLE_S,
  closeDayAtOrBefore,
  closeOn,
  dayIso,
  dayOf,
  fmtClose,
  marketWindow,
  nyToUnix,
  resolutionRule,
  sessionOn,
} from "@/lib/panta-window";
import type { History, Series } from "@/lib/history";
import { rememberOidc } from "@/lib/gcs-store";
import { freeze, readFrozen } from "@/lib/panta-freeze";

/**
 * GET /api/nav/<basket address>[?at=<unix seconds | YYYY-MM-DD>[&asOf=YYYY-MM-DD]]
 *
 * Every `?at=` answer is stored once in GCS under its close day and the date
 * of the data it came from (lib/panta-freeze.ts) and served from there after;
 * `&asOf=` replays a stored answer exactly, so a resolution can be re-checked
 * byte for byte later.
 *
 * The number a Panta market on this basket resolves from, as JSON a machine can
 * read: what one share is worth, with every input that went into it.
 *
 * Without `at`, right now, three ways, plus the trailing week against SPY:
 *   navPerShare.recipe   units per share (fixed at creation, on chain) x live
 *                        token price x the mint's Token-2022 multiplier
 *   navPerShare.vault    what the vault actually holds, divided by the shares
 *                        outstanding, at the same prices (at least the recipe)
 *   navPerShare.listed   the recipe at the listed shares' last prices
 *
 * With `at`, the value the market's rule reads: navPerShare.listed at the last
 * US regular-session close at or before `at` (closeDay), from adjusted daily
 * closes x each mint's multiplier, and SPY's adjusted close on the same day.
 * Recipe and vault values are not reconstructed for the past, so they are
 * absent there. A time in the future, before the history starts, or a close
 * the history has not caught up with yet is refused, never answered with
 * today's number.
 *
 * Every input is public and listed under `recompute`: the share supply, vault
 * balances and recipe are Solana accounts, the multipliers sit on each mainnet
 * mint, and the only off-chain inputs are Jupiter's prices and the daily
 * closes (Yahoo Finance's chart API, cached by Sheaf for an hour).
 */

export const dynamic = "force-dynamic";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT_OFFSET = 64;
const SUPPLY_OFFSET = 36;

let snap: { at: number; value: MarketSnapshot } | null = null;
async function market(): Promise<MarketSnapshot> {
  if (snap && Date.now() - snap.at < 15_000) return snap.value;
  const [m, chain] = await Promise.all([fetchMarket(), readMints(UNIVERSE_MINTS)]);
  const value = withChainMultipliers(m, chain);
  snap = { at: Date.now(), value };
  return value;
}

const u64 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);

const round = (x: number | null, digits = 6) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));

/** Everything a resolver fetches to rebuild the number without Sheaf, one command per input. */
function recomputeList(x: { shareMint: string; basket: string; vaults: string[]; priceMints: string[]; bases: string[] }) {
  const rpc = (cluster: string, method: string, params: unknown[]) =>
    `curl -s https://api.${cluster}.solana.com -H 'content-type: application/json' -d '${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}'`;
  return [
    { input: "Shares outstanding (share mint supply)", run: rpc(WRITE_CLUSTER, "getTokenSupply", [x.shareMint]) },
    {
      input: "Recipe: units of each stock per share (the basket account; decode with Sheaf's Anchor IDL)",
      run: rpc(WRITE_CLUSTER, "getAccountInfo", [x.basket, { encoding: "base64" }]),
    },
    {
      input: "What each vault holds (for navPerShare.vault)",
      run: rpc(WRITE_CLUSTER, "getMultipleAccounts", [x.vaults, { encoding: "jsonParsed" }]),
    },
    {
      input: "Each stock's dividend multiplier (Token-2022 scaledUiAmountConfig on the mainnet mint)",
      run: rpc("mainnet-beta", "getMultipleAccounts", [x.priceMints, { encoding: "jsonParsed" }]),
    },
    { input: "Live token prices (navPerShare.recipe and .vault)", run: `curl -s 'https://lite-api.jup.ag/price/v3?ids=${x.priceMints.join(",")}'` },
    ...x.bases.map((b) => ({
      input: `Daily closes and adjusted closes for ${b} (navPerShare.listed with ?at=, trailingWeek, spy.adjClose)`,
      run: `curl -s -A 'Mozilla/5.0' 'https://query1.finance.yahoo.com/v8/finance/chart/${b}?range=1mo&interval=1d'`,
    })),
  ];
}

/** The value on the last trading day at or before `day` (YYYYMMDD), and that day. */
function onOrBefore(series: Series | undefined, day: number): { day: number; adj: number; close: number } | null {
  if (!series) return null;
  let i = -1;
  for (let k = 0; k < series.t.length && series.t[k] <= day; k++) i = k;
  return i < 0 ? null : { day: series.t[i], adj: series.adj[i], close: series.close[i] };
}

const bad = (error: string, status = 400, extra: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*", ...extra } });

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!BASE58.test(address)) return bad("Not a basket address.");

  rememberOidc(req);
  // ?at=<unix seconds> or ?at=YYYY-MM-DD: the value at the last US close at or
  // before that time (for a date: that day's close, or the last one before it).
  const search = new URL(req.url).searchParams;
  const atParam = search.get("at");
  const asOfParam = search.get("asOf");
  let at: number | null = null;
  if (atParam != null) {
    const nowS = Math.floor(Date.now() / 1000);
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(atParam);
    if (date) {
      const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
      if (m < 1 || m > 12 || d < 1 || d > 31) return bad("at must be a unix time in seconds or a date, YYYY-MM-DD.");
      at = sessionOn(y, m, d) ? closeOn(dayOf({ y, m, d })) : nyToUnix(y, m, d, 23, 59);
    } else {
      at = Number(atParam);
      if (!/^\d{9,11}$/.test(atParam) || !Number.isSafeInteger(at)) {
        return bad("at must be a unix time in seconds or a date, YYYY-MM-DD.");
      }
    }
    if (at > nowS) return bad("at is in the future: that close has not happened yet.");
    const closeTime = closeOn(closeDayAtOrBefore(at));
    if (nowS < closeTime + CLOSE_SETTLE_S) {
      return bad(
        `The close at or before at (${fmtClose(closeTime)}) is not final here yet; ask again after ${new Date((closeTime + CLOSE_SETTLE_S) * 1000).toISOString()}.`,
        503,
        { "retry-after": String(closeTime + CLOSE_SETTLE_S - nowS) },
      );
    }
    // &asOf=YYYY-MM-DD replays the answer stored for this close when the data
    // was as of that date, byte for byte (lib/panta-freeze.ts).
    if (asOfParam != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) return bad("asOf must be a date, YYYY-MM-DD.");
      const stored = await readFrozen<Record<string, unknown>>(address, dayIso(closeDayAtOrBefore(at)), asOfParam);
      if (!stored) return bad(`No answer is stored for this close with data as of ${asOfParam}.`, 404);
      return NextResponse.json(
        { ...stored.answer, frozen: { key: stored.key, storedAt: stored.storedAt, replayed: true } },
        { headers: { "cache-control": "public, s-maxage=86400, immutable", "access-control-allow-origin": "*" } },
      );
    }
  } else if (asOfParam != null) {
    return bad("asOf replays a stored ?at= answer; give at as well.");
  }

  const basket = await fetchBasketAt(address);
  if (!basket) return NextResponse.json({ error: "No basket at this address." }, { status: 404 });

  const basketKey = new PublicKey(basket.address);
  const tokenProgram = new PublicKey(basket.tokenProgram);
  const vaults = basket.components.map((c) => tokenAccount(new PublicKey(c.mint), basketKey, tokenProgram));

  const [snapshot, infos, history] = await Promise.all([
    market(),
    new Connection(WRITE_RPC, "confirmed")
      .getMultipleAccountsInfoAndContext([new PublicKey(basket.shareMint), ...vaults])
      .catch(() => null),
    readHistory().catch(() => null),
  ]);

  const bySymbol = new Map(snapshot.quotes.map((q) => [q.symbol, q]));
  const supplyRaw = infos?.value[0] ? u64(new Uint8Array(infos.value[0].data), SUPPLY_OFFSET) : null;
  const shares = supplyRaw == null ? null : Number(supplyRaw) / ONE_SHARE;

  const components = basket.components.map((c, i) => {
    const stock = stockForWriteMint(c.mint);
    const q = stock ? bySymbol.get(stock.symbol) : undefined;
    const info = infos?.value[i + 1];
    const held = info ? u64(new Uint8Array(info.data), AMOUNT_OFFSET) : null;
    const perRaw = q ? (q.price * q.multiplier) / 10 ** c.decimals : null;
    const perRawListed = q?.sharePrice != null ? (q.sharePrice * q.multiplier) / 10 ** c.decimals : null;
    return {
      base: stock?.base ?? null,
      symbol: stock?.symbol ?? null,
      company: stock?.company ?? null,
      vaultMint: c.mint,
      priceMint: stock?.mint ?? null,
      decimals: c.decimals,
      unitsPerShare: c.unitsPerShare.toString(),
      targetWeightBps: c.weightBps,
      vault: vaults[i].toBase58(),
      vaultHeld: held?.toString() ?? null,
      price: q?.price ?? null,
      listedPrice: q?.sharePrice ?? null,
      multiplier: q?.multiplier ?? null,
      valuePerShare: perRaw == null ? null : round(Number(c.unitsPerShare) * perRaw),
      _perRaw: perRaw,
      _perRawListed: perRawListed,
      _held: held,
    };
  });

  const all = <T,>(xs: (T | null)[]) => (xs.every((x) => x != null) ? (xs as T[]) : null);
  const recipeParts = all(components.map((c) => c.valuePerShare));
  const recipe = recipeParts ? recipeParts.reduce((a, b) => a + b, 0) : null;
  const listedParts = all(components.map((c) => (c._perRawListed == null ? null : Number(c.unitsPerShare) * c._perRawListed)));
  const listed = listedParts ? listedParts.reduce((a, b) => a + b, 0) : null;
  const heldValue = all(components.map((c) => (c._held == null || c._perRaw == null ? null : Number(c._held) * c._perRaw)));
  const vault = heldValue && shares && shares > 0 ? heldValue.reduce((a, b) => a + b, 0) / shares : null;

  const navUrl = `${PUBLIC_SITE}/api/nav/${basket.address}`;
  const recompute = recomputeList({
    shareMint: basket.shareMint,
    basket: basket.address,
    vaults: components.map((c) => c.vault),
    priceMints: components.map((c) => c.priceMint).filter((m): m is string => !!m),
    bases: [...new Set([...components.map((c) => c.base).filter((b): b is string => !!b), "SPY"])],
  });
  const historySource = (h: History | null) =>
    h
      ? `Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart/<ticker>), adjusted daily closes as of ${h.asOf}, read by Sheaf at most hourly${h.stale.length ? `; from Sheaf's committed snapshot for: ${h.stale.join(", ")}` : ""}`
      : null;

  if (at != null) {
    if (!history) return bad("Daily closes could not be read right now; try again shortly.", 503, { "retry-after": "60" });
    // An answer already stored for this close and this data date is served as stored.
    const frozenDay = dayIso(closeDayAtOrBefore(at));
    const already = await readFrozen<Record<string, unknown>>(address, frozenDay, history.asOf);
    if (already) {
      return NextResponse.json(
        {
          ...already.answer,
          frozen: { key: already.key, storedAt: already.storedAt, replay: `${navUrl}?at=${at}&asOf=${history.asOf}` },
        },
        { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=600", "access-control-allow-origin": "*" } },
      );
    }
    // The rule's value uses each mint's multiplier as the chain states it. If the
    // mainnet read failed, refuse rather than answer from Jupiter's copy.
    if (!snapshot.chain) {
      return bad("The mints' multipliers could not be read from mainnet right now; try again shortly.", 503, { "retry-after": "30" });
    }
    const day = closeDayAtOrBefore(at);
    const spySeries = history.series.SPY;
    const latest = spySeries?.t[spySeries.t.length - 1] ?? 0;
    if (latest < day) {
      return bad(`The close on ${dayIso(day)} is not in the history yet (latest ${dayIso(latest)}); try again later.`, 503, {
        "retry-after": "900",
      });
    }
    if (!spySeries || spySeries.t[0] > day) return bad("at is before the start of the daily history (one year).");
    const spyAt = onOrBefore(spySeries, day)!;
    const parts = components.map((c) => {
      const h = onOrBefore(c.base ? history.series[c.base] : undefined, spyAt.day);
      // A token's dollar value then = adjusted close x today's multiplier: the
      // multiplier has grown by the dividends since, which the adjustment takes out.
      const value =
        h && c.multiplier != null ? (Number(c.unitsPerShare) / 10 ** c.decimals) * h.adj * c.multiplier : null;
      return {
        base: c.base,
        unitsPerShare: c.unitsPerShare,
        decimals: c.decimals,
        closeDay: h ? dayIso(h.day) : null,
        close: h?.close ?? null,
        adjClose: h?.adj ?? null,
        multiplier: c.multiplier,
        valuePerShare: round(value),
      };
    });
    const missing = parts.filter((p) => p.valuePerShare == null).map((p) => p.base ?? "unknown");
    const listedAt = missing.length ? null : parts.reduce((a, p) => a + p.valuePerShare!, 0);
    const answer = {
        basket: { address: basket.address, name: basket.name, symbol: basket.symbol, shareMint: basket.shareMint, cluster: WRITE_CLUSTER },
        question: basketQuestion(basket.name, basket.symbol),
        at,
        closeDay: dayIso(spyAt.day),
        closeTime: new Date(closeOn(spyAt.day) * 1000).toISOString(),
        asOf: history.asOf,
        rule: "The last NYSE regular-session close at or before at, on the exchange calendar (16:00 New York; 13:00 on early-close days; holidays skipped).",
        navPerShare: { listed: round(listedAt) },
        ...(missing.length
          ? { unavailable: `No listed history for ${missing.join(", ")} (pre-IPO), so there is no listed value for this basket.` }
          : {}),
        spy: { token: "SPYx", closeDay: dayIso(spyAt.day), close: spyAt.close, adjClose: spyAt.adj },
        components: parts,
        method:
          "navPerShare.listed at a close = sum over components of unitsPerShare / 10^decimals x adjusted close x the mint's multiplier today. Adjusted closes reinvest dividends, as the multiplier does, so the ratio between two closes is the share's total return; spy.adjClose is on the same basis.",
        sources: {
          closes: historySource(history),
          multipliers: `Token-2022 ScaledUiAmount config on each mainnet mint, read at slot ${snapshot.chain.slot}`,
          recipe: `The basket account ${basket.address} on Solana ${WRITE_CLUSTER}`,
        },
        recompute,
    };
    // Store it once under its close and data date; if another instance stored
    // one first, that one is served, so every reader gets the same bytes.
    const stored = await freeze(address, frozenDay, history.asOf, answer);
    const body = stored?.answer ?? answer;
    return NextResponse.json(
      {
        ...body,
        frozen: stored
          ? { key: stored.key, storedAt: stored.storedAt, replay: `${navUrl}?at=${at}&asOf=${history.asOf}` }
          : null,
      },
      // An hour, not a day: Yahoo re-adjusts past closes after an ex-dividend
      // date, and the rule reads both closes at resolution time, so a long-cached
      // earlier close must not meet a freshly adjusted later one. The stored
      // answer for each data date is what a resolution replays (&asOf=).
      { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=600", "access-control-allow-origin": "*" } },
    );
  }

  // The trailing five trading days, recipe vs SPY, from adjusted closes.
  let week: {
    from: number;
    to: number;
    navReturnPct: number;
    spyReturnPct: number | null;
    beatsSpy: boolean | null;
  } | null = null;
  const track = trackRecord(
    components.map((c) => ({ base: c.base ?? "", valueNow: c.valuePerShare ?? 0 })),
    history,
    "1m",
  );
  if (track && track.points.length >= 6) {
    const end = track.points[track.points.length - 1];
    const start = track.points[track.points.length - 6];
    const navReturnPct = (end.nav / start.nav - 1) * 100;
    const spyReturnPct = end.bench != null && start.bench != null ? (end.bench / start.bench - 1) * 100 : null;
    week = {
      from: start.d,
      to: end.d,
      navReturnPct: round(navReturnPct, 4)!,
      spyReturnPct: round(spyReturnPct, 4),
      beatsSpy: spyReturnPct == null ? null : navReturnPct > spyReturnPct,
    };
  }

  const spy = bySymbol.get("SPYx");
  const now = new Date();
  return NextResponse.json(
    {
      basket: {
        address: basket.address,
        name: basket.name,
        symbol: basket.symbol,
        creator: basket.creator,
        shareMint: basket.shareMint,
        cluster: WRITE_CLUSTER,
      },
      question: basketQuestion(basket.name, basket.symbol),
      at: now.toISOString(),
      unix: Math.floor(now.getTime() / 1000),
      navPerShare: { recipe: round(recipe), vault: round(vault), listed: round(listed) },
      sharesOutstanding: shares,
      vaultSlot: infos?.context.slot ?? null,
      spy: spy
        ? { token: spy.symbol, mint: spy.mint, price: spy.price, listedPrice: spy.sharePrice, multiplier: spy.multiplier }
        : null,
      trailingWeek: week,
      resolution: (() => {
        const w = marketWindow();
        // No listed history (a pre-IPO holding): there is no number to resolve
        // from, so no market is offered on this basket.
        const unlisted = components
          .filter((c) => !c.base || (history ? !history.series[c.base] : c.listedPrice == null))
          .map((c) => c.base ?? c.vaultMint);
        if (unlisted.length) {
          return {
            offered: false,
            reason: `No listed price history for ${unlisted.join(", ")} (pre-IPO), so navPerShare.listed cannot be read at a close and no market is offered on this basket.`,
          };
        }
        return {
          offered: true,
          navField: "navPerShare.listed",
          benchmarkField: "spy.adjClose",
          readWith: `${navUrl}?at=<unix seconds>`,
          nextWindow: {
            opens: new Date(w.opens * 1000).toISOString(),
            opensText: fmtClose(w.opens),
            fromClose: w.fromClose,
            toClose: w.toClose,
            from: fmtClose(w.fromClose),
            to: fmtClose(w.toClose),
            resolves: new Date(w.resolves * 1000).toISOString(),
            resolvesText: fmtClose(w.resolves),
          },
          // The recipe's units are written into the rule, so it outlives the devnet account.
          rule: resolutionRule(
            basket.symbol,
            navUrl,
            w,
            components.map((c) => ({ base: c.base ?? c.vaultMint, unitsPerShare: c.unitsPerShare, decimals: c.decimals })),
          ),
        };
      })(),
      components: components.map(({ _perRaw, _perRawListed, _held, ...c }) => {
        void _perRaw;
        void _perRawListed;
        void _held;
        return c;
      }),
      sources: {
        prices: `Jupiter price API v3, fetched ${new Date(snapshot.fetchedAt * 1000).toISOString()}`,
        multipliers: snapshot.chain
          ? `Token-2022 ScaledUiAmount config on each mainnet mint, read at slot ${snapshot.chain.slot} through ${snapshot.chain.via === "solami" ? "Solami" : "the public mainnet RPC"}`
          : "Jupiter's copy of each mint's multiplier (the chain read failed)",
        vault: `Share mint supply and the vault's token accounts on Solana ${WRITE_CLUSTER}, slot ${infos?.context.slot ?? "unknown"}`,
        trailingWeek: historySource(history),
      },
      method:
        "value per share = sum over components of unitsPerShare / 10^decimals x price x multiplier. The vault figure uses the vault's actual balances over shares outstanding.",
      recompute,
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60", "access-control-allow-origin": "*" } },
  );
}
