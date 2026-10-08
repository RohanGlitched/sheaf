// SheafFactory: deterministic deployment, symbol rules and recipe validation.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E18, deployCore, createBasket, freshRecipe } = require("./helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const symKey = (symbol) => ethers.keccak256(ethers.toUtf8Bytes(symbol));

/// Off-chain CREATE2 prediction: salt = keccak256(abi.encode(creator, keccak256(symbol))),
/// init code = Basket creation bytecode ++ abi-encoded constructor arguments.
async function predictBasket(factory, creator, name, symbol, feeBps, recipe) {
  const Basket = await ethers.getContractFactory("Basket");
  const comps = recipe.map((r) => [r.token, r.unitsPerShare, r.weightBps]);
  const { data: initCode } = await Basket.getDeployTransaction(name, symbol, creator, feeBps, comps);
  const salt = ethers.keccak256(coder.encode(["address", "bytes32"], [creator, symKey(symbol)]));
  return ethers.getCreate2Address(await factory.getAddress(), salt, ethers.keccak256(initCode));
}

describe("SheafFactory: deterministic CREATE2 addresses", () => {
  it("deploys to the address predicted off-chain from creator, symbol salt and init code", async () => {
    const { factory, alice, recipe } = await loadFixture(deployCore);
    const predicted = await predictBasket(factory, alice.address, "Chip Makers", "CHIPS", 25, recipe);
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    await expect(factory.connect(alice).createBasket("Chip Makers", "CHIPS", 25, recipe))
      .to.emit(factory, "BasketCreated")
      .withArgs(predicted, alice.address, "Chip Makers", "CHIPS", 25, 3);
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    expect(await factory.basketOf(alice, symKey("CHIPS"))).to.equal(predicted);
    expect(await factory.isBasket(predicted)).to.equal(true);
    expect((await factory.allBaskets()).at(-1)).to.equal(predicted);
  });

  it("an attacker copying a creator's exact call cannot squat the creator's predicted address", async () => {
    const { factory, alice, bob, recipe } = await loadFixture(deployCore);
    const forAlice = await predictBasket(factory, alice.address, "Front Run", "FR", 0, recipe);
    const bobsBasket = await createBasket(factory, bob, "Front Run", "FR", 0, recipe);
    expect(await bobsBasket.getAddress()).to.not.equal(forAlice);
    const alicesBasket = await createBasket(factory, alice, "Front Run", "FR", 0, recipe);
    expect(await alicesBasket.getAddress()).to.equal(forAlice);
    expect(await alicesBasket.creator()).to.equal(alice.address);
  });
});

describe("SheafFactory: symbols", () => {
  it("the same creator cannot reuse a symbol: SymbolTaken(existing)", async () => {
    const { factory, creator, basket, recipe } = await loadFixture(deployCore);
    await expect(factory.connect(creator).createBasket("Different Name", "SAS", 0, recipe))
      .to.be.revertedWithCustomError(factory, "SymbolTaken")
      .withArgs(await basket.getAddress());
  });

  it("different creators may reuse a symbol and get different baskets", async () => {
    const { factory, creator, alice, bob, basket, recipe } = await loadFixture(deployCore);
    const a = await createBasket(factory, alice, "Streaming and Stuff", "SAS", 50, recipe);
    const b = await createBasket(factory, bob, "Streaming and Stuff", "SAS", 50, recipe);
    const addrs = new Set([await basket.getAddress(), await a.getAddress(), await b.getAddress()]);
    expect(addrs.size).to.equal(3);
    expect(await factory.basketOf(creator, symKey("SAS"))).to.equal(await basket.getAddress());
    expect(await factory.basketOf(alice, symKey("SAS"))).to.equal(await a.getAddress());
    expect(await factory.basketOf(bob, symKey("SAS"))).to.equal(await b.getAddress());
    expect(await factory.basketCount()).to.equal(3n);
  });

  it("symbols are exact bytes: case variants are distinct symbols", async () => {
    const { factory, creator, recipe } = await loadFixture(deployCore);
    await expect(factory.connect(creator).createBasket("lower", "sas", 0, recipe)).to.emit(factory, "BasketCreated");
  });

  it("enforces name 1..32 bytes and symbol 1..10 bytes, counting UTF-8 bytes", async () => {
    const { factory, alice, recipe } = await loadFixture(deployCore);
    const f = factory.connect(alice);
    await expect(f.createBasket("n".repeat(32), "S".repeat(10), 0, recipe)).to.emit(factory, "BasketCreated");
    await expect(f.createBasket("n".repeat(33), "S2", 0, recipe)).to.be.revertedWithCustomError(f, "BadName");
    await expect(f.createBasket("ok", "S".repeat(11), 0, recipe)).to.be.revertedWithCustomError(f, "BadSymbol");
    // 4 x 3-byte characters = 12 bytes > 10
    await expect(f.createBasket("ok", "€€€€", 0, recipe)).to.be.revertedWithCustomError(f, "BadSymbol");
  });
});

