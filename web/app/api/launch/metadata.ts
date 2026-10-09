import { Connection } from "@solana/web3.js";
import { WRITE_RPC } from "@/lib/config";
import { PRESET_NAMES, launchName, launchSymbol, preIpoCompanies } from "@/lib/dbc";
import { clientIp, rateLimiter } from "@/lib/evm-server";
import { PUBLIC_SITE } from "@/lib/launch";
import { fetchBasketAt } from "@/lib/sheaf";
import { resolveLaunch } from "./anchor";

/** 60 reads a minute per IP: a cold read fans out to the chain, two price APIs and the NAV history. */
const perIp = rateLimiter(60_000, 60);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const METHOD =
  "openedAt is the pool's activation_point; navSolAtOpen is the curve's opening market cap / 0.5; solUsdAtOpen is SOL's price in that hour (Coinbase candles, else Kraken); navUsdAtClose is navProof's navPerShare.listed. The anchor is verified when navSolAtOpen x solUsdAtOpen is within 10% of navUsdAtClose.";

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/**
 * Token metadata for a launch token, by basket (`/api/launch/<basket>`, the
 * URI of the first launches) or by basket and slot (`/api/launch/<basket>/<slot>`,
 * every launch since). Both name the official mint in the visible fields, so a
 * mint that borrows the URL is told apart: the per-slot URL answers with the
 * official metadata only when that slot holds the basket's launch, and with
 * "Not an official Sheaf launch" and the reason otherwise.
 *
 * The provenance is derived from the pool's own accounts and independent
 * prices, never from anything the creator wrote: preset, open time, the NAV
 * the curve was anchored to, SOL's price in that hour, the basket's NAV at the
 * last close before the open, and whether they agree (`anchor`).
 * `provenance.refused` lists every pool Sheaf refused at the basket's
 * addresses, with the reason.
 */
