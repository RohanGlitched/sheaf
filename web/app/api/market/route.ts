import { UNIVERSE_MINTS, fetchMarket, withChainMultipliers } from "@/lib/market";
import { lastMintReadFailure, readMints } from "@/lib/mainnet";

/**
 * The market snapshot, proxied server-side.
 *
 * Not fetched from the browser: the upstream rate limits per IP, and visitors
 * behind one NAT share that budget. Proxying lets a single response serve every
 * open tab. Ten seconds of shared cache sits well inside the time a price takes
 * to move meaningfully, and stale-while-revalidate means nobody waits on the
 * upstream.
 *
 * Prices come from Jupiter; the dividend multipliers come from the mint
 * accounts themselves, read in one call through Solami's mainnet RPC. When
 * that read failed or Solami had to be skipped, `chainError` says why and who
 * answered instead (null if nobody did, in which case `chain` is null and the
 * multipliers are Jupiter's copy).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const [market, chain] = await Promise.all([fetchMarket(), readMints(UNIVERSE_MINTS)]);
  const snapshot = withChainMultipliers(market, chain);
  const failure = lastMintReadFailure();
  // Only a failure from this read (or one still in effect) is worth reporting.
  const chainError =
    failure && (chain == null || chain.via === "public") && Date.now() - failure.at < 60_000
      ? { message: failure.message, answeredBy: failure.answeredBy, at: new Date(failure.at).toISOString() }
      : null;
  return Response.json(
    { ...snapshot, chainError },
    {
      headers: {
        // A failed chain read should not be cached as if it were the answer.
        "cache-control": chain ? "public, s-maxage=10, stale-while-revalidate=50" : "public, s-maxage=2",
      },
    },
  );
}
