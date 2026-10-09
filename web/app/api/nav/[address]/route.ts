import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { UNIVERSE_MINTS, fetchMarket, withChainMultipliers, type MarketSnapshot } from "@/lib/market";
import { readMints } from "@/lib/mainnet";
import { readHistory } from "@/lib/history";
import { trackRecord } from "@/lib/track";
import { stockForWriteMint } from "@/lib/mirror";
import { fetchBasketAt, tokenAccount } from "@/lib/sheaf";
import { ONE_SHARE, WRITE_CLUSTER, WRITE_RPC } from "@/lib/config";
import { basketQuestion } from "@/lib/panta-server";

/**
 * GET /api/nav/<basket address>
 *
 * The number a Panta market on this basket resolves from, as JSON a machine can
 * read: what one share is worth right now, three ways, with every input that
 * went into it, plus the trailing week against SPY.
 *
 *   navPerShare.recipe   units per share (fixed at creation, on chain) x live
 *                        token price x the mint's Token-2022 multiplier
 *   navPerShare.vault    what the vault actually holds, divided by the shares
 *                        outstanding, at the same prices (at least the recipe)
 *   navPerShare.listed   the recipe at the listed shares' last prices, the
 *                        number that matters once the stock market has closed
 *
 * Anyone can recompute it: the vault balances and share supply are public
 * accounts, the multipliers are on each mainnet mint, and the prices are
 * Jupiter's public API. Nothing here needs trusting Sheaf.
 */

export const dynamic = "force-dynamic";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT_OFFSET = 64;
const SUPPLY_OFFSET = 36;

let snap: { at: number; value: MarketSnapshot } | null = null;
async function market(): Promise<MarketSnapshot> {
  if (snap && Date.now() - snap.at < 15_000) return snap.value;
  const [m, chain] = await Promise.all([fetchMarket(), readMints(UNIVERSE_MINTS)]);
  const value = withChainMultipliers(m, chain);
  snap = { at: Date.now(), value };
  return value;
}

const u64 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);