describe("SheafFactory: recipe validation", () => {
  it("accepts exactly 8 components and rejects 9 with BadComponentCount", async () => {
    const { factory, alice } = await loadFixture(deployCore);
    const { recipe: eight } = await freshRecipe(8);
    const b = await createBasket(factory, alice, "Eight", "EIGHT", 0, eight);
    expect(await b.componentCount()).to.equal(8n);
    const { recipe: nine } = await freshRecipe(9);
    await expect(factory.connect(alice).createBasket("Nine", "NINE", 0, nine)).to.be.revertedWithCustomError(factory, "BadComponentCount");
  });

  it("accepts a single-component basket", async () => {
    const { factory, alice } = await loadFixture(deployCore);
    const { recipe } = await freshRecipe(1);
    expect(await (await createBasket(factory, alice, "One", "ONE", 0, recipe)).componentCount()).to.equal(1n);
  });

  it("rejects a duplicate component anywhere in the list with DuplicateComponent(token)", async () => {
    const { factory, alice } = await loadFixture(deployCore);
    const { recipe } = await freshRecipe(6);
    recipe[5] = { ...recipe[5], token: recipe[1].token };
    await expect(factory.connect(alice).createBasket("Dup", "DUP", 0, recipe))
      .to.be.revertedWithCustomError(factory, "DuplicateComponent")
      .withArgs(recipe[1].token);
  });

  it("rejects zero units, zero weight and the zero address", async () => {
    const { factory, alice } = await loadFixture(deployCore);
    const { recipe } = await freshRecipe(3);
    const f = factory.connect(alice);
    const at = (i, patch) => recipe.map((r, j) => (j === i ? { ...r, ...patch } : r));
    await expect(f.createBasket("Z", "Z", 0, at(2, { unitsPerShare: 0n }))).to.be.revertedWithCustomError(f, "ZeroUnits");
    await expect(f.createBasket("Z", "Z", 0, at(1, { weightBps: 0 }))).to.be.revertedWithCustomError(f, "ZeroWeight");
    await expect(f.createBasket("Z", "Z", 0, at(0, { token: ethers.ZeroAddress }))).to.be.revertedWithCustomError(f, "ZeroToken");
  });

  it("weights must sum to exactly 10000 bps", async () => {
    const { factory, alice } = await loadFixture(deployCore);
    const { recipe } = await freshRecipe(2);
    const f = factory.connect(alice);
    await expect(f.createBasket("W", "W", 0, [recipe[0], { ...recipe[1], weightBps: recipe[1].weightBps + 1 }]))
      .to.be.revertedWithCustomError(f, "WeightsMustSumToOne")
      .withArgs(10001);
    await expect(f.createBasket("W", "W", 0, [recipe[0], { ...recipe[1], weightBps: recipe[1].weightBps - 1 }]))
      .to.be.revertedWithCustomError(f, "WeightsMustSumToOne")
      .withArgs(9999);
  });

  it("caps the creator fee: 100 bps is accepted, 101 reverts CreatorFeeTooHigh", async () => {
    const { factory, alice, recipe } = await loadFixture(deployCore);
    const b = await createBasket(factory, alice, "Fee Cap", "CAP", 100, recipe);
    expect(await b.creatorFeeBps()).to.equal(100n);
    expect(await b.MAX_CREATOR_FEE_BPS()).to.equal(100n);
    await expect(factory.connect(alice).createBasket("Fee Cap 2", "CAP2", 101, recipe)).to.be.revertedWithCustomError(factory, "CreatorFeeTooHigh");
  });

  it("factory limits agree with the Basket's published constants", async () => {
    const { factory, basket } = await loadFixture(deployCore);
    expect(await basket.MAX_COMPONENTS()).to.equal(8n);
    expect(await basket.ONE_SHARE()).to.equal(E18);
    expect(await factory.MAX_NAME_LEN()).to.equal(32n);
    expect(await factory.MAX_SYMBOL_LEN()).to.equal(10n);
  });
});
