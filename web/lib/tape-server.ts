import "server-only";
import { XSTOCKS } from "./universe";
import { MAINNET_RPC } from "./config";

/**
 * The tape: trades in tokenized stocks on Solana mainnet, as they land.
 *
 * Read through Solami's RPC when a key is set. Each poll asks for the newest
 * signatures on two of the busiest stock mints (rotating), decodes the ones it has
 * not seen, and works out from the token balances who gained or lost the stock.
 * One shared cache answers every visitor, so the page can poll every few seconds
 * while the server stays inside Solami's free limit of five requests a second.
 */

export type Print = {
  signature: string;
  slot: number;
  time: number | null;
  symbol: string;
  base: string;
  /** Whole tokens that changed hands (before the dividend multiplier). */
  amount: number;
  side: "buy" | "sell" | "move";
  wallet: string;
};

export type Tape = {
  slot: number;
  via: "solami" | "public";
  prints: Print[];
  polledAt: number;
  /** Mints the tape watches, so the page can say what it is reading. */
  watching: string[];
};

/** The mints we watch; the rest of the universe trades too rarely to fill a tape. */
const WATCH = ["SPY", "NVDA", "TSLA", "AAPL", "QQQ", "CRCL", "MSTR", "COIN", "GOOGL", "HOOD"];
const STOCKS = XSTOCKS.filter((x) => WATCH.includes(x.base));
const BY_MINT = new Map(STOCKS.map((x) => [x.mint, x]));

function endpoint(): { url: string; via: Tape["via"] } {
  const key = process.env.SOLAMI_API_KEY?.trim();
  return key
    ? { url: `https://rpc.solami.dev/solana?api-key=${encodeURIComponent(key)}`, via: "solami" }
    : { url: MAINNET_RPC, via: "public" };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

type Balance = { mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } };
type RawTx = {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; preTokenBalances?: Balance[]; postTokenBalances?: Balance[] } | null;
  transaction: { message: { accountKeys: string[] } };
};

const seen = new Map<string, Print | null>();
let cache: Tape | null = null;
let inflight: Promise<Tape> | null = null;
let cursor = 0;

function decode(tx: RawTx, signature: string): Print | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  // The fee payer, first in the account list, is the wallet that sent the trade.
  const signer = tx.transaction.message.accountKeys[0] ?? "";
  const deltas = new Map<string, Map<string, number>>();
  const add = (b: Balance, sign: 1 | -1) => {
    if (!b.owner || !BY_MINT.has(b.mint)) return;
    const m = deltas.get(b.mint) ?? new Map<string, number>();
    m.set(b.owner, (m.get(b.owner) ?? 0) + sign * (b.uiTokenAmount.uiAmount ?? 0));
    deltas.set(b.mint, m);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1);
  for (const b of meta.postTokenBalances ?? []) add(b, 1);
  let best: Print | null = null;
  for (const [mint, owners] of deltas) {
    const stock = BY_MINT.get(mint)!;
    const moved = Math.max(0, ...[...owners.values()].map((v) => Math.abs(v)));
    if (moved < 1e-9) continue;
    const mine = owners.get(signer) ?? 0;
    const side: Print["side"] = mine > 1e-12 ? "buy" : mine < -1e-12 ? "sell" : "move";
    const print: Print = {
      signature,
      slot: tx.slot,
      time: tx.blockTime,
      symbol: stock.symbol,
      base: stock.base,
      amount: side === "move" ? moved : Math.abs(mine),
      side,
      wallet: signer,
    };
    if (!best || print.amount > best.amount) best = print;
  }
  return best;
}

async function poll(): Promise<Tape> {
  const { url, via } = endpoint();
  const batch = [STOCKS[cursor % STOCKS.length], STOCKS[(cursor + 1) % STOCKS.length]];
  cursor = (cursor + 2) % STOCKS.length;
  const [slot, ...lists] = await Promise.all([
    rpc<number>(url, "getSlot", [{ commitment: "confirmed" }]),
    ...batch.map((s) =>
      rpc<{ signature: string; slot: number; err: unknown }[]>(url, "getSignaturesForAddress", [
        s.mint,
        { limit: 5, commitment: "confirmed" },
      ]).catch(() => []),
    ),
  ]);
  const fresh = lists
    .flat()
    .filter((s) => !s.err && !seen.has(s.signature))
    .sort((a, b) => b.slot - a.slot)
    .slice(0, 2);
  await Promise.all(
    fresh.map(async (s) => {
      const tx = await rpc<RawTx | null>(url, "getTransaction", [
        s.signature,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]).catch(() => null);
      // A failed read is retried on a later poll rather than remembered as empty.
      if (tx) seen.set(s.signature, decode(tx, s.signature));
    }),
  );
  if (seen.size > 600) {
    for (const k of [...seen.keys()].slice(0, seen.size - 400)) seen.delete(k);
  }
  const prints = [...seen.values()]
    .filter((p): p is Print => p != null)
    .sort((a, b) => b.slot - a.slot)
    .slice(0, 24);
  return { slot, via, prints, polledAt: Date.now(), watching: STOCKS.map((s) => s.base) };
}

export async function readTape(): Promise<Tape> {
  if (cache && Date.now() - cache.polledAt < 3000) return cache;
  if (!inflight) {
    inflight = poll()
      .then((t) => (cache = t))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
