// Every event, with every argument checked exactly. Indexers and the web app
// depend on these, so they are part of the contracts' interface.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E6, ONE_SHARE, approveAll, deployCore, createBasket } = require("./helpers");

describe("Events: exact arguments", () => {
  it("BasketCreated(basket, creator, name, symbol, creatorFeeBps, componentCount)", async () => {
    const { factory, bob, recipe } = await loadFixture(deployCore);
    const addr = await factory.connect(bob).createBasket.staticCall("Big Tech", "BIGT", 75, recipe);
    await expect(factory.connect(bob).createBasket("Big Tech", "BIGT", 75, recipe))
      .to.emit(factory, "BasketCreated")
      .withArgs(addr, bob.address, "Big Tech", "BIGT", 75, 3);
  });

  it("SharesMinted(payer, receiver, net, fee, amountsIn) with a creator fee", async () => {
    const { basket, alice, carol, stocks } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    const shares = 7n * ONE_SHARE + 3n;
    const amounts = await basket.previewMint(shares);
    const fee = (shares * 50n) / 10000n;
    await expect(basket.connect(alice).mint(shares, carol))
      .to.emit(basket, "SharesMinted")
      .withArgs(alice.address, carol.address, shares - fee, fee, amounts);
  });

  it("SharesMinted with zero fee mints no creator shares and emits no creator Transfer", async () => {
    const { factory, alice, stocks, recipe, creator } = await loadFixture(deployCore);
    const b = await createBasket(factory, creator, "No Fee", "NOFEE", 0, recipe);
    await approveAll(stocks, alice, b);
    const amounts = await b.previewMint(ONE_SHARE);
    const tx = b.connect(alice).mint(ONE_SHARE, alice);
    await expect(tx).to.emit(b, "SharesMinted").withArgs(alice.address, alice.address, ONE_SHARE, 0n, amounts);
    await expect(tx).to.emit(b, "Transfer").withArgs(ethers.ZeroAddress, alice.address, ONE_SHARE);
    const receipt = await (await tx).wait();
    const mintsTo = receipt.logs
      .filter((l) => l.address === b.target)
      .map((l) => b.interface.parseLog(l))
      .filter((e) => e && e.name === "Transfer")
      .map((e) => e.args.to);
    expect(mintsTo).to.deep.equal([alice.address]);
    expect(await b.balanceOf(creator)).to.equal(0n);
  });

  it("SharesRedeemed(owner, receiver, sharesBurned, amountsOut)", async () => {
    const { basket, alice, bob, stocks } = await loadFixture(deployCore);
    await approveAll(stocks, alice, basket);
    await basket.connect(alice).mint(3n * ONE_SHARE, alice);
    const burn = ONE_SHARE + 12345n;
    const out = await basket.previewRedeem(burn);
    await expect(basket.connect(alice).redeem(burn, bob))
      .to.emit(basket, "SharesRedeemed")
      .withArgs(alice.address, bob.address, burn, out);
  });

  it("OrderPlaced(id, buyer, basket, shares, usdgAmount, expiry)", async () => {
    const { desk, usdg, basket, alice, bob } = await loadFixture(deployCore);
    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    await usdg.connect(bob).approve(desk, ethers.MaxUint256);
    const expiry = (await time.latest()) + 900;
    await expect(desk.connect(alice).placeOrder(basket, 2n * ONE_SHARE, 46n * E6, expiry))
      .to.emit(desk, "OrderPlaced")
      .withArgs(0, alice.address, await basket.getAddress(), 2n * ONE_SHARE, 46n * E6, expiry);
    await expect(desk.connect(bob).placeOrder(basket, ONE_SHARE, 23n * E6, expiry))
      .to.emit(desk, "OrderPlaced")
      .withArgs(1, bob.address, await basket.getAddress(), ONE_SHARE, 23n * E6, expiry);
  });

  it("OrderFilled(id, filler, sharesDelivered) reports net shares, alongside the basket's SharesMinted", async () => {
    const { desk, usdg, basket, alice, ap, stocks } = await loadFixture(deployCore);
    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    await desk.connect(alice).placeOrder(basket, 4n * ONE_SHARE, 92n * E6, (await time.latest()) + 900);
    await approveAll(stocks, ap, desk);
    const [net, fee] = await basket.previewNetShares(4n * ONE_SHARE);
    const amounts = await basket.previewMint(4n * ONE_SHARE);
    const tx = desk.connect(ap).fill(0);
    await expect(tx).to.emit(desk, "OrderFilled").withArgs(0, ap.address, net);
    await expect(tx)
      .to.emit(basket, "SharesMinted")
      .withArgs(await desk.getAddress(), alice.address, net, fee, amounts);
    await expect(tx).to.emit(usdg, "Transfer").withArgs(await desk.getAddress(), ap.address, 92n * E6);
  });

  it("OrderCancelled(id) for buyer and third-party cancels", async () => {
    const { desk, usdg, basket, alice, bob } = await loadFixture(deployCore);
    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    const expiry = (await time.latest()) + 900;
    await desk.connect(alice).placeOrder(basket, ONE_SHARE, E6, expiry);
    await desk.connect(alice).placeOrder(basket, ONE_SHARE, E6, expiry);
    await expect(desk.connect(alice).cancel(0)).to.emit(desk, "OrderCancelled").withArgs(0);
    await time.increaseTo(expiry + 1);
    const tx = desk.connect(bob).cancel(1);
    await expect(tx).to.emit(desk, "OrderCancelled").withArgs(1);
    await expect(tx).to.emit(usdg, "Transfer").withArgs(await desk.getAddress(), alice.address, E6);
  });
});
