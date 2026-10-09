// CreationDeskV2: the Dutch auction on share count, the 0.10% protocol fee,
// the creator fee, refunds after expiry, hostile tokens and the admin surface.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { PANIC_CODES } = require("@nomicfoundation/hardhat-chai-matchers/panic");
const { E18, E6, ONE_SHARE, prng, approveAll, deployV2, createBasket, v2Split, sharesAt } = require("./helpers");

const OPEN = 1n;
const FILLED = 2n;
const CANCELLED = 3n;
const CASH = 115n * E6;
const START = (55n * ONE_SHARE) / 10n; // 5.5 shares
const END = (45n * ONE_SHARE) / 10n; // 4.5 shares
const SPAN = 1000n;
const SAS_FEE = 50n;

/// Two open auctions: #0 from alice (under test) and #1 from carol, so every
/// test can check that settling one never touches the other's escrow.
async function withV2Orders() {
  const f = await deployV2();
  const { deskV2, usdg, alice, carol, ap, basket, stocks } = f;
  await usdg.connect(alice).approve(deskV2, ethers.MaxUint256);
  await usdg.connect(carol).approve(deskV2, ethers.MaxUint256);
  await approveAll(stocks, ap, deskV2);
  const startTs = BigInt(await time.latest()) + 100n;
  const endTs = startTs + SPAN;
  await deskV2.connect(alice).placeOrder(basket, CASH, START, END, startTs, endTs);
  await deskV2.connect(carol).placeOrder(basket, 23n * E6, ONE_SHARE, ONE_SHARE / 2n, startTs, endTs + 7200n);
  return { ...f, startTs, endTs };
}

/// Fill order `id` at exactly `ts` and check every balance that moves.
async function fillAt(f, id, ts, creatorBps = SAS_FEE, basketC = f.basket) {
  const { deskV2, usdg, ap, alice, creator, treasury, stocks } = f;
  const o = await deskV2.getOrder(id);
  const out = sharesAt(o.startShares, o.endShares, o.startTs, o.endTs, ts);
  const split = v2Split(out, creatorBps);
  const need = await basketC.previewMint(split.gross);
  const before = {
    buyer: await basketC.balanceOf(o.buyer),
    creator: await basketC.balanceOf(creator),
    treasury: await basketC.balanceOf(treasury),
    apCash: await usdg.balanceOf(ap),
    deskCash: await usdg.balanceOf(deskV2),
    apStocks: await Promise.all(stocks.map((s) => s.balanceOf(ap))),
    supply: await basketC.totalSupply(),
  };
  await time.setNextBlockTimestamp(ts);
  const tx = deskV2.connect(ap).fill(id);
  await expect(tx)
    .to.emit(deskV2, "OrderFilled")
    .withArgs(id, ap.address, split.buyer, split.gross, split.creator, split.protocol, o.cashAmount);
  expect(await basketC.balanceOf(o.buyer)).to.equal(before.buyer + split.buyer);
  expect(await basketC.balanceOf(treasury)).to.equal(before.treasury + split.protocol);
  if (creatorBps > 0n) expect(await basketC.balanceOf(creator)).to.equal(before.creator + split.creator);
  expect(await basketC.totalSupply()).to.equal(before.supply + split.gross);
  expect(await usdg.balanceOf(ap)).to.equal(before.apCash + o.cashAmount);
  expect(await usdg.balanceOf(deskV2)).to.equal(before.deskCash - o.cashAmount);
  expect(await basketC.balanceOf(deskV2)).to.equal(0n);
  if (basketC === f.basket) {
    for (let i = 0; i < stocks.length; i++) {
      expect(await stocks[i].balanceOf(ap)).to.equal(before.apStocks[i] - need[i]);
      expect(await stocks[i].balanceOf(deskV2)).to.equal(0n);
    }
  }
  const after = await deskV2.getOrder(id);
  expect(after.status).to.equal(FILLED);
  expect(after.filler).to.equal(ap.address);
  expect(after.sharesOut).to.equal(split.buyer);
  void alice;
  return { out, split };
}

