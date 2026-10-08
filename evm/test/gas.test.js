// Gas snapshot for the user-facing calls. Prints a table so changes in cost are
// visible in every test run, and asserts loose ceilings so a regression fails.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { E6, ONE_SHARE, approveAll, deployCore, freshRecipe, createBasket } = require("./helpers");

const gasOf = async (txPromise) => (await (await txPromise).wait()).gasUsed;

describe("Gas snapshot", () => {
  it("logs gas for createBasket, mint, redeem, placeOrder, fill and cancel", async () => {
    const { factory, desk, usdg, alice, bob, ap, creator, stocks, recipe } = await deployCore();
    const rows = [];
    const record = (op, gas, note) => rows.push({ op, gas: Number(gas), note });

    record("createBasket (3 components)", await gasOf(factory.connect(alice).createBasket("Gas Three", "GAS3", 50, recipe)), "CREATE2 + recipe write");
    const { recipe: eight, tokens: eightTokens } = await freshRecipe(8);
    record("createBasket (8 components)", await gasOf(factory.connect(alice).createBasket("Gas Eight", "GAS8", 50, eight)), "max components");

    const basket = await createBasket(factory, creator, "Gas Basket", "GASB", 50, recipe);
    await approveAll(stocks, alice, basket);
    await approveAll(stocks, bob, basket);
    record("mint (first, cold vault)", await gasOf(basket.connect(alice).mint(ONE_SHARE, alice)), "3 transferFrom + fee mint");
    record("mint (warm vault)", await gasOf(basket.connect(bob).mint(ONE_SHARE, bob)), "steady state");
    record("redeem (partial)", await gasOf(basket.connect(alice).redeem(ONE_SHARE / 2n, alice)), "3 transfers");
    record("redeem (full balance)", await gasOf(basket.connect(alice).redeem(await basket.balanceOf(alice), alice)), "clears holder balance");

    const b8 = await createBasket(factory, creator, "Gas Eight B", "GAS8B", 0, eight);
    for (const t of eightTokens) {
      await t.mint(alice, 10n ** 24n);
      await t.connect(alice).approve(b8, ethers.MaxUint256);
    }
    record("mint (8 components)", await gasOf(b8.connect(alice).mint(ONE_SHARE, alice)), "worst case");
    record("redeem (8 components)", await gasOf(b8.connect(alice).redeem(ONE_SHARE, alice)), "worst case");

    await usdg.connect(alice).approve(desk, ethers.MaxUint256);
    const expiry = (await time.latest()) + 3600;
    record("placeOrder", await gasOf(desk.connect(alice).placeOrder(basket, ONE_SHARE, 23n * E6, expiry)), "escrow USDG");
    await desk.connect(alice).placeOrder(basket, ONE_SHARE, 23n * E6, expiry);
    await approveAll(stocks, ap, desk);
    record("fill (3 components)", await gasOf(desk.connect(ap).fill(0)), "pull, approve, mint, pay");
    record("cancel", await gasOf(desk.connect(alice).cancel(1)), "refund USDG");

    console.table(rows);

    // Ceilings sit about 20% above the measured numbers. Coverage instrumentation
    // inflates gas, so they only apply to normal runs.
    if (hre.__SOLIDITY_COVERAGE_RUNNING) return;
    const ceiling = {
      "createBasket (3 components)": 1_800_000,
      "createBasket (8 components)": 2_250_000,
      "mint (first, cold vault)": 300_000,
      "mint (warm vault)": 180_000,
      "mint (8 components)": 525_000,
      "redeem (partial)": 135_000,
      "redeem (8 components)": 210_000,
      "placeOrder": 245_000,
      "fill (3 components)": 360_000,
      "cancel": 60_000,
    };
    for (const r of rows) if (ceiling[r.op]) expect(r.gas, r.op).to.be.lessThan(ceiling[r.op]);
  });
});
