import "server-only";
import { XSTOCKS } from "./universe";
import {
  RpcError,
  mainnetCall,
  raceSlot,
  raceTransaction,
  solamiKey,
  upstreamStats,
  type SlotRace,
  type Via,
} from "./solami";

const INSTANCE = Math.random().toString(36).slice(2, 8);
const SINCE = Date.now();

/**
 * The tape: trades in tokenized stocks on Solana mainnet, as they land.
 *
 * Read through Solami's RPC when a key is set (see lib/solami.ts for the pacing
 * and the fallback). Each poll asks for the newest signatures on two of the
 * busiest stock mints (rotating), decodes the ones it has not seen, and works
 * out from the token balances which pool gave up the stock, what it was paid,
 * and so the price of the fill. Transfers that are not trades are dropped. One
 * shared cache answers every visitor, and the CDN coalesces on top, so the page
 * can poll every few seconds while the server stays inside Solami's free limit
 * of five requests a second.
 *
 * Calls go out one at a time, 667 ms apart. A normal poll is getSlot,
 * getSignaturesForAddress x2, getTransaction x<=5 (up to three that just
 * landed, up to two from the backfill while the tape is short) and
 * getBlockTime x<=1. An instance's first poll is the backfill: the last 20
 * signatures on every watched mint (ten calls), then the newest four decoded;
 * the rest wait in a queue that later polls work through. Once a minute a poll
 * also runs the Solami-vs-public comparison (see raceSlot in lib/solami.ts).
 */

export type Side = "buy" | "sell" | "arb";

export type Print = {
  signature: string;
  slot: number;
  /** Unix seconds the block was produced. Always set; see timeSource. */
  time: number;
  /** "chain" when the node reported the block time, "slot" when placed by slot distance (about 0.4 s a slot). */
  timeSource: "chain" | "slot";
  symbol: string;
  base: string;
  /**
   * Tokens that changed hands, as raw units over 10^decimals: before the
   * Token-2022 dividend multiplier. Multiply by the mint's multiplier for the
   * UI amount that a price quote refers to.
   */
  raw: number;
  side: Side;
  /** The fee payer: the wallet that sent the transaction. */
  wallet: string;
  /** Dollar value of the stock leg, from what the pool was paid. Null if the counter-asset is unknown. */
  usd: number | null;
  /** What the stock was swapped against. */
  quote: "USDC" | "USDT" | "SOL" | null;
  /** Known programs the transaction routed through, aggregator first. */
  venue: string | null;
  /** Server clock (ms) when this instance first decoded the print. */
  seenAt: number;
  /**
   * True when the trade landed after this instance last looked at its mint, so
   * block-to-screen time means something. False for trades read by the backfill
   * or on the first look at a mint: real, but history.
   */
  live: boolean;
  /**
   * Jupiter's USD price for this stock token (per UI token) when the server
   * read the trade, and when that price was fetched (unix seconds). For a live
   * row that is within a minute or two of the trade; for a backfilled row it
   * can be later, so the page only compares a fill with it when the two are
   * close in time.
   */
  refPrice: number | null;
  refAt: number | null;
};

export type Comparison = {
  /** The latest paired getSlot run, or null before the first one (or without a Solami key). */
  slot: SlotRace | null;
  /** Running totals of the paired getTransaction check on a signature that just landed. */
  freshTx: { tried: number; solami: number; public: number };
  /**
   * Every tape and market call this instance sent to each upstream, and how it
   * ended, plus how many reads Solami answered. The comparison's own calls are
   * not in here.
   */
  upstreams: ReturnType<typeof upstreamStats>;
};

export type Tape = {
  slot: number;
  /** Which RPC answered this poll's reads. */
  via: Via;
  /** Set when a Solami key is configured but the public RPC had to answer, with the reason. */
  fallback: string | null;
  /** True when this is the last good tape, returned because a fresh poll failed or is still running. */
  stale: boolean;
  /** How old a stale tape is, in milliseconds, when it was returned rather than waited for. */
  ageMs?: number;
  /** True on a cold instance's first answer, while its backfill is still running: no rows yet, nothing is wrong. */
  warming?: boolean;
  prints: Print[];
  polledAt: number;
  /** Mints the tape watches, so the page can say what it is reading. */
  watching: string[];
  /** Backfilled signatures still waiting to be decoded. */
  backlog: number;
  proof: {
    /**
     * Which server instance answered (random per instance) and when it started
     * (ms). Counters are per instance, so the page keeps one set per instance
     * instead of letting a younger instance's totals replace an older one's.
     */
    instance: string;
    since: number;
    /**
     * Round trip of this poll's getSlot, in ms, against `via`. Null on an
     * instance's first call, which includes opening the TLS connection.
     */
    rpcMs: number | null;
    /** Solami against the public RPC, measured the same way on both. */
    compare: Comparison;
    /** RPC calls this poll sent and how long it took end to end. */
    calls: number;
    pollMs: number;
  };
};

