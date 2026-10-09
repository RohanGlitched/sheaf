import { isAddress, parseUnits, type Address, type Hex } from "viem";
import { ERC20_ABI, ONE_SHARE, mintAmounts, publicClientFor, isTempo, fromRaw } from "@/lib/evm";
import { clientIp, deploymentFor, dripGas, houseAccount, rateLimiter, walletFor, withChainLock } from "@/lib/evm-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/evm-faucet { network, address, basket? }
 *
 * What a visitor needs to try a chain, in one request:
 *  - Robinhood Chain: Robinhood's stock tokens cannot be minted by anyone but
 *    Robinhood, so the house sends a small slice of its own (enough for a quarter
 *    of a share of the chosen basket) plus a few USDG and a gas drip.
 *  - Arbitrum and Base: a gas drip only. The stock and dollar mirrors have a
 *    public faucet, which the visitor calls from their own wallet.
 *  - Tempo: the public Tempo faucet (pathUSD for fees, AlphaUSD for orders). No key.
 *  - Ethereum Sepolia: nothing. The house is nearly out of Sepolia ETH.
 *
 * Limited per address and per IP. Amounts are tiny on purpose.
 */

const perAddress = rateLimiter(6 * 60 * 60_000, 1);
const perIp = rateLimiter(60 * 60_000, 6);
/** Robinhood test stock tokens are finite; cap what one instance hands out per day. */
const realDaily = rateLimiter(24 * 60 * 60_000, 40);

const REAL_SHARE_SLICE = ONE_SHARE / 4n;
const REAL_CASH = "3";

type Tx = { label: string; hash: Hex };

export async function POST(request: Request) {
  let body: { network?: string; address?: string; basket?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON: { network, address }." }, { status: 400 });
  }
  const d = body.network ? deploymentFor(body.network) : undefined;
  if (!d) return Response.json({ error: "Unknown network." }, { status: 400 });
  if (!body.address || !isAddress(body.address)) return Response.json({ error: "That is not an EVM address." }, { status: 400 });
  const to = body.address as Address;

  const ip = clientIp(request);
  const addrKey = `${d.network}:${to.toLowerCase()}`;
  const a = perAddress.check(addrKey);
  if (!a.ok) {
    return Response.json(
      { error: `This address already claimed on ${d.label}. Try again in ${Math.ceil(a.retryInSec / 60)} minutes.` },
      { status: 429 },
    );
  }
  const i = perIp.check(ip);
  if (!i.ok) return Response.json({ error: `Too many claims from here. Try again in ${Math.ceil(i.retryInSec / 60)} minutes.` }, { status: 429 });
  // Claim the slots before the first await, so parallel requests cannot all pass
  // the checks above; give them back if nothing is sent.
  perAddress.hit(addrKey);
  perIp.hit(ip);
  const release = () => {
    perAddress.undo(addrKey);
    perIp.undo(ip);
  };

  // Tempo: the chain's own faucet, keyless.
  if (isTempo(d)) {
    try {
      const res = await fetch(d.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tempo_fundAddress", params: [to] }),
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json()) as { result?: Hex[]; error?: { message: string } };
      if (!json.result) throw new Error(json.error?.message ?? "the Tempo faucet did not answer");
      return Response.json({
        txs: json.result.map((hash, n) => ({ label: `Tempo faucet ${n + 1}`, hash })),
        notes: ["Tempo's faucet sent pathUSD (fees), AlphaUSD (orders) and two more test dollars."],
      });
    } catch (err) {
      release();
      return Response.json({ error: `Tempo faucet: ${(err as Error).message}` }, { status: 502 });
    }
  }

  if (!houseAccount()) {
    release();
    return Response.json({ error: "The faucet is not configured here. Set EVM_FAUCET_PRIVATE_KEY on the server." }, { status: 503 });
  }

  try {
    const result = await withChainLock(d.network, async () => {
      const txs: Tx[] = [];
      const notes: string[] = [];
      const gas = await dripGas(d, to);
      if (gas.hash) txs.push({ label: gas.note, hash: gas.hash });
      else notes.push(gas.note);

      if (d.tokenSource === "real") {
        // Checked and taken inside the chain lock, so queued requests see each other's claims.
        const r = realDaily.check(d.network);
        if (r.ok) realDaily.hit(d.network);
        if (!r.ok) {
          notes.push("Today's share of Robinhood test tokens is spent. Robinhood's own faucet gives 5 of each daily.");
        } else {
          const basket = d.baskets.find((b) => b.symbol.toLowerCase() === (body.basket ?? "").toLowerCase()) ?? d.baskets[0];
          const need = mintAmounts(basket, REAL_SHARE_SLICE);
          const client = publicClientFor(d);
          const house = houseAccount()!.address;
          const wallet = walletFor(d);
          const before = txs.length;
          for (const [n, c] of basket.components.entries()) {
            const held = await client.readContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [house] });
            if (held < need[n] * 4n) {
              notes.push(`The house is low on ${c.symbol}; skipped it.`);
              continue;
            }
            const hash = await wallet.writeContract({ address: c.token as Address, abi: ERC20_ABI, functionName: "transfer", args: [to, need[n]] });
            txs.push({ label: `${fromRaw(need[n]).toFixed(6)} ${c.symbol}`, hash });
          }
          const cash = parseUnits(REAL_CASH, d.stable.decimals);
          const heldCash = await client.readContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [house] });
          if (heldCash >= cash * 4n) {
            const hash = await wallet.writeContract({ address: d.stable.address as Address, abi: ERC20_ABI, functionName: "transfer", args: [to, cash] });
            txs.push({ label: `${REAL_CASH} ${d.stable.symbol}`, hash });
          } else {
            notes.push(`The house is low on ${d.stable.symbol}; skipped it.`);
          }
          if (txs.length === before) realDaily.undo(d.network);
          // Wait for the lot, so the page can read the new balances straight away.
          await Promise.all(txs.map((t) => client.waitForTransactionReceipt({ hash: t.hash, timeout: 60_000 })));
          notes.push(`Enough for a quarter share of ${basket.symbol}. Robinhood's faucet gives 5 of each token a day.`);
        }
      } else if (txs.length) {
        await publicClientFor(d).waitForTransactionReceipt({ hash: txs[0].hash, timeout: 60_000 });
      }
      return { txs, notes };
    });
    if (result.txs.length === 0) release();
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    release();
    return Response.json({ error: ((err as Error).message ?? "faucet failed").split("\n")[0] }, { status: 500 });
  }
}
