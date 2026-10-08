// Basket behaviour against hostile component tokens and at the edges of its math.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E18, ONE_SHARE, approveAll, deployCore, createBasket } = require("./helpers");

/// A two-component basket: a normal token first, then the hostile one, so the
/// hostile behaviour happens after state has already started to move.
async function withHostile(kind) {
  const f = await deployCore();
  const hostile = await (await ethers.getContractFactory(kind)).deploy();
  for (const s of [f.alice, f.bob]) await hostile.mint(s, 1000n * E18);
  const basket = await createBasket(f.factory, f.creator, `Hostile ${kind}`, "HOST", 0, [
    { token: await f.tsla.getAddress(), unitsPerShare: E18 / 10n, weightBps: 5000 },
    { token: await hostile.getAddress(), unitsPerShare: E18 / 4n, weightBps: 5000 },
  ]);
  for (const s of [f.alice, f.bob]) await approveAll([f.tsla, hostile], s, basket);
  return { ...f, hostile, hb: basket };
}
const withFeeOnTransfer = () => withHostile("FeeOnTransferERC20");
const withReentrant = () => withHostile("ReentrantERC20");
const withPausable = () => withHostile("PausableERC20");

describe("Basket: hostile component tokens", () => {
  describe("fee-on-transfer token", () => {
    it("reverts mint with ShortDeposit(token, expected, received) and moves nothing", async () => {
      const { hb, hostile, tsla, alice } = await loadFixture(withFeeOnTransfer);
      const [, expected] = await hb.previewMint(ONE_SHARE);
      const received = expected - expected / 100n;
      const tslaBefore = await tsla.balanceOf(alice);
      await expect(hb.connect(alice).mint(ONE_SHARE, alice))
        .to.be.revertedWithCustomError(hb, "ShortDeposit")
        .withArgs(await hostile.getAddress(), expected, received);
      // The first component had already been pulled; the revert undid it.
      expect(await tsla.balanceOf(alice)).to.equal(tslaBefore);
      expect(await hb.totalSupply()).to.equal(0n);
    });
  });

  describe("reentrant token", () => {
    async function minted() {
      const f = await withReentrant();
      await f.hb.connect(f.alice).mint(2n * ONE_SHARE, f.alice); // hook disarmed
      return f;
    }

    it("control: with the hook disarmed, mint and redeem work normally", async () => {
      const { hb, hostile, alice } = await loadFixture(minted);
      await hostile.arm(hb, hb.interface.encodeFunctionData("redeem", [1n, alice.address]));
      await hostile.disarm();
      expect(await hb.balanceOf(alice)).to.equal(2n * ONE_SHARE);
      await hb.connect(alice).redeem(ONE_SHARE, alice);
      expect(await hb.balanceOf(alice)).to.equal(ONE_SHARE);
    });

    for (const [outer, inner] of [
      ["mint", "mint"],
      ["mint", "redeem"],
      ["redeem", "redeem"],
      ["redeem", "mint"],
    ]) {
      it(`re-entering ${inner}() from inside ${outer}() reverts with ReentrancyGuardReentrantCall`, async () => {
        const { hb, hostile, alice } = await loadFixture(minted);
        await hostile.arm(hb, hb.interface.encodeFunctionData(inner, [1n, alice.address]));
        await expect(hb.connect(alice)[outer](ONE_SHARE, alice)).to.be.revertedWithCustomError(
          hb,
          "ReentrancyGuardReentrantCall",
        );
        expect(await hb.balanceOf(alice)).to.equal(2n * ONE_SHARE);
      });
    }
  });

  describe("pausable / blocklisting token (known limitation)", () => {
    async function minted() {
      const f = await withPausable();
      await f.hb.connect(f.alice).mint(2n * ONE_SHARE, f.alice);
      await f.hb.connect(f.bob).mint(ONE_SHARE, f.bob);
      return f;
    }

    it("a paused component blocks redemption for every holder, and unpausing restores it", async () => {
      const { hb, hostile, alice, bob } = await loadFixture(minted);
      await hostile.setPaused(true);
      for (const who of [alice, bob]) {
        await expect(hb.connect(who).redeem(ONE_SHARE, who)).to.be.revertedWithCustomError(hostile, "TokenPaused");
      }
      await expect(hb.connect(alice).mint(ONE_SHARE, alice)).to.be.revertedWithCustomError(hostile, "TokenPaused");
      // Shares stay fully backed and transferable while the component is paused.
      await hb.connect(alice).transfer(bob, ONE_SHARE);
      await hostile.setPaused(false);
      await hb.connect(bob).redeem(2n * ONE_SHARE, bob);
      expect(await hb.balanceOf(bob)).to.equal(0n);
    });

    it("blocklisting the vault itself freezes every redemption", async () => {
      const { hb, hostile, alice } = await loadFixture(minted);
      await hostile.setBlocked(hb, true);
      await expect(hb.connect(alice).redeem(ONE_SHARE, alice))
        .to.be.revertedWithCustomError(hostile, "AddressBlocked")
        .withArgs(await hb.getAddress());
    });

    it("a blocklisted holder can still exit by redeeming to another receiver", async () => {
      const { hb, hostile, tsla, alice, carol } = await loadFixture(minted);
      await hostile.setBlocked(alice, true);
      await expect(hb.connect(alice).redeem(ONE_SHARE, alice)).to.be.revertedWithCustomError(hostile, "AddressBlocked");
      const out = await hb.previewRedeem(ONE_SHARE);
      await hb.connect(alice).redeem(ONE_SHARE, carol);
      expect(await hostile.balanceOf(carol)).to.equal(out[1]);
      expect(await tsla.balanceOf(carol)).to.equal(1000n * E18 + out[0]);
    });
  });

  it("a component address with no code makes the basket unmintable but cannot take anyone's funds", async () => {
    const { factory, alice, tsla } = await loadFixture(deployCore);
    const eoa = ethers.Wallet.createRandom().address;
    const b = await createBasket(factory, alice, "No Code", "NOCODE", 0, [
      { token: await tsla.getAddress(), unitsPerShare: E18, weightBps: 5000 },
      { token: eoa, unitsPerShare: E18, weightBps: 5000 },
    ]);
    await tsla.connect(alice).approve(b, ethers.MaxUint256);
    const before = await tsla.balanceOf(alice);
    await expect(b.connect(alice).mint(ONE_SHARE, alice)).to.be.reverted;
    expect(await tsla.balanceOf(alice)).to.equal(before);
  });
});

