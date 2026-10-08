const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const E18 = 10n ** 18n;
const ONE_SHARE = E18;

async function deploy() {
  const [creator, alice, bob, ap] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const tsla = await Mock.deploy("Tesla", "TSLA", 18);
  const amzn = await Mock.deploy("Amazon", "AMZN", 18);
  const nflx = await Mock.deploy("Netflix", "NFLX", 18);
  const usdg = await Mock.deploy("Global Dollar", "USDG", 6);
  const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
  const desk = await (await ethers.getContractFactory("CreationDesk")).deploy(usdg, factory);

  for (const t of [tsla, amzn, nflx]) {
    for (const s of [alice, bob, ap]) await t.mint(s, 1000n * E18);
  }
  for (const s of [alice, bob]) await usdg.mint(s, 1_000_000n * 10n ** 6n);

  // 1 share = 0.02 TSLA + 0.03 AMZN + 0.007 NFLX (roughly $7.40 + $6.60 + $8.50)
  const recipe = [
    { token: await tsla.getAddress(), unitsPerShare: 2n * E18 / 100n, weightBps: 3300 },
    { token: await amzn.getAddress(), unitsPerShare: 3n * E18 / 100n, weightBps: 3000 },
    { token: await nflx.getAddress(), unitsPerShare: 7n * E18 / 1000n, weightBps: 3700 },
  ];
  await factory.connect(creator).createBasket("Streaming and Stuff", "SAS", 50, recipe);
  const basket = await ethers.getContractAt("Basket", (await factory.allBaskets())[0]);
  return { creator, alice, bob, ap, tsla, amzn, nflx, usdg, factory, desk, basket, recipe };
}

async function approveAll(tokens, owner, spender) {
  for (const t of tokens) await t.connect(owner).approve(spender, ethers.MaxUint256);
}

describe("SheafFactory", () => {
  it("publishes a basket with the recipe, creator and fee it was given", async () => {
    const { basket, creator, recipe, factory } = await loadFixture(deploy);
    expect(await basket.name()).to.equal("Streaming and Stuff");
    expect(await basket.symbol()).to.equal("SAS");
    expect(await basket.creator()).to.equal(creator.address);
    expect(await basket.creatorFeeBps()).to.equal(50);
    expect(await basket.factory()).to.equal(await factory.getAddress());
    const comps = await basket.components();
    expect(comps.length).to.equal(3);
    comps.forEach((c, i) => {
      expect(c.token).to.equal(recipe[i].token);
      expect(c.unitsPerShare).to.equal(recipe[i].unitsPerShare);
      expect(c.weightBps).to.equal(recipe[i].weightBps);
    });
    expect(await factory.isBasket(basket)).to.equal(true);
    expect(await factory.basketCount()).to.equal(1);
  });

  it("rejects recipes that break the rules", async () => {
    const { factory, recipe, tsla } = await loadFixture(deploy);
    const f = factory;
    await expect(f.createBasket("", "X", 0, recipe)).to.be.revertedWithCustomError(f, "BadName");
    await expect(f.createBasket("x".repeat(33), "X", 0, recipe)).to.be.revertedWithCustomError(f, "BadName");
    await expect(f.createBasket("A", "", 0, recipe)).to.be.revertedWithCustomError(f, "BadSymbol");
    await expect(f.createBasket("A", "ELEVENCHARS", 0, recipe)).to.be.revertedWithCustomError(f, "BadSymbol");
    await expect(f.createBasket("A", "X", 101, recipe)).to.be.revertedWithCustomError(f, "CreatorFeeTooHigh");
    await expect(f.createBasket("A", "X", 0, [])).to.be.revertedWithCustomError(f, "BadComponentCount");
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...recipe[0], token: ethers.Wallet.createRandom().address }));
    await expect(f.createBasket("A", "X", 0, nine)).to.be.revertedWithCustomError(f, "BadComponentCount");
    await expect(f.createBasket("A", "X", 0, [{ ...recipe[0], weightBps: 9999 }]))
      .to.be.revertedWithCustomError(f, "WeightsMustSumToOne").withArgs(9999);
    await expect(f.createBasket("A", "X", 0, [{ ...recipe[0], unitsPerShare: 0, weightBps: 10000 }]))
      .to.be.revertedWithCustomError(f, "ZeroUnits");
    await expect(f.createBasket("A", "X", 0, [{ ...recipe[0], weightBps: 0 }, { ...recipe[1], weightBps: 10000 }]))
      .to.be.revertedWithCustomError(f, "ZeroWeight");
    await expect(f.createBasket("A", "X", 0, [{ ...recipe[0], weightBps: 5000 }, { ...recipe[0], weightBps: 5000 }]))
      .to.be.revertedWithCustomError(f, "DuplicateComponent").withArgs(await tsla.getAddress());
    await expect(f.createBasket("A", "X", 0, [{ ...recipe[0], token: ethers.ZeroAddress, weightBps: 10000 }]))
      .to.be.revertedWithCustomError(f, "ZeroToken");
  });

  it("stops a creator reusing their own symbol but lets others use it", async () => {
    const { factory, recipe, creator, alice } = await loadFixture(deploy);
    await expect(factory.connect(creator).createBasket("Again", "SAS", 0, recipe))
      .to.be.revertedWithCustomError(factory, "SymbolTaken");
    await expect(factory.connect(alice).createBasket("Mine", "SAS", 0, recipe)).to.emit(factory, "BasketCreated");
    expect(await factory.basketCount()).to.equal(2);
  });
});

