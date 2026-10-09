import "server-only";
import { GcsConflict, gcsConfigured, getJson, putJson } from "./gcs-store";
import { cleanRef } from "./invite-ref";

/**
 * The faucets' daily budget, kept where every instance sees it.
 *
 * In-memory limits are per instance, so a script that lands on many instances
 * multiplies them. These counters live in the project's bucket, one document per
 * UTC day (faucet/day-YYYY-MM-DD.json), updated with a generation precondition,
 * so a grant is counted once however many instances race for it. When the bucket
 * is configured but a write keeps failing or losing races, the grant is refused
 * ("busy", try again in a few seconds) rather than counted in one instance's
 * memory. Only a deployment with no bucket at all keeps the counters in memory.
 *
 * Every grant is checked against all the layers that apply:
 *   global       what the faucet key may spend in a day, across both Solana routes;
 *   pool         that day split in two: visitors without an invite code may use
 *                only the anonymous share, so a script cannot spend what is kept
 *                for invited friends and judges, and the invite share is capped too;
 *   per network  per IP address, generous enough for a room of testers on one
 *                Wi-Fi (about 25 SOL grants a day); an invited visitor still counts
 *                against their network, at three times the cap;
 *   per invite   each founder-issued code (INVITE_CODES) has its own daily cap.
 * Only codes on that list count as invites. Any other ?ref= still lands people on
 * the site and is counted on /voices, but buys nothing here.
 *
 * The EVM faucet (/api/evm-faucet) keeps its own counters in the same document:
 * claims per chain and per network, and the house's finite Robinhood test stock
 * slices per chain, split into the same two pools.
 *
 * A grant is reserved before anything is sent and released if the send fails.
 */

export const LIMITS = {
  /** SOL grants a day, across every visitor (at 0.05 SOL, 3 SOL). */
  globalSolGrants: 60,
  /** New token accounts the token faucet may open a day (about 0.6 SOL of rent). */
  globalAccounts: 300,
  /** Of the global day, what visitors without an invite code may use. The rest is kept for invites. */
  anonSolGrants: 36,
  anonAccounts: 180,
  /** Per network (IP) a day, for a visitor without an invite code. */
  netSolGrants: 25,
  netTokenClaims: 120,
  /** An invited visitor's network may take this many times the network cap. */
  inviteNetFactor: 3,
  /** Per invite code a day. */
  inviteSolGrants: 15,
  inviteTokenClaims: 80,
  /** EVM faucet claims a day per chain, and per network across chains. */
  evmChainClaims: 150,
  evmNetClaims: 20,
  /** Robinhood test stock slices a day per chain, and the anonymous share of them. */
  evmRealSlices: 25,
  anonRealSlices: 15,
};

/**
 * The codes the founder hands out (FRIENDS.md), one per channel. INVITE_CODES (a
 * comma list) replaces them on a deployment; a code is matched after cleanRef, so
 * "WhatsApp" and "whatsapp" are one code.
 */
const DEFAULT_INVITE_CODES = ["whatsapp", "college", "x", "superteam", "meteora", "chains", "friends", "judge"];
let inviteList: Set<string> | null = null;
function inviteCodes(): Set<string> {
  if (inviteList) return inviteList;
  const fromEnv = (process.env.INVITE_CODES ?? "").split(",").map(cleanRef).filter((c): c is string => c != null);
  return (inviteList = new Set(fromEnv.length ? fromEnv : DEFAULT_INVITE_CODES));
}

/** The first of these that is a founder-issued invite code, or null: a made-up code is no code here. */
export function faucetInvite(...raws: unknown[]): string | null {
  for (const raw of raws) {
    const code = cleanRef(raw);
    if (code && inviteCodes().has(code)) return code;
  }
  return null;
}

/** Rent for one Token-2022 account the faucet opens, for the burn rate. */
const ACCOUNT_RENT_LAMPORTS = 2_039_280;

type Counts = { sol: number; token: number; evm?: number };
type Pool = { sol: number; accounts: number };
type Chain = { claims: number; real: number; realAnon: number };
export type BudgetDay = {
  day: string;
  solGrants: number;
  solLamports: number;
  tokenClaims: number;
  accountsOpened: number;
  perNet: Record<string, Counts>;
  perInvite: Record<string, Counts>;
  /** The global day by pool. Absent in documents written before the split. */
  pools?: { anon: Pool; invite: Pool };
  /** The EVM faucet, per chain. */
  evm?: Record<string, Chain>;
  /** Lamports spent per UTC hour ("00".."23"), grants and rent together, for the burn rate. */
  hours: Record<string, number>;
};

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(11, 13);
const object = (day: string) => `faucet/day-${day}.json`;
const empty = (day: string): BudgetDay => ({ day, solGrants: 0, solLamports: 0, tokenClaims: 0, accountsOpened: 0, perNet: {}, perInvite: {}, hours: {} });

