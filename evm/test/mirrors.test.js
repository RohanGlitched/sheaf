// MockStock and MockDollar: the labelled testnet mirrors deployed on chains
// with no real tokenized stocks or stablecoin.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18, E6 } = require("./helpers");

describe("Mirrors: MockStock", () => {
  async function deploy() {
    const [a, b] = await ethers.getSigners();
    const t = await (await ethers.getContractFactory("MockStock")).deploy("Tesla (Sheaf testnet mirror)", "TSLA");
    return { a, b, t };
  }

  it("is an 18-decimal token labelled as a mirror", async () => {
    const { t } = await deploy();
    expect(await t.name()).to.equal("Tesla (Sheaf testnet mirror)");
    expect(await t.symbol()).to.equal("TSLA");
    expect(await t.decimals()).to.equal(18n);
    expect(await t.isMirror()).to.equal(true);
  });

  it("lets anyone faucet up to the per-call cap, to themselves or another address", async () => {
    const { a, b, t } = await deploy();
    await t.connect(a).faucet(100n * E18);
    await t.connect(a).mint(b, 5n * E18);
    expect(await t.balanceOf(a)).to.equal(100n * E18);
    expect(await t.balanceOf(b)).to.equal(5n * E18);
  });

  it("refuses a single call above the cap", async () => {
    const { a, t } = await deploy();
    await expect(t.connect(a).faucet(100n * E18 + 1n))
      .to.be.revertedWithCustomError(t, "MintCapExceeded")
      .withArgs(100n * E18 + 1n, 100n * E18);
    await expect(t.mint(a, 101n * E18)).to.be.revertedWithCustomError(t, "MintCapExceeded");
  });
});

describe("Mirrors: MockDollar", () => {
  async function deploy() {
    const [a, b] = await ethers.getSigners();
    const t = await (await ethers.getContractFactory("MockDollar")).deploy("Sheaf Test Dollar (mirror)", "sUSD");
    return { a, b, t };
  }

  it("is a 6-decimal token labelled as a mirror", async () => {
    const { t } = await deploy();
    expect(await t.decimals()).to.equal(6n);
    expect(await t.isMirror()).to.equal(true);
  });

  it("caps each faucet call at 10,000 dollars", async () => {
    const { a, b, t } = await deploy();
    await t.connect(a).faucet(10_000n * E6);
    await t.mint(b, 1n);
    expect(await t.balanceOf(a)).to.equal(10_000n * E6);
    await expect(t.faucet(10_000n * E6 + 1n)).to.be.revertedWithCustomError(t, "MintCapExceeded");
  });

  it("settles a full desk round trip against MockStock components", async () => {
    const [creator, buyer, filler] = await ethers.getSigners();
    const MS = await ethers.getContractFactory("MockStock");
    const s1 = await MS.deploy("Nvidia (Sheaf testnet mirror)", "NVDA");
    const s2 = await MS.deploy("Apple (Sheaf testnet mirror)", "AAPL");
    const usd = await (await ethers.getContractFactory("MockDollar")).deploy("Sheaf Test Dollar (mirror)", "sUSD");
    const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
    const desk = await (await ethers.getContractFactory("CreationDesk")).deploy(usd, factory);
    const recipe = [
      { token: await s1.getAddress(), unitsPerShare: E18 / 20n, weightBps: 6000 },
      { token: await s2.getAddress(), unitsPerShare: E18 / 30n, weightBps: 4000 },
    ];
    await factory.connect(creator).createBasket("Mirror Two", "MIR2", 0, recipe);
    const basket = await ethers.getContractAt("Basket", (await factory.allBaskets())[0]);

    await usd.connect(buyer).faucet(100n * E6);
    await usd.connect(buyer).approve(desk, 20n * E6);
    const expiry = (await ethers.provider.getBlock("latest")).timestamp + 600;
    await desk.connect(buyer).placeOrder(basket, 2n * E18, 20n * E6, expiry);

    for (const s of [s1, s2]) {
      await s.connect(filler).faucet(10n * E18);
      await s.connect(filler).approve(desk, ethers.MaxUint256);
    }
    await desk.connect(filler).fill(0);
    expect(await basket.balanceOf(buyer)).to.equal(2n * E18);
    expect(await usd.balanceOf(filler)).to.equal(20n * E6);
    expect(await s1.balanceOf(basket)).to.equal(E18 / 10n);
  });
});
