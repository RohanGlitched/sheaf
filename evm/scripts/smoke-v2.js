// Live smoke test of the v2 desk and the plan desk on a deployed chain. The
// deployer plays buyer, filler, plan owner and (by default) treasury, so the
// checks compare every event field with the fee and auction formulas and every
// balance delta exactly.
//
//   npx hardhat run scripts/smoke-v2.js --network robinhoodTestnet
//
// Steps:
//   1. placeAuction on the first basket: 10.10 dollars, fair 1 share, ±2%,
//      10 minutes, floor 0.98; fill it at once (the count is near the start).
//   2. openPlan: 10.10 a run, daily, ±2% for 10 minutes, bounds 0.95 to 1.10
//      shares; instalment at fair 1 share; fill it.
// Records the hashes under v2.smoke in deployments/<network>.json.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
const BPS = 10_000n;

function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.v2?.desk || !d.v2?.planDesk) throw new Error("run deploy-v2.js first");
  const [me] = await ethers.getSigners();
  const txs = {};
  let gas = 0n;
  let tag = await ethers.provider.getBlockNumber();
  const at = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn({ blockTag: tag });
      } catch (e) {
        if (i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
  const send = async (label, p) => {
    const r = await (await p).wait();
    txs[label] = r.hash;
    gas += r.gasUsed;
    tag = Math.max(tag, r.blockNumber);
    return r;
  };

  const b = d.baskets[0];
  const basket = await ethers.getContractAt("Basket", b.address);
  const desk = await ethers.getContractAt("CreationDeskV2", d.v2.desk);
  const plans = await ethers.getContractAt("PlanDesk", d.v2.planDesk);
  const cash = await ethers.getContractAt(ERC20, d.stable.address);
  const comps = await basket.components();
  const tokens = await Promise.all(comps.map((c) => ethers.getContractAt(ERC20, c.token)));
  const creatorBps = BigInt(await basket.creatorFeeBps());
  const treasury = await desk.treasury();
  console.log(`${d.label}: v2 smoke test on ${b.symbol} ${b.address}, desk ${d.v2.desk}, plans ${d.v2.planDesk}`);

  const ONE = ethers.parseEther("1");
  const cashAmount = (10n ** BigInt(d.stable.decimals) * 101n) / 10n; // 10.10 dollars
  // Components for two fills of up to ~1.03 shares gross each.
  const need = await basket.previewMint((ONE * 21n) / 10n);
  for (let i = 0; i < comps.length; i++) {
    const meta = d.tokens.find((t) => t.address.toLowerCase() === comps[i].token.toLowerCase());
    const have = await at((o) => tokens[i].balanceOf(me.address, o));
    if (have >= need[i]) continue;
    if (!meta.isMirror) throw new Error(`deployer holds too little ${meta.symbol}`);
    const mirror = await ethers.getContractAt("MockStock", comps[i].token);
    await send(`faucet_${meta.symbol}`, mirror.faucet(need[i] - have));
  }
  if (d.stable.isMirror) {
    const dollar = await ethers.getContractAt("MockDollar", d.stable.address);
    await send("faucet_dollar", dollar.faucet(100n * 10n ** 6n));
  }
  for (let i = 0; i < tokens.length; i++) await send(`approve_desk_${i}`, tokens[i].approve(d.v2.desk, ethers.MaxUint256));
  await send("approve_cash_desk", cash.approve(d.v2.desk, cashAmount));
  await send("approve_cash_plans", cash.approve(d.v2.planDesk, cashAmount));

  const split = (out) => {
    const gross = (out * BPS + (BPS - creatorBps - 10n) - 1n) / (BPS - creatorBps - 10n);
    const creator = (gross * creatorBps) / BPS;
    const protocol = (gross * 10n) / BPS;
    return { gross, creator, protocol, buyer: gross - creator - protocol };
  };
  const errName = (e) => {
    for (const data of [e.data, e.data?.data, e.error?.data, e.info?.error?.data, e.error?.data?.data]) {
      if (typeof data !== "string" || data.length < 10) continue;
      try {
        const name = plans.interface.parseError(data)?.name;
        if (name) return name;
      } catch {}
    }
    const m = String(e.message).match(/(TooSoon|FairOutOfBounds|NotAllowed|PlanClosedAlready)/);
    return m ? m[1] : e.shortMessage || "reverted";
  };
  const parse = (r, c, name) => r.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);

  async function fillAndCheck(label, id) {
    const o = await at((ov) => desk.getOrder(id, ov));
    const sharesBefore = await at((ov) => basket.balanceOf(me.address, ov));
    const treasuryBefore = await at((ov) => basket.balanceOf(treasury, ov));
    const r = await send(`${label}_fill`, desk.fill(id));
    let block = null;
    for (let i = 0; !block && i < 30; i++) {
      block = await ethers.provider.getBlock(r.blockNumber);
      if (!block) await new Promise((res) => setTimeout(res, 1500));
    }
    const ts = BigInt(block.timestamp);
    const out =
      ts <= o.startTs ? o.startShares : ts >= o.endTs ? o.endShares : o.startShares - ((o.startShares - o.endShares) * (ts - o.startTs)) / (o.endTs - o.startTs);
    const s = split(out);
    const ev = parse(r, desk, "OrderFilled");
    check(ev.args.sharesToBuyer === s.buyer && ev.args.grossShares === s.gross, `${label}: buyer got ${ethers.formatEther(s.buyer)} for an auction count of ${ethers.formatEther(out)} (gross ${ethers.formatEther(s.gross)})`);
    check(ev.args.creatorFeeShares === s.creator && ev.args.protocolFeeShares === s.protocol, `${label}: creator fee ${ethers.formatEther(s.creator)}, protocol fee ${ethers.formatEther(s.protocol)} (0.10%)`);
    check(ev.args.sharesToBuyer >= out, `${label}: the buyer received at least the auction's count`);
    const sharesAfter = await at((ov) => basket.balanceOf(me.address, ov));
    const treasuryAfter = await at((ov) => basket.balanceOf(treasury, ov));
    const creatorIsMe = (await basket.creator()).toLowerCase() === me.address.toLowerCase();
    const treasuryIsMe = treasury.toLowerCase() === me.address.toLowerCase();
    const expectMine = s.buyer + (creatorIsMe ? s.creator : 0n) + (treasuryIsMe ? s.protocol : 0n);
    check(sharesAfter - sharesBefore === expectMine, `${label}: share balance moved by exactly buyer${creatorIsMe ? " + creator" : ""}${treasuryIsMe ? " + treasury" : ""} cuts`);
    if (!treasuryIsMe) check(treasuryAfter - treasuryBefore === s.protocol, `${label}: treasury received the protocol fee`);
    check((await at((ov) => basket.balanceOf(d.v2.desk, ov))) === 0n, `${label}: desk holds no shares`);
    return { out, ...s };
  }

  // 1. A direct auction.
  const deskCashBefore = await at((o) => cash.balanceOf(d.v2.desk, o));
  const placed = await send("placeAuction", desk.placeAuction(b.address, cashAmount, ONE, 200, 600, (ONE * 98n) / 100n));
  const id = parse(placed, desk, "OrderPlaced").args.id;
  const o = await at((ov) => desk.getOrder(id, ov));
  check(o.startShares === (ONE * 10200n) / BPS && o.endShares === (ONE * 9800n) / BPS, "auction: 1.02 down to 0.98 shares over 10 minutes");
  check((await at((ov) => cash.balanceOf(d.v2.desk, ov))) - deskCashBefore === cashAmount, "auction: escrowed 10.10 of the cash token");
  const a = await fillAndCheck("auction", id);

  // 2. A plan and one instalment.
  const opened = await send("openPlan", plans.openPlan(b.address, cashAmount, 86400, 600, 200, (ONE * 95n) / 100n, (ONE * 110n) / 100n, ethers.ZeroAddress));
  const planId = parse(opened, plans, "PlanOpened").args.id;
  const ran = await send("instalment", plans.instalment(planId, ONE));
  const inst = parse(ran, plans, "Instalment");
  check(inst.args.startShares === (ONE * 10200n) / BPS && inst.args.endShares === (ONE * 9800n) / BPS, `plan ${planId}: instalment posted order ${inst.args.orderId}, 1.02 down to 0.98`);
  // A load-balanced RPC can serve a read from a node that has not seen the
  // instalment yet, so ask again until the refusal names the rule.
  const refusal = async (fn, re) => {
    let name = "";
    for (let i = 0; i < 12; i++) {
      try {
        await fn();
        name = "not refused";
      } catch (e) {
        name = errName(e);
      }
      if (re.test(name)) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    return name;
  };
  let refused = await refusal(() => plans.instalment.staticCall(planId, ONE, { blockTag: tag }), /TooSoon/);
  check(/TooSoon/.test(refused), `plan ${planId}: a second instalment the same day is refused (${refused})`);
  refused = await refusal(() => plans.auctionFor(planId, ONE / 2n, { blockTag: tag }), /FairOutOfBounds/);
  check(/FairOutOfBounds/.test(refused), `plan ${planId}: a fair below the owner's cap is refused (${refused})`);
  const p = await fillAndCheck("plan", inst.args.orderId);

  const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
  fresh.v2.smoke = {
    passedAt: new Date().toISOString(),
    basket: b.symbol,
    auctionOrderId: Number(id),
    planId: Number(planId),
    planOrderId: Number(inst.args.orderId),
    auction: { sharesToBuyer: ethers.formatEther(a.buyer), protocolFeeShares: ethers.formatEther(a.protocol) },
    plan: { sharesToBuyer: ethers.formatEther(p.buyer), protocolFeeShares: ethers.formatEther(p.protocol) },
    gasUsed: Number(gas),
    txs,
  };
  fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`\n${d.label}: v2 smoke test passed (gas ${gas})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
