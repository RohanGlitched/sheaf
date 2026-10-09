// Tempo SIP v2: the access key can run the plan, never rewrite it.
//
//   node scripts/tempo-sip-v2.mjs
//
// In v1 the keeper's access key was scoped to CreationDesk.placeOrder, so the
// key chose the share count and the price of every instalment. Here:
//   1. The investor (the deployer's root key) opens a plan on PlanDesk: 10.10
//      AlphaUSD a run, every 30 days, a ±2% auction for an hour, and a price cap
//      of at least 0.97 MAG8 per run (fair bounded to 0.97..1.05 shares).
//   2. The investor authorizes a fresh P256 keeper key: 25 AlphaUSD and 2
//      pathUSD per 30 days, scoped to AlphaUSD.approve (spender PlanDesk only)
//      and PlanDesk.instalment only.
//   3. The keeper tries the attacks the v1 scope allowed, and the chain refuses
//      each: an instalment at 1 raw share unit (FairOutOfBounds, the plan's
//      price cap), a direct CreationDeskV2.placeOrder at its own price and a
//      PlanDesk.openPlan with its own terms (both CallNotAllowed, the scope).
//   4. The keeper runs this month's instalment: approve + instalment in one
//      atomic Tempo transaction. A second one at once is refused (TooSoon).
//   5. The investor fills the auction as the participant; the shares, net of
//      the creator fee and the 0.10% protocol fee, land with the investor.
// Writes the hashes under v2.sip in deployments/tempoTestnet.json. The keeper
// key lives only in memory.
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
const DESK = d.v2.desk;
const PLANS = d.v2.planDesk;
const basket = d.baskets[0];
const MONTH = 30 * 86400;
const ONE = 10n ** 18n;

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const planAbi = parseAbi([
  "function openPlan(address basket, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint256 minShares, uint256 maxShares, address keeper) returns (uint256)",
  "function instalment(uint256 id, uint256 fairShares) returns (uint256)",
  "event PlanOpened(uint256 indexed id, address indexed owner, address indexed basket, address keeper, uint256 cashPerRun, uint64 interval, uint64 auctionSecs, uint16 bandBps, uint256 minShares, uint256 maxShares)",
  "event Instalment(uint256 indexed id, uint256 indexed orderId, address indexed caller, uint256 fairShares, uint256 startShares, uint256 endShares, uint32 run)",
  "error FairOutOfBounds(uint256 fairShares, uint256 minShares, uint256 maxShares)",
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

const chain = tempoModerato.extend({ feeToken: PATH_USD });
const investor = Account.fromSecp256k1(process.env.DEPLOYER_PRIVATE_KEY);
const client = createClient({ account: investor, chain, transport: http(d.rpc) }).extend(publicActions);
const keeper = Account.fromP256(P256.randomPrivateKey(), { access: investor });

const ok = (m) => console.log(`  ok  ${m}`);
const fmt = (v) => (Number(v) / 1e6).toFixed(2);
const refusals = {};

/// The contract's own reason for a revert: the same call simulated from the
/// investor's address, which is the msg.sender an access key signs as.
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
    ok(`${label} (refused: ${refusals[key]})`);
    return;
  }
  throw new Error(`FAILED: ${label} was not refused`);
}