export async function launchMetadata(req: Request, address: string, slotParam: string | null): Promise<Response> {
  const url = new URL(req.url);
  if (!BASE58.test(address)) return Response.json({ error: "Not a basket address." }, { status: 400 });
  const slot = slotParam == null ? null : Number(slotParam);
  if (slot != null && !(Number.isInteger(slot) && slot >= 0 && slot < 16)) {
    return Response.json({ error: "Not a launch slot." }, { status: 400 });
  }
  // One URL per launch, so the edge cache always answers: anything after "?" is dropped.
  if (url.search) return Response.redirect(`${url.origin}${url.pathname}`, 308);
  const ip = clientIp(req);
  const limit = perIp.check(ip);
  if (!limit.ok) {
    return Response.json({ error: "Too many requests." }, { status: 429, headers: { "retry-after": String(limit.retryInSec) } });
  }
  perIp.hit(ip);
  const basket = await fetchBasketAt(address).catch(() => null);
  if (!basket) return Response.json({ error: "No basket at that address." }, { status: 404 });

  const page = `${PUBLIC_SITE}/basket/${basket.address}`;
  const preIpo = preIpoCompanies(basket);
  const connection = new Connection(WRITE_RPC, "confirmed");
  const resolved = await resolveLaunch(connection, url.origin, basket).catch(() => null);
  const launch = resolved?.launch ?? null;
  const state = resolved?.state ?? null;
  const anchor = resolved?.anchor ?? null;
  const officialMint = launch?.info.baseMint ?? null;
  // Every pool refused at this basket's addresses, with its reason (and its anchor, when it was checked).
  const refused = (resolved?.unofficial ?? []).map((u) => ({
    slot: u.info.slot ?? 0,
    pool: u.info.pool,
    mint: u.info.baseMint,
    reason: u.check.reason,
    anchor: resolved?.anchors.get(u.info.pool) ?? null,
  }));
  const rejected = refused.filter((r) => r.anchor?.status === "mismatch").map(({ pool, reason, anchor }) => ({ pool, reason, anchor }));
  const checking = resolved?.checking ?? false;
  // While the opening price is still being checked, keep the answer short-lived so the verdict replaces it soon.
  const headers = {
    "cache-control": checking ? "public, s-maxage=60, stale-while-revalidate=60" : "public, s-maxage=300, stale-while-revalidate=86400",
  };

  // A per-slot URL that is not the basket's launch: say so, and point at the real one.
  if (slot != null && (!launch || (launch.info.slot ?? 0) !== slot)) {
    const here = refused.find((r) => r.slot === slot);
    const reason = here?.reason ?? (launch ? "No pool in this slot is the basket's launch." : "This basket has no official launch.");
    return Response.json(
      {
        name: "Not an official Sheaf launch",
        symbol: "NOTSHEAF",
        description:
          `This token is not the launch of ${basket.name}. ${reason}` +
          (officialMint ? ` The basket's official launch token is mint ${officialMint}.` : "") +
          " Sheaf does not list or trade it.",
        external_url: page,
        attributes: [
          { trait_type: "official", value: "no" },
          { trait_type: "reason", value: reason },
          ...(here?.anchor ? [{ trait_type: "anchor", value: here.anchor.status }] : []),
          ...(officialMint ? [{ trait_type: "official_mint", value: officialMint }] : []),
        ],
        provenance: { slot, pool: here?.pool ?? null, official: false, reason, anchor: here?.anchor ?? null, officialMint, method: METHOD },
      },
      { headers },
    );
  }

  const attributes = [
    ...(officialMint ? [{ trait_type: "official_mint", value: officialMint }] : []),
    ...(launch ? [{ trait_type: "official_pool", value: launch.info.pool }] : []),
    { trait_type: "basket", value: `${basket.name} (${basket.symbol})` },
    ...(state?.preset ? [{ trait_type: "preset", value: PRESET_NAMES[state.preset] }] : []),
    ...(anchor?.openedAt ? [{ trait_type: "opened_at", value: new Date(anchor.openedAt * 1000).toISOString() }] : []),
    ...(anchor ? [{ trait_type: "nav_sol_at_open", value: Number(anchor.navSolAtOpen.toPrecision(6)) }] : []),
    ...(anchor?.solUsdAtOpen ? [{ trait_type: "sol_usd_at_open", value: Number(anchor.solUsdAtOpen.toFixed(2)) }] : []),
    ...(anchor?.navUsdAtClose ? [{ trait_type: "nav_usd_at_last_close", value: Number(anchor.navUsdAtClose.toFixed(2)) }] : []),
    ...(anchor ? [{ trait_type: "anchor", value: anchor.status }] : []),
    ...(checking ? [{ trait_type: "official", value: "checking the opening price" }] : []),
    { trait_type: "redeemable", value: "no" },
    ...(preIpo.length ? [{ trait_type: "pre_ipo_components", value: preIpo.join(", ") }] : []),
  ];

  return Response.json(
    {
      name: launchName(basket.name),
      symbol: launchSymbol(basket.symbol),
      description:
        (officialMint
          ? `Describes mint ${officialMint} (${short(officialMint)}) only. Any other token pointing here is not the launch of ${basket.name}. `
          : "") +
        `Launch token for ${basket.name} (${basket.symbol}), a Sheaf basket of ${basket.components.length} tokenized equities. ` +
        "A separate token on a Meteora bonding curve: not a basket share, not backed by the basket's vault and not redeemable for anything." +
        (preIpo.length
          ? ` The basket holds pre-IPO SPV tokens (${preIpo.join(", ")}), not company shares; in May 2026 Anthropic and OpenAI said transfers of their stock without board approval, tokenized ones included, are void.`
          : ""),
      image: `${page}/opengraph-image`,
      external_url: page,
      attributes,
      provenance:
        launch || refused.length
          ? {
              pool: launch?.info.pool ?? null,
              config: launch?.info.config ?? null,
              mint: officialMint,
              slot: launch ? (launch.info.slot ?? 0) : null,
              preset: state?.preset ? PRESET_NAMES[state.preset] : null,
              anchor,
              // True while the opening price of a listed basket's launch is still unchecked: not official until it answers.
              checking,
              rejected,
              refused,
              method: METHOD,
            }
          : null,
    },
    { headers },
  );
}