const g = globalThis as unknown as { __sheafFaucetDays?: Map<string, BudgetDay> };
const memory: Map<string, BudgetDay> = (g.__sheafFaucetDays ??= new Map<string, BudgetDay>());

export type Ask =
  | { kind: "sol"; net: string; invite: string | null; lamports: number }
  | { kind: "token"; net: string; invite: string | null; accounts: number }
  /** One EVM faucet claim (gas drip, test dollars) on a chain. */
  | { kind: "evm"; chain: string; net: string; invite: string | null }
  /** One slice of the house's Robinhood test stocks on a chain. */
  | { kind: "evm-real"; chain: string; invite: string | null };

export type Refusal = "global" | "network" | "invite" | "busy";

/** What applying (or undoing, with sign −1) an ask does to a day, or why it may not. */
function apply(d: BudgetDay, ask: Ask, sign: 1 | -1): Refusal | null {
  const h = hourKey();
  if (ask.kind === "evm" || ask.kind === "evm-real") {
    const chain = ((d.evm ??= {})[ask.chain] ??= { claims: 0, real: 0, realAnon: 0 });
    if (ask.kind === "evm-real") {
      if (sign === 1) {
        if (chain.real >= LIMITS.evmRealSlices) return "global";
        if (!ask.invite && chain.realAnon >= LIMITS.anonRealSlices) return "global";
      }
      chain.real += sign;
      if (!ask.invite) chain.realAnon += sign;
      return null;
    }
    const net = (d.perNet[ask.net] ??= { sol: 0, token: 0 });
    if (sign === 1) {
      if (chain.claims >= LIMITS.evmChainClaims) return "global";
      if ((net.evm ?? 0) >= LIMITS.evmNetClaims * (ask.invite ? LIMITS.inviteNetFactor : 1)) return "network";
    }
    chain.claims += sign;
    net.evm = (net.evm ?? 0) + sign;
    return null;
  }

  const pools = (d.pools ??= { anon: { sol: 0, accounts: 0 }, invite: { sol: 0, accounts: 0 } });
  const pool = ask.invite ? pools.invite : pools.anon;
  const net = (d.perNet[ask.net] ??= { sol: 0, token: 0 });
  const code = ask.invite ? (d.perInvite[ask.invite] ??= { sol: 0, token: 0 }) : null;
  const factor = ask.invite ? LIMITS.inviteNetFactor : 1;
  if (ask.kind === "sol") {
    if (sign === 1) {
      if (d.solGrants >= LIMITS.globalSolGrants) return "global";
      if (pool.sol >= (ask.invite ? LIMITS.globalSolGrants - LIMITS.anonSolGrants : LIMITS.anonSolGrants)) return "global";
      if (net.sol >= LIMITS.netSolGrants * factor) return "network";
      if (code && code.sol >= LIMITS.inviteSolGrants) return "invite";
    }
    d.solGrants += sign;
    d.solLamports += sign * ask.lamports;
    pool.sol += sign;
    net.sol += sign;
    if (code) code.sol += sign;
    d.hours[h] = (d.hours[h] ?? 0) + sign * ask.lamports;
  } else {
    if (sign === 1) {
      if (d.accountsOpened + ask.accounts > LIMITS.globalAccounts) return "global";
      if (pool.accounts + ask.accounts > (ask.invite ? LIMITS.globalAccounts - LIMITS.anonAccounts : LIMITS.anonAccounts)) return "global";
      if (net.token >= LIMITS.netTokenClaims * factor) return "network";
      if (code && code.token >= LIMITS.inviteTokenClaims) return "invite";
    }
    d.tokenClaims += sign;
    d.accountsOpened += sign * ask.accounts;
    pool.accounts += sign * ask.accounts;
    net.token += sign;
    if (code) code.token += sign;
    d.hours[h] = (d.hours[h] ?? 0) + sign * ask.accounts * ACCOUNT_RENT_LAMPORTS;
  }
  return null;
}

const ATTEMPTS = 6;
const pause = (attempt: number) => new Promise((r) => setTimeout(r, 40 * (attempt + 1) + Math.random() * 120));

