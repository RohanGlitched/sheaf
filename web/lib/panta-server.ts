import "server-only";
import { marketWindow, recipeText, resolutionRule } from "./panta-window";
import { fetchBasketAt } from "./sheaf";
import { stockForWriteMint } from "./mirror";

/**
 * Panta (prediction markets on Solana, by Kaito) from the server side.
 *
 * The API key never reaches the browser and Panta does not answer cross-origin
 * calls, so every request goes through /api/panta. Writes on Panta follow one
 * pattern: quote, build an unsigned transaction, the wallet signs, report the
 * signature. Sheaf drives that whole lifecycle for a market on each basket
 * ("Will <basket> beat SPY this week?") and for a buy in it, plus positions,
 * win claims and creator fees.
 *
 * Money rule: every step that builds or reports a transaction runs only with a
 * pk_test_ key, which Panta answers from its sandbox fixtures without touching
 * mainnet. With a pk_live_ key Sheaf reads and quotes and stops there, so no
 * real USDC can move from this code. See docs/panta.md.
 */

const BASE = process.env.PANTA_API_BASE ?? "https://live-api.panta.market/api/v1";
const KEY = process.env.PANTA_API_KEY?.trim() ?? "";

/** The public origin Panta can reach, for sourcesOfTruth and the market image. */
export const PUBLIC_SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://sheaf.world").replace(/\/$/, "");

export type PantaMode = "live" | "sandbox" | "off";
export const pantaMode = (): PantaMode => (!KEY ? "off" : KEY.startsWith("pk_live_") ? "live" : "sandbox");

/** Panta marks every sandbox answer with a `disclaimer`. */
export type Fixture = { disclaimer?: string };
export const isFixture = (x: Fixture | null | undefined) => typeof x?.disclaimer === "string";

export class PantaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T & Fixture> {
  if (!KEY) throw new PantaError("Panta is not configured on this deployment.", 503);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: { "X-Api-Key": KEY, "content-type": "application/json" },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new PantaError("Panta did not answer in time.", 504);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    let code: string | null = null;
    try {
      const j = JSON.parse(text);
      code = j.code ?? null;
      msg = j.message ?? j.detail ?? j.error ?? msg;
    } catch {
      if (/<html/i.test(text)) msg = "not found";
    }
    throw new PantaError(`Panta answered ${res.status}${code ? ` ${code}` : ""}: ${msg}`, res.status === 429 ? 429 : 502, code);
  }
  return JSON.parse(text) as T & Fixture;
}

/** Steps that build or report a transaction: sandbox only. */
function sandboxOnly(step: string) {
  if (pantaMode() !== "sandbox") {
    throw new PantaError(
      `${step} runs against Panta's sandbox only. With a live key Sheaf stops at the quote, so no real USDC moves.`,
      403,
      "SHEAF_SANDBOX_ONLY",
    );
  }
}

// ------------------------------------------------------------- discovery, data

export type PantaMarket = {
  marketId: string;
  title: string;
  description?: string;
  category: string;
  phase: string;
  status: string;
  endTime: string;
  resolutionTime: string;
  volumeUsdc: string;
  yesPrice: string | null;
  noPrice: string | null;
  creatorAddress?: string;
};

const memo = new Map<string, { at: number; value: unknown }>();
async function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 300) memo.delete(memo.keys().next().value!);
  return value;
}

export function categories() {
  return remember("categories", 10 * 60_000, () => call<{ categories: string[] }>("/categories/"));
}

/** A stock-index question belongs in finance; the sandbox list has none, so it falls back to crypto. */
export async function basketCategory(): Promise<{ category: string; offered: string[]; preferred: boolean }> {
  const { categories: offered = [] } = await categories().catch(() => ({ categories: [] as string[] }));
  if (offered.includes("finance")) return { category: "finance", offered, preferred: true };
  return { category: offered.includes("crypto") ? "crypto" : (offered[0] ?? "finance"), offered, preferred: false };
}

export async function listMarkets(category?: string) {
  const q = new URLSearchParams({ limit: "24" });
  if (category) q.set("category", category);
  return remember(`markets:${q}`, 30_000, () => call<{ items: PantaMarket[] }>(`/markets/?${q}`));
}

export function getMarket(marketId: string) {
  return remember(`market:${marketId}`, 20_000, () => call<PantaMarket>(`/markets/${encodeURIComponent(marketId)}/`));
}

export function marketTrades(marketId: string) {
  return remember(`trades:${marketId}`, 20_000, () =>
    call<{ marketId: string; items: unknown[] }>(`/markets/${encodeURIComponent(marketId)}/trades/`),
  );
}

// -------------------------------------------------------------------- creation

export const basketQuestion = (name: string, symbol: string) =>
  `Will ${name.replace(/^The /, "the ")} (${symbol}) beat SPY this week?`;

export type CreateQuote = {
  createId: string;
  expectedEventPda: string;
  paymentUsdc: string;
  liquidityInjectionUsdc?: string;
  platformRevenueUsdc?: string;
  expiresAt: string;
};

