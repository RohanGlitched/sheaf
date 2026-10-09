import { Connection, PublicKey } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { CASH_MINT } from "@/lib/cash.generated";
import { runFillerPass, type CoreBasket, type FillerIdl } from "@/lib/filler-core";
import { fetchMarket } from "@/lib/market";
import { stockForWriteMint, symbolForWriteMint } from "@/lib/mirror";
import { filler2Keypair } from "@/lib/server-keys";
import idl from "@/lib/sheaf-idl.json";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET or POST /api/filler2: one pass of the second filler.
 *
 * A filler the site runs on its own key (FILLER2_KEY), apart from the house: the
 * reference filler's code (lib/filler-core.ts, the same file scripts/filler.mjs
 * runs), at an 8 bps margin, so it bids against the house filler's 15. It holds
 * only what any outsider can get: test stocks from the public faucet, asked for
 * here over HTTP like anyone else, never minted. Whatever it was short of on this
 * pass it claims for the next one.
 *
 * Open to anyone, like the keeper; a short gap stops a loop.
 */

const EDGE_BPS = 8;
/** Inside one pass, wait up to this long for an order about to reach the margin. */
const WAIT_SECS = 30;

let lastRun = 0;
let running = false;

export async function GET(request: Request) {
  const filler = filler2Keypair();
  if (!filler) return Response.json({ error: "The second filler is not configured here. Set FILLER2_KEY on the server." }, { status: 503 });
  const noStore = { headers: { "cache-control": "no-store" } };
  if (running) return Response.json({ busy: true }, noStore);
  if (Date.now() - lastRun < 4_000) return Response.json({ throttled: true }, noStore);
  lastRun = Date.now();
  running = true;
  const origin = new URL(request.url).origin;
  const connection = new Connection(WRITE_RPC, "confirmed");
  const lines: string[] = [];
  const short = new Set<string>();
  try {
    const market = await fetchMarket();
    const quotes = new Map(market.quotes.map((q) => [q.symbol, q]));
    const result = await runFillerPass({
      connection,
      filler,
      idl: idl as unknown as FillerIdl,
      cashMint: new PublicKey(CASH_MINT),
      edgeBps: EDGE_BPS,
      waitUpToSecs: WAIT_SECS,
      quote: (mint) => {
        const stock = stockForWriteMint(mint.toBase58());
        return stock ? quotes.get(stock.symbol) : undefined;
      },
      lookupTable: async (basket: CoreBasket) => {
        const res = await fetch(`${origin}/api/alt?basket=${basket.address.toBase58()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        return res?.alt ? (await connection.getAddressLookupTable(new PublicKey(res.alt))).value : null;
      },
      shortOf: (_basket, mints) => mints.forEach((m) => {
        const symbol = symbolForWriteMint(m.toBase58());
        if (symbol) short.add(symbol);
      }),
      log: (line) => lines.push(line),
    });
    // Stock for next time, from the public faucet, the way an outside filler gets it.
    let topUp: unknown = null;
    if (short.size) {
      topUp = await fetch(`${origin}/api/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: filler.publicKey.toBase58(), symbols: [...short].slice(0, 8) }),
      })
        .then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }))
        .catch((e) => ({ error: (e as Error).message }));
    }
    return Response.json({ filler: filler.publicKey.toBase58(), edgeBps: EDGE_BPS, ...result, topUp, log: lines.slice(-40) }, noStore);
  } catch (err) {
    return Response.json({ error: ((err as Error).message ?? "pass failed").split("\n")[0].slice(0, 200), log: lines.slice(-20) }, { status: 500 });
  } finally {
    running = false;
  }
}

export const POST = GET;
