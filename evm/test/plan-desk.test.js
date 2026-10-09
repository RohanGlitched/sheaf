// PlanDesk: recurring buys whose amount, schedule and worst price the owner
// writes on chain, so the key that triggers an instalment (a Tempo access key
// signing as the owner, or a named keeper) can neither overspend nor overpay.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E18, E6, ONE_SHARE, approveAll, deployV2, v2Split, sharesAt } = require("./helpers");

const CASH = 10n * E6; // 10 dollars a run
const MONTH = 30n * 86400n;
const AUCTION = 3600n;
const BAND = 200; // 2%
const MIN = (95n * ONE_SHARE) / 100n; // the owner's price cap: never fewer than 0.95 shares for 10 dollars
const MAX = (110n * ONE_SHARE) / 100n;
const FAIR = ONE_SHARE;
const OPEN = 1n;
const CANCELLED = 3n;

async function withPlan() {
  const f = await deployV2();
  const { plans, usdg, alice, ap, stocks, deskV2, basket } = f;
  // On Tempo this is the access key's scoped approve; here a standing allowance.
  await usdg.connect(alice).approve(plans, ethers.MaxUint256);
  await approveAll(stocks, ap, deskV2);
  await plans.connect(alice).openPlan(basket, CASH, MONTH, AUCTION, BAND, MIN, MAX, ethers.ZeroAddress);
  return { ...f, id: 0n };
}

async function withKeeperPlan() {
  const f = await withPlan();
  await f.plans.connect(f.alice).openPlan(f.basket, CASH, 86400n, AUCTION, BAND, MIN, MAX, f.keeper.address);
  return { ...f, kid: 1n };
}

describe("PlanDesk: opening plans", () => {
  it("records every term, indexes the plan by owner and emits PlanOpened", async () => {
    const { plans, alice, basket, deskV2, usdg } = await loadFixture(withPlan);
    const p = await plans.getPlan(0);
    expect(p.owner).to.equal(alice.address);
    expect(p.basket).to.equal(await basket.getAddress());
    expect(p.keeper).to.equal(ethers.ZeroAddress);
    expect(p.cashPerRun).to.equal(CASH);
    expect(p.interval).to.equal(MONTH);
    expect(p.auctionSecs).to.equal(AUCTION);
    expect(p.bandBps).to.equal(BAND);
    expect(p.minShares).to.equal(MIN);
    expect(p.maxShares).to.equal(MAX);
    expect(p.runs).to.equal(0n);
    expect(p.lastRunAt).to.equal(0n);
    expect(p.active).to.equal(true);
    expect(await plans.planCount()).to.equal(1n);
    expect(await plans.plansOf(alice)).to.deep.equal([0n]);
    expect(await plans.nextRunAt(0)).to.equal(0n);
    expect(await plans.desk()).to.equal(await deskV2.getAddress());
    expect(await plans.cash()).to.equal(await usdg.getAddress());
    await expect(plans.connect(alice).openPlan(basket, CASH, 60n, 30n, 0, 1n, 1n, ethers.ZeroAddress))
      .to.emit(plans, "PlanOpened")
      .withArgs(1n, alice.address, await basket.getAddress(), ethers.ZeroAddress, CASH, 60n, 30n, 0, 1n, 1n);
    expect(await plans.plansOf(alice)).to.deep.equal([0n, 1n]);
  });

  it("refuses an unknown basket, zero cash, an empty schedule, a band over 50% and inverted or zero bounds", async () => {
    const { plans, alice, basket, tsla } = await loadFixture(withPlan);
    const Z = ethers.ZeroAddress;
    await expect(plans.connect(alice).openPlan(tsla, CASH, MONTH, AUCTION, BAND, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "UnknownBasket");
    await expect(plans.connect(alice).openPlan(basket, 0, MONTH, AUCTION, BAND, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "ZeroAmount");
    await expect(plans.connect(alice).openPlan(basket, CASH, 0, AUCTION, BAND, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, 0, BAND, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, MONTH + 1n, BAND, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "BadSchedule");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, AUCTION, 5001, MIN, MAX, Z)).to.be.revertedWithCustomError(plans, "BandTooWide");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, AUCTION, BAND, 0, MAX, Z)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, AUCTION, BAND, MAX, MIN, Z)).to.be.revertedWithCustomError(plans, "BadBounds");
    await expect(plans.connect(alice).openPlan(basket, CASH, MONTH, MONTH, 5000, MIN, MIN, Z)).to.emit(plans, "PlanOpened");
  });
});

