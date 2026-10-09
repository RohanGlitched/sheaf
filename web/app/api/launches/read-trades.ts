import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { NATIVE_SOL, dammV2PoolAddress } from "@/lib/dbc";
import { teamTag } from "@/lib/team-wallets";

/** The program PDAs that own every curve vault (DBC) and every graduated pool vault (DAMM v2). */
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";

/** How many recent signatures are read per market. Counts are over these, so they are lower bounds past it. */
export const TRADE_WINDOW = 100;

export type LaunchTrade = {
  signature: string;
  /** Unix seconds, when the cluster reports it. */
  at: number | null;
  /** The fee payer, which signs the swap. */
  wallet: string;
  /** "house", "treasury", "deploy" or "test wallet" for Sheaf's own wallets; null for anyone else. */
  team: string | null;
  side: "buy" | "sell";
  /** SOL the trade moved into or out of the pool's SOL vault, fees included. */
  sol: number;
  market: "curve" | "damm";
};

export type LaunchTrades = {
  trades: LaunchTrade[];
  /** Distinct wallets outside the Sheaf team that traded. Team, house and test wallets never count. */
  traders: number;
  teamTrades: number;
  outsideTrades: number;
};

const cache = new Map<string, { at: number; value: LaunchTrades }>();

async function parsed(connection: Connection, signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
  if (signatures.length === 0) return [];
  const options = { maxSupportedTransactionVersion: 0, commitment: "confirmed" as const };
  try {
    return await connection.getParsedTransactions(signatures, options);
  } catch {
    // Some RPC plans refuse batch requests; fall back to a few at a time.
    const out: (ParsedTransactionWithMeta | null)[] = [];
    for (let i = 0; i < signatures.length; i += 5) {
      out.push(
        ...(await Promise.all(
          signatures.slice(i, i + 5).map((s) => connection.getParsedTransaction(s, options).catch(() => null)),
        )),
      );
    }
    return out;
  }
}

/** One swap, read from the change in the pool's SOL vault; null for anything that is not a swap. */
function tradeOf(
  tx: ParsedTransactionWithMeta | null,
  signature: string,
  market: LaunchTrade["market"],
  authority: string,
): LaunchTrade | null {
  if (!tx?.meta || tx.meta.err) return null;
  if (!(tx.meta.logMessages ?? []).some((l) => /Instruction: Swap/.test(l))) return null;
  const vault = (balances: typeof tx.meta.preTokenBalances) =>
    (balances ?? []).find((b) => b.mint === NATIVE_SOL.toBase58() && b.owner === authority);
  const pre = vault(tx.meta.preTokenBalances);
  const post = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === pre?.accountIndex);
  if (!pre || !post) return null;
  const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount);
  if (delta === 0n) return null;
  const wallet = tx.transaction.message.accountKeys[0].pubkey.toBase58();
  return {
    signature,
    at: tx.blockTime ?? null,
    wallet,
    team: teamTag(wallet),
    side: delta > 0n ? "buy" : "sell",
    sol: Number(delta < 0n ? -delta : delta) / 1e9,
    market,
  };
}

/**
 * Every recent swap on a launch's curve, and on its DAMM v2 pool once it has
 * graduated, newest first, with Sheaf's own wallets tagged. Read from the
 * chain on request (cached 30 seconds per pool); no indexer.
 */
export async function readTrades(
  connection: Connection,
  launch: { pool: string; baseMint: string; migrated: boolean },
): Promise<LaunchTrades> {
  const key = `${launch.pool}:${launch.migrated}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;

  const markets: { address: string; market: LaunchTrade["market"]; authority: string }[] = [
    { address: launch.pool, market: "curve", authority: DBC_POOL_AUTHORITY },
  ];
  if (launch.migrated) {
    markets.push({ address: dammV2PoolAddress(launch.baseMint), market: "damm", authority: DAMM_V2_POOL_AUTHORITY });
  }
  const trades: LaunchTrade[] = [];
  for (const m of markets) {
    const signatures = (await connection.getSignaturesForAddress(new PublicKey(m.address), { limit: TRADE_WINDOW }))
      .filter((s) => !s.err)
      .map((s) => s.signature);
    const txs = await parsed(connection, signatures);
    txs.forEach((tx, i) => {
      const trade = tradeOf(tx, signatures[i], m.market, m.authority);
      if (trade) trades.push(trade);
    });
  }
  trades.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const outside = trades.filter((t) => t.team == null);
  const value: LaunchTrades = {
    trades,
    traders: new Set(outside.map((t) => t.wallet)).size,
    teamTrades: trades.length - outside.length,
    outsideTrades: outside.length,
  };
  // Keys are official launch pools only (the routes check), but keep the map bounded anyway.
  if (cache.size >= 100) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
