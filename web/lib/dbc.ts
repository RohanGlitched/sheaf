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
 * the basket's creator. The config's own terms (locked LP, immutable token,
 * fee split, migration fee, curve preset) must also be the published ones, so
 * not even the creator can open an "official" pool on other terms. A
 * squatter's or a rogue pool is reported as unofficial and ignored; a squatter who bricks a derived address only pushes the launch to
 * the next of `LAUNCH_SLOTS` salted slots.
 */

import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import preset from "./meteora-preset.json";
import { symbolForWriteMint } from "./mirror";
import { BY_SYMBOL_PRESTOCKS } from "./prestocks";

export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111112");
const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/** The DAMM v2 config a graduating pool with a customizable migration fee moves into. */
const DAMM_V2_CUSTOMIZABLE_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

/**
 * Sheaf's treasury, the partner on every launch. Of every curve fee Meteora
 * keeps 20% (the DBC program's protocol share) and the other 80% splits evenly
 * between the basket's creator and the treasury, so each gets 40% of what a
 * trader pays. The treasury also takes the migration fee and the leftover supply.
 */
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
  /** Which derived slot the launch lives in: 0 unless an earlier slot was squatted (PROXYA is in 1). */
  slot?: number;
};

/** The basket the method page uses as its running example: Frontier Labs. */
export const FEATURED_BASKET = {
  address: "6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv",
  name: "Frontier Labs",
  symbol: "FRNTR",
  creator: HOUSE,
};

/** Frontier Labs' early-access market, on the first (v1) curve. */
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

/**
 * The launch the home page features: Bitcoin, by proxy, the first launch on the
 * current (v2) curve. It lives in slot 1 because slot 0 was squatted on purpose
 * to prove the official-launch check (docs/meteora.md §3).
 */
export const FEATURED_LAUNCH: { basket: LaunchBasket; info: DbcPoolInfo } = {
  basket: {
    address: "FCzzVUBxL2NMpbxqR8dkhQ3U7gG9XFNKdg49jDFSnqF8",
    name: "Bitcoin, by proxy",
    symbol: "PROXY",
    creator: HOUSE,
  },
  info: {
    pool: "3HX35pe7XTfD38o9EZEwhYKfVLZuE7Vx7SZfaLvjz8hV",
    config: "He6bRAV4Fs3TKxmykt3bJHnL242MPL8cXrfiM3Zinfie",
    baseMint: "5wMGUdLisfNW1kMiQoeYN4hQcv1rpUXma6Apf8mpjtw9",
    baseSymbol: "PROXYA",
    baseName: "Bitcoin, by proxy, early access",
    quoteSymbol: "SOL",
    baseDecimals: LAUNCH_DECIMALS,
    supply: LAUNCH_SUPPLY,
    slot: 1,
  },
};

/**
 * Launch mints whose immutable metadata URI points at sheaf.vercel.app, the
 * site's old domain, which Sheaf no longer controls: BIG5A, FRNTRA and PROXYA.
 * Their cards say so; their provenance is served at /api/launch/<basket>.
 */
export const RETIRED_METADATA_MINTS: ReadonlySet<string> = new Set([
  "7X46CBfPfFg2cBMaCFKJ8XpEqY7iCn9rMUsnAZnftKxB",
  "8GcjtcMYoMAAncQs7JWcmfmSbLmNyeZ8CMixsBPfpBSY",
  "5wMGUdLisfNW1kMiQoeYN4hQcv1rpUXma6Apf8mpjtw9",
]);

/** Where the published curve presets and the integration write-up live. */
export const PRESET_URL = "https://github.com/RohanGlitched/sheaf/blob/main/web/lib/meteora-preset.json";
export const METEORA_DOCS_URL = "https://github.com/RohanGlitched/sheaf/blob/main/docs/meteora.md";

/**
 * The pre-IPO companies (PreStocks: SPV tokens, not shares) in a basket, by
 * name. A launch in front of such a basket gets a plain warning and is kept
 * off the featured and Explore surfaces: in May 2026 Anthropic and OpenAI said
 * transfers of their stock without board approval, tokenized ones included,
 * are void.
 */
