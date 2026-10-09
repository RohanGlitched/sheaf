// Tempo SIP v3: a plan that follows the price, run by a key that cannot rewrite it.
//
//   node scripts/tempo-sip-v3.mjs
//
// PlanDeskV3 bounds each run's fair share count by a trailing window (±10% around
// what the last run filled at) inside the owner's hard bounds (70% to 150% of the
// fair count at signing). The protocol fee of the desk it posts to goes to a separate
// treasury. The run, recorded under v3.sip in deployments/tempoTestnet.json:
//   1. The investor (the deployer's root key) opens plan N: 10.10 AlphaUSD a run,
//      a 2-minute interval (so the recording shows two runs), a ±2% auction for 4
//      minutes, a ±10% step, hard bounds 0.70 to 1.50 MAG8.
//   2. The investor authorizes a fresh P256 keeper key: 25 AlphaUSD and 2 pathUSD
//      per 30 days, scoped to AlphaUSD.approve (spender PlanDeskV3) and
//      PlanDeskV3.instalment only.
//   3. Refused: an instalment at 1 raw share unit (FairOutOfBounds), a direct
//      CreationDeskV2.placeOrder, an openPlan and a recenter by the key (all three
//      CallNotAllowed: outside the scope).
//   4. Run 1 at fair 1 share; the investor fills it as the participant. A second
//      run at once is refused (TooSoon).
//   5. After the interval, run 2 at 5% more shares than run 1 filled at (a price
//      fall): the plan re-centres on run 1's fill (Recentered) and runs; filled.
// The keeper key lives only in memory.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient, http, parseUnits, encodeFunctionData, parseAbi, parseEventLogs, publicActions } from "viem";
import { tempoModerato } from "viem/chains";
import { Account, Actions, P256 } from "viem/tempo";
import { sendTransactionSync, readContract } from "viem/actions";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env"), quiet: true });
const file = path.join(here, "..", "deployments", "tempoTestnet.json");
const d = JSON.parse(fs.readFileSync(file, "utf8"));

const PATH_USD = "0x20c0000000000000000000000000000000000000";
const ALPHA_USD = d.stable.address;
const DESK = d.v3.desk;
const PLANS = d.v3.planDesk;
const basket = d.baskets[0];
const MONTH = 30 * 86400;
const INTERVAL = 120n;
const ONE = 10n ** 18n;
const BPS = 10_000n;

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
const planAbi = parseAbi([
  "function openPlan(address basket, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint16 stepBps, uint256 refShares, uint256 hardMin, uint256 hardMax, address keeper) returns (uint256)",
  "function recenter(uint256 id, uint256 refShares, uint256 hardMin, uint256 hardMax)",
  "function instalment(uint256 id, uint256 fairShares) returns (uint256)",
  "function nextRunAt(uint256 id) view returns (uint256)",
  "function windowOf(uint256 id) view returns (uint256 refShares, uint256 low, uint256 high)",
  "event PlanOpened(uint256 indexed id, address indexed owner, address indexed basket, address keeper, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint16 stepBps, uint256 refShares, uint256 hardMin, uint256 hardMax)",
  "event Recentered(uint256 indexed id, uint256 refShares, uint256 hardMin, uint256 hardMax, bool byOwner)",
  "event Instalment(uint256 indexed id, uint256 indexed orderId, address indexed caller, uint256 fairShares, uint256 startShares, uint256 endShares, uint32 run)",
  "error FairOutOfBounds(uint256 fairShares, uint256 low, uint256 high)",
  "error TooSoon(uint256 nextRunAt)",
  "error NotAllowed()",
]);
const deskAbi = parseAbi([
  "function placeOrder(address basket, uint256 cashAmount, uint256 startShares, uint256 endShares, uint64 startTs, uint64 endTs) returns (uint256)",
  "function fill(uint256 id) returns (uint256)",
  "function quoteFill(uint256 id) view returns (uint256 sharesOut, uint256 grossShares, uint256[] amounts)",
  "event OrderFilled(uint256 indexed id, address indexed filler, uint256 sharesToBuyer, uint256 grossShares, uint256 creatorFeeShares, uint256 protocolFeeShares, uint256 cashPaid)",
]);
const basketAbi = parseAbi(["function components() view returns ((address token, uint256 unitsPerShare, uint16 weightBps)[])"]);
const faucetAbi = parseAbi(["function faucet(uint256)"]);

const chain = tempoModerato.extend({ feeToken: PATH_USD });
const investor = Account.fromSecp256k1(process.env.DEPLOYER_PRIVATE_KEY);
const client = createClient({ account: investor, chain, transport: http(d.rpc) }).extend(publicActions);
const keeper = Account.fromP256(P256.randomPrivateKey(), { access: investor });

