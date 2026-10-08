// CreationDesk: order lifecycle, expiry boundaries, settlement accounting and
// hostile-token behaviour.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { PANIC_CODES } = require("@nomicfoundation/hardhat-chai-matchers/panic");
const { E18, E6, ONE_SHARE, approveAll, deployCore, createBasket } = require("./helpers");

const OPEN = 1n;
const FILLED = 2n;
const CANCELLED = 3n;
const SHARES = 5n * ONE_SHARE;
const PRICE = 115n * E6;

/// Two open orders: #0 from alice (the one under test) and #1 from carol, so
/// every test can check that settling one order never touches another's escrow.
async function withOrders() {
  const f = await deployCore();
  const { desk, usdg, alice, carol, basket } = f;
  await usdg.connect(alice).approve(desk, ethers.MaxUint256);
  await usdg.connect(carol).approve(desk, ethers.MaxUint256);
  const expiry = (await time.latest()) + 3600;
  await desk.connect(alice).placeOrder(basket, SHARES, PRICE, expiry);
  await desk.connect(carol).placeOrder(basket, ONE_SHARE, 23n * E6, expiry + 7200);
  return { ...f, expiry };
}

describe("CreationDesk: placing orders", () => {
  it("records every field of the order and escrows exactly usdgAmount", async () => {
    const { desk, usdg, alice, basket, expiry } = await loadFixture(withOrders);
    const o = await desk.getOrder(0);
    expect(o.buyer).to.equal(alice.address);
    expect(o.basket).to.equal(await basket.getAddress());
    expect(o.expiry).to.equal(BigInt(expiry));
    expect(o.shares).to.equal(SHARES);
    expect(o.usdgAmount).to.equal(PRICE);
    expect(o.status).to.equal(OPEN);
    expect(o.filler).to.equal(ethers.ZeroAddress);
    expect(await desk.orderCount()).to.equal(2n);
    expect(await usdg.balanceOf(desk)).to.equal(PRICE + 23n * E6);
  });

  it("rejects a token that is not a factory basket with UnknownBasket", async () => {
    const { desk, alice, tsla } = await loadFixture(withOrders);
    const expiry = (await time.latest()) + 60;
    await expect(desk.connect(alice).placeOrder(tsla, 1, 1, expiry)).to.be.revertedWithCustomError(desk, "UnknownBasket");
    await expect(desk.connect(alice).placeOrder(ethers.ZeroAddress, 1, 1, expiry)).to.be.revertedWithCustomError(desk, "UnknownBasket");
  });

  it("rejects a byte-identical Basket deployed outside the factory with UnknownBasket", async () => {
    const { desk, alice, recipe } = await loadFixture(withOrders);
    const rogue = await (await ethers.getContractFactory("Basket")).deploy("Streaming and Stuff", "SAS", alice.address, 50, recipe);
    const expiry = (await time.latest()) + 60;
    await expect(desk.connect(alice).placeOrder(rogue, ONE_SHARE, E6, expiry)).to.be.revertedWithCustomError(desk, "UnknownBasket");
  });

  it("rejects zero shares or zero USDG with ZeroAmount", async () => {
    const { desk, alice, basket } = await loadFixture(withOrders);
    const expiry = (await time.latest()) + 60;
    await expect(desk.connect(alice).placeOrder(basket, 0, E6, expiry)).to.be.revertedWithCustomError(desk, "ZeroAmount");
    await expect(desk.connect(alice).placeOrder(basket, ONE_SHARE, 0, expiry)).to.be.revertedWithCustomError(desk, "ZeroAmount");
  });

  it("rejects an expiry in the past or equal to the block timestamp with BadExpiry", async () => {
    const { desk, alice, basket } = await loadFixture(withOrders);
    const now = await time.latest();
    await expect(desk.connect(alice).placeOrder(basket, ONE_SHARE, E6, now - 1)).to.be.revertedWithCustomError(desk, "BadExpiry");
    await time.setNextBlockTimestamp(now + 10);
    await expect(desk.connect(alice).placeOrder(basket, ONE_SHARE, E6, now + 10)).to.be.revertedWithCustomError(desk, "BadExpiry");
    // One second later is fine.
    await expect(desk.connect(alice).placeOrder(basket, ONE_SHARE, E6, now + 100)).to.emit(desk, "OrderPlaced");
  });

  it("reverts without USDG allowance and leaves no order behind", async () => {
    const { desk, usdg, bob, basket } = await loadFixture(withOrders);
    const expiry = (await time.latest()) + 60;
    await expect(desk.connect(bob).placeOrder(basket, ONE_SHARE, E6, expiry)).to.be.revertedWithCustomError(usdg, "ERC20InsufficientAllowance");
    expect(await desk.orderCount()).to.equal(2n);
  });
});

