import { isAddress, type Address } from "viem";
import { DEPLOYED } from "@/lib/chains";
import {
  clientIp,
  deploymentFor,
  houseAccount,
  rateLimiter,
  runEvmKeeper,
  runSipSchedule,
  runTempoSip,
  SIP_ACTIONS,
  SipRefused,
  tempoSipTerms,
  type FillResult,
  type SipAction,
} from "@/lib/evm-server";
import { originAllowed } from "@/lib/server-origin";
import { beat } from "@/lib/server-heartbeat";
import { rememberOidc } from "@/lib/gcs-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET or POST /api/evm-keeper[?network=…&order=…&version=2]
 *
 * The house filler on the EVM creation desks. Open to anyone, because filling an
 * open order is permissionless on chain: the buyer gets shares minted in kind and
 * the filler collects the escrowed dollars.
 *
 *  - Mirror chains (Tempo, Ethereum, Arbitrum, Base): the house mints the labeled
 *    mirrors it is missing from their public faucet, then fills. On Tempo that is
 *    one transaction, every call batched, fees in pathUSD.
 *  - Robinhood Chain: the components are Robinhood's real test stock tokens. The
 *    house fills only small orders, and only while it holds enough of each token;
 *    otherwise the order stays open for any other holder to fill, and the response
 *    says why.
 *  - v2 desk (CreationDeskV2, a Dutch auction): the house fills once the auction's
 *    count reaches fair value plus 0.15%, waiting up to 30 s for it; past that the
 *    response says when (retryInSec). v1 orders still open are filled as before, at
 *    their fixed price if it is within 2% (Robinhood) or 5% (mirrors) of fair.
 *    A named order takes `version` (1 by default, the v1 desk).
 *
 * With no network it sweeps every deployed chain (for a cron), and places each
 * Tempo SIP's instalment once its period comes round. Sepolia is left out of
 * sweeps because the house has almost no Sepolia gas.
 *
 * Automatic calls (the cron's sweep, a chain page's kick with only a network) have
 * their own limit and a 4 s throttle per target that answers 200, so a visitor's
 * own fills and SIP steps never wait behind them.
 */

/** A visitor's own actions: filling a named order, or a SIP step. */
const perIp = rateLimiter(60_000, 12);
/** Automatic calls from pages and schedulers, which the per-target throttle already spaces out. */
const perIpAuto = rateLimiter(60_000, 40);
const lastSweep = new Map<string, number>();
const sweeping = new Set<string>();

const fail = (err: unknown) => ((err as Error).message ?? "error").split("\n")[0].slice(0, 200);
const noStore = { headers: { "cache-control": "no-store" } };

async function handle(request: Request) {
  rememberOidc(request);
  if (!houseAccount()) {
    return Response.json({ error: "The keeper is not configured here. Set EVM_FAUCET_PRIVATE_KEY on the server." }, { status: 503 });
  }
  const url = new URL(request.url);
  let network = url.searchParams.get("network") ?? undefined;
  let orderParam = url.searchParams.get("order");
  let versionParam = url.searchParams.get("version");
  let sip: { account?: string; action?: string } | undefined;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as {
        network?: string;
        order?: number | string;
        version?: number | string;
        sip?: { account?: string; action?: string };
      };
      network = body.network ?? network;
      if (body.order != null) orderParam = String(body.order);
      if (body.version != null) versionParam = String(body.version);
      sip = body.sip;
    } catch {
      // An empty POST is a sweep.
    }
  }
  const orderId = orderParam != null && orderParam !== "" && Number.isInteger(Number(orderParam)) ? Number(orderParam) : undefined;
  if (orderParam != null && orderParam !== "" && orderId == null) return Response.json({ error: "order must be an order id." }, { status: 400 });
  if (versionParam != null && versionParam !== "1" && versionParam !== "2") return Response.json({ error: "version must be 1 or 2." }, { status: 400 });
  const version = versionParam === "2" ? 2 : versionParam === "1" ? 1 : undefined;
  const auto = !sip && orderId == null;

  const ip = clientIp(request);
  const limiter = auto ? perIpAuto : perIp;
  const limit = limiter.check(ip);
  if (!limit.ok) return Response.json({ error: `Slow down; try again in ${limit.retryInSec}s.` }, { status: 429 });
  limiter.hit(ip);

  // Tempo SIP: act as the access key a visitor's account authorized. The plan contract fixes the amount, the
  // interval and the worst price; the chain fixes the budget and the scope. The keeper supplies today's fair
  // count and only takes the request from this site's pages. `terms` is a read: what a new plan would sign.
  if (sip) {
    if (!originAllowed(request)) return Response.json({ error: "SIP runs are started from this site." }, { status: 403 });
    if (network !== "tempoTestnet") return Response.json({ error: "SIPs run on Tempo." }, { status: 400 });
    if (sip.action === "terms") {
      try {
        return Response.json(await tempoSipTerms(), noStore);
      } catch (err) {
        return Response.json({ error: fail(err) }, { status: err instanceof SipRefused ? 429 : 500 });
      }
    }
    if (!sip.account || !isAddress(sip.account)) return Response.json({ error: "sip.account must be an address." }, { status: 400 });
    const action = sip.action as SipAction;
    if (!SIP_ACTIONS.includes(action)) return Response.json({ error: "Unknown SIP action." }, { status: 400 });
    try {
      return Response.json(await runTempoSip(sip.account as Address, action), noStore);
    } catch (err) {
      return Response.json({ error: fail(err) }, { status: err instanceof SipRefused ? 429 : 500 });
    }
  }

  const targets = network
    ? [deploymentFor(network)].filter((d) => d != null)
    : DEPLOYED.map((c) => c.deployment!).filter((d) => d.network !== "sepolia");
  if (network && targets.length === 0) return Response.json({ error: "Unknown network." }, { status: 400 });

  // An automatic sweep, of everything or of one chain, runs one at a time per
  // target and at most every few seconds; a repeat is answered, not failed.
  const target = network ?? "*";
  if (auto) {
    if (sweeping.has(target)) return Response.json({ busy: true }, noStore);
    if (Date.now() - (lastSweep.get(target) ?? 0) < 4_000) return Response.json({ throttled: true }, noStore);
    lastSweep.set(target, Date.now());
    sweeping.add(target);
  }

  const results: FillResult[] = [];
  const errors: { network: string; error: string }[] = [];
  let sips: Awaited<ReturnType<typeof runSipSchedule>> | undefined;
  try {
    await Promise.all([
      ...targets.map(async (d) => {
        try {
          results.push(...(await runEvmKeeper(d, { orderId, version, max: orderId != null ? 1 : 3 })));
        } catch (err) {
          errors.push({ network: d.network, error: fail(err) });
        }
      }),
      // The schedule half of a SIP: only on the full sweep, which the cron makes.
      !network
        ? runSipSchedule()
            .then((r) => void (sips = r))
            .catch((err) => void errors.push({ network: "tempoTestnet", error: `SIP schedule: ${fail(err)}` }))
        : Promise.resolve(),
    ]);
  } finally {
    if (auto) sweeping.delete(target);
  }
  if (!network) await beat("evmKeeper", { results: results.length, filled: results.filter((r) => r.status === "filled").length });
  return Response.json({ results, errors, ...(sips ? { sips } : {}) }, noStore);
}

export const GET = handle;
export const POST = handle;