const ok = (m) => console.log(`  ok  ${m}`);
const sh = (v) => (Number(v) / 1e18).toFixed(4);
const refusals = {};

/// The contract's own reason for a revert: the same call simulated from the investor's address.
async function contractReason(args) {
  try {
    await client.simulateContract({ account: investor.address, address: PLANS, abi: planAbi, functionName: "instalment", args });
  } catch (e) {
    const named = e.walk?.((x) => x?.data?.errorName)?.data?.errorName;
    if (named) return named;
  }
  return null;
}

async function expectRefused(key, label, re, fn, simulate) {
  try {
    await fn();
  } catch (e) {
    const text = `${e.details ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`;
    let reason = simulate ? await contractReason(simulate) : null;
    if (!reason) reason = text.match(re)?.[1];
    if (!reason || !re.test(reason)) throw new Error(`FAILED: ${label} was refused, but not for the expected reason: ${reason ?? text.slice(0, 300)}`);
    refusals[key] = reason;
    ok(`${label} (refused: ${reason})`);
    return;
  }
  throw new Error(`FAILED: ${label} was not refused`);
}

async function fillAsInvestor(orderId) {
  const [, , need] = await readContract(client, { address: DESK, abi: deskAbi, functionName: "quoteFill", args: [orderId] });
  const comps = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "components" });
  await sendTransactionSync(client, {
    calls: comps.map((c, i) => ({ to: c.token, data: encodeFunctionData({ abi: faucetAbi, functionName: "faucet", args: [need[i] * 2n] }) })),
  });
  const filled = await sendTransactionSync(client, {
    calls: [
      ...comps.map((c, i) => ({ to: c.token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [DESK, need[i] * 2n] }) })),
      { to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "fill", args: [orderId] }) },
    ],
  });
  const f = parseEventLogs({ abi: deskAbi, logs: filled.logs, eventName: "OrderFilled" })[0].args;
  return { tx: filled.transactionHash, shares: f.sharesToBuyer, protocolFee: f.protocolFeeShares };
}

