// Tempo-native recurring buy (SIP) into a Sheaf basket, on Tempo testnet.
//
//   node scripts/tempo-sip.mjs
//
// Tempo access keys let an account hand a second key a recurring TIP-20
// spending limit plus a call scope. Here the deployer (the "investor") signs one
// key authorization that lets a fresh P256 keeper key:
//   - spend at most 25 AlphaUSD per 30-day period,
//   - call only AlphaUSD.approve with the Sheaf CreationDesk as spender, and
//     CreationDesk.placeOrder.
// The keeper then places this month's order in one atomic Tempo transaction
// (approve + placeOrder), and the script proves the guard rails hold: an order
// over the remaining budget and a transfer outside the scope are both refused.
// Finally the investor fills the order as the participant, so the buyer ends up
// holding basket shares.
//
// The keeper key is generated in memory and never written anywhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient, http, parseUnits, encodeFunctionData, parseAbi, publicActions } from "viem";
import { tempoModerato } from "viem/chains";
import { Account, Actions, P256 } from "viem/tempo";
import { sendTransactionSync, readContract, writeContractSync } from "viem/actions";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env"), quiet: true });
const d = JSON.parse(fs.readFileSync(path.join(here, "..", "deployments", "tempoTestnet.json"), "utf8"));

const PATH_USD = "0x20c0000000000000000000000000000000000000";
const ALPHA_USD = d.stable.address;
const DESK = d.desk;
const basket = d.baskets[0];
const MONTH = 30 * 86400;

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const deskAbi = parseAbi([
  "function placeOrder(address basket, uint256 shares, uint256 usdgAmount, uint96 expiry) returns (uint256)",
  "function orderCount() view returns (uint256)",
  "function fill(uint256 id) returns (uint256)",
  "function getOrder(uint256 id) view returns ((address buyer, address basket, uint96 expiry, uint256 shares, uint256 usdgAmount, uint8 status, address filler))",
]);
const basketAbi = parseAbi([
  "function previewMint(uint256) view returns (uint256[])",
  "function components() view returns ((address token, uint256 unitsPerShare, uint16 weightBps)[])",
  "function balanceOf(address) view returns (uint256)",
]);

const chain = tempoModerato.extend({ feeToken: PATH_USD });
const investor = Account.fromSecp256k1(process.env.DEPLOYER_PRIVATE_KEY);
const client = createClient({ account: investor, chain, transport: http(d.rpc) }).extend(publicActions);
const keeper = Account.fromP256(P256.randomPrivateKey(), { access: investor });

const ok = (m) => console.log(`  ok  ${m}`);
const fmt = (v) => (Number(v) / 1e6).toFixed(2);

async function expectRevert(label, fn) {
  try {
    await fn();
  } catch (e) {
    ok(`${label} (refused: ${String(e.shortMessage || e.message).split("\n")[0].slice(0, 90)})`);
    return;
  }
  throw new Error(`FAILED: ${label} was not refused`);
}

