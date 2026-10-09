import "server-only";
import { Connection, PublicKey } from "@solana/web3.js";
import { serverRpcUrl, SITE_URL } from "./config";
import { dammV2PoolAddress, openLaunches } from "./dbc";
import { entriesOf, type LedgerEntry } from "./ledger";
import { fetchBaskets } from "./sheaf";
import { money, quantity } from "./format";
import type { Proof } from "./voices-message";

/**
 * Has this wallet really done something on Sheaf? A name is listed on /voices
 * only once it has: one Sheaf program event with the wallet as its actor (a
 * basket created, shares created or redeemed, a dollar order, a plan, a sale),
 * or one swap the wallet paid for on an official Sheaf launch pool (the Meteora
 * curve or, once graduated, its DAMM v2 pool).
 *
 * Read from the wallet's own recent transactions (its newest 100), decoded with
 * the ledger's decoder, so there is no 300-transaction window on the program:
 * an action from weeks ago still counts. The first proof found is stored with
 * the entry, so it is checked once and never expires.
 */

const WINDOW = 100;
const POOLS_TTL_MS = 5 * 60_000;

let pools: { at: number; bySymbol: Map<string, string> } | null = null;

/**
 * The pools the server's anchor check refused (pool -> reason), from the launches
 * feed (cached at the edge), as lib/use-launches.ts fetchRejected reads it in the
 * browser. Throws when the feed cannot be read, so no refused pool ever counts.
 */
async function refusedPools(): Promise<Map<string, string>> {
  const res = await fetch(`${SITE_URL}/api/launches?tests=1`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`launches feed: HTTP ${res.status}`);
  const body = (await res.json()) as { launches?: { unofficial?: { pool: string; reason?: string; anchor?: { status?: string } }[] }[] };
  const refused = new Map<string, string>();
  for (const l of body.launches ?? []) {
    for (const u of l.unofficial ?? []) {
      if (u.anchor?.status === "mismatch") refused.set(u.pool, u.reason ?? "It did not open at half the basket's NAV.");
    }
  }
  return refused;
}

/**
 * Every official launch market's address (curve and DAMM v2), mapped to the
 * basket's symbol. A pool that did not open at half of NAV is not official, so a
 * swap on it proves nothing; without the refused list, no launch swap counts this time.
 */
async function officialMarkets(connection: Connection): Promise<Map<string, string>> {
  if (pools && Date.now() - pools.at < POOLS_TTL_MS) return pools.bySymbol;
  const [baskets, refused] = await Promise.all([fetchBaskets(connection), refusedPools()]);
  const symbol = new Map(baskets.map((b) => [b.address, b.symbol]));
  const found = await openLaunches(connection, baskets, refused);
  const bySymbol = new Map<string, string>();
  for (const [basket, info] of found) {
    const sym = symbol.get(basket) ?? info.baseSymbol;
    bySymbol.set(info.pool, sym);
    bySymbol.set(dammV2PoolAddress(info.baseMint), sym);
  }
  pools = { at: Date.now(), bySymbol };
  return bySymbol;
}

/** The events that count as the wallet acting. Kinds not listed here (a fee accruing to a creator, say) happen to a wallet, not by it. */
const VERB: Partial<Record<LedgerEntry["kind"], (e: LedgerEntry) => string>> = {
  created: (e) => (e.symbol ? `created the ${e.symbol} basket` : "created a basket"),
  minted: (e) => `created ${quantity(e.shares ?? 0, 2)} shares in kind`,
  redeemed: (e) => `redeemed ${quantity(e.shares ?? 0, 2)} shares for the stocks`,
  ordered: (e) => `placed a ${money(e.cash ?? 0)} dollar order`,
  planRun: () => "ran a scheduled plan order",
  filled: (e) => `bought ${money(e.cash ?? 0)} of a basket`,
  returned: (e) => `got ${money(e.cash ?? 0)} back on an unfilled order`,
  planOpened: (e) => `opened a plan, ${money(e.cash ?? 0)} a run`,
  sellOrdered: (e) => `offered ${quantity(e.shares ?? 0, 2)} shares for dollars`,
  sold: (e) => `sold ${quantity(e.shares ?? 0, 2)} shares for ${money(e.cash ?? 0)}`,
  sellReturned: () => "had an unsold offer returned",
};

/** The wallet's first provable Sheaf action, or null when its recent transactions show none. */
export async function findProof(wallet: string): Promise<Proof | null> {
  const connection = new Connection(serverRpcUrl(), "confirmed");
  const owner = new PublicKey(wallet);
  const [signatures, markets] = await Promise.all([
    connection.getSignaturesForAddress(owner, { limit: WINDOW }, "confirmed"),
    officialMarkets(connection).catch(() => new Map<string, string>()),
  ]);
  const ok = signatures.filter((s) => s.err == null);
  for (let i = 0; i < ok.length; i += 25) {
    const chunk = ok.slice(i, i + 25);
    const txs = await connection.getTransactions(
      chunk.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    );
    for (let k = 0; k < chunk.length; k++) {
      const tx = txs[k];
      const info = chunk[k];
      if (!tx?.meta || tx.meta.err) continue;
      const time = tx.blockTime ?? info.blockTime ?? null;

      const event = entriesOf(info, tx.meta.logMessages, tx.blockTime).find((e) => e.actor === wallet && VERB[e.kind]);
      if (event) return { kind: "sheaf", signature: info.signature, time, text: VERB[event.kind]!(event) };

      if (markets.size > 0 && (tx.meta.logMessages ?? []).some((l) => /Instruction: Swap/.test(l))) {
        const keys = tx.transaction.message
          .getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
          .keySegments()
          .flat()
          .map((key) => key.toBase58());
        // The fee payer signs the swap; a swap someone else paid for is theirs, not this wallet's.
        const market = keys[0] === wallet ? keys.find((key) => markets.has(key)) : undefined;
        if (market) return { kind: "launch", signature: info.signature, time, text: `swapped on the ${markets.get(market)} launch pool` };
      }
    }
  }
  return null;
}
