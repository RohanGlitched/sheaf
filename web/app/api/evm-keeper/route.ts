import { isAddress, type Address } from "viem";
import { DEPLOYED } from "@/lib/chains";
import {
  clientIp,
  deploymentFor,
  houseAccount,
  rateLimiter,
  runEvmKeeper,
  runTempoSip,
  type FillResult,
  type SipAction,
} from "@/lib/evm-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET or POST /api/evm-keeper[?network=…&order=…]
 *
 * The house filler on the EVM creation desks. Open to anyone, because filling an
 * open order is permissionless on chain: the buyer gets shares minted in kind and
 * the filler collects the escrowed dollars.
 *
 *  - Mirror chains (Tempo, Ethereum, Arbitrum, Base): the house mints the labeled
 *    mirrors it is missing from their public faucet, then fills. On Tempo that is
 *    one transaction, every call batched, fees in pathUSD.
 *  - Robinhood Chain: the components are Robinhood's real test stock tokens. The
 *    house fills only small orders priced within 2% of the live Robinhood quote,
 *    and only while it holds enough of each token; otherwise the order stays open
 *    for any other holder to fill, and the response says why.
 *
 * With no network it sweeps every deployed chain (for a cron). Sepolia is left out
 * of sweeps because the house has almost no Sepolia gas.
 */

const perIp = rateLimiter(60_000, 12);

async function handle(request: Request) {
  if (!houseAccount()) {
    return Response.json({ error: "The keeper is not configured here. Set EVM_FAUCET_PRIVATE_KEY on the server." }, { status: 503 });
  }
  const ip = clientIp(request);
  const limit = perIp.check(ip);
  if (!limit.ok) return Response.json({ error: `Slow down; try again in ${limit.retryInSec}s.` }, { status: 429 });
  perIp.hit(ip);

  const url = new URL(request.url);
  let network = url.searchParams.get("network") ?? undefined;
  let orderParam = url.searchParams.get("order");
  let sip: { account?: string; action?: string } | undefined;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { network?: string; order?: number | string; sip?: { account?: string; action?: string } };
      network = body.network ?? network;
      if (body.order != null) orderParam = String(body.order);
      sip = body.sip;
    } catch {
      // An empty POST is a sweep.
    }
  }

  // Tempo SIP: act as the access key a visitor's account authorized. The chain enforces the budget and scope.
  if (sip) {
    if (network !== "tempoTestnet") return Response.json({ error: "SIPs run on Tempo." }, { status: 400 });
    if (!sip.account || !isAddress(sip.account)) return Response.json({ error: "sip.account must be an address." }, { status: 400 });
    const action = sip.action as SipAction;
    if (!["instalment", "overspend", "outOfScope"].includes(action)) return Response.json({ error: "Unknown SIP action." }, { status: 400 });
    try {
      return Response.json(await runTempoSip(sip.account as Address, action), { headers: { "cache-control": "no-store" } });
    } catch (err) {
      return Response.json({ error: ((err as Error).message ?? "error").split("\n")[0].slice(0, 200) }, { status: 500 });
    }
  }
  const orderId = orderParam != null && orderParam !== "" && Number.isInteger(Number(orderParam)) ? Number(orderParam) : undefined;

  const targets = network
    ? [deploymentFor(network)].filter((d) => d != null)
    : DEPLOYED.map((c) => c.deployment!).filter((d) => d.network !== "sepolia");
  if (network && targets.length === 0) return Response.json({ error: "Unknown network." }, { status: 400 });

  const results: FillResult[] = [];
  const errors: { network: string; error: string }[] = [];
  await Promise.all(
    targets.map(async (d) => {
      try {
        results.push(...(await runEvmKeeper(d, { orderId, max: orderId != null ? 1 : 3 })));
      } catch (err) {
        errors.push({ network: d.network, error: ((err as Error).message ?? "error").split("\n")[0].slice(0, 200) });
      }
    }),
  );
  return Response.json({ results, errors }, { headers: { "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