/** The mints we watch; the rest of the universe trades too rarely to fill a tape. */
const WATCH = ["SPY", "NVDA", "TSLA", "AAPL", "QQQ", "CRCL", "MSTR", "COIN", "GOOGL", "HOOD"];
// Busiest first: a cold instance decodes its first rows from the first two.
const STOCKS = XSTOCKS.filter((x) => WATCH.includes(x.base)).sort((a, b) => WATCH.indexOf(a.base) - WATCH.indexOf(b.base));
const BY_MINT = new Map(STOCKS.map((x) => [x.mint, x]));
const mintOf = (symbol: string) => STOCKS.find((s) => s.symbol === symbol)?.mint ?? "";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";

/** Program ids worth naming. Invoked programs are always static keys, so accountKeys has them. */
const VENUES: [string, string][] = [
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter"],
  ["6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma", "OKX"],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9t1V2Y9iD", "Meteora DLMM"],
  ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "Meteora DAMM"],
  ["Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", "Meteora"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "Raydium CPMM"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium"],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca"],
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "PumpSwap"],
  ["PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY", "Phoenix"],
];

/** Below either of these a row is dust: rounding left by a route, not a trade. */
const MIN_RAW = 1e-4;
const MIN_USD = 1;
const SLOT_SECONDS = 0.4;

type Balance = { mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type RawTx = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: Balance[];
    postTokenBalances?: Balance[];
  } | null;
  transaction: { message: { accountKeys: string[] } };
};
type Signature = { signature: string; slot: number; err: unknown; blockTime?: number | null };

const seen = new Map<string, Print | null>();
const blockTimes = new Map<number, number>();
let cache: Tape | null = null;
let inflight: Promise<Tape> | null = null;
let cursor = 0;
/** Newest signature slot this instance has read for each mint: anything above it is live. */
const lastLook = new Map<string, number>();
/** Signatures read by the backfill (or past a poll's decode budget), newest first, not yet decoded. */
let backlog: Signature[] = [];
let backfilled = false;
/** Signatures that landed after their mint was last read (kept, so a retried decode stays live). */
const live = new Set<string>();
let slotRace: SlotRace | null = null;
const freshTx = { tried: 0, solami: 0, public: 0 };
const RACE_EVERY_MS = 60_000;
/** Prints kept in the answer; the page shows up to 40 after merging polls. */
const DEPTH = 60;
/** The newest slot any poll has read, for a warming answer. */
let latestSlot = 0;
/** Upstreams this instance has already called once (so the connection is open). */
const warmed = new Set<Via>();
const BACKLOG_MAX = 80;

const round = (x: number, digits: number) => Number(x.toFixed(digits));
const tokens = (b: Balance) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/**
 * Dollar prices from Jupiter's price API (not an RPC call), cached a minute:
 * SOL, to value fills paid in SOL, and each watched stock, so a row whose
 * counter-leg could not be read can still be recognised as dust.
 */
let refPrices: { at: number; usd: Map<string, number> } | null = null;
async function prices(): Promise<Map<string, number>> {
  if (refPrices && Date.now() - refPrices.at < 60_000) return refPrices.usd;
  try {
    const ids = [WSOL, ...STOCKS.map((s) => s.mint)].join(",");
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    const j = (await res.json()) as Record<string, { usdPrice?: number }>;
    const usd = new Map<string, number>();
    for (const [mint, p] of Object.entries(j)) if (p?.usdPrice && p.usdPrice > 0) usd.set(mint, p.usdPrice);
    if (usd.size) refPrices = { at: Date.now(), usd };
  } catch {}
  return refPrices?.usd ?? new Map();
}

type Decoded = Omit<Print, "time" | "timeSource" | "seenAt" | "live" | "refPrice" | "refAt"> & {
  blockTime: number | null;
};