describe("CreationDesk: filling", () => {
  it("settles exactly: buyer gets net shares, creator gets fee shares, filler gets exactly usdgAmount", async () => {
    const { desk, usdg, basket, alice, ap, creator, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    const [net, fee] = await basket.previewNetShares(SHARES);
    expect(fee).to.be.greaterThan(0n);
    const pull = await basket.previewMint(SHARES);
    const apStocksBefore = await Promise.all(stocks.map((t) => t.balanceOf(ap)));
    const apUsdgBefore = await usdg.balanceOf(ap);
    const deskUsdgBefore = await usdg.balanceOf(desk);

    expect(await desk.connect(ap).fill.staticCall(0)).to.equal(net);
    await desk.connect(ap).fill(0);

    expect(await basket.balanceOf(alice)).to.equal(net);
    expect(await basket.balanceOf(creator)).to.equal(fee);
    expect(net + fee).to.equal(SHARES); // buyer paid for gross shares
    expect((await usdg.balanceOf(ap)) - apUsdgBefore).to.equal(PRICE);
    for (let i = 0; i < 3; i++) expect(apStocksBefore[i] - (await stocks[i].balanceOf(ap))).to.equal(pull[i]);
    expect(await basket.vaultBalances()).to.deep.equal(pull);
  });

  it("leaves the desk holding no stock tokens, no basket shares, no leftover allowance, and only other orders' USDG", async () => {
    const { desk, usdg, basket, ap, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await desk.connect(ap).fill(0);
    for (const t of stocks) {
      expect(await t.balanceOf(desk)).to.equal(0n);
      expect(await t.allowance(desk, basket)).to.equal(0n);
    }
    expect(await basket.balanceOf(desk)).to.equal(0n);
    expect(await usdg.balanceOf(desk)).to.equal(23n * E6); // carol's order only
    const o = await desk.getOrder(0);
    expect(o.status).to.equal(FILLED);
    expect(o.filler).to.equal(ap.address);
    expect((await desk.getOrder(1)).status).to.equal(OPEN);
  });

  it("double fill reverts NotOpen, and a filled order cannot be cancelled", async () => {
    const { desk, ap, alice, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await desk.connect(ap).fill(0);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "NotOpen");
    await expect(desk.connect(alice).cancel(0)).to.be.revertedWithCustomError(desk, "NotOpen");
  });

  it("a filler with no approval reverts and the order stays open", async () => {
    const { desk, ap, tsla } = await loadFixture(withOrders);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(tsla, "ERC20InsufficientAllowance");
    expect((await desk.getOrder(0)).status).to.equal(OPEN);
  });

  it("a filler missing one component reverts and the order stays open", async () => {
    const { desk, ap, nflx, stocks, bob } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await nflx.connect(ap).transfer(bob, await nflx.balanceOf(ap));
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(nflx, "ERC20InsufficientBalance");
    expect((await desk.getOrder(0)).status).to.equal(OPEN);
  });

  it("anyone may fill, including the buyer, and fills are first come first served", async () => {
    const { desk, usdg, basket, alice, ap, bob, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, alice, desk);
    await approveAll(stocks, bob, desk);
    await approveAll(stocks, ap, desk);
    const [net] = await basket.previewNetShares(SHARES);
    const before = await usdg.balanceOf(alice);
    await desk.connect(alice).fill(0); // self-fill: alice is refunded her own USDG
    expect(await usdg.balanceOf(alice)).to.equal(before + PRICE);
    expect(await basket.balanceOf(alice)).to.equal(net);
    await desk.connect(bob).fill(1);
    await expect(desk.connect(ap).fill(1)).to.be.revertedWithCustomError(desk, "NotOpen");
  });
});

describe("CreationDesk: expiry and cancellation", () => {
  it("a fill at the exact expiry second still succeeds (the expiry is inclusive)", async () => {
    const { desk, ap, stocks, expiry } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await time.setNextBlockTimestamp(expiry);
    await expect(desk.connect(ap).fill(0)).to.emit(desk, "OrderFilled");
    expect(await time.latest()).to.equal(expiry);
  });

  it("fill after expiry reverts Expired", async () => {
    const { desk, ap, stocks, expiry } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await time.increaseTo(expiry + 1);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "Expired");
  });

  it("the buyer can cancel before expiry and gets exactly usdgAmount back", async () => {
    const { desk, usdg, alice } = await loadFixture(withOrders);
    const before = await usdg.balanceOf(alice);
    await desk.connect(alice).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + PRICE);
    expect((await desk.getOrder(0)).status).to.equal(CANCELLED);
    expect(await usdg.balanceOf(desk)).to.equal(23n * E6);
  });

  it("a third party cannot cancel before expiry, nor at the exact expiry second (NotBuyer)", async () => {
    const { desk, bob, expiry } = await loadFixture(withOrders);
    await expect(desk.connect(bob).cancel(0)).to.be.revertedWithCustomError(desk, "NotBuyer");
    await time.setNextBlockTimestamp(expiry);
    await expect(desk.connect(bob).cancel(0)).to.be.revertedWithCustomError(desk, "NotBuyer");
  });

  it("after expiry a third party can cancel; the USDG goes to the buyer, never the caller", async () => {
    const { desk, usdg, alice, bob, expiry } = await loadFixture(withOrders);
    await time.increaseTo(expiry + 1);
    const aliceBefore = await usdg.balanceOf(alice);
    const bobBefore = await usdg.balanceOf(bob);
    await desk.connect(bob).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(aliceBefore + PRICE);
    expect(await usdg.balanceOf(bob)).to.equal(bobBefore);
    expect((await desk.getOrder(0)).status).to.equal(CANCELLED);
  });

  it("a cancelled order cannot be filled or cancelled again", async () => {
    const { desk, alice, ap, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await desk.connect(alice).cancel(0);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "NotOpen");
    await expect(desk.connect(alice).cancel(0)).to.be.revertedWithCustomError(desk, "NotOpen");
  });

  it("a buyer's cancel races a fill cleanly: whichever lands second reverts NotOpen", async () => {
    const { desk, alice, ap, stocks } = await loadFixture(withOrders);
    await approveAll(stocks, ap, desk);
    await desk.connect(alice).cancel(0);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "NotOpen");
  });
});

