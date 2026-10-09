// PlanDeskV3: trailing bounds under the owner's hard floor and ceiling, and the
// owner's recenter. A monthly plan must survive normal price moves, and no run of
// fills, however uncompetitive, may ever take a run below the owner's hard floor.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E18, E6, ONE_SHARE, approveAll, deployV2, sharesAt, v2Split } = require("./helpers");

const CASH = 10n * E6;
const DAY = 86400n;
const AUCTION = 600n;
const BAND = 200; // ±2% auction
const STEP = 1000; // ±10% trailing window
const REF = ONE_SHARE;
const HARD_MIN = (70n * ONE_SHARE) / 100n;
const HARD_MAX = (150n * ONE_SHARE) / 100n;
const FILLED = 2n;
const pct = (x, bps) => (x * BigInt(bps)) / 10_000n;

async function withV3() {
  const f = await deployV2();
  const plans = await (await ethers.getContractFactory("PlanDeskV3")).deploy(f.deskV2);
  await f.usdg.connect(f.alice).approve(plans, ethers.MaxUint256);
  await approveAll(f.stocks, f.ap, f.deskV2);
  await plans.connect(f.alice).openPlan(f.basket, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, ethers.ZeroAddress);
  return { ...f, plans, id: 0n };
}

/// Run an instalment at `fair` and fill its auction at `fraction` (0 = start, 1 = end) of the way through.
async function runAndFill(f, fair, fraction) {
  const { plans, deskV2, alice, ap } = f;
  const tx = await plans.connect(alice).instalment(0, fair);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return plans.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Instalment");
  const orderId = ev.args.orderId;
  const o = await deskV2.getOrder(orderId);
  const ts = o.startTs + BigInt(Math.floor(Number(o.endTs - o.startTs) * fraction));
  await time.setNextBlockTimestamp(ts > BigInt(await time.latest()) ? ts : BigInt(await time.latest()) + 1n);
  await deskV2.connect(ap).fill(orderId);
  return { orderId, order: await deskV2.getOrder(orderId) };
}