async function main() {
  const cash = parseUnits("10.10", 6);
  const minShares = (ONE * 97n) / 100n;
  const maxShares = (ONE * 105n) / 100n;
  console.log(`Tempo SIP v2: investor ${investor.address}, keeper key ${keeper.accessKeyAddress}`);
  console.log(`basket ${basket.symbol} ${basket.address}, plan desk ${PLANS}, desk ${DESK}`);

  // 1. The investor writes the plan with the root key.
  const opened = await sendTransactionSync(client, {
    calls: [
      {
        to: PLANS,
        data: encodeFunctionData({
          abi: planAbi,
          functionName: "openPlan",
          args: [basket.address, cash, BigInt(MONTH), 3600n, 200, minShares, maxShares, "0x0000000000000000000000000000000000000000"],
        }),
      },
    ],
  });
  const planId = parseEventLogs({ abi: planAbi, logs: opened.logs, eventName: "PlanOpened" })[0].args.id;
  ok(`plan ${planId} opened: 10.10 AlphaUSD every 30 days, never fewer than 0.97 ${basket.symbol} a run (tx ${opened.transactionHash})`);

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

  // 3. What the v1 scope let a keeper do, refused.
  const approve = { to: ALPHA_USD, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [PLANS, cash] }) };
  await expectRefused("dustFair", "keeper runs the instalment at 1 raw share unit for 10.10 AlphaUSD", /(FairOutOfBounds)/, () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [approve, { to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "instalment", args: [planId, 1n] }) }],
    }),
    [planId, 1n],
  );
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
      calls: [
        {
          to: PLANS,
          data: encodeFunctionData({ abi: planAbi, functionName: "openPlan", args: [basket.address, cash, 1n, 600n, 0, 1n, 1n, keeper.accessKeyAddress] }),
        },
      ],
    }),
  );

  // 4. This month's instalment, inside the owner's bounds.
  const ran = await sendTransactionSync(client, {
    account: keeper,
    calls: [approve, { to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "instalment", args: [planId, ONE] }) }],
  });
  const inst = parseEventLogs({ abi: planAbi, logs: ran.logs, eventName: "Instalment" })[0].args;
  ok(`keeper ran instalment 1: order ${inst.orderId}, ${Number(inst.startShares) / 1e18} down to ${Number(inst.endShares) / 1e18} ${basket.symbol} (tx ${ran.transactionHash})`);
  const lim = await Actions.accessKey.getRemainingLimit(client, { account: investor.address, accessKey: keeper.accessKeyAddress, token: ALPHA_USD });
  ok(`AlphaUSD budget left this period: ${fmt(lim.remaining)}`);
  await expectRefused("tooSoon", "keeper runs a second instalment at once", /(TooSoon)/, () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [approve, { to: PLANS, data: encodeFunctionData({ abi: planAbi, functionName: "instalment", args: [planId, ONE] }) }],
    }),
    [planId, ONE],
  );

  // 5. The investor fills as the participant.
  const [, , need] = await readContract(client, { address: DESK, abi: deskAbi, functionName: "quoteFill", args: [inst.orderId] });
  const comps = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "components" });
  const faucetAbi = parseAbi(["function faucet(uint256)"]);
  await sendTransactionSync(client, {
    calls: comps.map((c, i) => ({ to: c.token, data: encodeFunctionData({ abi: faucetAbi, functionName: "faucet", args: [need[i] * 2n] }) })),
  });
  const filled = await sendTransactionSync(client, {
    calls: [
      ...comps.map((c, i) => ({ to: c.token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [DESK, need[i] * 2n] }) })),
      { to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "fill", args: [inst.orderId] }) },
    ],
  });
  const f = parseEventLogs({ abi: deskAbi, logs: filled.logs, eventName: "OrderFilled" })[0].args;
  if (f.sharesToBuyer < minShares) throw new Error("FAILED: the investor got fewer shares than the cap");
  ok(`order ${inst.orderId} filled: investor got ${Number(f.sharesToBuyer) / 1e18} ${basket.symbol}, protocol fee ${Number(f.protocolFeeShares) / 1e18}, creator fee ${Number(f.creatorFeeShares) / 1e18}`);

  const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
  fresh.v2.sip = {
    at: new Date().toISOString(),
    keeperKey: keeper.accessKeyAddress,
    planId: Number(planId),
    openPlanTx: opened.transactionHash,
    authorizeTx: auth.receipt.transactionHash,
    instalmentTx: ran.transactionHash,
    fillTx: filled.transactionHash,
    orderId: Number(inst.orderId),
    cashPerRun: "10.10 AlphaUSD",
    minSharesPerRun: "0.97",
    maxSharesPerRun: "1.05",
    sharesToInvestor: (Number(f.sharesToBuyer) / 1e18).toString(),
    limitPerPeriod: "25 AlphaUSD",
    periodSeconds: MONTH,
    scopes: ["AlphaUSD.approve(spender = PlanDesk)", "PlanDesk.instalment(uint256,uint256)"],
    refused: refusals,
  };
  fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log("\nTempo SIP v2 demo passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