describe("CreationDeskV2: placing auctions", () => {
  it("records every field, escrows exactly the cash and emits OrderPlaced with the payer", async () => {
    const { deskV2, usdg, alice, basket, startTs, endTs } = await loadFixture(withV2Orders);
    const o = await deskV2.getOrder(0);
    expect(o.buyer).to.equal(alice.address);
    expect(o.basket).to.equal(await basket.getAddress());
    expect(o.cashAmount).to.equal(CASH);
    expect(o.startShares).to.equal(START);
    expect(o.endShares).to.equal(END);
    expect(o.startTs).to.equal(startTs);
    expect(o.endTs).to.equal(endTs);
    expect(o.status).to.equal(OPEN);
    expect(o.sharesOut).to.equal(0n);
    expect(o.filler).to.equal(ethers.ZeroAddress);
    expect(await deskV2.orderCount()).to.equal(2n);
    expect(await usdg.balanceOf(deskV2)).to.equal(CASH + 23n * E6);
    const s = BigInt(await time.latest()) + 10n;
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, s, s + 5n))
      .to.emit(deskV2, "OrderPlaced")
      .withArgs(2n, alice.address, await basket.getAddress(), alice.address, E6, 2n, 1n, s, s + 5n);
  });

  it("knows the fee constants: 0.10% protocol fee, the treasury, 30-day cap", async () => {
    const { deskV2, treasury, usdg, factory } = await loadFixture(withV2Orders);
    expect(await deskV2.PROTOCOL_FEE_BPS()).to.equal(10n);
    expect(await deskV2.treasury()).to.equal(treasury.address);
    expect(await deskV2.cash()).to.equal(await usdg.getAddress());
    expect(await deskV2.factory()).to.equal(await factory.getAddress());
    expect(await deskV2.MAX_ORDER_SECS()).to.equal(30n * 86400n);
  });

  it("refuses a zero cash token, factory or treasury at construction", async () => {
    const { usdg, factory, treasury } = await loadFixture(withV2Orders);
    const F = await ethers.getContractFactory("CreationDeskV2");
    await expect(F.deploy(ethers.ZeroAddress, factory, treasury)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(usdg, ethers.ZeroAddress, treasury)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(usdg, factory, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("rejects a token that is not a factory basket, including a byte-identical rogue Basket", async () => {
    const { deskV2, alice, tsla, recipe } = await loadFixture(withV2Orders);
    const s = BigInt(await time.latest()) + 10n;
    await expect(deskV2.connect(alice).placeOrder(tsla, E6, 2n, 1n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "UnknownBasket");
    const rogue = await (await ethers.getContractFactory("Basket")).deploy("Rogue", "SAS", alice.address, 0, recipe);
    await expect(deskV2.connect(alice).placeOrder(rogue, E6, 2n, 1n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "UnknownBasket");
  });

  it("rejects zero cash, a zero end count, and a rising auction", async () => {
    const { deskV2, alice, basket } = await loadFixture(withV2Orders);
    const s = BigInt(await time.latest()) + 10n;
    await expect(deskV2.connect(alice).placeOrder(basket, 0, 2n, 1n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "ZeroAmount");
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 0n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "BadAuctionShares");
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 1n, 2n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "BadAuctionShares");
    // A flat auction (start == end) is a plain limit order and is allowed.
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 2n, s, s + 5n)).to.emit(deskV2, "OrderPlaced");
  });

  it("rejects an empty window, an end in the past, and an end more than 30 days out", async () => {
    const { deskV2, alice, basket } = await loadFixture(withV2Orders);
    const now = BigInt(await time.latest());
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, now + 50n, now + 50n)).to.be.revertedWithCustomError(deskV2, "BadAuctionWindow");
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, now + 60n, now + 50n)).to.be.revertedWithCustomError(deskV2, "BadAuctionWindow");
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, 0n, now)).to.be.revertedWithCustomError(deskV2, "BadAuctionWindow");
    const max = 30n * 86400n;
    await time.setNextBlockTimestamp(now + 10n);
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, now, now + 10n + max + 1n)).to.be.revertedWithCustomError(deskV2, "BadAuctionWindow");
    await time.setNextBlockTimestamp(now + 20n);
    await expect(deskV2.connect(alice).placeOrder(basket, E6, 2n, 1n, now, now + 20n + max)).to.emit(deskV2, "OrderPlaced");
  });

  it("refuses values that do not fit the packed order (SafeCast)", async () => {
    const { deskV2, usdg, alice, basket } = await loadFixture(withV2Orders);
    const s = BigInt(await time.latest()) + 10n;
    const big = 2n ** 128n;
    await expect(deskV2.connect(alice).placeOrder(basket, E6, big, 1n, s, s + 5n)).to.be.revertedWithCustomError(deskV2, "SafeCastOverflowedUintDowncast");
    void usdg;
  });

  it("placeAuction centres the auction on the buyer's fair count: fair+band down to fair-band, now to now+secs", async () => {
    const { deskV2, alice, basket } = await loadFixture(withV2Orders);
    const fair = 5n * ONE_SHARE;
    const t = BigInt(await time.latest()) + 5n;
    await time.setNextBlockTimestamp(t);
    await deskV2.connect(alice).placeAuction(basket, CASH, fair, 200, 600n, 0n);
    const o = await deskV2.getOrder(2);
    expect(o.startShares).to.equal((fair * 10200n) / 10000n);
    expect(o.endShares).to.equal((fair * 9800n) / 10000n);
    expect(o.startTs).to.equal(t);
    expect(o.endTs).to.equal(t + 600n);
    expect(await deskV2.auctionBounds(fair, 200, 0n)).to.deep.equal([o.startShares, o.endShares]);
  });

  it("placeAuction never ends below the buyer's floor, and refuses a fair below it or a band over 50%", async () => {
    const { deskV2, alice, basket } = await loadFixture(withV2Orders);
    const fair = 5n * ONE_SHARE;
    const floor = (fair * 9900n) / 10000n;
    await deskV2.connect(alice).placeAuction(basket, CASH, fair, 300, 600n, floor);
    const o = await deskV2.getOrder(2);
    expect(o.endShares).to.equal(floor);
    expect(o.startShares).to.equal((fair * 10300n) / 10000n);
    // A floor at fair collapses the end to fair.
    expect(await deskV2.auctionBounds(fair, 300, fair)).to.deep.equal([(fair * 10300n) / 10000n, fair]);
    await expect(deskV2.connect(alice).placeAuction(basket, CASH, fair, 300, 600n, fair + 1n)).to.be.revertedWithCustomError(deskV2, "FairBelowFloor");
    await expect(deskV2.connect(alice).placeAuction(basket, CASH, fair, 5001, 600n, 0n)).to.be.revertedWithCustomError(deskV2, "BandTooWide");
    await expect(deskV2.auctionBounds(fair, 5001, 0n)).to.be.revertedWithCustomError(deskV2, "BandTooWide");
    await expect(deskV2.connect(alice).placeAuction(basket, CASH, fair, 5000, 600n, 0n)).to.emit(deskV2, "OrderPlaced");
    await expect(deskV2.connect(alice).placeAuction(basket, CASH, fair, 100, 0n, 0n)).to.be.revertedWithCustomError(deskV2, "BadAuctionWindow");
  });

  it("placeOrderFor: the caller pays, the named buyer owns the order; a zero buyer is refused", async () => {
    const { deskV2, usdg, alice, bob, basket } = await loadFixture(withV2Orders);
    const s = BigInt(await time.latest()) + 10n;
    const before = await usdg.balanceOf(alice);
    await expect(deskV2.connect(alice).placeOrderFor(bob, basket, E6, 2n, 1n, s, s + 50n))
      .to.emit(deskV2, "OrderPlaced")
      .withArgs(2n, bob.address, await basket.getAddress(), alice.address, E6, 2n, 1n, s, s + 50n);
    expect(await usdg.balanceOf(alice)).to.equal(before - E6);
    expect((await deskV2.getOrder(2)).buyer).to.equal(bob.address);
    await expect(deskV2.connect(alice).placeOrderFor(ethers.ZeroAddress, basket, E6, 2n, 1n, s, s + 50n)).to.be.revertedWithCustomError(
      deskV2,
      "ZeroAddress",
    );
    // The refund goes to the buyer, not the payer: bob may cancel, alice may not.
    await expect(deskV2.connect(alice).cancel(2)).to.be.revertedWithCustomError(deskV2, "NotBuyer");
    const bobBefore = await usdg.balanceOf(bob);
    await deskV2.connect(bob).cancel(2);
    expect(await usdg.balanceOf(bob)).to.equal(bobBefore + E6);
  });

  it("reverts without cash allowance and leaves no order behind", async () => {
    const { deskV2, usdg, bob, basket } = await loadFixture(withV2Orders);
    const s = BigInt(await time.latest()) + 10n;
    await expect(deskV2.connect(bob).placeOrder(basket, E6, 2n, 1n, s, s + 50n)).to.be.revertedWithCustomError(usdg, "ERC20InsufficientAllowance");
    expect(await deskV2.orderCount()).to.equal(2n);
  });

  it("refuses a cash token that skims on transfer (ShortCash)", async () => {
    const { factory, basket, alice, treasury } = await loadFixture(withV2Orders);
    const skim = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy();
    const d2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(skim, factory, treasury.address);
    await skim.mint(alice, 1000n * E6);
    await skim.connect(alice).approve(d2, ethers.MaxUint256);
    const s = BigInt(await time.latest()) + 10n;
    await expect(d2.connect(alice).placeOrder(basket, 100n * E6, 2n, 1n, s, s + 50n))
      .to.be.revertedWithCustomError(d2, "ShortCash")
      .withArgs(100n * E6, 99n * E6);
  });
});

