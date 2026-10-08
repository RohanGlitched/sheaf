// No admin surface: proves from the ABI and the bytecode itself that nothing
// can change a recipe, move funds outside the documented flows, or upgrade code.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployCore } = require("./helpers");

const mutating = (iface) =>
  iface.fragments
    .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
    .map((f) => f.name)
    .sort();

/// Opcodes in deployed runtime code, skipping PUSH data and the CBOR metadata trailer.
function opcodes(hex) {
  const code = ethers.getBytes(hex);
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const end = code.length - metaLen - 2;
  const ops = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    ops.add(op);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f; // PUSH1..PUSH32
  }
  return ops;
}

const DELEGATECALL = 0xf4;
const CALLCODE = 0xf2;
const SELFDESTRUCT = 0xff;

describe("Immutability: no admin, no upgrade, no hidden mutators", () => {
  it("Basket: the only state-changing functions are ERC-20 transfers/approvals plus mint and redeem", async () => {
    const { basket } = await loadFixture(deployCore);
    expect(mutating(basket.interface)).to.deep.equal(["approve", "mint", "redeem", "transfer", "transferFrom"]);
  });

  it("CreationDesk: the only state-changing functions are placeOrder, fill and cancel", async () => {
    const { desk } = await loadFixture(deployCore);
    expect(mutating(desk.interface)).to.deep.equal(["cancel", "fill", "placeOrder"]);
  });

  it("SheafFactory: the only state-changing function is createBasket", async () => {
    const { factory } = await loadFixture(deployCore);
    expect(mutating(factory.interface)).to.deep.equal(["createBasket"]);
  });

  it("none of the three contracts is payable, has a receive/fallback, or exposes an owner/admin role", async () => {
    const { basket, desk, factory } = await loadFixture(deployCore);
    for (const c of [basket, desk, factory]) {
      const frags = c.interface.fragments;
      expect(frags.filter((f) => f.type === "fallback" || f.type === "receive")).to.have.length(0);
      expect(frags.filter((f) => f.type === "function" && f.payable)).to.have.length(0);
      const names = frags.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
      for (const bad of ["owner", "admin", "pause", "unpause", "upgradeto", "setfee", "sweep", "rescue", "withdraw"]) {
        expect(names.some((n) => n.includes(bad)), `${bad} in ${names}`).to.equal(false);
      }
    }
  });

  it("deployed Basket and CreationDesk bytecode contains no DELEGATECALL, CALLCODE or SELFDESTRUCT", async () => {
    const { basket, desk } = await loadFixture(deployCore);
    for (const c of [basket, desk]) {
      const ops = opcodes(await ethers.provider.getCode(c));
      expect(ops.has(DELEGATECALL)).to.equal(false);
      expect(ops.has(CALLCODE)).to.equal(false);
      expect(ops.has(SELFDESTRUCT)).to.equal(false);
    }
  });

  it("a factory-made basket runs exactly the compiled Basket code, immutables aside (what explorer verification checks)", async () => {
    const { basket } = await loadFixture(deployCore);
    const fqn = "contracts/Basket.sol:Basket";
    const art = await artifacts.readArtifact("Basket");
    const build = await artifacts.getBuildInfo(fqn);
    const refs = build.output.contracts["contracts/Basket.sol"].Basket.evm.deployedBytecode.immutableReferences || {};
    const onchain = ethers.getBytes(await ethers.provider.getCode(basket));
    const compiled = ethers.getBytes(art.deployedBytecode);
    expect(onchain.length).to.equal(compiled.length);
    const mask = new Uint8Array(compiled.length);
    let masked = 0;
    for (const ranges of Object.values(refs)) {
      for (const { start, length } of ranges) {
        mask.fill(1, start, start + length);
        masked += length;
      }
    }
    // factory, creator, creatorFeeBps, createdAt: four immutables, 32 bytes per reference.
    expect(Object.keys(refs)).to.have.length(4);
    for (let i = 0; i < compiled.length; i++) {
      if (!mask[i] && onchain[i] !== compiled[i]) expect.fail(`byte ${i} differs outside immutables`);
    }
    expect(masked).to.be.greaterThan(0);
  });

  it("recipe, creator and fee read back identically after heavy use (no setter exists to change them)", async () => {
    const { basket, alice, stocks, recipe, creator } = await loadFixture(deployCore);
    for (const t of stocks) await t.connect(alice).approve(basket, ethers.MaxUint256);
    for (let i = 0; i < 5; i++) await basket.connect(alice).mint(10n ** 18n, alice);
    await basket.connect(alice).redeem(await basket.balanceOf(alice), alice);
    const comps = await basket.components();
    comps.forEach((c, i) => {
      expect(c.token).to.equal(recipe[i].token);
      expect(c.unitsPerShare).to.equal(recipe[i].unitsPerShare);
      expect(c.weightBps).to.equal(BigInt(recipe[i].weightBps));
    });
    expect(await basket.creator()).to.equal(creator.address);
    expect(await basket.creatorFeeBps()).to.equal(50n);
  });
});
