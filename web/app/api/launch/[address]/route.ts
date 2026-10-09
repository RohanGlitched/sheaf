import { Connection } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { PRESET_NAMES, findLaunch, launchName, launchSymbol, preIpoCompanies, readDbcState } from "@/lib/dbc";
import { LAUNCH_METADATA_SITE } from "@/lib/launch";
import { fetchBasketAt } from "@/lib/sheaf";
import { anchorFor } from "../anchor";

export const dynamic = "force-dynamic";

/**
 * Token metadata for a basket's launch token, which points its mint's URI
 * here (`/api/launch/<basket>`). Besides the usual name, symbol and image, it
 * carries the launch's provenance as attributes, all derived from the pool's
 * own accounts and independent prices rather than from anything the creator
 * wrote: the preset, the open time, the NAV the curve was anchored to, SOL's
 * price in that hour, the basket's NAV at the last close before the open, and
 * whether the two agree (`anchor`). `provenance.anchor.navProof` is the NAV
 * endpoint to check it against.
 */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const basket = await fetchBasketAt(address).catch(() => null);
  if (!basket) return Response.json({ error: "No basket at that address." }, { status: 404 });

  const page = `${LAUNCH_METADATA_SITE}/basket/${basket.address}`;
  const preIpo = preIpoCompanies(basket);
  const connection = new Connection(WRITE_RPC, "confirmed");
  const { launch } = await findLaunch(connection, basket).catch(() => ({ launch: null }));
  const state = launch ? await readDbcState(connection, launch.info, basket.creator).catch(() => null) : null;
  const anchor =
    launch && state
      ? await anchorFor({
          connection,
          origin: new URL(req.url).origin,
          basket: basket.address,
          pool: launch.info.pool,
          state,
        }).catch(() => null)
      : null;

  const attributes = [
    { trait_type: "basket", value: `${basket.name} (${basket.symbol})` },
    ...(state?.preset ? [{ trait_type: "preset", value: PRESET_NAMES[state.preset] }] : []),
    ...(anchor?.openedAt ? [{ trait_type: "opened_at", value: new Date(anchor.openedAt * 1000).toISOString() }] : []),
    ...(anchor ? [{ trait_type: "nav_sol_at_open", value: Number(anchor.navSolAtOpen.toPrecision(6)) }] : []),
    ...(anchor?.solUsdAtOpen ? [{ trait_type: "sol_usd_at_open", value: Number(anchor.solUsdAtOpen.toFixed(2)) }] : []),
    ...(anchor?.navUsdAtClose
      ? [{ trait_type: "nav_usd_at_last_close", value: Number(anchor.navUsdAtClose.toFixed(2)) }]
      : []),
    ...(anchor ? [{ trait_type: "anchor", value: anchor.status }] : []),
    { trait_type: "redeemable", value: "no" },
    ...(preIpo.length ? [{ trait_type: "pre_ipo_components", value: preIpo.join(", ") }] : []),
  ];

  return Response.json(
    {
      name: launchName(basket.name),
      symbol: launchSymbol(basket.symbol),
      description:
        `Launch token for ${basket.name} (${basket.symbol}), a Sheaf basket of ${basket.components.length} tokenized equities. ` +
        "A separate token on a Meteora bonding curve: not a basket share, not backed by the basket's vault and not redeemable for anything." +
        (preIpo.length
          ? ` The basket holds pre-IPO SPV tokens (${preIpo.join(", ")}), not company shares; in May 2026 Anthropic and OpenAI said transfers of their stock without board approval, tokenized ones included, are void.`
          : ""),
      image: `${page}/opengraph-image`,
      external_url: page,
      attributes,
      provenance: launch
        ? {
            pool: launch.info.pool,
            config: launch.info.config,
            mint: launch.info.baseMint,
            slot: launch.info.slot ?? 0,
            preset: state?.preset ? PRESET_NAMES[state.preset] : null,
            anchor,
            method:
              "openedAt is the pool's activation_point; navSolAtOpen is the curve's opening market cap / 0.5; solUsdAtOpen is SOL's price in that hour (Coinbase candles, else Kraken); navUsdAtClose is navProof's navPerShare.listed. The anchor is verified when navSolAtOpen x solUsdAtOpen is within 20% of navUsdAtClose.",
          }
        : null,
    },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=86400" } },
  );
}