describe("CreationDeskV2: auction math", () => {
  it("sharesAt is startShares up to startTs, endShares from endTs, linear in between (rounded for the buyer)", async () => {
    const { deskV2, startTs, endTs } = await loadFixture(withV2Orders);
    expect(await deskV2.sharesAt(0, 0)).to.equal(START);
    expect(await deskV2.sharesAt(0, startTs)).to.equal(START);
    expect(await deskV2.sharesAt(0, startTs + SPAN / 2n)).to.equal((START + END) / 2n);
    expect(await deskV2.sharesAt(0, startTs + SPAN / 4n)).to.equal(START - (START - END) / 4n);
    expect(await deskV2.sharesAt(0, endTs)).to.equal(END);
    expect(await deskV2.sharesAt(0, endTs + 10_000n)).to.equal(END);
    // A span that does not divide evenly: the decay rounds down, so the buyer keeps the rounding.
    for (const dt of [1n, 3n, 7n, 333n, 999n]) {
      const exact = sharesAt(START, END, startTs, endTs, startTs + dt);
      expect(await deskV2.sharesAt(0, startTs + dt)).to.equal(exact);
      expect(exact * SPAN).to.be.gte(START * SPAN - (START - END) * dt);
    }
  });

  it("a fill at the start of the auction pays the buyer at least startShares", async () => {
    const f = await loadFixture(withV2Orders);
    const { out, split } = await fillAt(f, 0n, f.startTs);
    expect(out).to.equal(START);
    expect(split.buyer).to.be.gte(START);
    expect(split.buyer - START).to.be.lte(2n);
  });

  it("a fill before the start also pays startShares", async () => {
    const f = await loadFixture(withV2Orders);
    const { out } = await fillAt(f, 0n, f.startTs - 50n);
    expect(out).to.equal(START);
  });

  it("a fill halfway through pays the midpoint", async () => {
    const f = await loadFixture(withV2Orders);
    const { out } = await fillAt(f, 0n, f.startTs + SPAN / 2n);
    expect(out).to.equal(5n * ONE_SHARE);
  });

  it("a fill at the last second pays endShares; one second later it is Expired", async () => {
    const f = await loadFixture(withV2Orders);
    const { out } = await fillAt(f, 0n, f.endTs);
    expect(out).to.equal(END);
    await time.setNextBlockTimestamp(f.endTs + 7200n + 1n);
    await expect(f.deskV2.connect(f.ap).fill(1)).to.be.revertedWithCustomError(f.deskV2, "Expired");
  });

  it("quoteFill matches what a fill in the same block takes", async () => {
    const f = await loadFixture(withV2Orders);
    await time.increaseTo(f.startTs + 321n);
    const [out, gross, amounts] = await f.deskV2.quoteFill(0);
    // A view runs at the latest block's timestamp or the next second, depending on the node.
    const latest = BigInt(await time.latest());
    expect([sharesAt(START, END, f.startTs, f.endTs, latest), sharesAt(START, END, f.startTs, f.endTs, latest + 1n)]).to.deep.include(out);
    const split = v2Split(out, SAS_FEE);
    expect(gross).to.equal(split.gross);
    expect(amounts).to.deep.equal(await f.basket.previewMint(split.gross));
    expect(await f.deskV2.grossFor(f.basket, out)).to.equal(split.gross);
    // Filled in the next block, the buyer gets exactly the count quoted for that second.
    await fillAt(f, 0n, latest + 5n);
  });

  it("the count only falls, so a filler who approved the quote at placement can fill any time later", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, basket, stocks, dave, alice } = f;
    const [, , atStart] = await deskV2.quoteFill(0);
    for (let i = 0; i < stocks.length; i++) await stocks[i].connect(dave).approve(deskV2, atStart[i]);
    await time.setNextBlockTimestamp(f.startTs + 700n);
    await expect(deskV2.connect(dave).fill(0)).to.emit(deskV2, "OrderFilled");
    expect(await basket.balanceOf(alice)).to.be.gte(sharesAt(START, END, f.startTs, f.endTs, f.startTs + 700n));
  });
});