describe("Basket: edge cases", () => {
  it("DustMint guard fires for a zero-unit component (only reachable by deploying Basket outside the factory)", async () => {
    const { alice, tsla } = await loadFixture(deployCore);
    const rogue = await (await ethers.getContractFactory("Basket")).deploy("Rogue", "RG", alice.address, 0, [
      { token: await tsla.getAddress(), unitsPerShare: 0n, weightBps: 10000 },
    ]);
    await expect(rogue.connect(alice).mint(ONE_SHARE, alice)).to.be.revertedWithCustomError(rogue, "DustMint");
  });

  it("for any factory basket the smallest mint (1 wei of a share) costs exactly 1 raw unit of every component", async () => {
    const { basket, alice, stocks } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    expect(await basket.previewMint(1n)).to.deep.equal([1n, 1n, 1n]);
    await expect(basket.connect(alice).mint(1n, alice)).to.emit(basket, "SharesMinted").withArgs(alice.address, alice.address, 1n, 0n, [1n, 1n, 1n]);
    expect(await basket.vaultBalances()).to.deep.equal([1n, 1n, 1n]);
  });

  it("ZeroShares guard fires when the fee would consume the whole mint (fee 100%, outside the factory)", async () => {
    const { alice, tsla } = await loadFixture(deployCore);
    const rogue = await (await ethers.getContractFactory("Basket")).deploy("Rogue", "RG", alice.address, 10000, [
      { token: await tsla.getAddress(), unitsPerShare: E18, weightBps: 10000 },
    ]);
    await tsla.connect(alice).approve(rogue, ethers.MaxUint256);
    await expect(rogue.connect(alice).mint(ONE_SHARE, alice)).to.be.revertedWithCustomError(rogue, "ZeroShares");
    expect(await rogue.previewNetShares(ONE_SHARE)).to.deep.equal([0n, ONE_SHARE]);
  });

  it("at the factory's 1% fee cap net shares can never be zero: tiny mints simply pay no fee", async () => {
    const { factory, alice, stocks, recipe } = await loadFixture(deployCore);
    const b = await createBasket(factory, alice, "Max Fee", "MAXFEE", 100, recipe);
    expect(await b.previewNetShares(1n)).to.deep.equal([1n, 0n]);
    expect(await b.previewNetShares(99n)).to.deep.equal([99n, 0n]);
    expect(await b.previewNetShares(100n)).to.deep.equal([99n, 1n]);
    await approveAll(stocks, alice, b);
    await b.connect(alice).mint(1n, alice);
    expect(await b.balanceOf(alice)).to.equal(1n);
  });

  it("a Basket deployed outside the factory is not recognised: factory() is its deployer and isBasket is false", async () => {
    const { alice, tsla, factory } = await loadFixture(deployCore);
    const rogue = await (await ethers.getContractFactory("Basket")).connect(alice).deploy("Rogue", "RG", alice.address, 0, [
      { token: await tsla.getAddress(), unitsPerShare: E18, weightBps: 10000 },
    ]);
    expect(await rogue.factory()).to.equal(alice.address);
    expect(await factory.isBasket(rogue)).to.equal(false);
  });

  it("redeeming a sliver that rounds to zero still burns it (rounding always favours the vault)", async () => {
    const { basket, alice, stocks } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    await basket.connect(alice).mint(ONE_SHARE, alice);
    expect(await basket.previewRedeem(1n)).to.deep.equal([0n, 0n, 0n]);
    const before = await basket.balanceOf(alice);
    await basket.connect(alice).redeem(1n, alice);
    expect(await basket.balanceOf(alice)).to.equal(before - 1n);
  });

  it("mints to a third-party receiver: payer pays, receiver gets net, creator gets the fee", async () => {
    const { basket, alice, carol, creator, stocks } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    const shares = 3n * ONE_SHARE;
    const [net, fee] = await basket.previewNetShares(shares);
    const pull = await basket.previewMint(shares);
    const before = await Promise.all(stocks.map((t) => t.balanceOf(alice)));
    await basket.connect(alice).mint(shares, carol);
    expect(await basket.balanceOf(carol)).to.equal(net);
    expect(await basket.balanceOf(alice)).to.equal(0n);
    expect(await basket.balanceOf(creator)).to.equal(fee);
    for (let i = 0; i < 3; i++) expect(await stocks[i].balanceOf(alice)).to.equal(before[i] - pull[i]);
  });

  it("rejects the zero address as a mint or redeem receiver, and redeeming more than held", async () => {
    const { basket, alice, stocks, tsla } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    await expect(basket.connect(alice).mint(ONE_SHARE, ethers.ZeroAddress)).to.be.revertedWithCustomError(basket, "ERC20InvalidReceiver");
    await basket.connect(alice).mint(ONE_SHARE, alice);
    await expect(basket.connect(alice).redeem(ONE_SHARE / 2n, ethers.ZeroAddress)).to.be.revertedWithCustomError(tsla, "ERC20InvalidReceiver");
    const bal = await basket.balanceOf(alice);
    await expect(basket.connect(alice).redeem(bal + 1n, alice)).to.be.revertedWithCustomError(basket, "ERC20InsufficientBalance");
  });

  it("donations raise backing but are never claimable beyond the recipe (no sweep, no owner)", async () => {
    const { basket, alice, bob, stocks, tsla } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    await basket.connect(alice).mint(ONE_SHARE, alice);
    await tsla.connect(bob).transfer(basket, 5n * E18);
    const out = await basket.previewRedeem(await basket.balanceOf(alice));
    const before = await tsla.balanceOf(alice);
    await basket.connect(alice).redeem(await basket.balanceOf(alice), alice);
    expect(await tsla.balanceOf(alice)).to.equal(before + out[0]);
    expect(await tsla.balanceOf(basket)).to.be.gte(5n * E18);
  });

  it("tracks mintCount, redeemCount and createdAt", async () => {
    const { basket, alice, stocks } = await loadFixture(deployCore);
    expect(await basket.createdAt()).to.be.greaterThan(0n);
    await approveAll(stocks, alice, basket);
    await basket.connect(alice).mint(ONE_SHARE, alice);
    await basket.connect(alice).mint(ONE_SHARE, alice);
    await basket.connect(alice).redeem(ONE_SHARE, alice);
    expect(await basket.mintCount()).to.equal(2n);
    expect(await basket.redeemCount()).to.equal(1n);
  });
});