async function main() {
  const cash = parseUnits("10.10", 6);
  const hardMin = (ONE * 70n) / 100n;
  const hardMax = (ONE * 150n) / 100n;
  console.log(`Tempo SIP v3: investor ${investor.address}, keeper key ${keeper.accessKeyAddress}`);
  console.log(`basket ${basket.symbol} ${basket.address}, plan desk ${PLANS}, desk ${DESK} (treasury ${d.v3.treasury})`);

  // 1. The investor writes the plan with the root key.
  const opened = await sendTransactionSync(client, {
    calls: [
      {
        to: PLANS,
        data: encodeFunctionData({
          abi: planAbi,
          functionName: "openPlan",
          args: [basket.address, cash, INTERVAL, 240n, 200, 1000, ONE, hardMin, hardMax, "0x0000000000000000000000000000000000000000"],
        }),
      },
    ],
  });
  const planId = parseEventLogs({ abi: planAbi, logs: opened.logs, eventName: "PlanOpened" })[0].args.id;
  ok(`plan ${planId} opened: 10.10 AlphaUSD a run, ±10% around the last fill, never outside 0.70 to 1.50 ${basket.symbol} (tx ${opened.transactionHash})`);

  // 2. One key authorization: a recurring budget, two calls only.
  const auth = await Actions.accessKey.authorizeSync(client, {
    accessKey: keeper,
    expiry: Math.floor(Date.now() / 1000) + 365 * 86400,
    limits: [
      { token: ALPHA_USD, limit: parseUnits("25", 6), period: MONTH },
      { token: PATH_USD, limit: parseUnits("2", 6), period: MONTH },
    ],
    scopes: [
      { address: ALPHA_USD, selector: "approve(address,uint256)", recipients: [PLANS] },
      { address: PLANS, selector: "instalment(uint256,uint256)" },
    ],
  });
  ok(`keeper authorized in tx ${auth.receipt.transactionHash}`);

  // 3. What a keeper must not be able to do.
  const approve = { to: ALPHA_USD, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [PLANS, cash] }) };
  const run = (fair) => ({ to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "instalment", args: [planId, fair] }) });
  await expectRefused("dustFair", "keeper runs the instalment at 1 raw share unit for 10.10 AlphaUSD", /(FairOutOfBounds)/, () => sendTransactionSync(client, { account: keeper, calls: [approve, run(1n)] }), [planId, 1n]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await expectRefused("directOrder", "keeper calls CreationDeskV2.placeOrder at its own price", /(CallNotAllowed|[A-Z][A-Za-z]+NotAllowed)/, () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [{ to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "placeOrder", args: [basket.address, cash, 1n, 1n, now, now + 600n] }) }],
    }),
  );
  await expectRefused("rewriteTerms", "keeper opens a plan with its own terms", /(CallNotAllowed|[A-Z][A-Za-z]+NotAllowed)/, () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [{ to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "openPlan", args: [basket.address, cash, 1n, 600n, 0, 0, 1n, 1n, 1n, keeper.accessKeyAddress] }) }],
    }),
  );
  await expectRefused("recenterByKey", "keeper re-centres the plan to a floor of 1 raw unit", /(CallNotAllowed|[A-Z][A-Za-z]+NotAllowed)/, () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [{ to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "recenter", args: [planId, 1n, 1n, ONE] }) }],
    }),
  );

  // 4. Run 1, filled; a second run at once is refused.
  const ran1 = await sendTransactionSync(client, { account: keeper, calls: [approve, run(ONE)] });
  const inst1 = parseEventLogs({ abi: planAbi, logs: ran1.logs, eventName: "Instalment" })[0].args;
  ok(`run 1: order ${inst1.orderId}, ${sh(inst1.startShares)} down to ${sh(inst1.endShares)} ${basket.symbol} (tx ${ran1.transactionHash})`);
  const fill1 = await fillAsInvestor(inst1.orderId);
  ok(`run 1 filled: ${sh(fill1.shares)} ${basket.symbol} to the investor, ${sh(fill1.protocolFee)} to the separate treasury key`);
  await expectRefused("tooSoon", "keeper runs a second instalment at once", /(TooSoon)/, () => sendTransactionSync(client, { account: keeper, calls: [approve, run(ONE)] }), [planId, ONE]);

  // 5. After the interval: run 2 at 5% above run 1's fill. The window has trailed to it.
  const [ref, low, high] = await readContract(client, { address: PLANS, abi: planAbi, functionName: "windowOf", args: [planId] });
  ok(`window now ${sh(low)} to ${sh(high)} around run 1's fill ${sh(ref)}`);
  const due = Number(await readContract(client, { address: PLANS, abi: planAbi, functionName: "nextRunAt", args: [planId] }));
  for (;;) {
    const head = await client.getBlock();
    if (Number(head.timestamp) >= due + 2) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const fair2 = (fill1.shares * 10500n) / BPS;
  const ran2 = await sendTransactionSync(client, { account: keeper, calls: [approve, run(fair2)] });
  const rec = parseEventLogs({ abi: planAbi, logs: ran2.logs, eventName: "Recentered" })[0]?.args;
  const inst2 = parseEventLogs({ abi: planAbi, logs: ran2.logs, eventName: "Instalment" })[0].args;
  if (!rec || rec.refShares !== fill1.shares || rec.byOwner) throw new Error("FAILED: run 2 did not re-centre on run 1's fill");
  ok(`run 2: re-centred on ${sh(rec.refShares)}, order ${inst2.orderId} at fair ${sh(fair2)} (tx ${ran2.transactionHash})`);
  const fill2 = await fillAsInvestor(inst2.orderId);
  ok(`run 2 filled: ${sh(fill2.shares)} ${basket.symbol}`);
  const lim = await Actions.accessKey.getRemainingLimit(client, { account: investor.address, accessKey: keeper.accessKeyAddress, token: ALPHA_USD });
  ok(`AlphaUSD budget left this period: ${(Number(lim.remaining) / 1e6).toFixed(2)}`);

  const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
  fresh.v3.sip = {
    at: new Date().toISOString(),
    keeperKey: keeper.accessKeyAddress,
    planId: Number(planId),
    openPlanTx: opened.transactionHash,
    authorizeTx: auth.receipt.transactionHash,
    instalmentTxs: [ran1.transactionHash, ran2.transactionHash],
    fillTxs: [fill1.tx, fill2.tx],
    orderIds: [Number(inst1.orderId), Number(inst2.orderId)],
    cashPerRun: "10.10 AlphaUSD",
    hardMinShares: "0.70",
    hardMaxShares: "1.50",
    stepPct: 10,
    intervalSeconds: Number(INTERVAL),
    run2Fair: sh(fair2),
    recenteredOn: sh(rec.refShares),
    sharesToInvestor: [sh(fill1.shares), sh(fill2.shares)],
    limitPerPeriod: "25 AlphaUSD",
    periodSeconds: MONTH,
    scopes: ["AlphaUSD.approve(spender = PlanDeskV3)", "PlanDeskV3.instalment(uint256,uint256)"],
    refused: refusals,
  };
  fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log("\nTempo SIP v3 demo passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