describe("Basket", () => {
  it("mints in kind, charging the creator fee in shares", async () => {
    const { basket, alice, creator, tsla, amzn, nflx } = await loadFixture(deploy);
    await approveAll([tsla, amzn, nflx], alice, basket);
    const shares = 10n * ONE_SHARE;
    const expected = await basket.previewMint(shares);
    await expect(basket.connect(alice).mint(shares, alice))
      .to.emit(basket, "SharesMinted")
      .withArgs(alice.address, alice.address, shares - shares / 200n, shares / 200n, expected);
    expect(await basket.balanceOf(alice)).to.equal(shares - shares / 200n);
    expect(await basket.balanceOf(creator)).to.equal(shares / 200n);
    expect(await basket.totalSupply()).to.equal(shares);
    expect(await basket.vaultBalances()).to.deep.equal(expected);
    expect(await tsla.balanceOf(basket)).to.equal(2n * E18 / 10n);
  });

  it("redeems pro rata back to the holder", async () => {
    const { basket, alice, bob, tsla, amzn, nflx } = await loadFixture(deploy);
    await approveAll([tsla, amzn, nflx], alice, basket);
    await basket.connect(alice).mint(4n * ONE_SHARE, alice);
    const held = await basket.balanceOf(alice);
    const before = await amzn.balanceOf(bob);
    const out = await basket.previewRedeem(held);
    await expect(basket.connect(alice).redeem(held, bob)).to.emit(basket, "SharesRedeemed");
    expect(await amzn.balanceOf(bob)).to.equal(before + out[1]);
    expect(await basket.balanceOf(alice)).to.equal(0);
    expect(await basket.redeemCount()).to.equal(1);
  });

  it("rounds deposits up and withdrawals down, so the vault never ends short", async () => {
    const { basket, alice, bob, tsla, amzn, nflx } = await loadFixture(deploy);
    await approveAll([tsla, amzn, nflx], alice, basket);
    await approveAll([tsla, amzn, nflx], bob, basket);
    // Odd-sized mints and redemptions designed to produce rounding remainders.
    const sizes = [1n, 7n, 333n, 10n ** 12n + 1n, 123456789n, ONE_SHARE + 3n];
    for (const s of sizes) {
      await basket.connect(alice).mint(s * 1000n + 1n, alice);
      await basket.connect(bob).mint(s * 977n + 13n, bob);
    }
    for (const who of [alice, bob]) {
      let bal = await basket.balanceOf(who);
      while (bal > 0n) {
        const chunk = bal > 3n ? bal / 3n + 1n : bal;
        await basket.connect(who).redeem(chunk, who);
        bal -= chunk;
      }
    }
    // Only the creator's fee shares remain; the vault must cover all of them.
    const supply = await basket.totalSupply();
    const owed = await basket.previewRedeem(supply);
    const held = await basket.vaultBalances();
    held.forEach((h, i) => expect(h).to.be.gte(owed[i]));
  });

  it("refuses zero, dust and missing approvals", async () => {
    const { basket, alice, tsla, amzn, nflx } = await loadFixture(deploy);
    await expect(basket.connect(alice).mint(0, alice)).to.be.revertedWithCustomError(basket, "ZeroShares");
    await expect(basket.connect(alice).redeem(0, alice)).to.be.revertedWithCustomError(basket, "ZeroShares");
    await expect(basket.connect(alice).mint(ONE_SHARE, alice)).to.be.reverted; // no allowance
    await approveAll([tsla, amzn, nflx], alice, basket);
    await expect(basket.connect(alice).redeem(1, alice)).to.be.reverted; // no shares
  });

  it("refuses tokens that skim on transfer", async () => {
    const { factory, alice } = await loadFixture(deploy);
    const skim = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy();
    await skim.mint(alice, 1000n * E18);
    await factory.connect(alice).createBasket("Skim", "SK", 0, [
      { token: await skim.getAddress(), unitsPerShare: E18, weightBps: 10000 },
    ]);
    const b = await ethers.getContractAt("Basket", (await factory.allBaskets())[1]);
    await skim.connect(alice).approve(b, ethers.MaxUint256);
    await expect(b.connect(alice).mint(ONE_SHARE, alice)).to.be.revertedWithCustomError(b, "ShortDeposit");
  });

  it("has no way to change the recipe after creation", async () => {
    const { basket } = await loadFixture(deploy);
    const mutating = basket.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    expect(mutating).to.deep.equal(["approve", "mint", "redeem", "transfer", "transferFrom"]);
  });
});