/**
 * Read-modify-write one day's document, retrying a lost race after a short,
 * jittered pause. With a bucket configured, a write that keeps losing or a bucket
 * error refuses ("busy") instead of counting in this instance's memory, which
 * other instances never see. Memory is used only when there is no bucket.
 */
async function update(day: string, fn: (d: BudgetDay) => Refusal | null): Promise<Refusal | null> {
  if (gcsConfigured()) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const doc = await getJson<BudgetDay>(object(day));
        const d = doc?.data ?? empty(day);
        const refused = fn(d);
        if (refused) return refused;
        await putJson(object(day), d, { ifGenerationMatch: doc?.generation ?? "0" });
        memory.set(day, d);
        return null;
      } catch (err) {
        if (!(err instanceof GcsConflict)) return "busy";
        if (attempt < ATTEMPTS - 1) await pause(attempt);
      }
    }
    return "busy";
  }
  const d = memory.get(day) ?? empty(day);
  memory.set(day, d);
  return fn(d);
}

export type Reservation = { ok: true; release: () => Promise<void> } | { ok: false; refused: Refusal };

/** Reserves a grant against every budget that applies; `release` gives it back if nothing was sent. */
export async function reserve(ask: Ask): Promise<Reservation> {
  const day = dayKey();
  const refused = await update(day, (d) => apply(d, ask, 1));
  if (refused) return { ok: false, refused };
  return {
    ok: true,
    // A release that cannot be written leaves the grant counted: the safe side.
    release: () => update(day, (d) => (apply(d, ask, -1), null)).then(() => undefined, () => undefined),
  };
}

/** Today's totals and the burn of the last full hour and of the hour so far, for the heartbeat. */
export async function burnRate(): Promise<{ day: string; solGrants: number; accountsOpened: number; lamportsToday: number; lamportsLastHour: number; lamportsThisHour: number }> {
  const day = dayKey();
  let d: BudgetDay = memory.get(day) ?? empty(day);
  if (gcsConfigured()) d = (await getJson<BudgetDay>(object(day)).catch(() => null))?.data ?? d;
  const now = Date.now();
  // The previous hour may sit in yesterday's document; then it reads 0.
  const last = dayKey(now - 3_600_000) === day ? (d.hours[hourKey(now - 3_600_000)] ?? 0) : 0;
  return {
    day,
    solGrants: d.solGrants,
    accountsOpened: d.accountsOpened,
    lamportsToday: Object.values(d.hours).reduce((a, x) => a + x, 0),
    lamportsLastHour: last,
    lamportsThisHour: d.hours[hourKey(now)] ?? 0,
  };
}

/** The HTTP status for a refusal: a spent day or a busy bucket is 503, a spent share 429. */
export const budgetStatus = (refused: Refusal) => (refused === "global" || refused === "busy" ? 503 : 429);

/** Seconds to suggest before trying again (Retry-After, and the page's countdown), or null for "tomorrow". */
export const budgetRetryAfter = (refused: Refusal) => (refused === "busy" ? 5 : null);

/** The message a visitor sees when a budget is spent. `evm` names the chain for the EVM faucet. */
export function budgetMessage(refused: Refusal, opts: { evm?: string } = {}): string {
  if (refused === "busy") return "The faucet is busy right now. Try again in a few seconds.";
  if (opts.evm) {
    return refused === "global"
      ? `Today's test funds on ${opts.evm} are spent. The faucet refills at 00:00 UTC.`
      : refused === "invite"
        ? `This invite link has had its share of test funds on ${opts.evm} for today.`
        : `This network has had its share of test funds on ${opts.evm} for today. Try again tomorrow.`;
  }
  return refused === "global"
    ? "Out of test funds for today: faucet.solana.com hands out devnet SOL, and this faucet refills tomorrow."
    : refused === "invite"
      ? "This invite link has had its share of test funds for today. faucet.solana.com hands out devnet SOL too."
      : "This network has had its share of test funds for today. faucet.solana.com hands out devnet SOL too.";
}

/** The JSON body and headers for a refusal, shared by the faucet routes. */
export function budgetRefusal(refused: Refusal, opts: { evm?: string; extra?: Record<string, unknown> } = {}): Response {
  const retryAfter = budgetRetryAfter(refused);
  return Response.json(
    { error: budgetMessage(refused, opts), ...(retryAfter ? { retryAfter } : {}), ...opts.extra },
    { status: budgetStatus(refused), headers: { "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } },
  );
}
