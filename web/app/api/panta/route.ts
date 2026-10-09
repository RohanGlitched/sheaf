import { NextResponse } from "next/server";
import {
  PantaError,
  basketCategory,
  buildBuy,
  buildClaim,
  buildCreate,
  buildCreatorFees,
  isFixture,
  listMarkets,
  marketTrades,
  pantaMode,
  quoteBasketMarket,
  quoteBuy,
  registerCreate,
  reportTrade,
  submitBuy,
  verifyBuy,
} from "@/lib/panta-server";
import { clientIp, throttle, type Budget } from "@/lib/panta-throttle";
import { fetchBasketAt } from "@/lib/sheaf";
import { stockForWriteMint } from "@/lib/mirror";
import { HISTORY_SYMBOLS } from "@/lib/history";

/** Holdings with no listed price history (pre-IPO), or null when there is no basket at the address. */
async function unlistedHoldings(address: string): Promise<string[] | null> {
  const basket = await fetchBasketAt(address).catch(() => null);
  if (!basket) return null;
  return basket.components
    .map((c) => stockForWriteMint(c.mint)?.base ?? null)
    .filter((base) => !base || !HISTORY_SYMBOLS.includes(base))
    .map((base) => base ?? "an unknown token");
}

/**
 * GET  /api/panta -> { mode, markets, category, trades }  (GET /markets/, /categories/, /markets/{id}/trades/)
 *
 * POST /api/panta { kind, ... } runs one step of a Panta flow:
 *
 *   create-quote     { wallet, basket, name, symbol }   POST /markets/create/quote/
 *   create-build     { wallet, createId }               POST /markets/create/build/
 *   create-register  { createId, signature }            POST /markets/register/
 *   buy-quote        { wallet, marketId, side, amountUsdc }  POST /primaryorderquote/
 *   buy-build        { wallet, quoteId }                POST /primaryorderbuild/
 *   buy-submit       { wallet, orderId, signature }     POST /primaryordersubmit/
 *   buy-verify       { wallet, orderId, signature? }    POST /primaryorderverify/
 *   buy-report       { wallet, marketId, signature, quoteId? }  POST /trades/
 *   claim-build      { wallet, marketId }               POST /claim/build/
 *   creator-fees-build { wallet, marketId }             POST /claim/creator-fees/build/
 *
 * ("create" and "buy" are kept as aliases of the two quote steps.)
 *
 * Every step after a quote is sandbox-only (lib/panta-server.ts refuses it with
 * a live key). Nothing here signs or broadcasts: the wallet signs in the
 * browser, and Sheaf never sends a Panta transaction to any cluster.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;
const SESSION = /^[A-Za-z0-9_-]{3,80}$/;

const BUDGET: Record<string, Budget> = {
  "create-quote": "quote",
  "buy-quote": "quote",
  "create-build": "build",
  "buy-build": "build",
  "claim-build": "build",
  "creator-fees-build": "build",
  "create-register": "report",
  "buy-submit": "report",
  "buy-verify": "report",
  "buy-report": "report",
};

export async function GET() {
  const mode = pantaMode();
  if (mode === "off") return NextResponse.json({ mode, markets: [] });
  try {
    const [markets, category] = await Promise.all([listMarkets(), basketCategory()]);
    const first = markets.items?.[0]?.marketId;
    const tape = first ? await marketTrades(first).catch(() => null) : null;
    const trades = tape ? { marketId: first, count: tape.items?.length ?? 0, items: (tape.items ?? []).slice(0, 5) } : null;
    return NextResponse.json(
      { mode, fixture: isFixture(markets), markets: markets.items ?? [], category, trades },
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
    );
  } catch (err) {
    return NextResponse.json({ mode, markets: [], error: (err as Error).message }, { status: 502 });
  }
}

class BadRequest extends Error {}

function need(body: Record<string, unknown>, field: string, shape: RegExp, label: string): string {
  const v = String(body[field] ?? "");
  if (!shape.test(v)) throw new BadRequest(label);
  return v;
}

/** In the sandbox only Panta's fixture markets exist, so any other id is a mistake, not a market. */
async function knownMarket(marketId: string) {
  if (pantaMode() !== "sandbox") return;
  const { items = [] } = await listMarkets();
  if (!items.some((m) => m.marketId === marketId)) {
    throw new BadRequest("That market is not in Panta's sandbox catalog.");
  }
}

