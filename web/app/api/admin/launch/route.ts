import { Connection, PublicKey } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { faucetKeypair } from "@/lib/faucet-server";
import { fetchBasketAt } from "@/lib/sheaf";
import { buildLaunch, solUsd } from "@/lib/launch";
import { findLaunch } from "@/lib/dbc";
import { fetchMarket } from "@/lib/market";
import { stockForWriteMint } from "@/lib/mirror";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/launch?basket=<address>   (Authorization: Bearer ADMIN_TOKEN)
 *
 * Opens the Meteora launch market for a basket the house created, signing as its
 * creator. Anyone else opens theirs from the basket page with their own wallet.
 */
export async function POST(req: Request) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "Not allowed." }, { status: 401 });
  }
  const address = new URL(req.url).searchParams.get("basket") ?? "";
  const keeper = faucetKeypair();
  const basket = await fetchBasketAt(address).catch(() => null);
  if (!keeper || !basket) return Response.json({ error: "Unknown basket or no key." }, { status: 400 });
  if (basket.creator !== keeper.publicKey.toBase58()) {
    return Response.json({ error: "The house did not create this basket." }, { status: 400 });
  }
  const [market, sol] = await Promise.all([fetchMarket(), solUsd()]);
  const bySymbol = new Map(market.quotes.map((q) => [q.symbol, q]));
  let nav = 0;
  for (const c of basket.components) {
    const q = bySymbol.get(stockForWriteMint(c.mint)?.symbol ?? "");
    if (!q) return Response.json({ error: "A component has no price." }, { status: 502 });
    nav += (Number(c.unitsPerShare) / 10 ** c.decimals) * q.price * (q.multiplier ?? 1);
  }
  const connection = new Connection(WRITE_RPC, "confirmed");
  // Idempotent: buildLaunch refuses a basket that already has an official
  // launch, and skips any slot a squatter has taken.
  let tx;
  try {
    tx = await buildLaunch({
      connection,
      creator: keeper.publicKey,
      basket: { address: basket.address, name: basket.name, symbol: basket.symbol },
      navSol: nav / sol,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not build the launch." }, { status: 409 });
  }
  // buildLaunch partially signs with the launch's derived keys; the creator signs last.
  tx.partialSign(keeper);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  const { launch } = await findLaunch(connection, { ...basket, creator: keeper.publicKey.toBase58() });
  return Response.json({
    basket: basket.address,
    navUsd: nav,
    solUsd: sol,
    signature: sig,
    pubkey: new PublicKey(keeper.publicKey).toBase58(),
    pool: launch?.info.pool ?? null,
    slot: launch?.info.slot ?? null,
  });
}