function decode(tx: RawTx, signature: string, ref: Map<string, number>): Decoded | null {
  const sol = ref.get(WSOL) ?? null;
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  // The fee payer, first in the account list, is the wallet that sent the trade.
  const signer = keys[0] ?? "";

  // Net change per owner, per mint, from the raw token balances before and after.
  const deltas = new Map<string, Map<string, number>>();
  const add = (b: Balance, sign: 1 | -1) => {
    if (!b.owner) return;
    const m = deltas.get(b.mint) ?? new Map<string, number>();
    m.set(b.owner, (m.get(b.owner) ?? 0) + sign * tokens(b));
    deltas.set(b.mint, m);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1);
  for (const b of meta.postTokenBalances ?? []) add(b, 1);

  // Dollar change per owner across the quote assets we can price.
  const quoteUsd = new Map<string, { usd: number; asset: Print["quote"]; biggest: number }>();
  const bump = (owner: string, usd: number, asset: Print["quote"]) => {
    const prev = quoteUsd.get(owner);
    const bigger = !prev || Math.abs(usd) > prev.biggest;
    quoteUsd.set(owner, {
      usd: (prev?.usd ?? 0) + usd,
      asset: bigger ? asset : prev.asset,
      biggest: bigger ? Math.abs(usd) : prev.biggest,
    });
  };
  for (const [mint, asset, perUnit] of [
    [USDC, "USDC", 1],
    [USDT, "USDT", 1],
    [WSOL, "SOL", sol],
  ] as const) {
    if (perUnit == null) continue;
    for (const [owner, d] of deltas.get(mint) ?? []) bump(owner, d * perUnit, asset);
  }
  // Native SOL the signer spent or received, net of the network fee.
  const lamports = (meta.postBalances[0] ?? 0) - (meta.preBalances[0] ?? 0) + (meta.fee ?? 0);
  if (sol != null && Math.abs(lamports) > 1e6) bump(signer, (lamports / 1e9) * sol, "SOL");

  const venues = VENUES.filter(([id]) => keys.includes(id)).map(([, name]) => name);
  const venue = venues.length ? venues.slice(0, 2).join(" → ") : null;

  let best: Decoded | null = null;
  for (const [mint, owners] of deltas) {
    const stock = BY_MINT.get(mint);
    if (!stock) continue;
    const moved = Math.max(0, ...[...owners.values()].map((v) => Math.abs(v)));
    if (moved < MIN_RAW) continue;

    // The pool: whoever gave up (or took in) the most stock and was paid the
    // other way for it. Its two legs are the fill.
    let pool: { stock: number; usd: number; asset: Print["quote"] } | null = null;
    for (const [owner, d] of owners) {
      if (owner === signer || Math.abs(d) < MIN_RAW) continue;
      const q = quoteUsd.get(owner);
      if (!q || Math.abs(q.usd) < 0.01 || Math.sign(q.usd) === Math.sign(d)) continue;
      if (!pool || Math.abs(d) > Math.abs(pool.stock)) pool = { stock: d, usd: q.usd, asset: q.asset };
    }

    const mine = owners.get(signer) ?? 0;
    const paid = quoteUsd.get(signer)?.usd ?? 0;
    let side: Side;
    let raw: number;
    if (Math.abs(mine) >= MIN_RAW) {
      // The signer's stock changed, but with no pool paid the other way and no
      // swap program in the transaction it is a wallet-to-wallet transfer.
      if (!pool && !venue) continue;
      side = mine > 0 ? "buy" : "sell";
      raw = Math.abs(mine);
    } else if (pool) {
      // The signer ended flat in the stock. If it also ended about flat in
      // dollars, it routed through and out again: an arbitrage. Otherwise it
      // bought or sold on behalf of another account.
      raw = Math.abs(pool.stock);
      side = Math.abs(paid) < 1 ? "arb" : paid < 0 ? "buy" : "sell";
    } else {
      // Stock moved but nobody was paid for it: a transfer, a mint, a deposit
      // into a vault. Not a trade, so not on the tape.
      continue;
    }

    const usd = pool ? Math.abs(pool.usd) * (raw / Math.abs(pool.stock)) : null;
    const print: Decoded = {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime || null,
      symbol: stock.symbol,
      base: stock.base,
      raw: round(raw, 6),
      side,
      wallet: signer,
      usd: usd == null ? null : round(usd, 2),
      quote: pool?.asset ?? null,
      venue,
    };
    if (!best || print.raw > best.raw) best = print;
  }
  if (!best || best.raw < MIN_RAW) return null;
  // Raw units times the UI price understates by the dividend multiplier (a few
  // percent at most), which is close enough to tell a trade from dust.
  const worth = best.usd ?? (ref.has(mintOf(best.symbol)) ? best.raw * ref.get(mintOf(best.symbol))! : null);
  if (worth != null && worth < MIN_USD) return null;
  return best;
}

