import { Connection, PublicKey } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, serverRpcUrl } from "@/lib/config";
import { faucetKeypair } from "@/lib/faucet-server";
import { lastBeats } from "@/lib/server-heartbeat";

export const dynamic = "force-dynamic";

/**
 * GET /api/heartbeat → { keeperLastRunAt, evmKeeperLastRunAt, houseSol, deploySol, ... }
 *
 * Whether the keepers are alive and the keys can pay, for a scheduler's alert and
 * a "keeper last ran" line on the pages. Times are ISO strings or null.
 *
 *  - keeperLastRunAt: the later of this instance's last finished run and the
 *    house key's newest transaction on devnet (another instance may have run it).
 *  - evmKeeperLastRunAt: this instance's last full EVM sweep, if it served one.
 *  - houseSol: the house key (faucet, keeper, mint authority).
 *  - deploySol: the program's upgrade authority, read from its program-data account.
 */

/** Below this the house key stops paying for new plans and token accounts soon; alert on it. */
const HOUSE_ALERT_SOL = 4;
const CACHE_MS = 15_000;
let cached: { at: number; body: Record<string, unknown> } | null = null;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

async function upgradeAuthority(connection: Connection): Promise<PublicKey | null> {
  const program = await connection.getParsedAccountInfo(new PublicKey(SHEAF_PROGRAM_ID));
  const data = program.value?.data;
  const programData = data && "parsed" in data ? (data.parsed?.info?.programData as string | undefined) : undefined;
  if (!programData) return null;
  const pd = await connection.getParsedAccountInfo(new PublicKey(programData));
  const pdData = pd.value?.data;
  const authority = pdData && "parsed" in pdData ? (pdData.parsed?.info?.authority as string | undefined) : undefined;
  return authority ? new PublicKey(authority) : null;
}

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return Response.json(cached.body, { headers: { "cache-control": "no-store" } });
  const beats = lastBeats();
  const house = faucetKeypair()?.publicKey ?? null;
  const connection = new Connection(serverRpcUrl(), "confirmed");

  const [houseLamports, lastHouseTx, deploy] = await Promise.all([
    house ? connection.getBalance(house).catch(() => null) : Promise.resolve(null),
    house ? connection.getSignaturesForAddress(house, { limit: 1 }).then((s) => s[0]?.blockTime ?? null).catch(() => null) : Promise.resolve(null),
    upgradeAuthority(connection)
      .then(async (key) => (key ? { key: key.toBase58(), lamports: await connection.getBalance(key) } : null))
      .catch(() => null),
  ]);
  const keeperAt = Math.max(beats.keeper ?? 0, (lastHouseTx ?? 0) * 1000) || null;
  const houseSol = houseLamports != null ? houseLamports / 1e9 : null;

  const body = {
    keeperLastRunAt: iso(keeperAt),
    keeperLastRunSource: beats.keeper && beats.keeper >= (lastHouseTx ?? 0) * 1000 ? "this instance" : lastHouseTx ? "house key's newest devnet transaction" : null,
    evmKeeperLastRunAt: iso(beats.evmKeeper),
    evmKeeperLastResults: beats.evmKeeperResults,
    houseSol,
    houseKey: house?.toBase58() ?? null,
    houseLow: houseSol != null && houseSol < HOUSE_ALERT_SOL,
    deploySol: deploy ? deploy.lamports / 1e9 : null,
    deployKey: deploy?.key ?? null,
    asOf: new Date().toISOString(),
  };
  cached = { at: Date.now(), body };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