describe("PlanDeskV3: opening", () => {
  it("records the terms, emits PlanOpened, and opens with the window at ±step around the owner's reference", async () => {
    const { plans, alice, basket } = await loadFixture(withV3);
    const p = await plans.getPlan(0);
    expect(p.owner).to.equal(alice.address);
    expect(p.refShares).to.equal(REF);
    expect(p.hardMin).to.equal(HARD_MIN);
    expect(p.hardMax).to.equal(HARD_MAX);
    expect(p.stepBps).to.equal(STEP);
    expect(p.bandBps).to.equal(BAND);
    expect(p.active).to.equal(true);
    expect(p.lastOrderPlusOne).to.equal(0n);
    expect(await plans.windowOf(0)).to.deep.equal([REF, pct(REF, 9000), pct(REF, 11000)]);
    await expect(plans.connect(alice).openPlan(basket, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, ethers.ZeroAddress))
      .to.emit(plans, "PlanOpened")
      .withArgs(1n, alice.address, await basket.getAddress(), ethers.ZeroAddress, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX);
    expect(await plans.plansOf(alice)).to.deep.equal([0n, 1n]);
  });

  it("refuses bad terms: unknown basket, zero cash, empty schedule, wide band or step, inverted or zero hard bounds", async () => {
    const { plans, alice, basket, tsla } = await loadFixture(withV3);
    const Z = ethers.ZeroAddress;
    const open = (b, c, i, a, band, step, ref, lo, hi) => plans.connect(alice).openPlan(b, c, i, a, band, step, ref, lo, hi, Z);
    await expect(open(tsla, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "UnknownBasket");
    await expect(open(basket, 0, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "ZeroAmount");
    await expect(open(basket, CASH, 0, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(open(basket, CASH, DAY, 0, BAND, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(open(basket, CASH, DAY, 31n * DAY, BAND, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(open(basket, CASH, DAY, AUCTION, 5001, STEP, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BandTooWide");
    await expect(open(basket, CASH, DAY, AUCTION, BAND, 5001, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "StepTooWide");
    await expect(open(basket, CASH, DAY, AUCTION, BAND, STEP, REF, 0, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(open(basket, CASH, DAY, AUCTION, BAND, STEP, HARD_MIN - 1n, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(open(basket, CASH, DAY, AUCTION, BAND, STEP, HARD_MAX + 1n, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(open(basket, CASH, DAY, AUCTION, BAND, 0, REF, REF, REF)).to.emit(plans, "PlanOpened");
  });
});

describe("PlanDeskV3: the window and the hard bounds", () => {
  it("a fair outside the window is refused with the effective bounds; inside it runs, floored at hardMin", async () => {
    const { plans, deskV2, alice } = await loadFixture(withV3);
    const low = pct(REF, 9000);
    const high = pct(REF, 11000);
    await expect(plans.connect(alice).instalment(0, low - 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds").withArgs(low - 1n, low, high);
    await expect(plans.connect(alice).instalment(0, high + 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds").withArgs(high + 1n, low, high);
    await expect(plans.connect(alice).instalment(0, 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
    await plans.connect(alice).instalment(0, low);
    const o = await deskV2.getOrder(0);
    expect(o.startShares).to.equal(pct(low, 10200));
    expect(o.endShares).to.equal(pct(low, 9800));
    expect(o.endShares).to.be.gte(HARD_MIN);
  });

  it("the hard bounds clip the window: a plan opened at its floor cannot run below it", async () => {
    const { plans, alice, basket } = await loadFixture(withV3);
    await plans.connect(alice).openPlan(basket, CASH, DAY, AUCTION, BAND, STEP, HARD_MIN, HARD_MIN, HARD_MAX, ethers.ZeroAddress);
    expect(await plans.windowOf(1)).to.deep.equal([HARD_MIN, HARD_MIN, pct(HARD_MIN, 11000)]);
    await expect(plans.connect(alice).instalment(1, HARD_MIN - 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
  });
});

describe("PlanDeskV3: trailing the fills", () => {
  it("the next run's window centres on what the last run filled at, and says so (Recentered, byOwner false)", async () => {
    const f = await loadFixture(withV3);
    const { plans, alice, basket } = f;
    const { order } = await runAndFill(f, REF, 0.5);
    expect(order.status).to.equal(FILLED);
    const filled = order.sharesOut;
    expect(await plans.windowOf(0)).to.deep.equal([filled, pct(filled, 9000), pct(filled, 11000)]);
    await time.increase(DAY);
    // 8% above the original reference: outside v2-style fixed bounds of ±5%, inside the trailed window.
    const fair = pct(filled, 10800);
    await expect(plans.connect(alice).instalment(0, fair)).to.emit(plans, "Recentered").withArgs(0n, filled, HARD_MIN, HARD_MAX, false);
    expect((await plans.getPlan(0)).refShares).to.equal(filled);
    void basket;
  });

  it("a monthly plan survives a steady 6%-a-month rise for six months, re-centring on every fill", async () => {
    const f = await loadFixture(withV3);
    const { plans, alice } = f;
    let fair = REF;
    for (let m = 0; m < 6; m++) {
      const { order } = await runAndFill(f, fair, 0.5);
      expect(order.status).to.equal(FILLED);
      await time.increase(DAY);
      // The price rises 6%: the same cash buys 6% fewer shares. A fixed ±5% bound would have stopped at run 2.
      fair = pct(order.sharesOut, 9400);
    }
    expect((await plans.getPlan(0)).runs).to.equal(6n);
    void alice;
  });

  it("a run that never filled leaves the reference where it was", async () => {
    const { plans, deskV2, alice, bob } = await loadFixture(withV3);
    await plans.connect(alice).instalment(0, pct(REF, 10500));
    const o = await deskV2.getOrder(0);
    await time.setNextBlockTimestamp(o.endTs + 1n);
    await deskV2.connect(bob).cancel(0);
    expect(await plans.windowOf(0)).to.deep.equal([REF, pct(REF, 9000), pct(REF, 11000)]);
    await time.increase(DAY);
    await expect(plans.connect(alice).instalment(0, REF)).to.not.emit(plans, "Recentered");
  });

  it("an uncompetitive filler walks the reference down by the band each run, but never below the hard floor", async () => {
    const f = await loadFixture(withV3);
    const { plans } = f;
    const received = [];
    for (let run = 0; run < 24; run++) {
      // The worst a monopolist can do: post fair at the window's low edge and fill at the auction's very end.
      const [, low] = await plans.windowOf(0);
      const { order } = await runAndFill(f, low, 1);
      received.push(order.sharesOut);
      await time.increase(DAY);
    }
    for (const r of received) expect(r).to.be.gte(HARD_MIN);
    const [ref, low] = await plans.windowOf(0);
    // At the floor, give or take the fee rounding of the last fill.
    expect(ref - HARD_MIN).to.be.lte(2n);
    expect(low).to.equal(HARD_MIN);
    // It got there: the last runs bought exactly the floor (plus fee rounding), not less.
    expect(received[received.length - 1] - HARD_MIN).to.be.lte(2n);
  });

  it("a fill above the hard ceiling re-centres at the ceiling", async () => {
    const f = await loadFixture(withV3);
    const { plans, alice, basket } = f;
    await plans.connect(alice).openPlan(basket, CASH, DAY, AUCTION, BAND, STEP, HARD_MAX, HARD_MIN, HARD_MAX, ethers.ZeroAddress);
    await plans.connect(alice).instalment(1, HARD_MAX);
    const o = await f.deskV2.getOrder(0);
    await time.setNextBlockTimestamp(o.startTs + 1n);
    await f.deskV2.connect(f.ap).fill(0);
    expect((await f.deskV2.getOrder(0)).sharesOut).to.be.gt(HARD_MAX);
    const [ref, , high] = await plans.windowOf(1);
    expect(ref).to.equal(HARD_MAX);
    expect(high).to.equal(HARD_MAX);
  });
});

describe("PlanDeskV3: the owner's recenter", () => {
  it("after a move past one step the plan pauses; the owner re-centres and it runs again", async () => {
    const f = await loadFixture(withV3);
    const { plans, alice } = f;
    const { order } = await runAndFill(f, REF, 0.5);
    await time.increase(DAY);
    const jump = pct(order.sharesOut, 8500); // the price rose about 18%
    await expect(plans.connect(alice).instalment(0, jump)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
    await expect(plans.connect(alice).recenter(0, jump, pct(jump, 7000), pct(jump, 15000)))
      .to.emit(plans, "Recentered")
      .withArgs(0n, jump, pct(jump, 7000), pct(jump, 15000), true);
    const p = await plans.getPlan(0);
    expect(p.lastOrderPlusOne).to.equal(0n);
    expect(await plans.windowOf(0)).to.deep.equal([jump, pct(jump, 9000), pct(jump, 11000)]);
    await expect(plans.connect(alice).instalment(0, jump)).to.emit(plans, "Instalment");
  });

  it("only the owner can re-centre, only with sane bounds, and not a closed plan", async () => {
    const { plans, alice, bob, keeper, basket } = await loadFixture(withV3);
    await plans.connect(alice).openPlan(basket, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, keeper.address);
    await expect(plans.connect(bob).recenter(0, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "NotOwner");
    await expect(plans.connect(keeper).recenter(1, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "NotOwner");
    await expect(plans.connect(alice).recenter(0, REF, 0, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(plans.connect(alice).recenter(0, HARD_MAX + 1n, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "BadBounds");
    await plans.connect(alice).closePlan(0);
    await expect(plans.connect(alice).recenter(0, REF, HARD_MIN, HARD_MAX)).to.be.revertedWithCustomError(plans, "PlanClosedAlready");
  });
});

describe("PlanDeskV3: who, when and how much", () => {
  it("pulls exactly cashPerRun, keeps nothing, and refuses a second run inside the interval", async () => {
    const { plans, deskV2, usdg, alice } = await loadFixture(withV3);
    const before = await usdg.balanceOf(alice);
    const t = BigInt(await time.latest()) + 5n;
    await time.setNextBlockTimestamp(t);
    await plans.connect(alice).instalment(0, REF);
    expect(before - (await usdg.balanceOf(alice))).to.equal(CASH);
    expect(await usdg.balanceOf(plans)).to.equal(0n);
    expect(await usdg.allowance(plans, deskV2)).to.equal(0n);
    expect((await deskV2.getOrder(0)).buyer).to.equal(alice.address);
    expect(await plans.nextRunAt(0)).to.equal(t + DAY);
    await expect(plans.connect(alice).instalment(0, REF)).to.be.revertedWithCustomError(plans, "TooSoon").withArgs(t + DAY);
  });

  it("only the owner or its named keeper may run it; a closed plan never runs", async () => {
    const { plans, alice, bob, keeper, basket } = await loadFixture(withV3);
    await plans.connect(alice).openPlan(basket, CASH, DAY, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, keeper.address);
    await expect(plans.connect(bob).instalment(0, REF)).to.be.revertedWithCustomError(plans, "NotAllowed");
    await expect(plans.connect(keeper).instalment(0, REF)).to.be.revertedWithCustomError(plans, "NotAllowed");
    await expect(plans.connect(keeper).instalment(1, REF)).to.emit(plans, "Instalment");
    await expect(plans.connect(keeper).closePlan(1)).to.be.revertedWithCustomError(plans, "NotOwner");
    await plans.connect(alice).closePlan(1);
    await time.increase(DAY);
    await expect(plans.connect(keeper).instalment(1, REF)).to.be.revertedWithCustomError(plans, "PlanClosedAlready");
  });

  it("the buyer gets at least the auction's count, net of both fees, for every run", async () => {
    const f = await loadFixture(withV3);
    const { order } = await runAndFill(f, REF, 0.25);
    const out = sharesAt(order.startShares, order.endShares, order.startTs, order.endTs, order.startTs + (order.endTs - order.startTs) / 4n);
    expect(order.sharesOut).to.be.gte(out - 2n);
    expect(order.sharesOut).to.be.lte(v2Split(out + 2n, 50n).buyer);
  });

  it("a cash token that re-enters instalment, recenter or openPlan mid-pull reverts with ReentrancyGuardReentrantCall", async () => {
    const f = await deployV2();
    const cash = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
    const d2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(cash, f.factory, f.treasury.address);
    const p3 = await (await ethers.getContractFactory("PlanDeskV3")).deploy(d2);
    await cash.mint(f.alice, 1000n * E18);
    await cash.connect(f.alice).approve(p3, ethers.MaxUint256);
    await p3.connect(f.alice).openPlan(f.basket, CASH, 1n, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, ethers.ZeroAddress);
    for (const payload of [
      p3.interface.encodeFunctionData("instalment", [0n, REF]),
      p3.interface.encodeFunctionData("recenter", [0n, REF, HARD_MIN, HARD_MAX]),
      p3.interface.encodeFunctionData("openPlan", [await f.basket.getAddress(), CASH, 1n, AUCTION, BAND, STEP, REF, HARD_MIN, HARD_MAX, ethers.ZeroAddress]),
    ]) {
      await cash.arm(p3, payload);
      await expect(p3.connect(f.alice).instalment(0, REF)).to.be.revertedWithCustomError(p3, "ReentrancyGuardReentrantCall");
    }
    expect((await p3.getPlan(0)).runs).to.equal(0n);
  });

  it("has no admin surface: the only mutators are openPlan, recenter, closePlan and instalment", async () => {
    const { plans } = await loadFixture(withV3);
    const names = plans.interface.fragments.filter((x) => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map((x) => x.name).sort();
    expect(names).to.deep.equal(["closePlan", "instalment", "openPlan", "recenter"]);
    expect(plans.interface.fragments.filter((x) => x.type === "function" && x.payable)).to.have.length(0);
  });
});
