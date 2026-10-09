import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getScaledUiAmountConfig, unpackMint } from "@solana/spl-token";
import { pacedFetch, reportSolamiFailure, rpcUrl, solamiCooling, solamiKey, type Via } from "./solami";

/**
 * Mainnet reads go through Solami's private RPC when a key is configured, and
 * fall back to the public endpoint when it is not, or when Solami fails this
 * read. `via` says which one actually answered. The key stays on the server.
 *
 * Failures are not swallowed: each is logged, a Solami failure puts Solami on
 * its cool-down, and the last one is kept for routes to report beside the data
 * (lastMintReadFailure, shown by /api/market as `chainError`).
 */

export type MintState = {
  /** Raw supply over 10^decimals, before the multiplier. */
  supply: number;
  multiplier: number;
  nextMultiplier: number | null;
  /** ISO time the next multiplier takes effect, if one is scheduled. */
  nextMultiplierAt: string | null;
};

export type ChainRead = {
  slot: number;
  via: "solami" | "public";
  mints: Map<string, MintState>;
};

/**
 * Every mint in one round trip, straight from its account: the supply and the
 * Token-2022 ScaledUiAmount config that carries each dividend multiplier. These
 * are the numbers that value a basket, so they come from the chain rather than
 * from an aggregator's copy of it.
 */
export async function readMints(mints: string[]): Promise<ChainRead | null> {
  const order: Via[] = solamiKey() && !solamiCooling() ? ["solami", "public"] : ["public"];
  const failures: string[] = [];
  for (const via of order) {
    try {
      const read = await readMintsVia(via, mints);
      if (via === "public" && solamiKey()) {
        // Solami was skipped or failed: say so rather than pass the public answer off silently.
        lastFailure = {
          at: Date.now(),
          message: failures.length ? failures.join("; ") : `Solami is cooling down (${solamiCooling() ?? "recent failure"})`,
          answeredBy: "public",
        };
      }
      return read;
    } catch (err) {
      const message = `${via}: ${(err as Error).message?.slice(0, 160) || "read failed"}`;
      failures.push(message);
      // A Solami failure puts it on the same short cool-down the tape uses.
      if (via === "solami") reportSolamiFailure(message);
      console.error(`[mainnet] mint read failed via ${message}`);
    }
  }
  lastFailure = { at: Date.now(), message: failures.join("; ") || "no RPC answered", answeredBy: null };
  return null;
}

/**
 * The last time a mint read could not come from Solami: when, why, and who
 * answered instead (null if nobody did). Routes surface it next to the data.
 */
export type MintReadFailure = { at: number; message: string; answeredBy: Via | null };
let lastFailure: MintReadFailure | null = null;
export function lastMintReadFailure(): MintReadFailure | null {
  return lastFailure;
}

async function readMintsVia(via: Via, mints: string[]): Promise<ChainRead> {
  const connection = new Connection(rpcUrl(via), {
    commitment: "confirmed",
    fetch: pacedFetch(via),
    // web3.js would otherwise retry 429s on its own schedule, outside the pacing.
    disableRetryOnRateLimit: true,
  });
  {
    const keys = mints.map((m) => new PublicKey(m));
    const out = new Map<string, MintState>();
    let slot = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const { context, value } = await connection.getMultipleAccountsInfoAndContext(chunk);
      slot = Math.max(slot, context.slot);
      value.forEach((account, j) => {
        if (!account || !account.owner.equals(TOKEN_2022_PROGRAM_ID)) return;
        const mint = unpackMint(chunk[j], account, TOKEN_2022_PROGRAM_ID);
        const scaled = getScaledUiAmountConfig(mint);
        const at = scaled ? Number(scaled.newMultiplierEffectiveTimestamp) * 1000 : 0;
        // A scheduled step switches on by itself once its time has passed.
        const stepped = scaled != null && at > 0 && scaled.newMultiplier !== scaled.multiplier;
        const pending = stepped && at > Date.now();
        out.set(chunk[j].toBase58(), {
          supply: Number(mint.supply) / 10 ** mint.decimals,
          multiplier: stepped && !pending ? scaled.newMultiplier : (scaled?.multiplier ?? 1),
          nextMultiplier: pending ? scaled.newMultiplier : null,
          nextMultiplierAt: pending ? new Date(at).toISOString() : null,
        });
      });
    }
    if (out.size === 0) throw new Error("no Token-2022 mint in the answer");
    return { slot, via, mints: out };
  }
}
