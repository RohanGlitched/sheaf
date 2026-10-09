// The v2 desk and the plan desk: no admin surface, no upgrade path, and a gas
// snapshot of every user-facing call.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { E6, ONE_SHARE, approveAll, deployV2 } = require("./helpers");

const mutating = (iface) =>
  iface.fragments
    .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
    .map((f) => f.name)
    .sort();

function opcodes(hex) {
  const code = ethers.getBytes(hex);
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const end = code.length - metaLen - 2;
  const ops = new Set();
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc];
    ops.add(op);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  return ops;
}

describe("v2 immutability: no admin, no upgrade, no hidden mutators", () => {
  it("CreationDeskV2: the only state-changing functions place, fill and cancel orders", async () => {
    const { deskV2 } = await loadFixture(deployV2);
    expect(mutating(deskV2.interface)).to.deep.equal(["cancel", "fill", "placeAuction", "placeOrder", "placeOrderFor"]);
  });

  it("PlanDesk: the only state-changing functions open, close and run plans", async () => {
    const { plans } = await loadFixture(deployV2);
    expect(mutating(plans.interface)).to.deep.equal(["closePlan", "instalment", "openPlan"]);
  });

  it("neither is payable, has a receive/fallback, or exposes an admin, fee setter or sweep", async () => {
    const { deskV2, plans } = await loadFixture(deployV2);
    for (const c of [deskV2, plans]) {
      const frags = c.interface.fragments;
      expect(frags.filter((f) => f.type === "fallback" || f.type === "receive")).to.have.length(0);
      expect(frags.filter((f) => f.type === "function" && f.payable)).to.have.length(0);
      const names = frags.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
      for (const bad of ["owner", "admin", "pause", "upgrade", "setfee", "settreasury", "sweep", "rescue", "withdraw"]) {
        expect(names.some((n) => n.includes(bad)), `${bad} in ${names}`).to.equal(false);
      }
    }
  });

  it("their bytecode contains no DELEGATECALL, CALLCODE or SELFDESTRUCT", async () => {
    const { deskV2, plans } = await loadFixture(deployV2);
    for (const c of [deskV2, plans]) {
      const ops = opcodes(await ethers.provider.getCode(c));
      expect(ops.has(0xf4)).to.equal(false);
      expect(ops.has(0xf2)).to.equal(false);
      expect(ops.has(0xff)).to.equal(false);
    }
  });
});

describe("v2 gas snapshot", () => {
  const gasOf = async (p) => (await (await p).wait()).gasUsed;

  it("logs gas for deploys, placeOrder, placeAuction, fill, cancel, openPlan and instalment", async () => {
    const f = await deployV2();
    const { deskV2, plans, usdg, alice, ap, basket, stocks, factory, treasury } = f;
    const rows = [];
    const record = (op, gas) => rows.push({ op, gas: Number(gas) });
    const D = await ethers.getContractFactory("CreationDeskV2");
    const d = await D.deploy(usdg, factory, treasury.address);
    record("deploy CreationDeskV2", (await d.deploymentTransaction().wait()).gasUsed);
    const P = await ethers.getContractFactory("PlanDesk");
    const p = await P.deploy(d);
    record("deploy PlanDesk", (await p.deploymentTransaction().wait()).gasUsed);

    await usdg.connect(alice).approve(deskV2, ethers.MaxUint256);
    await usdg.connect(alice).approve(plans, ethers.MaxUint256);
    await approveAll(stocks, ap, deskV2);
    const s = BigInt(await time.latest()) + 5n;
    record("placeOrder", await gasOf(deskV2.connect(alice).placeOrder(basket, 23n * E6, 2n * ONE_SHARE, ONE_SHARE, s, s + 3600n)));
    record("placeAuction", await gasOf(deskV2.connect(alice).placeAuction(basket, 23n * E6, ONE_SHARE, 200, 3600n, 0n)));
    record("fill (3 components, fees)", await gasOf(deskV2.connect(ap).fill(0)));
    record("cancel", await gasOf(deskV2.connect(alice).cancel(1)));
    record(
      "openPlan",
      await gasOf(plans.connect(alice).openPlan(basket, 10n * E6, 86400n, 3600n, 200, ONE_SHARE / 2n, 2n * ONE_SHARE, ethers.ZeroAddress)),
    );
    record("instalment (first)", await gasOf(plans.connect(alice).instalment(0, ONE_SHARE)));
    await time.increase(86400);
    record("instalment (later)", await gasOf(plans.connect(alice).instalment(0, ONE_SHARE)));
    console.table(rows);
    const ceiling = {
      "deploy CreationDeskV2": 2_500_000,
      "deploy PlanDesk": 2_000_000,
      placeOrder: 200_000,
      placeAuction: 200_000,
      "fill (3 components, fees)": 520_000,
      cancel: 80_000,
      openPlan: 250_000,
      "instalment (first)": 250_000,
      "instalment (later)": 250_000,
    };
    for (const r of rows) expect(r.gas, r.op).to.be.lt(ceiling[r.op]);
  });
});