/** The market Sheaf would open on a basket, exactly as it is sent to Panta. */
export async function basketDraft(input: { wallet: string; basket: string; name: string; symbol: string }) {
  // Panta requires trading to open at least an hour out. The week is measured
  // between two week-ending NYSE closes (lib/panta-window.ts), and the market
  // ends at the second one, so the rule, the window and the NAV reader agree.
  const w = marketWindow();
  const [{ category, preferred }, basket] = await Promise.all([basketCategory(), fetchBasketAt(input.basket).catch(() => null)]);
  // The recipe's units go into the rule itself, so resolving does not depend on
  // the devnet basket account staying up.
  const recipe = (basket?.components ?? []).map((c) => ({
    base: stockForWriteMint(c.mint)?.base ?? c.mint,
    unitsPerShare: c.unitsPerShare.toString(),
    decimals: c.decimals,
  }));
  const nav = `${PUBLIC_SITE}/api/nav/${input.basket}`;
  return {
    draft: {
      wallet: input.wallet,
      title: `${input.name} vs SPY`,
      question: basketQuestion(input.name, input.symbol),
      description: `${input.symbol} is a Sheaf basket (on Solana devnet today): a fixed recipe of tokenized stocks${recipe.length ? ` (${recipeText(recipe)} per share)` : ""}, valued at listed closes and each token's mainnet multiplier. This market asks whether one share outgrows SPY, total return, between two week-ending US closes.`,
      resolutionRule: resolutionRule(input.symbol, nav, w, recipe),
      sourcesOfTruth: [
        `${nav}?at=${w.fromClose}`,
        `${nav}?at=${w.toClose}`,
        `${PUBLIC_SITE}/basket/${input.basket}`,
        "https://finance.yahoo.com/quote/SPY/history",
      ],
      category,
      imageUrl: `${PUBLIC_SITE}/api/panta/image/${input.basket}`,
      startTime: w.opens,
      endTime: w.toClose,
      resolutionTime: w.resolves,
      marketType: "standard",
      region: "Global",
    },
    categoryPreferred: preferred,
  };
}

/** What it would cost to open the basket's market. Identical quotes are reused for a minute. */
export async function quoteBasketMarket(input: { wallet: string; basket: string; name: string; symbol: string }) {
  return remember(`create:${input.wallet}:${input.basket}:${input.name}:${input.symbol}`, 60_000, async () => {
    const { draft, categoryPreferred } = await basketDraft(input);
    const quote = await call<CreateQuote>("/markets/create/quote/", { method: "POST", body: draft });
    return { ...quote, draft, categoryPreferred };
  });
}

export type CreateBuild = {
  transaction: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  buildFingerprint: string;
  expectedEventPda: string;
  expiresAt: string;
  derived?: Record<string, string>;
};

export function buildCreate(createId: string, wallet: string) {
  sandboxOnly("Building the create transaction");
  return call<CreateBuild>("/markets/create/build/", { method: "POST", body: { createId, wallet } });
}

export function registerCreate(createId: string, signature: string) {
  sandboxOnly("Registering the market");
  return call<{ status: string; marketId: string; createId: string; signature: string; category: string; title: string }>(
    "/markets/register/",
    { method: "POST", body: { createId, signature } },
  );
}

// --------------------------------------------------------------------- trading

export type BuyQuote = {
  quoteId: string;
  marketId: string;
  side: "yes" | "no";
  amountUsdc: string;
  shares: string;
  feeUsdc: string;
  expiresAt: string;
};

export function quoteBuy(input: { wallet: string; marketId: string; side: "yes" | "no"; amountUsdc: string }) {
  return call<BuyQuote>("/primaryorderquote/", { method: "POST", body: input });
}

export type Ix = { programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };

export function buildBuy(quoteId: string, wallet: string) {
  sandboxOnly("Building the buy");
  return call<{ orderId: string; quoteId: string; instructions: Ix[]; recentBlockhash: string; lastValidBlockHeight: number; expectedShares?: string }>(
    "/primaryorderbuild/",
    { method: "POST", body: { quoteId, wallet, maxSlippageBps: 100 } },
  );
}

export function submitBuy(orderId: string, signature: string, wallet: string) {
  sandboxOnly("Submitting the buy");
  return call<{ orderId: string; status: string; signature: string }>("/primaryordersubmit/", {
    method: "POST",
    body: { orderId, signature, wallet },
  });
}

export function verifyBuy(orderId: string, wallet: string, signature?: string) {
  sandboxOnly("Verifying the buy");
  return call<{ orderId: string; status: string; signature?: string }>("/primaryorderverify/", {
    method: "POST",
    body: { orderId, wallet, ...(signature ? { signature } : {}) },
  });
}

export function reportTrade(input: { signature: string; wallet: string; marketId: string; quoteId?: string }) {
  sandboxOnly("Reporting the trade");
  return call<{ signature: string; status: string; kind?: string; side?: string }>("/trades/", {
    method: "POST",
    body: input,
  });
}

// ----------------------------------------------------------- positions, claims

export type PantaPosition = {
  marketId: string;
  category: string | null;
  side: "yes" | "no";
  shares: string;
  phase: "primary" | "secondary" | "resolved" | "cancelled" | string;
  claimable: boolean;
  claimed: boolean;
  outcome: "yes" | "no" | null;
};

export function positions(wallet: string) {
  return call<{ wallet: string; positions: PantaPosition[] }>(`/positions/?wallet=${encodeURIComponent(wallet)}`);
}

export function buildClaim(wallet: string, marketId: string) {
  sandboxOnly("Building the win claim");
  return call<{ outcome: string; winningShares: string; instructions: Ix[]; recentBlockhash: string; derived?: Record<string, string> }>(
    "/claim/build/",
    { method: "POST", body: { wallet, marketId } },
  );
}

export function buildCreatorFees(wallet: string, marketId: string) {
  sandboxOnly("Building the creator-fee claim");
  return call<{ claimableFeesUsdc: string; instructions: Ix[]; recentBlockhash: string; derived?: Record<string, string> }>(
    "/claim/creator-fees/build/",
    { method: "POST", body: { wallet, marketId } },
  );
}