async function poll(): Promise<Tape> {
  const started = Date.now();
  let calls = 0;
  let via: Via = solamiKey() ? "solami" : "public";
  let fallback: string | null = null;
  const call = async <T>(method: string, params: unknown[]) => {
    calls++;
    const out = await mainnetCall<T>(method, params, { prefer: via });
    // Once Solami has failed in a poll, the rest of the poll stays on the public RPC.
    if (out.via === "public" && out.fallback) {
      via = "public";
      fallback = out.fallback;
    }
    return out;
  };

  let slot = cache?.slot ?? 0;
  let rpcMs: number | null = null;
  let slotAt = Date.now();
  try {
    const out = await call<number>("getSlot", [{ commitment: "confirmed" }]);
    slot = out.result;
    // The first call on an instance pays for the TLS handshake; it is not the RPC's speed.
    rpcMs = warmed.has(out.via) ? out.ms : null;
    warmed.add(out.via);
    slotAt = Date.now();
    latestSlot = slot;
  } catch {
    // A missed getSlot is not worth an empty tape: keep the last slot and go on.
  }

  // Decode signatures into prints. Rows go into `seen` as soon as they are
  // decoded, so a warming answer can already show them.
  const decodeSome = async (sigs: Signature[], ref: Map<string, number>, times: Map<string, number | null>) => {
    const decoded: (Decoded & { live: boolean })[] = [];
    for (const s of sigs) {
      try {
        const out = await call<RawTx | null>("getTransaction", [
          s.signature,
          { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
        ]);
        if (!out.result) continue; // not served yet; a later poll retries it
        seen.set(s.signature, null);
        const d = decode(out.result, s.signature, ref);
        if (!d) continue;
        const row = { ...d, blockTime: times.get(s.signature) || s.blockTime || d.blockTime, live: live.has(s.signature) };
        decoded.push(row);
        // Provisional: placed by slot distance until the block time is read below.
        const exact = row.blockTime || blockTimes.get(row.slot) || null;
        const { blockTime: _b, ...rest } = row;
        void _b;
        seen.set(s.signature, {
          ...rest,
          time: exact ?? Math.round(slotAt / 1000 - (slot - row.slot) * SLOT_SECONDS),
          timeSource: exact ? "chain" : "slot",
          seenAt: Date.now(),
          refPrice: ref.get(mintOf(row.symbol)) ?? null,
          refAt: ref.has(mintOf(row.symbol)) && refPrices ? Math.round(refPrices.at / 1000) : null,
        });
      } catch (err) {
        // An outage is retried on a later poll; a request the node refused is not.
        if (err instanceof RpcError && err.answered) seen.set(s.signature, null);
      }
    }
    return decoded;
  };

  // A cold instance has an empty tape, so its first poll is the backfill: the
  // last 20 signatures on every watched mint (ten paced calls, once). The two
  // busiest mints go first and their newest two trades are decoded straight
  // away (about three seconds), so the first answer, even a `warming` one,
  // already has rows; then the other mints, and the rest queue for later polls.
  const cold = !backfilled;
  const batch = cold ? STOCKS : [0, 1].map((i) => STOCKS[(cursor + i) % STOCKS.length]);
  if (!cold) cursor = (cursor + batch.length) % STOCKS.length;
  const lists: { mint: string; sigs: Signature[] }[] = [];
  const quickStart = async () => {
    if (lists.length !== 2) return;
    const sigs = lists.flatMap((l) => l.sigs).filter((s) => !s.err && !seen.has(s.signature));
    const first = sigs.sort((a, b) => b.slot - a.slot).slice(0, 2);
    if (!first.length) return;
    await decodeSome(first, await prices(), new Map(first.map((s) => [s.signature, s.blockTime || null])));
  };
  for (const s of batch) {
    if (cold) await quickStart();
    try {
      const out = await call<Signature[]>("getSignaturesForAddress", [
        s.mint,
        { limit: cold ? 20 : 6, commitment: "confirmed" },
      ]);
      lists.push({ mint: s.mint, sigs: out.result ?? [] });
    } catch {
      lists.push({ mint: s.mint, sigs: [] });
    }
  }
  if (lists.every((l) => l.sigs.length === 0) && rpcMs == null) {
    throw new Error("Mainnet did not answer this poll.");
  }
  if (cold && lists.some((l) => l.sigs.length)) backfilled = true;

  // A signature above the newest one read last time for its mint landed since
  // we last looked: live. Everything else (the backfill, a first look) is history.
  if (live.size > 400) for (const k of [...live].slice(0, live.size - 200)) live.delete(k);
  for (const { mint, sigs } of lists) {
    const before = lastLook.get(mint);
    for (const s of sigs) if (before != null && s.slot > before) live.add(s.signature);
    if (sigs.length) lastLook.set(mint, Math.max(before ?? 0, ...sigs.map((s) => s.slot)));
  }
  const all = lists.flatMap((l) => l.sigs);
  const sigTimes = new Map(all.map((s) => [s.signature, s.blockTime || null]));
  for (const s of all) slot = Math.max(slot, s.slot);

  const unseen = (s: Signature) => !s.err && !seen.has(s.signature);
  const candidates = all.filter(unseen).sort((a, b) => b.slot - a.slot);
  const now0 = candidates.filter((s) => live.has(s.signature) || cold);
  const fresh = now0.slice(0, cold ? 4 : 3);
  // What this poll cannot decode waits in the backlog, newest first.
  const taken = new Set(fresh.map((s) => s.signature));
  const queued = new Set(backlog.map((s) => s.signature));
  backlog = [...backlog, ...candidates.filter((s) => !taken.has(s.signature) && !queued.has(s.signature))]
    .filter(unseen)
    .sort((a, b) => b.slot - a.slot)
    .slice(0, BACKLOG_MAX);
  // While the tape is short, each poll also works a few signatures off the backlog.
  const shown = [...seen.values()].filter(Boolean).length;
  const extra = cold || shown >= 30 ? [] : backlog.splice(0, shown < 12 ? 2 : 1);
  const work = [...fresh, ...extra];

  const ref = work.length ? await prices() : (refPrices?.usd ?? new Map<string, number>());
  const decoded = await decodeSome(work.filter(unseen), ref, sigTimes);

  // Solami answers blockTime 0 at "confirmed". One getBlockTime on the newest
  // fresh slot anchors the rest, which are placed by slot distance from it.
  const missing = decoded.filter((d) => !d.blockTime && !blockTimes.has(d.slot));
  if (missing.length) {
    const newest = Math.max(...missing.map((d) => d.slot));
    try {
      const out = await call<number | null>("getBlockTime", [newest]);
      if (out.result) blockTimes.set(newest, out.result);
    } catch {}
  }
  const anchors = [...blockTimes.entries()].sort((a, b) => b[0] - a[0]);
  const estimate = (s: number) => {
    const near = anchors.find(([at]) => Math.abs(at - s) < 2_000);
    if (near) return Math.round(near[1] - (near[0] - s) * SLOT_SECONDS);
    return Math.round(slotAt / 1000 - (slot - s) * SLOT_SECONDS);
  };
  const now = Date.now();
  // Settle the times of this poll's rows (and any provisional ones) against the anchors.
  for (const p of seen.values()) {
    if (!p || p.timeSource === "chain") continue;
    const exact = blockTimes.get(p.slot) ?? null;
    p.time = exact ?? estimate(p.slot);
    p.timeSource = exact ? "chain" : "slot";
  }

  if (seen.size > 600) {
    for (const k of [...seen.keys()].slice(0, seen.size - 400)) seen.delete(k);
  }
  if (blockTimes.size > 200) {
    for (const k of [...blockTimes.keys()].slice(0, blockTimes.size - 100)) blockTimes.delete(k);
  }

  // Once a minute (never on the backfill poll, which a visitor is waiting on),
  // the comparison: the same getSlot sent to both upstreams at the same
  // instant, three times after a warm-up pair, and one getTransaction on both
  // for the newest signature this poll read, if it landed in the last ~30 s.
  // Solami's half of it is five paced calls a minute.
  if (!cold && solamiKey() && (!slotRace || now - slotRace.at > RACE_EVERY_MS)) {
    const race = await raceSlot(3);
    if (race) {
      slotRace = race;
      calls += (race.samples + 1) * 2;
    }
    const newest = all.filter((s) => !s.err).sort((a, b) => b.slot - a.slot)[0];
    if (newest && slot - newest.slot < 75) {
      const tx = await raceTransaction(newest.signature);
      calls += 2;
      if (tx && tx.solami != null && tx.public != null) {
        freshTx.tried++;
        if (tx.solami) freshTx.solami++;
        if (tx.public) freshTx.public++;
      }
    }
  }

  const prints = [...seen.values()]
    .filter((p): p is Print => p != null)
    .sort((a, b) => b.slot - a.slot || b.time - a.time)
    .slice(0, DEPTH);
  return {
    slot,
    via,
    fallback,
    stale: false,
    prints,
    polledAt: Date.now(),
    watching: STOCKS.map((s) => s.base),
    backlog: backlog.length,
    proof: {
      instance: INSTANCE,
      since: SINCE,
      rpcMs,
      compare: { slot: slotRace, freshTx: { ...freshTx }, upstreams: upstreamStats() },
      calls,
      pollMs: Date.now() - started,
    },
  };
}

function refresh(): Promise<Tape> {
  if (!inflight) {
    inflight = poll()
      .then((t) => (cache = t))
      .catch((err) => {
        // A failed poll answers with the last good tape, marked stale.
        if (cache) return { ...cache, stale: true };
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Fresh for 3 s. Up to 30 s old, the cached tape answers at once while a new
 * poll runs behind it (a poll is several paced calls, a few seconds end to end).
 * Older than that, the caller waits for the poll for at most 1.5 s; past that it
 * gets the cached tape marked `stale` with its `ageMs`, and the poll finishes
 * in the background. A visitor never waits on a slow poll; the page re-polls
 * every few seconds and picks up the fresh tape then.
 *
 * `background` runs the behind-the-response poll. The route passes Next's
 * `after()`, which keeps a serverless function alive until the poll finishes
 * instead of freezing it the moment the response is sent.
 *
 * A cold instance's backfill is about fifteen paced calls (ten seconds or
 * so). The caller waits up to four; past that it gets a tape marked `warming`
 * holding whatever the backfill has decoded so far (it decodes the busiest two
 * mints' newest trades first, in about three seconds), and the backfill
 * finishes in the background for the next request.
 */
/** The longest a visitor waits for a poll when an older tape is cached. */
const STALE_WAIT_MS = 1_500;

export async function readTape(background?: (task: () => Promise<unknown>) => void): Promise<Tape> {
  const age = cache ? Date.now() - cache.polledAt : Infinity;
  if (cache && age < 3_000) return cache;
  const later = (task: () => Promise<unknown>) => (background ? background(task) : void task());
  if (cache && age < 30_000) {
    later(() => refresh().catch(() => {}));
    return cache;
  }
  if (cache) {
    const stale = cache;
    const pending = refresh();
    const fresh = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), STALE_WAIT_MS))]);
    if (fresh) return fresh;
    later(() => pending.catch(() => {}));
    return { ...stale, stale: true, ageMs: Date.now() - stale.polledAt };
  }
  const poll = refresh();
  const first = await Promise.race([poll, new Promise<null>((r) => setTimeout(() => r(null), 4_000))]);
  if (first) return first;
  later(() => poll.catch(() => {}));
  return {
    slot: latestSlot,
    via: solamiKey() ? "solami" : "public",
    fallback: null,
    stale: false,
    warming: true,
    // Whatever the backfill has decoded so far (its first rows land in about three seconds).
    prints: [...seen.values()]
      .filter((p): p is Print => p != null)
      .sort((a, b) => b.slot - a.slot || b.time - a.time)
      .slice(0, DEPTH),
    polledAt: Date.now(),
    watching: STOCKS.map((s) => s.base),
    backlog: 0,
    proof: {
      instance: INSTANCE,
      since: SINCE,
      rpcMs: null,
      compare: { slot: slotRace, freshTx: { ...freshTx }, upstreams: upstreamStats() },
      calls: 0,
      pollMs: 0,
    },
  };
}
