/**
 * Meteora Dynamic Bonding Curve launch markets for Sheaf baskets.
 *
 * A launch is a separate token from the basket's own share, a front-market and
 * not a redemption right, on the real DBC program (same address on devnet and
 * mainnet). Every basket has exactly one place its launch can live: the config
 * and base-mint keys are derived from the basket's address, so the pool address
 * follows from the basket alone and the site finds any launch with one read,
 * without an indexer.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111112");
const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/** The DAMM v2 config a graduating pool with a customizable migration fee moves into. */
const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

/** Claims the partner half of curve fees and any leftover supply. */
export const TREASURY = new PublicKey("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");

export const LAUNCH_DECIMALS = 6;
export const LAUNCH_SUPPLY = 1_000_000_000;

export type DbcPoolInfo = {
  pool: string;
  config: string;
  baseMint: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  baseDecimals: number;
  supply: number;
};

/** Launches opened before they were derived from the basket. None on this program. */
const LEGACY: Record<string, DbcPoolInfo> = {};

/** The launch the home page and the method page show: Frontier Labs' early-access market. */
export const FEATURED_DBC: [string, DbcPoolInfo] = [
  "6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv",
  {
    pool: "67HdpukuYWudWNuv64vZK3TgGSqDBwS483YaDrSWoK73",
    config: "5hovqK44hwqE4rtgQ4XDVJAWiH2vKdJLuj1jjYtey1u4",
    baseMint: "8GcjtcMYoMAAncQs7JWcmfmSbLmNyeZ8CMixsBPfpBSY",
    baseSymbol: "FRNTRA",
    baseName: "Frontier Labs, early access",
    quoteSymbol: "SOL",
    baseDecimals: LAUNCH_DECIMALS,
    supply: LAUNCH_SUPPLY,
  },
];

export function launchSymbol(symbol: string): string {
  return `${symbol}A`.slice(0, 10);
}

export function launchName(name: string): string {
  const suffix = ", early access";
  return name.length + suffix.length <= 32 ? name + suffix : name.slice(0, 32);
}

async function seeded(basket: string, role: "config" | "mint"): Promise<Keypair> {
  const bytes = new TextEncoder().encode(`sheaf-launch-v1:${role}:${basket}`);
  return Keypair.fromSeed(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * The two keypairs a launch is created with. Their secrets are public by design:
 * they sign once, to create the accounts, and own nothing afterwards.
 */
export async function launchKeys(basket: string) {
  const [config, mint] = await Promise.all([seeded(basket, "config"), seeded(basket, "mint")]);
  return { config, mint };
}

function poolPda(program: PublicKey, config: PublicKey, baseMint: PublicKey): PublicKey {
  const quoteFirst = NATIVE_SOL.toBuffer().compare(baseMint.toBuffer()) > 0;
  const [first, second] = quoteFirst ? [NATIVE_SOL, baseMint] : [baseMint, NATIVE_SOL];
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("pool"), config.toBuffer(), first.toBuffer(), second.toBuffer()],
    program,
  )[0];
}

export function dbcPoolAddress(config: PublicKey, baseMint: PublicKey): PublicKey {
  return poolPda(DBC_PROGRAM, config, baseMint);
}

/** Where a launch's liquidity lives once it has graduated. */
export function dammV2PoolAddress(baseMint: string): string {
  return poolPda(DAMM_V2_PROGRAM, DAMM_V2_CUSTOMIZABLE_CONFIG, new PublicKey(baseMint)).toBase58();
}

/** Where a basket's launch lives, whether or not it has been opened yet. */
export async function launchFor(basket: {
  address: string;
  name: string;
  symbol: string;
}): Promise<DbcPoolInfo> {
  const legacy = LEGACY[basket.address];
  if (legacy) return legacy;
  const { config, mint } = await launchKeys(basket.address);
  return {
    pool: dbcPoolAddress(config.publicKey, mint.publicKey).toBase58(),
    config: config.publicKey.toBase58(),
    baseMint: mint.publicKey.toBase58(),
    baseSymbol: launchSymbol(basket.symbol),
    baseName: launchName(basket.name),
    quoteSymbol: "SOL",
    baseDecimals: LAUNCH_DECIMALS,
    supply: LAUNCH_SUPPLY,
  };
}