async function main() {
  console.log(`Tempo SIP demo: investor ${investor.address}, keeper key ${keeper.accessKeyAddress}`);
  console.log(`basket ${basket.symbol} ${basket.address}, desk ${DESK}, cash AlphaUSD`);

  // 1. One signature from the investor: a recurring, scoped budget for the keeper.
  const auth = await Actions.accessKey.authorizeSync(client, {
    accessKey: keeper,
    expiry: Math.floor(Date.now() / 1000) + 365 * 86400,
    limits: [
      { token: ALPHA_USD, limit: parseUnits("25", 6), period: MONTH },
      // Fees are paid in pathUSD; give the keeper a small recurring gas budget.
      { token: PATH_USD, limit: parseUnits("2", 6), period: MONTH },
    ],
    scopes: [
      { address: ALPHA_USD, selector: "approve(address,uint256)", recipients: [DESK] },
      { address: DESK, selector: "placeOrder(address,uint256,uint256,uint96)" },
    ],
  });
  ok(`keeper authorized in tx ${auth.receipt.transactionHash}`);
  const lim0 = await Actions.accessKey.getRemainingLimit(client, { account: investor.address, accessKey: keeper.accessKeyAddress, token: ALPHA_USD });
  ok(`AlphaUSD budget ${fmt(lim0.remaining)} per period, resets at ${lim0.periodEnd ? new Date(Number(lim0.periodEnd) * 1000).toISOString() : "n/a"}`);

  // 2. This month's instalment: approve + placeOrder in one atomic Tempo tx, signed by the keeper.
  const amount = parseUnits("10.10", 6);
  const shares = 10n ** 18n;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const id = await readContract(client, { address: DESK, abi: deskAbi, functionName: "orderCount" });
  const rcpt = await sendTransactionSync(client, {
    account: keeper,
    calls: [
      { to: ALPHA_USD, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [DESK, amount] }) },
      { to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "placeOrder", args: [basket.address, shares, amount, expiry] }) },
    ],
  });
  ok(`keeper placed order ${id} for 1 ${basket.symbol} at 10.10 AlphaUSD in tx ${rcpt.transactionHash}`);
  const lim1 = await Actions.accessKey.getRemainingLimit(client, { account: investor.address, accessKey: keeper.accessKeyAddress, token: ALPHA_USD });
  ok(`AlphaUSD budget left this period: ${fmt(lim1.remaining)}`);

  // 3. Guard rails.
  const big = parseUnits("20", 6);
  await expectRevert("an instalment above the remaining budget", () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [
        { to: ALPHA_USD, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [DESK, big] }) },
        { to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "placeOrder", args: [basket.address, shares, big, expiry] }) },
      ],
    }),
  );
  await expectRevert("a transfer outside the scope", () =>
    sendTransactionSync(client, {
      account: keeper,
      calls: [{ to: ALPHA_USD, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [keeper.accessKeyAddress, 1n] }) }],
    }),
  );

  // 4. The investor fills as the participant, delivering the components in kind.
  const need = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "previewMint", args: [shares] });
  const comps = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "components" });
  // Mirror components come from their public faucet.
  const faucetAbi = parseAbi(["function faucet(uint256)"]);
  const mirrors = new Set(d.tokens.filter((t) => t.isMirror).map((t) => t.address.toLowerCase()));
  await sendTransactionSync(client, {
    calls: comps
      .map((c, i) => [c, i])
      .filter(([c]) => mirrors.has(c.token.toLowerCase()))
      .map(([c, i]) => ({ to: c.token, data: encodeFunctionData({ abi: faucetAbi, functionName: "faucet", args: [need[i]] }) })),
  });
  const before = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "balanceOf", args: [investor.address] });
  await sendTransactionSync(client, {
    calls: [
      ...comps.map((c, i) => ({ to: c.token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [DESK, need[i]] }) })),
      { to: DESK, data: encodeFunctionData({ abi: deskAbi, functionName: "fill", args: [id] }) },
    ],
  });
  const order = await readContract(client, { address: DESK, abi: deskAbi, functionName: "getOrder", args: [id] });
  const after = await readContract(client, { address: basket.address, abi: basketAbi, functionName: "balanceOf", args: [investor.address] });
  if (order.status !== 2) throw new Error("FAILED: order not filled");
  ok(`order ${id} filled; investor's ${basket.symbol} balance +${Number(after - before) / 1e18}`);

  d.sip = {
    at: new Date().toISOString(),
    keeperKey: keeper.accessKeyAddress,
    authorizeTx: auth.receipt.transactionHash,
    instalmentTx: rcpt.transactionHash,
    orderId: Number(id),
    limitPerPeriod: "25 AlphaUSD",
    periodSeconds: MONTH,
  };
  fs.writeFileSync(path.join(here, "..", "deployments", "tempoTestnet.json"), `${JSON.stringify(d, null, 2)}\n`);
  console.log("\nTempo SIP demo passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