describe("CreationDeskV2: fees", () => {
  it("the buyer nets the auction's count after the 0.50% creator fee and the 0.10% protocol fee", async () => {
    const f = await loadFixture(withV2Orders);
    const { split } = await fillAt(f, 0n, f.startTs);
    // 5.5 shares out: gross = ceil(5.5e18 * 10000 / 9940).
    expect(split.gross).to.equal((START * 10000n + 9939n) / 9940n);
    expect(split.protocol).to.equal((split.gross * 10n) / 10000n);
    expect(split.creator).to.equal((split.gross * 50n) / 10000n);
  });

  it("a no-fee basket pays only the protocol: 0.10% of gross, to the treasury", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, factory, creator, alice, tsla, amzn, treasury } = f;
    const nofee = await createBasket(factory, creator, "No Fee", "NOFEE", 0, [
      { token: await tsla.getAddress(), unitsPerShare: E18 / 10n, weightBps: 5000 },
      { token: await amzn.getAddress(), unitsPerShare: E18 / 10n, weightBps: 5000 },
    ]);
    const s = BigInt(await time.latest()) + 10n;
    await deskV2.connect(alice).placeOrder(nofee, 100n * E6, 100n * ONE_SHARE, 100n * ONE_SHARE, s, s + 100n);
    const { split } = await fillAt(f, 2n, s, 0n, nofee);
    expect(split.creator).to.equal(0n);
    expect(split.gross).to.equal((100n * ONE_SHARE * 10000n + 9989n) / 9990n);
    expect(await nofee.balanceOf(treasury)).to.equal(split.protocol);
    // About a tenth of a share on a hundred.
    expect(split.protocol).to.be.closeTo(ONE_SHARE / 10n, ONE_SHARE / 1000n);
  });

  it("a 1% basket (the maximum) still nets the buyer exactly the count, within 2 raw units", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, factory, creator, alice, tsla } = f;
    const max = await createBasket(factory, creator, "Max Fee", "MAXF", 100, [
      { token: await tsla.getAddress(), unitsPerShare: E18 / 10n, weightBps: 10000 },
    ]);
    const s = BigInt(await time.latest()) + 10n;
    await deskV2.connect(alice).placeOrder(max, 10n * E6, 3n * ONE_SHARE, 3n * ONE_SHARE, s, s + 100n);
    const { split } = await fillAt(f, 2n, s, 100n, max);
    expect(split.buyer - 3n * ONE_SHARE).to.be.lte(2n);
    expect(await max.balanceOf(creator)).to.equal(split.creator);
  });

  it("a fill too small for a protocol fee pays none and emits no ProtocolFeePaid", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, alice, basket, ap } = f;
    const s = BigInt(await time.latest()) + 10n;
    // 900 raw units out: gross ~ 906, protocol floor(906 * 10 / 10000) = 0.
    await deskV2.connect(alice).placeOrder(basket, 1n, 900n, 900n, s, s + 100n);
    await time.setNextBlockTimestamp(s);
    await expect(deskV2.connect(ap).fill(2)).to.not.emit(deskV2, "ProtocolFeePaid");
  });

  it("emits ProtocolFeePaid with the basket, the treasury and the shares", async () => {
    const f = await loadFixture(withV2Orders);
    const split = v2Split(START, SAS_FEE);
    await time.setNextBlockTimestamp(f.startTs);
    await expect(f.deskV2.connect(f.ap).fill(0))
      .to.emit(f.deskV2, "ProtocolFeePaid")
      .withArgs(await f.basket.getAddress(), f.treasury.address, split.protocol);
  });

  it("randomized: for any count and creator fee, buyer >= count (by at most 2), fees exact, vault fully backed", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, factory, creator, alice, ap, tsla, amzn, treasury } = f;
    const rnd = prng(0x5eaf2);
    for (let k = 0; k < 12; k++) {
      const feeBps = BigInt(rnd.int(0, 100));
      const b = await createBasket(factory, creator, `R${k}`, `R${k}`, Number(feeBps), [
        { token: await tsla.getAddress(), unitsPerShare: E18 / BigInt(rnd.int(2, 50)), weightBps: 6000 },
        { token: await amzn.getAddress(), unitsPerShare: E18 / BigInt(rnd.int(2, 50)), weightBps: 4000 },
      ]);
      const out = rnd.big(5n * ONE_SHARE) + 10n ** 12n;
      const s = BigInt(await time.latest()) + 10n;
      const id = await deskV2.orderCount();
      await deskV2.connect(alice).placeOrder(b, E6, out, out, s, s + 100n);
      await time.setNextBlockTimestamp(s);
      const split = v2Split(out, feeBps);
      await expect(deskV2.connect(ap).fill(id))
        .to.emit(deskV2, "OrderFilled")
        .withArgs(id, ap.address, split.buyer, split.gross, split.creator, split.protocol, E6);
      expect(split.buyer).to.be.gte(out);
      expect(split.buyer - out).to.be.lte(2n);
      expect(await b.balanceOf(treasury)).to.equal(split.protocol);
      // Backing: vault >= supply x units, per component.
      const supply = await b.totalSupply();
      const comps = await b.components();
      const vault = await b.vaultBalances();
      for (let i = 0; i < comps.length; i++) expect(vault[i] * E18).to.be.gte(supply * comps[i].unitsPerShare);
    }
  });
});

