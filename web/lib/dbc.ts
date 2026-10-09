/**
 * Meteora Dynamic Bonding Curve launch markets for Sheaf baskets.
 *
 * A launch is a separate token from the basket's own share, a front-market and
 * not a redemption right, on the real DBC program (same address on devnet and
 * mainnet). The config and base-mint keys are derived from the basket's
 * address, so the pool address follows from the basket alone and the site
 * finds any launch with one batched read, without an indexer.
 *
 * Derived keys have public secrets, so anyone can create *something* at a
 * derived address. That is why nothing here trusts an address alone: a pool
 * counts as a basket's launch only if its own account data says so (see
 * `checkLaunch`). The DBC program makes the pool creator sign pool creation,
 * so nobody but the basket's creator can produce a pool whose creator field is
 * the basket's creator. A squatter's pool is reported as unofficial and
 * ignored; a squatter who bricks a derived address only pushes the launch to
 * the next of `LAUNCH_SLOTS` salted slots.
 */

import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111112");
const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/** The DAMM v2 config a graduating pool with a customizable migration fee moves into. */
const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

/** Claims the partner half of curve fees, the migration fee and any leftover supply. */
export const TREASURY = new PublicKey("9uuYuCQsZEfjXomEGV7eH5ByDuYLry9oaf1263vPJnuF");
/** The house key: created the featured baskets, so it is their launches' pool creator. */
export const HOUSE = "B8dLfY9rokrZwq7ae1CuVfi8deSoeywgJGiS3W2U9U1L";

export const LAUNCH_DECIMALS = 6;
export const LAUNCH_SUPPLY = 1_000_000_000;
/**
 * How many derived places a basket's launch may live. Slot 0 is the original
 * v1 derivation; later slots are salted, and only used when an earlier one was
 * taken by an account the basket's creator did not make.
 */
export const LAUNCH_SLOTS = 4;

/** What a trade on a full, not yet graduated curve fails with. */
export const CURVE_FULL =
  "The curve is full, so it takes no more buys or sells. Anyone can graduate it into Meteora DAMM v2, and trading carries on there.";

export type DbcPoolInfo = {
  pool: string;
  config: string;
  baseMint: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  baseDecimals: number;
  supply: number;
  /** Which derived slot the launch lives in; 0 for every launch opened so far. */
  slot?: number;
};

/** The basket the home page and the method page feature: Frontier Labs. */
export const FEATURED_BASKET = {
  address: "6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv",
  name: "Frontier Labs",
  symbol: "FRNTR",
  creator: HOUSE,
};

/** The launch the home page and the method page show: Frontier Labs' early-access market. */
export const FEATURED_DBC: [string, DbcPoolInfo] = [
  FEATURED_BASKET.address,
  {
    pool: "67HdpukuYWudWNuv64vZK3TgGSqDBwS483YaDrSWoK73",
    config: "5hovqK44hwqE4rtgQ4XDVJAWiH2vKdJLuj1jjYtey1u4",
    baseMint: "8GcjtcMYoMAAncQs7JWcmfmSbLmNyeZ8CMixsBPfpBSY",
    baseSymbol: "FRNTRA",
    baseName: "Frontier Labs, early access",
    quoteSymbol: "SOL",
    baseDecimals: LAUNCH_DECIMALS,
    supply: LAUNCH_SUPPLY,
    slot: 0,
  },
];

export function launchSymbol(symbol: string): string {
  return `${symbol}A`.slice(0, 10);
}

export function launchName(name: string): string {
  const suffix = ", early access";
  return name.length + suffix.length <= 32 ? name + suffix : name.slice(0, 32);
}