const round = (x: number | null, digits = 6) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!BASE58.test(address)) return NextResponse.json({ error: "Not a basket address." }, { status: 400 });

  const basket = await fetchBasketAt(address);
  if (!basket) return NextResponse.json({ error: "No basket at this address." }, { status: 404 });

  const basketKey = new PublicKey(basket.address);
  const tokenProgram = new PublicKey(basket.tokenProgram);
  const vaults = basket.components.map((c) => tokenAccount(new PublicKey(c.mint), basketKey, tokenProgram));

  const [snapshot, infos, history] = await Promise.all([
    market(),
    new Connection(WRITE_RPC, "confirmed")
      .getMultipleAccountsInfoAndContext([new PublicKey(basket.shareMint), ...vaults])
      .catch(() => null),
    readHistory().catch(() => null),
  ]);

  const bySymbol = new Map(snapshot.quotes.map((q) => [q.symbol, q]));
  const supplyRaw = infos?.value[0] ? u64(new Uint8Array(infos.value[0].data), SUPPLY_OFFSET) : null;
  const shares = supplyRaw == null ? null : Number(supplyRaw) / ONE_SHARE;

  const components = basket.components.map((c, i) => {
    const stock = stockForWriteMint(c.mint);
    const q = stock ? bySymbol.get(stock.symbol) : undefined;
    const info = infos?.value[i + 1];
    const held = info ? u64(new Uint8Array(info.data), AMOUNT_OFFSET) : null;
    const perRaw = q ? (q.price * q.multiplier) / 10 ** c.decimals : null;
    const perRawListed = q?.sharePrice != null ? (q.sharePrice * q.multiplier) / 10 ** c.decimals : null;
    return {
      base: stock?.base ?? null,
      symbol: stock?.symbol ?? null,
      company: stock?.company ?? null,
      vaultMint: c.mint,
      priceMint: stock?.mint ?? null,
      decimals: c.decimals,
      unitsPerShare: c.unitsPerShare.toString(),
      targetWeightBps: c.weightBps,
      vault: vaults[i].toBase58(),
      vaultHeld: held?.toString() ?? null,
      price: q?.price ?? null,
      listedPrice: q?.sharePrice ?? null,
      multiplier: q?.multiplier ?? null,
      valuePerShare: perRaw == null ? null : round(Number(c.unitsPerShare) * perRaw),
      _perRaw: perRaw,
      _perRawListed: perRawListed,
      _held: held,
    };
  });

  const all = <T,>(xs: (T | null)[]) => (xs.every((x) => x != null) ? (xs as T[]) : null);
  const recipeParts = all(components.map((c) => c.valuePerShare));
  const recipe = recipeParts ? recipeParts.reduce((a, b) => a + b, 0) : null;
  const listedParts = all(components.map((c) => (c._perRawListed == null ? null : Number(c.unitsPerShare) * c._perRawListed)));
  const listed = listedParts ? listedParts.reduce((a, b) => a + b, 0) : null;
  const heldValue = all(components.map((c) => (c._held == null || c._perRaw == null ? null : Number(c._held) * c._perRaw)));
  const vault = heldValue && shares && shares > 0 ? heldValue.reduce((a, b) => a + b, 0) / shares : null;

  // The trailing five trading days, recipe vs SPY, from adjusted closes.
  let week: {
    from: number;
    to: number;
    navReturnPct: number;
    spyReturnPct: number | null;
    beatsSpy: boolean | null;
  } | null = null;
  const track = trackRecord(
    components.map((c) => ({ base: c.base ?? "", valueNow: c.valuePerShare ?? 0 })),
    history,
    "1m",
  );
  if (track && track.points.length >= 6) {
    const end = track.points[track.points.length - 1];
    const start = track.points[track.points.length - 6];
    const navReturnPct = (end.nav / start.nav - 1) * 100;
    const spyReturnPct = end.bench != null && start.bench != null ? (end.bench / start.bench - 1) * 100 : null;
    week = {
      from: start.d,
      to: end.d,
      navReturnPct: round(navReturnPct, 4)!,
      spyReturnPct: round(spyReturnPct, 4),
      beatsSpy: spyReturnPct == null ? null : navReturnPct > spyReturnPct,
    };
  }

  const spy = bySymbol.get("SPYx");
  const now = new Date();
  return NextResponse.json(
    {
      basket: {
        address: basket.address,
        name: basket.name,
        symbol: basket.symbol,
        creator: basket.creator,
        shareMint: basket.shareMint,
        cluster: WRITE_CLUSTER,
      },
      question: basketQuestion(basket.name, basket.symbol),
      at: now.toISOString(),
      unix: Math.floor(now.getTime() / 1000),
      navPerShare: { recipe: round(recipe), vault: round(vault), listed: round(listed) },
      sharesOutstanding: shares,
      vaultSlot: infos?.context.slot ?? null,
      spy: spy
        ? { token: spy.symbol, mint: spy.mint, price: spy.price, listedPrice: spy.sharePrice, multiplier: spy.multiplier }
        : null,
      week,
      components: components.map(({ _perRaw, _perRawListed, _held, ...c }) => {
        void _perRaw;
        void _perRawListed;
        void _held;
        return c;
      }),
      sources: {
        prices: `Jupiter price API v3, fetched ${new Date(snapshot.fetchedAt * 1000).toISOString()}`,
        multipliers: snapshot.chain
          ? `Token-2022 ScaledUiAmount config on each mainnet mint, read at slot ${snapshot.chain.slot} through ${snapshot.chain.via === "solami" ? "Solami" : "the public mainnet RPC"}`
          : "Jupiter's copy of each mint's multiplier (the chain read failed)",
        vault: `Share mint supply and the vault's token accounts on Solana ${WRITE_CLUSTER}, slot ${infos?.context.slot ?? "unknown"}`,
        week: history ? `Adjusted daily closes as of ${history.asOf}${history.stale.length ? `; from snapshot: ${history.stale.join(", ")}` : ""}` : null,
      },
      method:
        "value per share = sum over components of unitsPerShare / 10^decimals x price x multiplier. The vault figure uses the vault's actual balances over shares outstanding.",
      recompute: [
        `curl -s https://api.${WRITE_CLUSTER}.solana.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["${basket.shareMint}"]}'`,
        `curl -s 'https://lite-api.jup.ag/price/v3?ids=${components.map((c) => c.priceMint).filter(Boolean).join(",")}'`,
      ],
    },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60", "access-control-allow-origin": "*" } },
  );
}
