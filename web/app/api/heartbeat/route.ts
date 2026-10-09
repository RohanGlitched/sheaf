import { Connection, PublicKey } from "@solana/web3.js";
import { SHEAF_PROGRAM_ID, serverRpcUrl } from "@/lib/config";
import { faucetKeypair } from "@/lib/faucet-server";
import { rememberOidc } from "@/lib/gcs-store";
import { faucetHasOwnKey, faucetPayerKeypair, filler2Keypair } from "@/lib/server-keys";
import { lastBeats } from "@/lib/server-heartbeat";
import { burnRate } from "@/lib/server-faucet-budget";

export const dynamic = "force-dynamic";

/**
 * GET /api/heartbeat → { keeperLastRunAt, evmKeeperLastRunAt, houseSol, deploySol, low, ... }
 *
 * Whether the keepers are alive and the keys can pay, for a scheduler's alert and
 * the "Keeper ran 40 s ago" line on the pages. Times are ISO strings or null.
 *
 *  - keeperLastRunAt / evmKeeperLastRunAt: each keeper's last finished run, kept in
 *    the project's bucket so every instance agrees. The Solana keeper falls back to
 *    the house key's newest devnet transaction when the bucket has nothing.
 *  - houseSol: the house key (mint authority, keeper, house filler).
 *  - faucetSol / filler2Sol: the faucet's and the second filler's own keys, when set.
 *  - deploySol: the program's upgrade authority, read from its program-data account.
 *  - faucetBurn: what the faucets spent today and in the last hour (grants and
 *    the rent of accounts they opened), from their durable daily budget.
 *  - low: true when the house is under 2 SOL, the faucet key under 1 SOL, the
 *    upgrade authority under 1 SOL, or the faucets burn more than 0.5 SOL an
 *    hour. The keeper workflow fails on it, as an alert.
 */

/** Low enough to alert with a day of the keeper's spending left. */
const HOUSE_LOW_SOL = 2;
const FAUCET_BURN_HIGH_SOL_PER_HOUR = 0.5;
const DEPLOY_LOW_SOL = 1;
const FAUCET_LOW_SOL = 1;
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

export async function GET(request: Request) {
  rememberOidc(request);
  if (cached && Date.now() - cached.at < CACHE_MS) return Response.json(cached.body, { headers: { "cache-control": "no-store" } });
  const connection = new Connection(serverRpcUrl(), "confirmed");
  const house = faucetKeypair()?.publicKey ?? null;
  const faucet = faucetHasOwnKey() ? faucetPayerKeypair()!.publicKey : null;
  const filler2 = filler2Keypair()?.publicKey ?? null;
  const sol = (key: PublicKey | null) => (key ? connection.getBalance(key).then((l) => l / 1e9).catch(() => null) : Promise.resolve(null));

  const [burn, beats, houseSol, faucetSol, filler2Sol, lastHouseTx, deploy] = await Promise.all([
    burnRate().catch(() => null),
    lastBeats().catch(() => ({}) as Awaited<ReturnType<typeof lastBeats>>),
    sol(house),
    sol(faucet),
    sol(filler2),
    house ? connection.getSignaturesForAddress(house, { limit: 1 }).then((s) => s[0]?.blockTime ?? null).catch(() => null) : Promise.resolve(null),
    upgradeAuthority(connection)
      .then(async (key) => (key ? { key: key.toBase58(), sol: await connection.getBalance(key).then((l) => l / 1e9) } : null))
      .catch(() => null),
  ]);
  const keeperBeat = beats.keeper?.at ?? null;
  const keeperAt = keeperBeat ?? (lastHouseTx ? lastHouseTx * 1000 : null);
  const houseLow = houseSol != null && houseSol < HOUSE_LOW_SOL;
  const deployLow = deploy != null && deploy.sol < DEPLOY_LOW_SOL;
  const faucetLow = faucetSol != null && faucetSol < FAUCET_LOW_SOL;
  const burnPerHour = burn ? Math.max(burn.lamportsLastHour, burn.lamportsThisHour) / 1e9 : null;
  const faucetBurnHigh = burnPerHour != null && burnPerHour > FAUCET_BURN_HIGH_SOL_PER_HOUR;

  const body = {
    keeperLastRunAt: iso(keeperAt),
    keeperLastRunSource: keeperBeat ? "keeper run" : lastHouseTx ? "house key's newest devnet transaction" : null,
    evmKeeperLastRunAt: iso(beats.evmKeeper?.at),
    evmKeeperLast: beats.evmKeeper?.detail ?? null,
    houseSol,
    houseKey: house?.toBase58() ?? null,
    houseLow,
    faucetSol,
    faucetKey: faucet?.toBase58() ?? null,
    faucetLow,
    faucetBurnPerHour: burnPerHour,
    faucetBurnHigh,
    faucetToday: burn ? { solGrants: burn.solGrants, accountsOpened: burn.accountsOpened, sol: burn.lamportsToday / 1e9 } : null,
    filler2Sol,
    filler2Key: filler2?.toBase58() ?? null,
    deploySol: deploy?.sol ?? null,
    deployKey: deploy?.key ?? null,
    deployLow,
    low: houseLow || deployLow || faucetLow || faucetBurnHigh,
    asOf: new Date().toISOString(),
  };
  cached = { at: Date.now(), body };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