async function seeded(basket: string, role: "config" | "mint", slot: number): Promise<Keypair> {
  const label =
    slot === 0 ? `sheaf-launch-v1:${role}:${basket}` : `sheaf-launch-v2:${role}:${basket}:${slot}`;
  const bytes = new TextEncoder().encode(label);
  return Keypair.fromSeed(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * The two keypairs a launch is created with. Their secrets are public by
 * design: they sign once, to create the accounts, and own nothing afterwards.
 * What makes a pool official is checked on every read, not assumed from these.
 */
export async function launchKeys(basket: string, slot = 0) {
  const [config, mint] = await Promise.all([seeded(basket, "config", slot), seeded(basket, "mint", slot)]);
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

export type LaunchBasket = { address: string; name: string; symbol: string; creator?: string };

/** Where a basket's launch lives in one slot, whether or not it has been opened. */
export async function launchFor(basket: LaunchBasket, slot = 0): Promise<DbcPoolInfo> {
  const { config, mint } = await launchKeys(basket.address, slot);
  return {
    pool: dbcPoolAddress(config.publicKey, mint.publicKey).toBase58(),
    config: config.publicKey.toBase58(),
    baseMint: mint.publicKey.toBase58(),
    baseSymbol: launchSymbol(basket.symbol),
    baseName: launchName(basket.name),
    quoteSymbol: "SOL",
    baseDecimals: LAUNCH_DECIMALS,
    supply: LAUNCH_SUPPLY,
    slot,
  };
}

/** Every place a basket's launch may live, slot 0 first. */
export function launchSlots(basket: LaunchBasket): Promise<DbcPoolInfo[]> {
  return Promise.all(Array.from({ length: LAUNCH_SLOTS }, (_, slot) => launchFor(basket, slot)));
}

/**
 * Byte offsets read straight from the DBC program's accounts (Anchor
 * discriminator included). `scripts/meteora-check.mjs` asserts every one of
 * them against the SDK's own decoder on devnet.
 *
 *   VirtualPool: volatility_tracker 8..72, config 72, creator 104, base_mint 136,
 *     quote_reserve 240, partner_quote_fee 272, sqrt_price 280, is_migrated 305,
 *     metrics.total_trading_quote_fee 336, creator_quote_fee 360.
 *   PoolConfig: quote_mint 8, fee_claimer 40, leftover_receiver 72,
 *     migration_option 233, activation_type 234, migration_quote_threshold 264,
 *     migration_sqrt_price 280, sqrt_start_price 392, curve 408 (20 × 32 bytes).
 */
const POOL = {
  config: 72,
  creator: 104,
  baseMint: 136,
  quoteReserve: 240,
  partnerQuoteFee: 272,
  sqrtPrice: 280,
  isMigrated: 305,
  totalQuoteFee: 336,
  creatorQuoteFee: 360,
} as const;
const CONFIG = {
  quoteMint: 8,
  feeClaimer: 40,
  leftoverReceiver: 72,
  migrationOption: 233,
  activationType: 234,
  threshold: 264,
  migrationSqrtPrice: 280,
  sqrtStartPrice: 392,
  curve: 408,
} as const;
/** MigrationOption.MET_DAMM_V2: the only graduation path this site can trade after. */
const MIGRATION_DAMM_V2 = 1;

function keyAt(data: Uint8Array, at: number): string {
  return new PublicKey(data.subarray(at, at + 32)).toBase58();
}

export type LaunchCheck = { official: true; reason: null } | { official: false; reason: string };

/**
 * Whether a pool at a basket's derived address is the basket's official
 * launch, from the two accounts' own data:
 *   - both accounts belong to the DBC program, and the pool sits on this config
 *     and this base mint;
 *   - the config pays Sheaf's treasury as fee claimer and leftover receiver,
 *     is quoted in SOL and graduates into DAMM v2;
 *   - the pool's creator is the basket's creator. Pool creation needs the
 *     creator's signature, so this is the check a squatter cannot pass.
 */
export function checkLaunch(
  info: DbcPoolInfo,
  pool: AccountInfo<Uint8Array> | null,
  config: AccountInfo<Uint8Array> | null,
  creator?: string,
): LaunchCheck {
  const no = (reason: string): LaunchCheck => ({ official: false, reason });
  if (!pool || !config) return no("No pool at this address.");
  if (!pool.owner.equals(DBC_PROGRAM) || !config.owner.equals(DBC_PROGRAM)) {
    return no("These accounts do not belong to the Meteora DBC program.");
  }
  if (pool.data.length < 376 || config.data.length < CONFIG.curve + 32) return no("Unexpected account size.");
  const p = pool.data;
  const c = config.data;
  if (keyAt(p, POOL.config) !== info.config || keyAt(p, POOL.baseMint) !== info.baseMint) {
    return no("The pool does not sit on this launch's config and mint.");
  }
  if (keyAt(c, CONFIG.feeClaimer) !== TREASURY.toBase58()) return no("Its fees do not go to Sheaf's treasury.");
  if (keyAt(c, CONFIG.leftoverReceiver) !== TREASURY.toBase58()) {
    return no("Its leftover supply does not go to Sheaf's treasury.");
  }
  if (keyAt(c, CONFIG.quoteMint) !== NATIVE_SOL.toBase58()) return no("It is not quoted in SOL.");
  if (c[CONFIG.migrationOption] !== MIGRATION_DAMM_V2) return no("It does not graduate into Meteora DAMM v2.");
  if (creator && keyAt(p, POOL.creator) !== creator) return no("It was not opened by the basket's creator.");
  return { official: true, reason: null };
}

export type FoundLaunch = { info: DbcPoolInfo; check: LaunchCheck };

/**
 * A basket's launch, read from every slot in one batched call: the first
 * official pool, any unofficial ones found on the way, and the first slot
 * still free for the creator to open a launch in.
 */
export async function findLaunch(
  connection: Connection,
  basket: LaunchBasket,
): Promise<{ launch: FoundLaunch | null; unofficial: FoundLaunch[]; free: DbcPoolInfo | null }> {
  const slots = await launchSlots(basket);
  const accounts = await connection.getMultipleAccountsInfo(
    slots.flatMap((s) => [new PublicKey(s.pool), new PublicKey(s.config), new PublicKey(s.baseMint)]),
  );
  let launch: FoundLaunch | null = null;
  const unofficial: FoundLaunch[] = [];
  let free: DbcPoolInfo | null = null;
  slots.forEach((info, i) => {
    const [pool, config, mint] = accounts.slice(i * 3, i * 3 + 3);
    if (!pool && !config && !mint) {
      free ??= info;
      return;
    }
    // Something sits at the config or mint key but there is no pool: a bricked slot.
    if (!pool) return;
    const check = checkLaunch(info, pool, config, basket.creator);
    if (check.official) launch ??= { info, check };
    else unofficial.push({ info, check });
  });
  return { launch, unofficial, free };
}

/** Which of these baskets have an official open launch, in batched reads. Squatted pools are ignored. */
export async function openLaunches(
  connection: Connection,
  baskets: LaunchBasket[],
): Promise<Map<string, DbcPoolInfo>> {
  const slots = (await Promise.all(baskets.map(launchSlots))).flat();
  const keys = slots.flatMap((s) => [new PublicKey(s.pool), new PublicKey(s.config)]);
  const accounts: (AccountInfo<Uint8Array> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    accounts.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  }
  const found = new Map<string, DbcPoolInfo>();
  slots.forEach((info, i) => {
    const basket = baskets[Math.floor(i / LAUNCH_SLOTS)];
    if (found.has(basket.address)) return;
    if (checkLaunch(info, accounts[i * 2], accounts[i * 2 + 1], basket.creator).official) {
      found.set(basket.address, info);
    }
  });
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
  /** SOL of trading fees the creator and the partner can claim right now, and all fees ever charged. */
  creatorFees: number;
  partnerFees: number;
  totalFees: number;
  /** Whether the fee scheduler counts in slots or in seconds. */
  activation: "slot" | "timestamp";
  /** Whether this pool passed `checkLaunch`, and why not if it did not. */
  official: boolean;
  unofficialReason: string | null;
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
 * launch has not been opened. Pass the basket's creator to have the pool
 * checked against it; the result says whether the pool is official.
 *
 * Offsets are the DBC program's VirtualPool and PoolConfig layouts (listed
 * above `checkLaunch`). Pulling in the SDK for a handful of numbers would put
 * its IDL on every page load.
 */
export async function readDbcState(
  connection: Connection,
  info: DbcPoolInfo,
  creator?: string,
): Promise<DbcState | null> {
  const [pool, config] = await connection.getMultipleAccountsInfo([
    new PublicKey(info.pool),
    new PublicKey(info.config),
  ]);
  if (!pool || !config) return null;
  if (!pool.owner.equals(DBC_PROGRAM) || !config.owner.equals(DBC_PROGRAM)) return null;
  const check = checkLaunch(info, pool, config, creator);

  const cap = (sqrtPrice: bigint) =>
    (Number(sqrtPrice) / Q64) ** 2 * 10 ** (info.baseDecimals - 9) * info.supply;

  // Segments are (sqrtPrice, liquidity) pairs from offset 408, up to twenty of
  // them; SOL raised across one is liquidity × Δ√price / 2^128. The curve runs
  // past the migration price, so the shape stops there.
  const start = u128(config.data, CONFIG.sqrtStartPrice);
  const migration = u128(config.data, CONFIG.migrationSqrtPrice);
  const shape = [{ raised: 0, cap: cap(start) }];
  let prev = start;
  let raised = 0;
  for (let i = 0; i < 20; i++) {
    const sqrtPrice = u128(config.data, CONFIG.curve + i * 32);
    const liquidity = u128(config.data, CONFIG.curve + i * 32 + 16);
    if (sqrtPrice === 0n || liquidity === 0n) break;
    const end = sqrtPrice < migration ? sqrtPrice : migration;
    raised += Number((liquidity * (end - prev)) >> 128n) / 1e9;
    shape.push({ raised, cap: cap(end) });
    prev = end;
    if (end === migration) break;
  }

  // After graduation the curve is frozen and trading carries on in DAMM v2, so
  // the market cap comes from that pool's own price.
  const migrated = pool.data[POOL.isMigrated] === 1;
  let capNow = cap(u128(pool.data, POOL.sqrtPrice));
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
    raised: Number(u64(pool.data, POOL.quoteReserve)) / 1e9,
    threshold: Number(u64(config.data, CONFIG.threshold)) / 1e9,
    openCap: cap(start),
    cap: capNow,
    graduationCap: cap(migration),
    migrated,
    creator: keyAt(pool.data, POOL.creator),
    creatorFees: Number(u64(pool.data, POOL.creatorQuoteFee)) / 1e9,
    partnerFees: Number(u64(pool.data, POOL.partnerQuoteFee)) / 1e9,
    totalFees: Number(u64(pool.data, POOL.totalQuoteFee)) / 1e9,
    activation: config.data[CONFIG.activationType] === 1 ? "timestamp" : "slot",
    official: check.official,
    unofficialReason: check.reason,
    shape,
  };
}