export function preIpoCompanies(basket: { components?: { mint: string }[] }): string[] {
  return (basket.components ?? [])
    .map((c) => BY_SYMBOL_PRESTOCKS[symbolForWriteMint(c.mint) ?? ""]?.company)
    .filter((name): name is string => !!name);
}

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

/** A basket as the launch readers need it. The creator is required: it is what makes a pool official. */
export type LaunchBasket = { address: string; name: string; symbol: string; creator: string };

/** Where a basket's launch lives in one slot, whether or not it has been opened. */
export async function launchFor(basket: Omit<LaunchBasket, "creator">, slot = 0): Promise<DbcPoolInfo> {
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
export function launchSlots(basket: Omit<LaunchBasket, "creator">): Promise<DbcPoolInfo[]> {
  return Promise.all(Array.from({ length: LAUNCH_SLOTS }, (_, slot) => launchFor(basket, slot)));
}

/**
 * Byte offsets read straight from the DBC program's accounts (Anchor
 * discriminator included), from the PoolConfig and VirtualPool layouts in the
 * SDK 1.5.12 IDL. `scripts/meteora-check.mjs` asserts every one of them against
 * the SDK's own decoder on devnet.
 *
 *   VirtualPool: volatility_tracker 8..72, config 72, creator 104, base_mint 136,
 *     quote_reserve 240, partner_quote_fee 272, sqrt_price 280,
 *     activation_point 296, is_migrated 305,
 *     metrics.total_protocol_quote_fee 320, metrics.total_trading_quote_fee 336,
 *     creator_quote_fee 360.
 *   PoolConfig: quote_mint 8, fee_claimer 40, leftover_receiver 72,
 *     pool_fees.base_fee 104..136 (cliff_fee_numerator 104, second_factor 112,
 *     third_factor 120, first_factor 128, base_fee_mode 130),
 *     pool_fees.dynamic_fee 136..184 (initialized 136,
 *     max_volatility_accumulator 144, variable_fee_control 148),
 *     partner_liquidity_vesting_info 184 (vesting_percentage 185),
 *     creator_liquidity_vesting_info 200 (vesting_percentage 201),
 *     collect_fee_mode 232, migration_option 233, activation_type 234,
 *     token_type 237, partner_permanent_locked_liquidity_percentage 239,
 *     partner_liquidity_percentage 240,
 *     creator_permanent_locked_liquidity_percentage 241,
 *     creator_liquidity_percentage 242, migration_fee_option 243,
 *     creator_trading_fee_percentage 245, token_update_authority 246,
 *     migration_fee_percentage 247, creator_migration_fee_percentage 248,
 *     migration_quote_threshold 264, migration_sqrt_price 280,
 *     locked_vesting_config 296..344 (amount_per_period 296,
 *     cliff_unlock_amount 328), migrated_pool_fee_bps 362,
 *     migrated_pool_base_fee_mode 364, sqrt_start_price 392,
 *     curve 408 (20 × 32 bytes).
 */
const POOL = {
  config: 72,
  creator: 104,
  baseMint: 136,
  quoteReserve: 240,
  partnerQuoteFee: 272,
  sqrtPrice: 280,
  activationPoint: 296,
  isMigrated: 305,
  protocolQuoteFee: 320,
  totalQuoteFee: 336,
  creatorQuoteFee: 360,
} as const;
const CONFIG = {
  quoteMint: 8,
  feeClaimer: 40,
  leftoverReceiver: 72,
  baseFeeCliff: 104,
  baseFeeSecond: 112,
  baseFeeThird: 120,
  baseFeeFirst: 128,
  baseFeeMode: 130,
  dynamicFeeOn: 136,
  maxVolatility: 144,
  variableFeeControl: 148,
  partnerVestingPercent: 185,
  creatorVestingPercent: 201,
  collectFeeMode: 232,
  migrationOption: 233,
  activationType: 234,
  tokenType: 237,
  partnerLockedLp: 239,
  partnerLp: 240,
  creatorLockedLp: 241,
  creatorLp: 242,
  migrationFeeOption: 243,
  creatorTradingFee: 245,
  tokenUpdateAuthority: 246,
  migrationFee: 247,
  creatorMigrationFee: 248,
  threshold: 264,
  migrationSqrtPrice: 280,
  vestingPerPeriod: 296,
  vestingCliffUnlock: 328,
  migratedPoolFeeBps: 362,
  migratedPoolFeeMode: 364,
  sqrtStartPrice: 392,
  curve: 408,
} as const;
/** MigrationOption.MET_DAMM_V2: the only graduation path this site can trade after. */
const MIGRATION_DAMM_V2 = 1;
/** MigrationFeeOption.Customizable: graduates into the DAMM v2 config `dammV2PoolAddress` derives from. */
const MIGRATION_FEE_CUSTOMIZABLE = 6;
/** TokenAuthorityOption.Immutable: nobody keeps an update or a mint authority. */
const TOKEN_IMMUTABLE = 1;
/** TokenType.Token2022, and CollectFeeMode.QuoteToken (curve fees taken in SOL). */
const TOKEN_2022 = 1;
const FEES_IN_QUOTE = 0;
/** The SDK's volatility-fee settings for a 1% base fee; every Sheaf launch carries them. */
const DYNAMIC_FEE = { maxVolatility: 14_460_000, variableFeeControl: 956 };

export type PresetId = "v1" | "v2";

type PresetTerms = {
  activation: number;
  baseFee: { cliff: bigint; first: number; second: bigint; third: bigint; mode: number };
  migratedPoolFeeBps: number;
  migratedPoolFeeMode: number;
  /** The end of each curve segment, as a multiple of the opening market cap; the last is graduation. */
  caps: number[];
  /** Each segment's liquidity relative to the first. */
  weights: number[];
};

const terms = (
  activation: number,
  fee: { startingFeeBps: number; numberOfPeriod: number; periodLength: number; reductionFactor: number },
  migratedPoolFeeBps: number,
  migratedPoolFeeMode: number,
  caps: number[],
  weights: number[],
): PresetTerms => ({
  activation,
  baseFee: {
    cliff: BigInt(fee.startingFeeBps) * 100_000n,
    first: fee.numberOfPeriod,
    second: BigInt(fee.periodLength),
    third: BigInt(fee.reductionFactor),
    mode: 1, // FeeSchedulerExponential
  },
  migratedPoolFeeBps,
  migratedPoolFeeMode,
  caps: caps.slice(1),
  weights: weights.map((w) => w / weights[0]),
});

/**
 * The terms each published curve is stored with, as the program keeps them:
 * v2 is `meteora-preset.json`, v1 its `previous` entry (BIG5A, FRNTRA and the
 * other first launches keep it).
 */
const PRESET_TERMS: Record<PresetId, PresetTerms> = {
  v2: terms(
    1, // ActivationType.Timestamp
    {
      ...preset.fees.antiSnipe,
      periodLength: preset.fees.antiSnipe.totalDurationSeconds / preset.fees.antiSnipe.numberOfPeriod,
    },
    preset.migration.dammV2.startingFeeBps,
    4, // DAMM v2 FeeMarketCapSchedulerExponential
    preset.curve.capMultiplesOfOpen,
    preset.curve.liquidityWeights,
  ),
  v1: terms(
    0, // ActivationType.Slot
    {
      ...preset.previous.antiSnipe,
      periodLength: preset.previous.antiSnipe.totalDurationSlots / preset.previous.antiSnipe.numberOfPeriod,
    },
    preset.previous.migratedPoolFeeBps,
    0, // flat DAMM v2 fee
    preset.previous.capMultiplesOfOpen,
    preset.previous.liquidityWeights,
  ),
};

/** The id each preset is published under, as `meteora-preset.json` names it. */
export const PRESET_NAMES: Record<PresetId, string> = { v2: preset.id, v1: preset.previous.id };

function keyAt(data: Uint8Array, at: number): string {
  return new PublicKey(data.subarray(at, at + 32)).toBase58();
}

function u16(data: Uint8Array, at: number): number {
  return new DataView(data.buffer, data.byteOffset + at, 2).getUint16(0, true);
}

function u32(data: Uint8Array, at: number): number {
  return new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true);
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 0.002;

/** Which published preset a config's curve and fee schedule are, or null if neither. */
function presetOf(c: Uint8Array): PresetId | null {
  const start = Number(u128(c, CONFIG.sqrtStartPrice));
  if (start === 0) return null;
  const caps: number[] = [];
  const liquidity: number[] = [];
  for (let i = 0; i < 20; i++) {
    const sqrtPrice = u128(c, CONFIG.curve + i * 32);
    if (sqrtPrice === 0n) break;
    caps.push((Number(sqrtPrice) / start) ** 2);
    liquidity.push(Number(u128(c, CONFIG.curve + i * 32 + 16)));
  }
  const migration = (Number(u128(c, CONFIG.migrationSqrtPrice)) / start) ** 2;
  for (const id of ["v2", "v1"] as const) {
    const t = PRESET_TERMS[id];
    if (c[CONFIG.activationType] !== t.activation) continue;
    if (
      u64(c, CONFIG.baseFeeCliff) !== t.baseFee.cliff ||
      u16(c, CONFIG.baseFeeFirst) !== t.baseFee.first ||
      u64(c, CONFIG.baseFeeSecond) !== t.baseFee.second ||
      u64(c, CONFIG.baseFeeThird) !== t.baseFee.third ||
      c[CONFIG.baseFeeMode] !== t.baseFee.mode
    ) {
      continue;
    }
    if (u16(c, CONFIG.migratedPoolFeeBps) !== t.migratedPoolFeeBps) continue;
    if (c[CONFIG.migratedPoolFeeMode] !== t.migratedPoolFeeMode) continue;
    if (caps.length !== t.caps.length || !caps.every((v, i) => near(v, t.caps[i]))) continue;
    if (!near(migration, t.caps[t.caps.length - 1])) continue;
    if (!liquidity.every((l, i) => near(l / liquidity[0], t.weights[i]))) continue;
    return id;
  }
  return null;
}

/**
 * Whether a config's terms are the ones every launch card promises: all
 * graduated LP permanently locked and split evenly between creator and
 * treasury, an immutable Token-2022 token, curve fees in SOL split evenly
 * (after Meteora's 20%), a migration fee of at most 1% with none to the
 * creator, no supply vesting outside the curve, and a curve and fee schedule
 * that are one of the published presets. A creator can script
 * `createConfigAndPool` with any terms at all, so a pool on other terms is
 * unofficial, with the first term it breaks as the reason.
 */
function checkTerms(c: Uint8Array): { preset: PresetId; reason: null } | { preset: null; reason: string } {
  const no = (reason: string) => ({ preset: null, reason }) as const;
  const unlocked =
    c[CONFIG.partnerLp] + c[CONFIG.creatorLp] + c[CONFIG.partnerVestingPercent] + c[CONFIG.creatorVestingPercent];
  if (unlocked > 0) {
    return no(`${unlocked}% of its graduated liquidity is not permanently locked and can be withdrawn after graduation.`);
  }
  if (c[CONFIG.partnerLockedLp] !== 50 || c[CONFIG.creatorLockedLp] !== 50) {
    return no("Its locked liquidity is not split evenly between the creator and Sheaf's treasury.");
  }
  if (c[CONFIG.tokenUpdateAuthority] !== TOKEN_IMMUTABLE) {
    return no("Its token is not immutable: someone keeps an update or a mint authority.");
  }
  if (c[CONFIG.tokenType] !== TOKEN_2022) return no("Its token is not Token-2022.");
  if (c[CONFIG.collectFeeMode] !== FEES_IN_QUOTE) return no("Its curve fees are not collected in SOL.");
  if (c[CONFIG.creatorTradingFee] !== preset.fees.creatorTradingFeePercentage) {
    return no(
      `It gives the creator ${c[CONFIG.creatorTradingFee]}% of curve fees after Meteora's share, not ${preset.fees.creatorTradingFeePercentage}%.`,
    );
  }
  if (
    c[CONFIG.migrationFeeOption] !== MIGRATION_FEE_CUSTOMIZABLE ||
    c[CONFIG.migrationFee] > preset.migration.migrationFeePercentage ||
    c[CONFIG.creatorMigrationFee] !== 0
  ) {
    return no("Its migration fee is not Sheaf's: at most 1% of the raise, none of it to the creator.");
  }
  if (u64(c, CONFIG.vestingPerPeriod) !== 0n || u64(c, CONFIG.vestingCliffUnlock) !== 0n) {
    return no("It reserves supply for vesting outside the curve.");
  }
  if (
    c[CONFIG.dynamicFeeOn] !== 1 ||
    u32(c, CONFIG.maxVolatility) !== DYNAMIC_FEE.maxVolatility ||
    u32(c, CONFIG.variableFeeControl) !== DYNAMIC_FEE.variableFeeControl
  ) {
    return no("Its volatility fee is not the preset's.");
  }
  const id = presetOf(c);
  if (!id) return no("Its curve or fee schedule is not one of Sheaf's published presets.");
  return { preset: id, reason: null };
}

export type LaunchCheck =
  | { official: true; reason: null; preset: PresetId }
  | { official: false; reason: string; preset: null };

/**
 * Whether a pool at a basket's derived address is the basket's official
 * launch, from the accounts' own data:
 *   - both accounts belong to the DBC program, and the pool sits on this config
 *     and this base mint;
 *   - the config pays Sheaf's treasury as fee claimer and leftover receiver,
 *     is quoted in SOL and graduates into DAMM v2;
 *   - the pool's creator is the basket's creator. Pool creation needs the
 *     creator's signature, so this is the check a squatter cannot pass;
 *   - the config's terms are the published ones (`checkTerms`), so a creator
 *     who scripts a pool with unlocked liquidity or a kept mint authority does
 *     not get the label either;
 *   - when the mint account is passed, it has no mint authority left.
 * The basket's creator is required: without it nothing is official.
 */
export function checkLaunch(
  info: DbcPoolInfo,
  pool: AccountInfo<Uint8Array> | null,
  config: AccountInfo<Uint8Array> | null,
  creator: string,
  mint?: AccountInfo<Uint8Array> | null,
): LaunchCheck {
  const no = (reason: string): LaunchCheck => ({ official: false, reason, preset: null });
  if (!creator) return no("Unknown basket creator.");
  if (!pool || !config) return no("No pool at this address.");
  if (!pool.owner.equals(DBC_PROGRAM) || !config.owner.equals(DBC_PROGRAM)) {
    return no("These accounts do not belong to the Meteora DBC program.");
  }
  if (pool.data.length < 376 || config.data.length < CONFIG.curve + 20 * 32) return no("Unexpected account size.");
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
  if (keyAt(p, POOL.creator) !== creator) return no("It was not opened by the basket's creator.");
  const checked = checkTerms(c);
  if (checked.reason != null) return no(checked.reason);
  // A mint account opens with its mint authority as a COption: tag 0 means none.
  if (mint && (mint.data.length < 82 || u32(mint.data, 0) !== 0)) return no("Its token still has a mint authority.");
  return { official: true, reason: null, preset: checked.preset };
}

export type FoundLaunch = { info: DbcPoolInfo; check: LaunchCheck };

/** Every slot of a basket, read in one batched call: pools on the published terms (in slot order), pools that are not, and the first free slot. */
export type LaunchScan = { candidates: FoundLaunch[]; failed: FoundLaunch[]; free: DbcPoolInfo | null };

export async function scanLaunch(connection: Connection, basket: LaunchBasket): Promise<LaunchScan> {
  const slots = await launchSlots(basket);
  const accounts = await connection.getMultipleAccountsInfo(
    slots.flatMap((s) => [new PublicKey(s.pool), new PublicKey(s.config), new PublicKey(s.baseMint)]),
  );
  const candidates: FoundLaunch[] = [];
  const failed: FoundLaunch[] = [];
  let free: DbcPoolInfo | null = null;
  slots.forEach((info, i) => {
    const [pool, config, mint] = accounts.slice(i * 3, i * 3 + 3);
    if (!pool && !config && !mint) {
      free ??= info;
      return;
    }
    // Something sits at the config or mint key but there is no pool: a bricked slot.
    if (!pool) return;
    const check = checkLaunch(info, pool, config, basket.creator, mint);
    (check.official ? candidates : failed).push({ info, check });
  });
  return { candidates, failed, free };
}

/**
 * The basket's launch out of a scan: the first pool on the published terms
 * that is not in `rejected` (pool -> reason; the server's anchor check fills
 * it with pools that did not open at half the basket's NAV). Rejected pools,
 * and any later pool on the published terms, are listed as unofficial, so
 * nothing found at the basket's addresses disappears, and a rejected slot
 * never stops a correct launch from being chosen or opened.
 */
export function pickLaunch(
  scan: LaunchScan,
  rejected: ReadonlyMap<string, string> = new Map(),
): { launch: FoundLaunch | null; unofficial: FoundLaunch[]; free: DbcPoolInfo | null } {
  let launch: FoundLaunch | null = null;
  const unofficial = [...scan.failed];
  const no = (info: DbcPoolInfo, reason: string): FoundLaunch => ({ info, check: { official: false, reason, preset: null } });
  for (const c of scan.candidates) {
    const why = rejected.get(c.info.pool);
    if (why) unofficial.push(no(c.info, why));
    else if (!launch) launch = c;
    else unofficial.push(no(c.info, `A later pool on the same terms: this basket's launch is the one in slot ${launch.info.slot ?? 0}.`));
  }
  unofficial.sort((x, y) => (x.info.slot ?? 0) - (y.info.slot ?? 0));
  return { launch, unofficial, free: scan.free };
}

/**
 * A basket's launch, read from every slot in one batched call: the first
 * official pool, any unofficial ones found on the way, and the first slot
 * still free for the creator to open a launch in. Pass `rejected` to skip
 * pools the anchor check refused.
 */
export async function findLaunch(
  connection: Connection,
  basket: LaunchBasket,
  rejected?: ReadonlyMap<string, string>,
): Promise<{ launch: FoundLaunch | null; unofficial: FoundLaunch[]; free: DbcPoolInfo | null }> {
  return pickLaunch(await scanLaunch(connection, basket), rejected);
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
  /**
   * SOL of curve fees the creator and the partner can claim right now, what
   * Meteora's protocol has taken (20% of every fee), and every fee ever charged
   * on the curve, Meteora's share included.
   */
  creatorFees: number;
  partnerFees: number;
  protocolFees: number;
  totalFees: number;
  /** Whether the fee scheduler counts in slots or in seconds, and the point (slot or unix time) the pool opened at. */
  activation: "slot" | "timestamp";
  activationPoint: number;
  /** Whether this pool passed `checkLaunch`, and why not if it did not. */
  official: boolean;
  unofficialReason: string | null;
  /** Which published curve the pool is on (`PRESET_NAMES`), if it passed the check. */
  preset: PresetId | null;
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
 * launch has not been opened. The pool is checked against the basket's
 * creator and the published terms; the result says whether it is official.
 *
 * Offsets are the DBC program's VirtualPool and PoolConfig layouts (listed
 * above `checkLaunch`). Pulling in the SDK for a handful of numbers would put
 * its IDL on every page load.
 */
export async function readDbcState(
  connection: Connection,
  info: DbcPoolInfo,
  creator: string,
): Promise<DbcState | null> {
  const [pool, config, mint] = await connection.getMultipleAccountsInfo([
    new PublicKey(info.pool),
    new PublicKey(info.config),
    new PublicKey(info.baseMint),
  ]);
  if (!pool || !config) return null;
  if (!pool.owner.equals(DBC_PROGRAM) || !config.owner.equals(DBC_PROGRAM)) return null;
  const check = checkLaunch(info, pool, config, creator, mint);

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
    protocolFees: Number(u64(pool.data, POOL.protocolQuoteFee)) / 1e9,
    totalFees: Number(u64(pool.data, POOL.totalQuoteFee) + u64(pool.data, POOL.protocolQuoteFee)) / 1e9,
    activation: config.data[CONFIG.activationType] === 1 ? "timestamp" : "slot",
    activationPoint: Number(u64(pool.data, POOL.activationPoint)),
    official: check.official,
    unofficialReason: check.reason,
    preset: check.preset,
    shape,
  };
}