describe("CreationDeskV2: cancels and refunds", () => {
  it("the buyer can cancel before the end and gets the cash back; nobody else can", async () => {
    const { deskV2, usdg, alice, bob } = await loadFixture(withV2Orders);
    await expect(deskV2.connect(bob).cancel(0)).to.be.revertedWithCustomError(deskV2, "NotBuyer");
    const before = await usdg.balanceOf(alice);
    await expect(deskV2.connect(alice).cancel(0)).to.emit(deskV2, "OrderCancelled").withArgs(0n, CASH);
    expect(await usdg.balanceOf(alice)).to.equal(before + CASH);
    expect((await deskV2.getOrder(0)).status).to.equal(CANCELLED);
    expect(await usdg.balanceOf(deskV2)).to.equal(23n * E6);
  });

  it("after the auction ends anyone can cancel, and the refund always goes to the buyer", async () => {
    const { deskV2, usdg, alice, bob, endTs } = await loadFixture(withV2Orders);
    await time.setNextBlockTimestamp(endTs);
    await expect(deskV2.connect(bob).cancel(0)).to.be.revertedWithCustomError(deskV2, "NotBuyer");
    await time.setNextBlockTimestamp(endTs + 1n);
    const before = await usdg.balanceOf(alice);
    const bobBefore = await usdg.balanceOf(bob);
    await deskV2.connect(bob).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + CASH);
    expect(await usdg.balanceOf(bob)).to.equal(bobBefore);
  });

  it("a filled order cannot be cancelled, and a cancelled one cannot be filled or cancelled again", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, alice, carol, ap } = f;
    await fillAt(f, 0n, f.startTs);
    await expect(deskV2.connect(alice).cancel(0)).to.be.revertedWithCustomError(deskV2, "NotOpen");
    await expect(deskV2.connect(ap).fill(0)).to.be.revertedWithCustomError(deskV2, "NotOpen");
    await deskV2.connect(carol).cancel(1);
    await expect(deskV2.connect(ap).fill(1)).to.be.revertedWithCustomError(deskV2, "NotOpen");
    await expect(deskV2.connect(carol).cancel(1)).to.be.revertedWithCustomError(deskV2, "NotOpen");
  });

  it("out-of-range ids revert with an array out-of-bounds panic", async () => {
    const { deskV2, alice } = await loadFixture(withV2Orders);
    await expect(deskV2.getOrder(2)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
    await expect(deskV2.connect(alice).fill(2)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
    await expect(deskV2.connect(alice).cancel(2)).to.be.revertedWithPanic(PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS);
  });

  it("a filler short of a component reverts the whole fill; the order stays open and refundable", async () => {
    const f = await loadFixture(withV2Orders);
    const { deskV2, stocks, bob, alice, usdg } = f;
    await stocks[0].connect(bob).transfer(alice, await stocks[0].balanceOf(bob));
    await approveAll(stocks, bob, deskV2);
    await time.setNextBlockTimestamp(f.startTs);
    await expect(deskV2.connect(bob).fill(0)).to.be.reverted;
    expect((await deskV2.getOrder(0)).status).to.equal(OPEN);
    const before = await usdg.balanceOf(alice);
    await deskV2.connect(alice).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + CASH);
  });
});