export async function POST(req: Request) {
  const mode = pantaMode();
  if (mode === "off") return NextResponse.json({ error: "Panta is not configured." }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });

  const kind = body.kind === "create" ? "create-quote" : body.kind === "buy" ? "buy-quote" : String(body.kind ?? "");
  const budget = BUDGET[kind];
  if (!budget) return NextResponse.json({ error: "Unknown request." }, { status: 400 });

  const wait = throttle(clientIp(req), budget);
  if (wait != null) {
    return NextResponse.json(
      { error: `Too many Panta requests. Try again in ${wait}s.` },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }

  try {
    const wallet = kind === "create-register" ? null : need(body, "wallet", BASE58, "Connect a wallet first.");
    let out: object;
    switch (kind) {
      case "create-quote": {
        const basket = need(body, "basket", BASE58, "Unknown basket.");
        const name = String(body.name ?? "").slice(0, 40).trim();
        const symbol = String(body.symbol ?? "").slice(0, 10).trim();
        if (!name || !symbol) throw new BadRequest("Name the basket.");
        // The rule resolves from navPerShare.listed at two closes; a basket with a
        // pre-IPO holding has no listed history, so no market is drafted for it.
        const unlisted = await unlistedHoldings(basket);
        if (unlisted == null) throw new BadRequest("Unknown basket.");
        if (unlisted.length) {
          throw new BadRequest(
            `No market is offered on this basket: ${unlisted.join(", ")} ha${unlisted.length === 1 ? "s" : "ve"} no listed price history (pre-IPO), so the value the rule reads at a close does not exist.`,
          );
        }
        out = await quoteBasketMarket({ wallet: wallet!, basket, name, symbol });
        break;
      }
      case "create-build":
        out = await buildCreate(need(body, "createId", SESSION, "Quote the market first."), wallet!);
        break;
      case "create-register":
        out = await registerCreate(
          need(body, "createId", SESSION, "Quote the market first."),
          need(body, "signature", SIGNATURE, "Sign the transaction first."),
        );
        break;
      case "buy-quote": {
        const marketId = need(body, "marketId", BASE58, "Pick a market.");
        await knownMarket(marketId);
        const side = body.side === "no" ? "no" : "yes";
        const amount = Math.max(1, Math.min(1000, Number(body.amountUsdc) || 0)).toFixed(2);
        const q = await quoteBuy({ wallet: wallet!, marketId, side, amountUsdc: amount });
        // Panta's sandbox answers every buy with the same fixed fixture; say what we asked for.
        out = { ...q, requestedUsdc: amount };
        break;
      }
      case "buy-build":
        out = await buildBuy(need(body, "quoteId", SESSION, "Quote the buy first."), wallet!);
        break;
      case "buy-submit":
        out = await submitBuy(
          need(body, "orderId", SESSION, "Build the buy first."),
          need(body, "signature", SIGNATURE, "Sign the transaction first."),
          wallet!,
        );
        break;
      case "buy-verify": {
        const sig = body.signature ? need(body, "signature", SIGNATURE, "Bad signature.") : undefined;
        out = await verifyBuy(need(body, "orderId", SESSION, "Build the buy first."), wallet!, sig);
        break;
      }
      case "buy-report": {
        const marketId = need(body, "marketId", BASE58, "Pick a market.");
        const quoteId = body.quoteId ? need(body, "quoteId", SESSION, "Bad quote id.") : undefined;
        out = await reportTrade({
          signature: need(body, "signature", SIGNATURE, "Sign the transaction first."),
          wallet: wallet!,
          marketId,
          ...(quoteId ? { quoteId } : {}),
        });
        break;
      }
      case "claim-build":
      case "creator-fees-build": {
        const marketId = need(body, "marketId", BASE58, "Pick a market.");
        await knownMarket(marketId);
        out = kind === "claim-build" ? await buildClaim(wallet!, marketId) : await buildCreatorFees(wallet!, marketId);
        break;
      }
      default:
        throw new BadRequest("Unknown request.");
    }
    // Panta echoes the account's own ids on some answers; the browser has no use for them.
    const { userId: _u, apiKeyId: _k, ...shown } = out as Record<string, unknown>;
    void _u;
    void _k;
    return NextResponse.json({ mode, kind, fixture: isFixture(out as { disclaimer?: string }), ...shown });
  } catch (err) {
    if (err instanceof BadRequest) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof PantaError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Panta did not answer." }, { status: 502 });
  }
}