/** Which of these baskets have an open launch, in one batched read. */
export async function openLaunches(
  connection: Connection,
  baskets: { address: string; name: string; symbol: string }[],
): Promise<Map<string, DbcPoolInfo>> {
  const infos = await Promise.all(baskets.map(launchFor));
  const found = new Map<string, DbcPoolInfo>();
  for (let i = 0; i < infos.length; i += 100) {
    const chunk = infos.slice(i, i + 100);
    const accounts = await connection.getMultipleAccountsInfo(
      chunk.map((info) => new PublicKey(info.pool)),
    );
    accounts.forEach((account, j) => {
      if (account) found.set(baskets[i + j].address, chunk[j]);
    });
  }
  return found;
}

export type DbcState = {
  /** SOL in the curve, and the amount at which it graduates. */
  raised: number;
  threshold: number;
  /** Market caps in SOL at the open, now, and at graduation. */
  openCap: number;
  cap: number;
  graduationCap: number;
  migrated: boolean;
  creator: string;
  /** SOL of trading fees the creator can claim right now, and all fees ever charged. */
  creatorFees: number;
  totalFees: number;
  /**
   * The curve itself, as (SOL raised, market cap) at the start of the pool and
   * at the end of every segment up to graduation. A chart drawn through these
   * is the pool's own shape, whatever it is.
   */
  shape: { raised: number; cap: number }[];
};

const Q64 = 2 ** 64;

function u64(data: Uint8Array, at: number): bigint {
  return new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true);
}

function u128(data: Uint8Array, at: number): bigint {
  return u64(data, at) | (u64(data, at + 8) << 64n);
}

/**
 * Read a pool and its config straight from their accounts, or null if the
 * launch has not been opened.
 *
 * Offsets are the DBC program's VirtualPool and PoolConfig layouts. Pulling in
 * the SDK for a handful of numbers would put its IDL on every page load.
 */
export async function readDbcState(
  connection: Connection,
  info: DbcPoolInfo,
): Promise<DbcState | null> {
  const [pool, config] = await connection.getMultipleAccountsInfo([
    new PublicKey(info.pool),
    new PublicKey(info.config),
  ]);
  if (!pool || !config) return null;

  const cap = (sqrtPrice: bigint) =>
    (Number(sqrtPrice) / Q64) ** 2 * 10 ** (info.baseDecimals - 9) * info.supply;

  // Segments are (sqrtPrice, liquidity) pairs from offset 408, up to twenty of
  // them; SOL raised across one is liquidity × Δ√price / 2^128. The curve runs
  // past the migration price, so the shape stops there.
  const start = u128(config.data, 392);
  const migration = u128(config.data, 280);
  const shape = [{ raised: 0, cap: cap(start) }];
  let prev = start;
  let raised = 0;
  for (let i = 0; i < 20; i++) {
    const sqrtPrice = u128(config.data, 408 + i * 32);
    const liquidity = u128(config.data, 408 + i * 32 + 16);
    if (sqrtPrice === 0n || liquidity === 0n) break;
    const end = sqrtPrice < migration ? sqrtPrice : migration;
    raised += Number((liquidity * (end - prev)) >> 128n) / 1e9;
    shape.push({ raised, cap: cap(end) });
    prev = end;
    if (end === migration) break;
  }

  // After graduation the curve is frozen and trading carries on in DAMM v2, so
  // the market cap comes from that pool's own price.
  const migrated = pool.data[305] === 1;
  let capNow = cap(u128(pool.data, 280));
  if (migrated) {
    const damm = await connection.getAccountInfo(new PublicKey(dammV2PoolAddress(info.baseMint)));
    if (damm) {
      const baseIsA = new PublicKey(damm.data.subarray(168, 200)).toBase58() === info.baseMint;
      const raw = (Number(u128(damm.data, 456)) / Q64) ** 2;
      const solPerToken = (baseIsA ? raw : 1 / raw) * 10 ** (info.baseDecimals - 9);
      capNow = solPerToken * info.supply;
    }
  }

  return {
    raised: Number(u64(pool.data, 240)) / 1e9,
    threshold: Number(u64(config.data, 264)) / 1e9,
    openCap: cap(u128(config.data, 392)),
    cap: capNow,
    graduationCap: cap(u128(config.data, 280)),
    migrated,
    creator: new PublicKey(pool.data.subarray(104, 136)).toBase58(),
    creatorFees: Number(u64(pool.data, 360)) / 1e9,
    totalFees: Number(u64(pool.data, 336)) / 1e9,
    shape,
  };
}