describe("CreationDesk", () => {
  async function withOrder() {
    const f = await deploy();
    const { desk, usdg, alice, basket } = f;
    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    const expiry = (await time.latest()) + 3600;
    await desk.connect(alice).placeOrder(basket, 5n * ONE_SHARE, 115_000_000n, expiry);
    return { ...f, expiry };
  }

  it("escrows USDG for an order", async () => {
    const { desk, usdg, alice, basket } = await loadFixture(withOrder);
    const o = await desk.getOrder(0);
    expect(o.buyer).to.equal(alice.address);
    expect(o.basket).to.equal(await basket.getAddress());
    expect(o.status).to.equal(1);
    expect(await usdg.balanceOf(desk)).to.equal(115_000_000n);
  });

  it("lets a participant fill with stock tokens: buyer gets shares, filler gets USDG", async () => {
    const { desk, usdg, alice, ap, basket, tsla, amzn, nflx } = await loadFixture(withOrder);
    await approveAll([tsla, amzn, nflx], ap, desk);
    const [net] = await basket.previewNetShares(5n * ONE_SHARE);
    await expect(desk.connect(ap).fill(0)).to.emit(desk, "OrderFilled").withArgs(0, ap.address, net);
    expect(await basket.balanceOf(alice)).to.equal(net);
    expect(await usdg.balanceOf(ap)).to.equal(115_000_000n);
    expect(await usdg.balanceOf(desk)).to.equal(0);
    expect((await desk.getOrder(0)).status).to.equal(2);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "NotOpen");
  });

  it("refunds on cancel, and only the buyer may cancel before expiry", async () => {
    const { desk, usdg, alice, bob } = await loadFixture(withOrder);
    await expect(desk.connect(bob).cancel(0)).to.be.revertedWithCustomError(desk, "NotBuyer");
    const before = await usdg.balanceOf(alice);
    await desk.connect(alice).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + 115_000_000n);
    await expect(desk.connect(alice).cancel(0)).to.be.revertedWithCustomError(desk, "NotOpen");
  });

  it("stops fills after expiry and lets anyone return the USDG", async () => {
    const { desk, usdg, alice, bob, ap, tsla, amzn, nflx, expiry } = await loadFixture(withOrder);
    await time.increaseTo(expiry + 1);
    await approveAll([tsla, amzn, nflx], ap, desk);
    await expect(desk.connect(ap).fill(0)).to.be.revertedWithCustomError(desk, "Expired");
    const before = await usdg.balanceOf(alice);
    await desk.connect(bob).cancel(0);
    expect(await usdg.balanceOf(alice)).to.equal(before + 115_000_000n);
  });

  it("only accepts baskets from the Sheaf factory", async () => {
    const { desk, alice, tsla } = await loadFixture(withOrder);
    const expiry = (await time.latest()) + 60;
    await expect(desk.connect(alice).placeOrder(tsla, 1, 1, expiry)).to.be.revertedWithCustomError(desk, "UnknownBasket");
  });
});
