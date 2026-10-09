import "server-only";
import { XSTOCKS } from "./universe";
import { RpcError, mainnetCall, solamiKey, timeSlot, type Via } from "./solami";

/**
 * The tape: trades in tokenized stocks on Solana mainnet, as they land.
 *
 * Read through Solami's RPC when a key is set (see lib/solami.ts for the pacing
 * and the fallback). Each poll asks for the newest signatures on two of the
 * busiest stock mints (rotating), decodes up to three it has not seen, and works
 * out from the token balances which pool gave up the stock, what it was paid,
 * and so the price of the fill. One shared cache answers every visitor, and the
 * CDN coalesces on top, so the page can poll every few seconds while the server
 * stays inside Solami's free limit of five requests a second.
 *
 * A poll is at most seven Solami calls, sent one at a time about 240 ms apart:
 * getSlot, getSignaturesForAddress x2, getTransaction x<=3, getBlockTime x<=1,
 * plus one getSlot every 30 s for the Solami-vs-public timing. While a cold
 * instance's tape is thin, a poll reads four mints and decodes up to six
 * (at most twelve calls, still paced; only an instance's first three polls).
 */

export type Side = "buy" | "sell" | "arb" | "move";

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
};

export type Tape = {
  slot: number;
  /** Which RPC answered this poll's reads. */
  via: Via;
  /** Set when a Solami key is configured but the public RPC had to answer, with the reason. */
  fallback: string | null;
  /** True when this is the last good tape, returned because a fresh poll failed. */
  stale: boolean;
  prints: Print[];
  polledAt: number;
  /** Mints the tape watches, so the page can say what it is reading. */
  watching: string[];
  proof: {
    /** Round trip of this poll's getSlot, in ms, against `via`. */
    rpcMs: number | null;
    /** Last side-by-side getSlot, Solami vs the public RPC, refreshed every 30 s. */
    race: { solamiMs: number | null; publicMs: number | null; at: number } | null;
    /** RPC calls this poll sent and how long it took end to end. */
    calls: number;
    pollMs: number;
  };
};

/** The mints we watch; the rest of the universe trades too rarely to fill a tape. */
const WATCH = ["SPY", "NVDA", "TSLA", "AAPL", "QQQ", "CRCL", "MSTR", "COIN", "GOOGL", "HOOD"];
const STOCKS = XSTOCKS.filter((x) => WATCH.includes(x.base));
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
let warmups = 0;
let race: Tape["proof"]["race"] = null;

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

type Decoded = Omit<Print, "time" | "timeSource" | "seenAt"> & { blockTime: number | null };

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
      side = mine > 0 ? "buy" : "sell";
      raw = Math.abs(mine);
    } else if (pool) {
      // The signer ended flat in the stock. If it also ended about flat in
      // dollars, it routed through and out again: an arbitrage. Otherwise it
      // bought or sold on behalf of another account.
      raw = Math.abs(pool.stock);
      side = Math.abs(paid) < 1 ? "arb" : paid < 0 ? "buy" : "sell";
    } else {
      side = "move";
      raw = moved;
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
    rpcMs = out.ms;
    slotAt = Date.now();
  } catch {
    // A missed getSlot is not worth an empty tape: keep the last slot and go on.
  }

  // A cold instance has an empty tape: its first polls read four mints and
  // decode up to six trades (about a dozen paced calls, once), so a new
  // visitor is not left looking at an empty list.
  const thin = warmups < 3 && [...seen.values()].filter(Boolean).length < 6;
  if (thin) warmups++;
  const width = thin ? 4 : 2;
  const batch = Array.from({ length: width }, (_, i) => STOCKS[(cursor + i) % STOCKS.length]);
  cursor = (cursor + width) % STOCKS.length;
  const lists: Signature[][] = [];
  for (const s of batch) {
    try {
      const out = await call<Signature[]>("getSignaturesForAddress", [s.mint, { limit: 6, commitment: "confirmed" }]);
      lists.push(out.result ?? []);
    } catch {
      lists.push([]);
    }
  }
  if (lists.every((l) => l.length === 0) && rpcMs == null) {
    throw new Error("Mainnet did not answer this poll.");
  }
  const sigTimes = new Map(lists.flat().map((s) => [s.signature, s.blockTime || null]));
  for (const s of lists.flat()) slot = Math.max(slot, s.slot);

  const fresh = lists
    .flat()
    .filter((s) => !s.err && !seen.has(s.signature))
    .sort((a, b) => b.slot - a.slot)
    .slice(0, thin ? 6 : 3);

  const ref = fresh.length ? await prices() : (refPrices?.usd ?? new Map<string, number>());
  const decoded: Decoded[] = [];
  for (const s of fresh) {
    try {
      const out = await call<RawTx | null>("getTransaction", [
        s.signature,
        { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
      ]);
      if (!out.result) continue; // not served yet; a later poll retries it
      seen.set(s.signature, null);
      const d = decode(out.result, s.signature, ref);
      if (d) decoded.push({ ...d, blockTime: sigTimes.get(s.signature) || d.blockTime });
    } catch (err) {
      // An outage is retried on a later poll; a request the node refused is not.
      if (err instanceof RpcError && err.answered) seen.set(s.signature, null);
    }
  }

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
  for (const { blockTime, ...rest } of decoded) {
    const exact = blockTime || blockTimes.get(rest.slot) || null;
    seen.set(rest.signature, {
      ...rest,
      time: exact ?? estimate(rest.slot),
      timeSource: exact ? "chain" : "slot",
      seenAt: now,
    });
  }

  if (seen.size > 600) {
    for (const k of [...seen.keys()].slice(0, seen.size - 400)) seen.delete(k);
  }
  if (blockTimes.size > 200) {
    for (const k of [...blockTimes.keys()].slice(0, blockTimes.size - 100)) blockTimes.delete(k);
  }

  // Every 30 s, one getSlot to each upstream back to back: the side-by-side
  // the page shows. Public calls do not count against Solami's budget.
  if (solamiKey() && (!race || now - race.at > 30_000)) {
    const a = await timeSlot("solami");
    const b = await timeSlot("public");
    calls += 2;
    race = { solamiMs: a?.ms ?? null, publicMs: b?.ms ?? null, at: Date.now() };
  }

  const prints = [...seen.values()]
    .filter((p): p is Print => p != null)
    .sort((a, b) => b.slot - a.slot || b.time - a.time)
    .slice(0, 30);
  return {
    slot,
    via,
    fallback,
    stale: false,
    prints,
    polledAt: Date.now(),
    watching: STOCKS.map((s) => s.base),
    proof: { rpcMs, race, calls, pollMs: Date.now() - started },
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
 * poll runs behind it (a poll is several paced calls, a few seconds end to end);
 * older than that, the caller waits for the poll.
 */
export async function readTape(): Promise<Tape> {
  const age = cache ? Date.now() - cache.polledAt : Infinity;
  if (cache && age < 3_000) return cache;
  if (cache && age < 30_000) {
    void refresh().catch(() => {});
    return cache;
  }
  return refresh();
}
