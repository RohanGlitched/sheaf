import "server-only";

/**
 * Panta (prediction markets on Solana, by Kaito) from the server side.
 *
 * The API key never reaches the browser and Panta does not answer cross-origin
 * calls, so every request goes through /api/panta. Writes on Panta follow one
 * pattern: quote, build an unsigned transaction, the wallet signs, report the
 * signature. Sheaf uses the quote steps to price a market on a basket and a buy
 * in it; a pk_test_ key answers from Panta's sandbox, which never touches mainnet.
 */

const BASE = process.env.PANTA_API_BASE ?? "https://live-api.panta.market/api/v1";
const KEY = process.env.PANTA_API_KEY ?? "";

export const pantaMode = (): "live" | "sandbox" | "off" =>
  !KEY ? "off" : KEY.startsWith("pk_live_") ? "live" : "sandbox";

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
};

async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  if (!KEY) throw new Error("Panta is not configured on this deployment.");
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { "X-Api-Key": KEY, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.detail ?? j.error ?? j.message ?? msg;
    } catch {}
    throw new Error(`Panta answered ${res.status}: ${msg}`);
  }
  return JSON.parse(text) as T;
}

export async function listMarkets(category?: string): Promise<PantaMarket[]> {
  const q = new URLSearchParams({ limit: "24" });
  if (category) q.set("category", category);
  const out = await call<{ items: PantaMarket[] }>(`/markets/?${q}`);
  return out.items ?? [];
}

export type CreateQuote = {
  createId: string;
  expectedEventPda: string;
  paymentUsdc: string;
  liquidityInjectionUsdc?: string;
  platformRevenueUsdc?: string;
  expiresAt: string;
};

/** What it would cost to open "Will <basket> beat SPY this week?" on Panta. */
export async function quoteBasketMarket(input: {
  wallet: string;
  basketName: string;
  basketSymbol: string;
  navUrl: string;
}): Promise<CreateQuote & { draft: Record<string, unknown> }> {
  const now = Math.floor(Date.now() / 1000);
  // Panta requires the market to open at least an hour out. It runs a week.
  const startTime = now + 2 * 3600;
  const endTime = startTime + 7 * 24 * 3600;
  const draft = {
    wallet: input.wallet,
    title: `${input.basketName} vs SPY`,
    question: `Will the ${input.basketName} basket (${input.basketSymbol}) beat SPY this week?`,
    resolutionRule: `YES if the ${input.basketSymbol} share's value, read from its vault at the closing time, rose by more than SPY's close-to-close change over the same week. NO otherwise.`,
    sourcesOfTruth: [input.navUrl, "https://www.nasdaq.com/market-activity/etf/spy"],
    category: "crypto",
    startTime,
    endTime,
    resolutionTime: endTime + 3600,
    marketType: "standard",
    region: "Global",
  };
  const quote = await call<CreateQuote>("/markets/create/quote/", { method: "POST", body: draft });
  return { ...quote, draft };
}

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

export function positions(wallet: string) {
  return call<{ items?: unknown[] } | unknown[]>(`/positions/?wallet=${encodeURIComponent(wallet)}`);
}