describe("CreationDesk: out-of-range ids", () => {
  it("getOrder, fill and cancel on a non-existent id revert with an array out-of-bounds panic (0x32)", async () => {
    const { desk, alice } = await loadFixture(withOrders);
    const n = await desk.orderCount();
    await expect(desk.getOrder(n)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
    await expect(desk.connect(alice).fill(n)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
    await expect(desk.connect(alice).cancel(n)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
  });
});

describe("CreationDesk: hostile component tokens", () => {
  async function withHostileBasket(kind) {
    const f = await withOrders();
    const hostile = await (await ethers.getContractFactory(kind)).deploy();
    await hostile.mint(f.ap, 1000n * E18);
    const hb = await createBasket(f.factory, f.creator, `Hostile ${kind}`, "HOST", 0, [
      { token: await f.tsla.getAddress(), unitsPerShare: E18 / 10n, weightBps: 5000 },
      { token: await hostile.getAddress(), unitsPerShare: E18 / 4n, weightBps: 5000 },
    ]);
    await approveAll([f.tsla, hostile], f.ap, f.desk);
    await f.desk.connect(f.alice).placeOrder(hb, ONE_SHARE, 10n * E6, f.expiry);
    return { ...f, hostile, hb, id: 2n };
  }
  const reentrant = () => withHostileBasket("ReentrantERC20");
  const pausable = () => withHostileBasket("PausableERC20");
  const skimming = () => withHostileBasket("FeeOnTransferERC20");

  it("a token that re-enters fill() during a fill reverts with ReentrancyGuardReentrantCall", async () => {
    const { desk, hostile, ap, id } = await loadFixture(reentrant);
    await hostile.arm(desk, desk.interface.encodeFunctionData("fill", [1n]));
    await expect(desk.connect(ap).fill(id)).to.be.revertedWithCustomError(desk, "ReentrancyGuardReentrantCall");
    expect((await desk.getOrder(id)).status).to.equal(OPEN);
    expect((await desk.getOrder(1)).status).to.equal(OPEN);
  });

  it("a token that re-enters cancel() during a fill reverts with ReentrancyGuardReentrantCall", async () => {
    const { desk, hostile, ap, id } = await loadFixture(reentrant);
    await hostile.arm(desk, desk.interface.encodeFunctionData("cancel", [id]));
    await expect(desk.connect(ap).fill(id)).to.be.revertedWithCustomError(desk, "ReentrancyGuardReentrantCall");
  });

  it("even a hostile settlement token cannot re-enter placeOrder() (ReentrancyGuardReentrantCall)", async () => {
    const { factory, basket, alice } = await loadFixture(withOrders);
    const cash = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
    const desk2 = await (await ethers.getContractFactory("CreationDesk")).deploy(cash, factory);
    await cash.mint(alice, 1000n * E6);
    await cash.connect(alice).approve(desk2, ethers.MaxUint256);
    const expiry = (await time.latest()) + 600;
    await cash.arm(desk2, desk2.interface.encodeFunctionData("placeOrder", [await basket.getAddress(), 1n, 1n, expiry]));
    await expect(desk2.connect(alice).placeOrder(basket, ONE_SHARE, E6, expiry)).to.be.revertedWithCustomError(
      desk2,
      "ReentrancyGuardReentrantCall",
    );
    expect(await desk2.orderCount()).to.equal(0n);
  });

  it("a fee-on-transfer component makes the fill revert; the buyer can still cancel and is refunded", async () => {
    const { desk, usdg, alice, ap, id } = await loadFixture(skimming);
    await expect(desk.connect(ap).fill(id)).to.be.reverted;
    const before = await usdg.balanceOf(alice);
    await desk.connect(alice).cancel(id);
    expect(await usdg.balanceOf(alice)).to.equal(before + 10n * E6);
  });

  it("a paused component blocks fills but never traps the buyer's USDG", async () => {
    const { desk, usdg, hostile, alice, ap, id } = await loadFixture(pausable);
    await hostile.setPaused(true);
    await expect(desk.connect(ap).fill(id)).to.be.revertedWithCustomError(hostile, "TokenPaused");
    const before = await usdg.balanceOf(alice);
    await desk.connect(alice).cancel(id);
    expect(await usdg.balanceOf(alice)).to.equal(before + 10n * E6);
  });
});
