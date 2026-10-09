import "server-only";
import { GcsConflict, gcsConfigured, getJson, putJson } from "./gcs-store";

/**
 * The faucets' daily budget, kept where every instance sees it.
 *
 * In-memory limits are per instance, so a script that lands on many instances
 * multiplies them. These counters live in the project's bucket, one document per
 * UTC day (faucet/day-YYYY-MM-DD.json), updated with a generation precondition,
 * so a grant is counted once however many instances race for it. Without a
 * bucket they fall back to memory, as before.
 *
 * Three layers, every grant checked against all that apply:
 *   global       what the faucet key may spend in a day, across both routes;
 *   per network  per IP address, generous enough for a room of testers on one
 *                Wi-Fi (about 25 SOL grants a day);
 *   per invite   a visitor who arrived with an invite code (?ref=) is counted
 *                against that code instead of their network, so a group sharing
 *                one link and one network is not turned away; the global budget
 *                still applies.
 *
 * A grant is reserved before anything is sent and released if the send fails.
 */

export const LIMITS = {
  /** SOL grants a day, across every visitor (at 0.05 SOL, 3 SOL). */
  globalSolGrants: 60,
  /** New token accounts the token faucet may open a day (about 0.6 SOL of rent). */
  globalAccounts: 300,
  /** Per network (IP) a day. */
  netSolGrants: 25,
  netTokenClaims: 120,
  /** Per invite code a day. */
  inviteSolGrants: 40,
  inviteTokenClaims: 200,
};

/** Rent for one Token-2022 account the faucet opens, for the burn rate. */
const ACCOUNT_RENT_LAMPORTS = 2_039_280;

type Counts = { sol: number; token: number };
export type BudgetDay = {
  day: string;
  solGrants: number;
  solLamports: number;
  tokenClaims: number;
  accountsOpened: number;
  perNet: Record<string, Counts>;
  perInvite: Record<string, Counts>;
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
  | { kind: "token"; net: string; invite: string | null; accounts: number };

/** What applying (or undoing, with sign −1) an ask does to a day, or why it may not. */
function apply(d: BudgetDay, ask: Ask, sign: 1 | -1): string | null {
  const who = ask.invite ? (d.perInvite[ask.invite] ??= { sol: 0, token: 0 }) : (d.perNet[ask.net] ??= { sol: 0, token: 0 });
  const h = hourKey();
  if (ask.kind === "sol") {
    if (sign === 1) {
      if (d.solGrants >= LIMITS.globalSolGrants) return "global";
      if (who.sol >= (ask.invite ? LIMITS.inviteSolGrants : LIMITS.netSolGrants)) return ask.invite ? "invite" : "network";
    }
    d.solGrants += sign;
    d.solLamports += sign * ask.lamports;
    who.sol += sign;
    d.hours[h] = (d.hours[h] ?? 0) + sign * ask.lamports;
  } else {
    if (sign === 1) {
      if (d.accountsOpened + ask.accounts > LIMITS.globalAccounts) return "global";
      if (who.token >= (ask.invite ? LIMITS.inviteTokenClaims : LIMITS.netTokenClaims)) return ask.invite ? "invite" : "network";
    }
    d.tokenClaims += sign;
    d.accountsOpened += sign * ask.accounts;
    who.token += sign;
    d.hours[h] = (d.hours[h] ?? 0) + sign * ask.accounts * ACCOUNT_RENT_LAMPORTS;
  }
  return null;
}

/** Read-modify-write one day's document, retrying a lost race; falls back to memory when the bucket is off or failing. */
async function update(day: string, fn: (d: BudgetDay) => string | null): Promise<string | null> {
  if (gcsConfigured()) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const doc = await getJson<BudgetDay>(object(day));
        const d = doc?.data ?? empty(day);
        const refused = fn(d);
        if (refused) return refused;
        await putJson(object(day), d, { ifGenerationMatch: doc?.generation ?? "0" });
        memory.set(day, d);
        return null;
      } catch (err) {
        if (!(err instanceof GcsConflict)) break;
      }
    }
  }
  // No bucket, or it is failing: this instance's memory still enforces the same numbers.
  const d = memory.get(day) ?? empty(day);
  memory.set(day, d);
  return fn(d);
}

export type Reservation = { ok: true; release: () => Promise<void> } | { ok: false; refused: "global" | "network" | "invite" };

/** Reserves a grant against every budget that applies; `release` gives it back if nothing was sent. */
export async function reserve(ask: Ask): Promise<Reservation> {
  const day = dayKey();
  const refused = await update(day, (d) => apply(d, ask, 1));
  if (refused) return { ok: false, refused: refused as "global" | "network" | "invite" };
  return {
    ok: true,
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

/** The message a visitor sees when a budget is spent. */
export function budgetMessage(refused: "global" | "network" | "invite"): string {
  return refused === "global"
    ? "Out of test funds for today: faucet.solana.com hands out devnet SOL, and this faucet refills tomorrow."
    : refused === "invite"
      ? "This invite link has had its share of test funds for today. faucet.solana.com hands out devnet SOL too."
      : "This network has had its share of test funds for today. faucet.solana.com hands out devnet SOL too.";
}