describe("CreationDeskV2: hostile tokens and re-entry", () => {
  async function withHostile(kind) {
    const f = await withV2Orders();
    const hostile = await (await ethers.getContractFactory(kind)).deploy();
    await hostile.mint(f.ap, 1000n * E18);
    const hb = await createBasket(f.factory, f.creator, `Hostile ${kind}`, "HOST", 0, [
      { token: await f.tsla.getAddress(), unitsPerShare: E18 / 10n, weightBps: 5000 },
      { token: await hostile.getAddress(), unitsPerShare: E18 / 4n, weightBps: 5000 },
    ]);
    await approveAll([f.tsla, hostile], f.ap, f.deskV2);
    await f.deskV2.connect(f.alice).placeOrder(hb, 10n * E6, ONE_SHARE, ONE_SHARE / 2n, f.startTs, f.endTs);
    return { ...f, hostile, hb, id: 2n };
  }

  it("a component that re-enters fill() mid-fill reverts with ReentrancyGuardReentrantCall; nothing moves", async () => {
    const { deskV2, hostile, ap, id, usdg } = await withHostile("ReentrantERC20");
    const cashBefore = await usdg.balanceOf(deskV2);
    await hostile.arm(deskV2, deskV2.interface.encodeFunctionData("fill", [1n]));
    await expect(deskV2.connect(ap).fill(id)).to.be.revertedWithCustomError(deskV2, "ReentrancyGuardReentrantCall");
    expect((await deskV2.getOrder(id)).status).to.equal(OPEN);
    expect((await deskV2.getOrder(1)).status).to.equal(OPEN);
    expect(await usdg.balanceOf(deskV2)).to.equal(cashBefore);
  });

  it("a component that re-enters cancel() or placeOrder() mid-fill reverts the same way", async () => {
    const { deskV2, hostile, ap, id, basket, startTs, endTs } = await withHostile("ReentrantERC20");
    await hostile.arm(deskV2, deskV2.interface.encodeFunctionData("cancel", [id]));
    await expect(deskV2.connect(ap).fill(id)).to.be.revertedWithCustomError(deskV2, "ReentrancyGuardReentrantCall");
    await hostile.arm(
      deskV2,
      deskV2.interface.encodeFunctionData("placeOrder", [await basket.getAddress(), 1n, 2n, 1n, startTs, endTs]),
    );
    await expect(deskV2.connect(ap).fill(id)).to.be.revertedWithCustomError(deskV2, "ReentrancyGuardReentrantCall");
  });

  it("a hostile cash token cannot re-enter placeOrder, placeOrderFor or placeAuction", async () => {
    const { factory, basket, alice, treasury } = await withV2Orders();
    const cash = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
    const d2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(cash, factory, treasury.address);
    await cash.mint(alice, 1000n * E6);
    await cash.connect(alice).approve(d2, ethers.MaxUint256);
    const s = BigInt(await time.latest()) + 100n;
    const b = await basket.getAddress();
    for (const payload of [
      d2.interface.encodeFunctionData("placeOrder", [b, 1n, 2n, 1n, s, s + 5n]),
      d2.interface.encodeFunctionData("placeOrderFor", [alice.address, b, 1n, 2n, 1n, s, s + 5n]),
      d2.interface.encodeFunctionData("placeAuction", [b, 1n, 2n, 0, 50n, 1n]),
    ]) {
      await cash.arm(d2, payload);
      await expect(d2.connect(alice).placeOrder(basket, E6, 2n, 1n, s, s + 5n)).to.be.revertedWithCustomError(d2, "ReentrancyGuardReentrantCall");
    }
    expect(await d2.orderCount()).to.equal(0n);
  });

  it("a hostile cash token re-entering during the filler's payout cannot double-pay", async () => {
    const { factory, basket, alice, ap, stocks, treasury } = await withV2Orders();
    const cash = await (await ethers.getContractFactory("ReentrantERC20")).deploy();
    const d2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(cash, factory, treasury.address);
    await cash.mint(alice, 1000n * E6);
    await cash.connect(alice).approve(d2, ethers.MaxUint256);
    await approveAll(stocks, ap, d2);
    const s = BigInt(await time.latest()) + 10n;
    await d2.connect(alice).placeOrder(basket, E6, ONE_SHARE, ONE_SHARE, s, s + 100n);
    await cash.arm(d2, d2.interface.encodeFunctionData("fill", [0n]));
    await expect(d2.connect(ap).fill(0)).to.be.revertedWithCustomError(d2, "ReentrancyGuardReentrantCall");
    expect(await cash.balanceOf(d2)).to.equal(E6);
    await cash.disarm();
    await expect(d2.connect(ap).fill(0)).to.emit(d2, "OrderFilled");
    expect(await cash.balanceOf(d2)).to.equal(0n);
  });

  it("a paused component blocks fills but never traps the buyer's cash", async () => {
    const { deskV2, usdg, hostile, alice, ap, id } = await withHostile("PausableERC20");
    await hostile.setPaused(true);
    await expect(deskV2.connect(ap).fill(id)).to.be.revertedWithCustomError(hostile, "TokenPaused");
    const before = await usdg.balanceOf(alice);
    await deskV2.connect(alice).cancel(id);
    expect(await usdg.balanceOf(alice)).to.equal(before + 10n * E6);
  });

  it("a component that skims on transfer makes the fill revert; the buyer can still cancel", async () => {
    const { deskV2, usdg, alice, ap, id } = await withHostile("FeeOnTransferERC20");
    await expect(deskV2.connect(ap).fill(id)).to.be.reverted;
    const before = await usdg.balanceOf(alice);
    await deskV2.connect(alice).cancel(id);
    expect(await usdg.balanceOf(alice)).to.equal(before + 10n * E6);
  });
});

describe("CreationDeskV2: beside v1", () => {
  it("v1 and v2 desks serve the same basket independently", async () => {
    const f = await loadFixture(withV2Orders);
    const { desk, deskV2, usdg, alice, ap, basket, stocks } = f;
    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    await approveAll(stocks, ap, desk);
    const exp = Number(f.endTs);
    await desk.connect(alice).placeOrder(basket, ONE_SHARE, 12n * E6, exp);
    await desk.connect(ap).fill(0);
    await fillAt(f, 0n, f.startTs + 10n);
    expect((await desk.getOrder(0)).status).to.equal(FILLED);
    expect(await usdg.balanceOf(desk)).to.equal(0n);
  });
});