describe("PlanDesk: instalments", () => {
  it("pulls exactly cashPerRun from the owner and posts the auction with the owner as buyer", async () => {
    const { plans, deskV2, usdg, alice, basket } = await loadFixture(withPlan);
    const before = await usdg.balanceOf(alice);
    const t = BigInt(await time.latest()) + 10n;
    await time.setNextBlockTimestamp(t);
    const start = (FAIR * 10200n) / 10000n;
    const end = (FAIR * 9800n) / 10000n;
    await expect(plans.connect(alice).instalment(0, FAIR))
      .to.emit(plans, "Instalment")
      .withArgs(0n, 0n, alice.address, FAIR, start, end, 1n)
      .and.to.emit(deskV2, "OrderPlaced")
      .withArgs(0n, alice.address, await basket.getAddress(), await plans.getAddress(), CASH, start, end, t, t + AUCTION);
    expect(await usdg.balanceOf(alice)).to.equal(before - CASH);
    expect(await usdg.balanceOf(deskV2)).to.equal(CASH);
    // The plan desk keeps nothing and leaves no allowance behind.
    expect(await usdg.balanceOf(plans)).to.equal(0n);
    expect(await usdg.allowance(plans, deskV2)).to.equal(0n);
    const o = await deskV2.getOrder(0);
    expect(o.buyer).to.equal(alice.address);
    expect(o.cashAmount).to.equal(CASH);
    const p = await plans.getPlan(0);
    expect(p.runs).to.equal(1n);
    expect(p.lastRunAt).to.equal(t);
    expect(await plans.nextRunAt(0)).to.equal(t + MONTH);
    expect(await plans.auctionFor(0, FAIR)).to.deep.equal([start, end]);
  });

  it("the price cap: a fair below the owner's minimum or above the maximum is refused", async () => {
    const { plans, alice } = await loadFixture(withPlan);
    await expect(plans.connect(alice).instalment(0, MIN - 1n))
      .to.be.revertedWithCustomError(plans, "FairOutOfBounds")
      .withArgs(MIN - 1n, MIN, MAX);
    await expect(plans.connect(alice).instalment(0, MAX + 1n))
      .to.be.revertedWithCustomError(plans, "FairOutOfBounds")
      .withArgs(MAX + 1n, MIN, MAX);
    // The trigger's worst choice, 1 raw share unit, is the attack the cap exists for.
    await expect(plans.connect(alice).instalment(0, 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
    await expect(plans.auctionFor(0, 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
    expect((await plans.getPlan(0)).runs).to.equal(0n);
  });

  it("at the cap the auction ends at minShares, never below: the owner never pays more than cashPerRun / minShares", async () => {
    const f = await loadFixture(withPlan);
    const { plans, deskV2, alice, ap, basket } = f;
    // Worst case for the owner: the trigger posts fair = min and fills at the very end itself.
    await plans.connect(alice).instalment(0, MIN);
    const o = await deskV2.getOrder(0);
    expect(o.endShares).to.equal(MIN);
    expect(o.startShares).to.equal((MIN * 10200n) / 10000n);
    await time.setNextBlockTimestamp(o.endTs);
    const before = await basket.balanceOf(alice);
    await deskV2.connect(ap).fill(0);
    const got = (await basket.balanceOf(alice)) - before;
    expect(got).to.be.gte(MIN);
    expect(got).to.equal(v2Split(MIN, 50n).buyer);
  });

  it("the band floor: with a fair above the cap, the end is fair minus the band", async () => {
    const { plans, deskV2, alice } = await loadFixture(withPlan);
    const fair = (105n * ONE_SHARE) / 100n;
    await plans.connect(alice).instalment(0, fair);
    const o = await deskV2.getOrder(0);
    expect(o.startShares).to.equal((fair * 10200n) / 10000n);
    expect(o.endShares).to.equal((fair * 9800n) / 10000n);
    expect(o.endShares).to.be.gt(MIN);
  });

  it("the amount is the owner's: a large allowance never lets an instalment take more than cashPerRun", async () => {
    const { plans, usdg, alice } = await loadFixture(withPlan);
    expect(await usdg.allowance(alice, plans)).to.equal(ethers.MaxUint256);
    const before = await usdg.balanceOf(alice);
    await plans.connect(alice).instalment(0, FAIR);
    expect(before - (await usdg.balanceOf(alice))).to.equal(CASH);
  });

  it("the schedule: a second run before the interval is TooSoon, at the interval it runs", async () => {
    const { plans, alice } = await loadFixture(withPlan);
    const t = BigInt(await time.latest()) + 10n;
    await time.setNextBlockTimestamp(t);
    await plans.connect(alice).instalment(0, FAIR);
    await time.setNextBlockTimestamp(t + MONTH - 1n);
    await expect(plans.connect(alice).instalment(0, FAIR))
      .to.be.revertedWithCustomError(plans, "TooSoon")
      .withArgs(t + MONTH);
    await time.setNextBlockTimestamp(t + MONTH);
    await expect(plans.connect(alice).instalment(0, FAIR)).to.emit(plans, "Instalment").withArgs(0n, 1n, alice.address, FAIR, (FAIR * 10200n) / 10000n, (FAIR * 9800n) / 10000n, 2n);
  });

  it("an unfilled run does not block the next one, and its cash is refunded to the owner after expiry by anyone", async () => {
    const { plans, deskV2, usdg, alice, bob } = await loadFixture(withPlan);
    await plans.connect(alice).instalment(0, FAIR);
    const o = await deskV2.getOrder(0);
    await expect(deskV2.connect(bob).cancel(0)).to.be.revertedWithCustomError(deskV2, "NotBuyer");
    await time.setNextBlockTimestamp(o.endTs + 1n);
    const before = await usdg.balanceOf(alice);
    await deskV2.connect(bob).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + CASH);
    expect((await deskV2.getOrder(0)).status).to.equal(CANCELLED);
    await time.increase(MONTH);
    await expect(plans.connect(alice).instalment(0, FAIR)).to.emit(deskV2, "OrderPlaced");
  });

  it("any filler can take a run: the owner gets the shares, the treasury the fee, the filler the cash", async () => {
    const { plans, deskV2, usdg, alice, ap, basket, treasury } = await loadFixture(withPlan);
    await plans.connect(alice).instalment(0, FAIR);
    const o = await deskV2.getOrder(0);
    const ts = o.startTs + AUCTION / 2n;
    const out = sharesAt(o.startShares, o.endShares, o.startTs, o.endTs, ts);
    const split = v2Split(out, 50n);
    const apCash = await usdg.balanceOf(ap);
    await time.setNextBlockTimestamp(ts);
    await deskV2.connect(ap).fill(0);
    expect(out).to.equal(FAIR);
    expect(await basket.balanceOf(alice)).to.equal(split.buyer);
    expect(await basket.balanceOf(treasury)).to.equal(split.protocol);
    expect(await usdg.balanceOf(ap)).to.equal(apCash + CASH);
  });

  it("fails cleanly without allowance or balance; the run is not counted", async () => {
    const { plans, usdg, dave, basket } = await loadFixture(withPlan);
    await plans.connect(dave).openPlan(basket, CASH, MONTH, AUCTION, BAND, MIN, MAX, ethers.ZeroAddress);
    await expect(plans.connect(dave).instalment(1, FAIR)).to.be.revertedWithCustomError(usdg, "ERC20InsufficientAllowance");
    await usdg.connect(dave).approve(plans, ethers.MaxUint256);
    await expect(plans.connect(dave).instalment(1, FAIR)).to.be.revertedWithCustomError(usdg, "ERC20InsufficientBalance");
    expect((await plans.getPlan(1)).runs).to.equal(0n);
  });
});

describe("PlanDesk: who may run a plan", () => {
  it("with no keeper, only the owner (or a key signing as the owner) can run it", async () => {
    const { plans, bob, keeper } = await loadFixture(withPlan);
    await expect(plans.connect(bob).instalment(0, FAIR)).to.be.revertedWithCustomError(plans, "NotAllowed");
    await expect(plans.connect(keeper).instalment(0, FAIR)).to.be.revertedWithCustomError(plans, "NotAllowed");
  });

  it("a named keeper can run its plan within the same terms, and no other plan", async () => {
    const { plans, deskV2, usdg, alice, keeper, kid } = await loadFixture(withKeeperPlan);
    await expect(plans.connect(keeper).instalment(0, FAIR)).to.be.revertedWithCustomError(plans, "NotAllowed");
    await expect(plans.connect(keeper).instalment(kid, MIN - 1n)).to.be.revertedWithCustomError(plans, "FairOutOfBounds");
    const before = await usdg.balanceOf(alice);
    await expect(plans.connect(keeper).instalment(kid, FAIR)).to.emit(plans, "Instalment").withArgs(kid, 0n, keeper.address, FAIR, (FAIR * 10200n) / 10000n, (FAIR * 9800n) / 10000n, 1n);
    expect((await deskV2.getOrder(0)).buyer).to.equal(alice.address);
    expect(before - (await usdg.balanceOf(alice))).to.equal(CASH);
    await expect(plans.connect(keeper).instalment(kid, FAIR)).to.be.revertedWithCustomError(plans, "TooSoon");
  });

  it("a keeper with a standing allowance drains at most cashPerRun per interval", async () => {
    const { plans, usdg, alice, keeper, kid } = await loadFixture(withKeeperPlan);
    const before = await usdg.balanceOf(alice);
    let runs = 0n;
    for (let day = 0; day < 5; day++) {
      await plans.connect(keeper).instalment(kid, FAIR);
      runs++;
      // Hammer it: every retry within the day is refused.
      await expect(plans.connect(keeper).instalment(kid, FAIR)).to.be.revertedWithCustomError(plans, "TooSoon");
      await time.increase(86400);
    }
    expect(before - (await usdg.balanceOf(alice))).to.equal(runs * CASH);
  });

  it("only the owner can close a plan; a closed plan never runs again; open orders stay refundable", async () => {
    const { plans, deskV2, usdg, alice, keeper, kid } = await loadFixture(withKeeperPlan);
    await plans.connect(keeper).instalment(kid, FAIR);
    await expect(plans.connect(keeper).closePlan(kid)).to.be.revertedWithCustomError(plans, "NotOwner");
    await expect(plans.connect(alice).closePlan(kid)).to.emit(plans, "PlanClosed").withArgs(kid);
    expect((await plans.getPlan(kid)).active).to.equal(false);
    await expect(plans.connect(alice).closePlan(kid)).to.be.revertedWithCustomError(plans, "PlanClosedAlready");
    await time.increase(86400);
    await expect(plans.connect(keeper).instalment(kid, FAIR)).to.be.revertedWithCustomError(plans, "PlanClosedAlready");
    await expect(plans.connect(alice).instalment(kid, FAIR)).to.be.revertedWithCustomError(plans, "PlanClosedAlready");
    expect((await deskV2.getOrder(0)).status).to.equal(OPEN);
    const before = await usdg.balanceOf(alice);
    await deskV2.connect(alice).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + CASH);
  });
});

describe("PlanDesk: re-entry", () => {
  async function hostileCash() {
    const f = await deployV2();
    const cash = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
    const d2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(cash, f.factory, f.treasury.address);
    const p2 = await (await ethers.getContractFactory("PlanDesk")).deploy(d2);
    await cash.mint(f.alice, 1000n * E18);
    await cash.connect(f.alice).approve(p2, ethers.MaxUint256);
    await p2.connect(f.alice).openPlan(f.basket, CASH, 1n, AUCTION, BAND, MIN, MAX, ethers.ZeroAddress);
    return { ...f, cash, d2, p2 };
  }

  it("a cash token that re-enters instalment, openPlan or closePlan mid-pull reverts with ReentrancyGuardReentrantCall", async () => {
    const { cash, p2, d2, alice, basket } = await hostileCash();
    for (const payload of [
      p2.interface.encodeFunctionData("instalment", [0n, FAIR]),
      p2.interface.encodeFunctionData("openPlan", [await basket.getAddress(), CASH, 1n, AUCTION, BAND, MIN, MAX, ethers.ZeroAddress]),
      p2.interface.encodeFunctionData("closePlan", [0n]),
    ]) {
      await cash.arm(p2, payload);
      await expect(p2.connect(alice).instalment(0, FAIR)).to.be.revertedWithCustomError(p2, "ReentrancyGuardReentrantCall");
    }
    expect((await p2.getPlan(0)).runs).to.equal(0n);
    expect(await d2.orderCount()).to.equal(0n);
  });
});
