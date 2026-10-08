// Property-style tests. Every random choice comes from a seeded PRNG, so a run
// is fully deterministic and any failure can be replayed by its seed.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { E18, ONE_SHARE, prng, ceilDiv, createBasket } = require("./helpers");

const BIG = 10n ** 36n; // plenty of raw units per actor for every scenario

/// A basket with deliberately awkward recipes: an 18-dec token with an odd unit
/// count, a 6-dec token at 7 raw units per share (so almost every mint and
/// redemption rounds) and an 8-dec token at 123456789 units.
async function scenario(feeBps, unitsOverride) {
  const signers = await ethers.getSigners();
  const creator = signers[0];
  const users = signers.slice(1, 5);
  const Mock = await ethers.getContractFactory("MockERC20");
  const specs = [
    ["Odd", "ODD", 18, 2n * 10n ** 16n + 1n, 4000],
    ["Tiny", "TINY", 6, 7n, 3500],
    ["Mid", "MID", 8, 123456789n, 2500],
  ];
  const tokens = [];
  const recipe = [];
  for (const [n, s, d, u, w] of specs) {
    const t = await Mock.deploy(n, s, d);
    tokens.push(t);
    recipe.push({ token: await t.getAddress(), unitsPerShare: unitsOverride ?? u, weightBps: w });
  }
  const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
  const basket = await createBasket(factory, creator, "Awkward Recipe", "AWK", feeBps, recipe);
  for (const t of tokens) {
    for (const u of users) {
      await t.mint(u, BIG);
      await t.connect(u).approve(basket, ethers.MaxUint256);
    }
    await t.mint(creator, BIG); // creator only uses this for donations
  }
  return { creator, users, tokens, recipe, basket, units: recipe.map((r) => r.unitsPerShare) };
}

/// Shares drawn across many orders of magnitude, from 1 wei to 50 whole shares.
function drawShares(r) {
  const bucket = r.int(0, 3);
  if (bucket === 0) return BigInt(r.int(1, 1000));
  if (bucket === 1) return 1n + r.big(10n ** 12n);
  if (bucket === 2) return 1n + r.big(ONE_SHARE);
  return 1n + r.big(50n * ONE_SHARE);
}

async function runScenario({ seed, feeBps, steps, unitsOverride }) {
  const r = prng(seed);
  const { creator, users, tokens, basket, units } = await scenario(feeBps, unitsOverride);
  const actors = [creator, ...users];
  const model = {
    supply: 0n,
    bal: new Map(actors.map((a) => [a.address, 0n])),
    vault: tokens.map(() => 0n),
  };
  const stats = { mint: 0, redeem: 0, transfer: 0, donate: 0, roundedMint: 0, roundedRedeem: 0 };

  const tokenBalances = (who) => Promise.all(tokens.map((t) => t.balanceOf(who)));

  async function check(step) {
    const supply = await basket.totalSupply();
    expect(supply, `supply @${step}`).to.equal(model.supply);
    let sum = 0n;
    for (const a of actors) {
      const b = await basket.balanceOf(a);
      expect(b, `balance ${a.address} @${step}`).to.equal(model.bal.get(a.address));
      sum += b;
    }
    expect(sum, `sum of balances @${step}`).to.equal(supply);
    const vault = await basket.vaultBalances();
    const owed = await basket.previewRedeem(supply);
    vault.forEach((v, i) => {
      expect(v, `vault model ${i} @${step}`).to.equal(model.vault[i]);
      // What every holder could claim at once is covered...
      expect(v, `vault ${i} >= previewRedeem(totalSupply) @${step}`).to.be.gte(owed[i]);
      // ...and so is the exact, unrounded backing of every share.
      expect(v * ONE_SHARE, `exact backing ${i} @${step}`).to.be.gte(units[i] * supply);
    });
  }

  for (let step = 0; step < steps; step++) {
    const roll = r.next();
    const holders = actors.filter((a) => model.bal.get(a.address) > 0n);

    if (roll < 0.42 || holders.length === 0) {
      // ------------------------------------------------------------- mint
      const payer = r.pick(users);
      const receiver = r.next() < 0.7 ? payer : r.pick(users);
      const shares = drawShares(r);
      const expected = units.map((u) => ceilDiv(u * shares, ONE_SHARE));
      if (expected.some((e, i) => e * ONE_SHARE !== units[i] * shares)) stats.roundedMint++;
      const fee = (shares * BigInt(feeBps)) / 10000n;
      const net = shares - fee;
      const before = await tokenBalances(payer);
      await basket.connect(payer).mint(shares, receiver);
      const after = await tokenBalances(payer);
      after.forEach((a, i) => expect(before[i] - a, `mint pulled ${i} @${step}`).to.equal(expected[i]));
      model.supply += shares;
      model.bal.set(receiver.address, model.bal.get(receiver.address) + net);
      model.bal.set(creator.address, model.bal.get(creator.address) + fee);
      expected.forEach((e, i) => (model.vault[i] += e));
      stats.mint++;
    } else if (roll < 0.8) {
      // ----------------------------------------------------------- redeem
      const owner = r.pick(holders);
      const bal = model.bal.get(owner.address);
      const mode = r.int(0, 3);
      const shares = mode === 0 ? bal : mode === 1 ? 1n : 1n + r.big(bal - 1n);
      const receiver = r.next() < 0.7 ? owner : r.pick(actors);
      const expected = units.map((u) => (u * shares) / ONE_SHARE);
      if (expected.some((e, i) => e * ONE_SHARE !== units[i] * shares)) stats.roundedRedeem++;
      const before = await tokenBalances(receiver);
      await basket.connect(owner).redeem(shares, receiver);
      const after = await tokenBalances(receiver);
      after.forEach((a, i) => expect(a - before[i], `redeem paid ${i} @${step}`).to.equal(expected[i]));
      model.supply -= shares;
      model.bal.set(owner.address, bal - shares);
      expected.forEach((e, i) => (model.vault[i] -= e));
      stats.redeem++;
    } else if (roll < 0.95) {
      // --------------------------------------------- share transfer (P2P)
      const from = r.pick(holders);
      const to = r.pick(actors);
      const amt = 1n + r.big(model.bal.get(from.address) - 1n);
      await basket.connect(from).transfer(to, amt);
      model.bal.set(from.address, model.bal.get(from.address) - amt);
      model.bal.set(to.address, model.bal.get(to.address) + amt);
      stats.transfer++;
    } else {
      // ------------------------------- donation straight into the vault
      const i = r.int(0, tokens.length - 1);
      const amt = 1n + r.big(1000n);
      await tokens[i].connect(creator).transfer(basket, amt);
      model.vault[i] += amt;
      stats.donate++;
    }
    await check(step);
  }

  // Bank run: every holder, creator included, exits in full. All must succeed.
  for (const a of actors) {
    const bal = model.bal.get(a.address);
    if (bal === 0n) continue;
    const expected = units.map((u) => (u * bal) / ONE_SHARE);
    await basket.connect(a).redeem(bal, a);
    model.supply -= bal;
    model.bal.set(a.address, 0n);
    expected.forEach((e, i) => (model.vault[i] -= e));
  }
  await check("drain");
  expect(await basket.totalSupply()).to.equal(0n);
  // Whatever is left is rounding dust plus donations, never a deficit.
  const leftover = await basket.vaultBalances();
  leftover.forEach((l) => expect(l).to.be.gte(0n));
  // The randomized walk really did exercise rounding on both sides.
  expect(stats.mint).to.be.greaterThan(0);
  expect(stats.redeem).to.be.greaterThan(0);
  expect(stats.roundedMint).to.be.greaterThan(0);
  expect(stats.roundedRedeem).to.be.greaterThan(0);
  return { stats, leftover };
}

describe("Invariants: full backing under random activity", function () {
  this.timeout(180_000);

  const scenarios = [
    { seed: 0x7e55e7a, feeBps: 100, steps: 250 },
    { seed: 20261004, feeBps: 0, steps: 200 },
    { seed: 0xbadc0de, feeBps: 37, steps: 200 },
    { seed: 42, feeBps: 100, steps: 150, unitsOverride: 1n }, // 1 raw unit per whole share
  ];

  for (const s of scenarios) {
    const label = `seed ${s.seed}, fee ${s.feeBps} bps, ${s.steps} steps${s.unitsOverride ? ", 1 unit/share" : ""}`;
    it(`vault >= previewRedeem(totalSupply) after every mint, redeem, transfer and donation (${label})`, async () => {
      const { stats } = await runScenario(s);
      // Visible in the test output so a reviewer can see the walk's shape.
      console.log(
        `      walk: ${stats.mint} mints (${stats.roundedMint} rounded), ${stats.redeem} redeems (${stats.roundedRedeem} rounded), ${stats.transfer} transfers, ${stats.donate} donations`,
      );
    });
  }
});

describe("Invariants: rounding math matches a BigInt reference", () => {
  async function basketWith(units, feeBps) {
    const [creator] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const t = await Mock.deploy("A", "A", 18);
    const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
    return createBasket(factory, creator, "Ref", "REF", feeBps, [
      { token: await t.getAddress(), unitsPerShare: units, weightBps: 10000 },
    ]);
  }

  it("previewMint rounds up, previewRedeem rounds down, previewNetShares floors the fee (400 random points)", async () => {
    const r = prng(0x5eed);
    for (const [units, fee] of [
      [1n, 100],
      [7n, 1],
      [2n * 10n ** 16n + 1n, 50],
      [3n * E18 + 17n, 0],
    ]) {
      const b = await basketWith(units, fee);
      for (let k = 0; k < 100; k++) {
        const s = drawShares(r);
        const [m] = await b.previewMint(s);
        const [d] = await b.previewRedeem(s);
        const [net, f] = await b.previewNetShares(s);
        expect(m).to.equal(ceilDiv(units * s, ONE_SHARE));
        expect(d).to.equal((units * s) / ONE_SHARE);
        expect(m).to.be.gte(d);
        expect(m - d).to.be.lte(1n); // never more than one raw unit apart
        expect(f).to.equal((s * BigInt(fee)) / 10000n);
        expect(net + f).to.equal(s);
        expect(f * 10000n).to.be.lte(s * 100n); // fee never above 1%
      }
    }
  });

  it("splitting a mint never costs less, splitting a redemption never pays more (no rounding arbitrage)", async () => {
    const r = prng(0xa5b17);
    const b = await basketWith(7n, 0);
    for (let k = 0; k < 150; k++) {
      const a = drawShares(r);
      const c = drawShares(r);
      const [mA] = await b.previewMint(a);
      const [mC] = await b.previewMint(c);
      const [mAC] = await b.previewMint(a + c);
      const [rA] = await b.previewRedeem(a);
      const [rC] = await b.previewRedeem(c);
      const [rAC] = await b.previewRedeem(a + c);
      expect(mA + mC).to.be.gte(mAC);
      expect(rA + rC).to.be.lte(rAC);
    }
  });

  it("a mint followed by redeeming everything received never returns more than was paid (60 round trips)", async () => {
    const [, alice] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const t1 = await Mock.deploy("A", "A", 18);
    const t2 = await Mock.deploy("B", "B", 6);
    const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
    const b = await createBasket(factory, alice, "RT", "RT", 0, [
      { token: await t1.getAddress(), unitsPerShare: 333333333333333333n, weightBps: 5000 },
      { token: await t2.getAddress(), unitsPerShare: 3n, weightBps: 5000 },
    ]);
    for (const t of [t1, t2]) {
      await t.mint(alice, BIG);
      await t.connect(alice).approve(b, ethers.MaxUint256);
    }
    const r = prng(77);
    for (let k = 0; k < 60; k++) {
      const s = drawShares(r);
      const before = [await t1.balanceOf(alice), await t2.balanceOf(alice)];
      await b.connect(alice).mint(s, alice);
      await b.connect(alice).redeem(await b.balanceOf(alice), alice);
      const after = [await t1.balanceOf(alice), await t2.balanceOf(alice)];
      expect(after[0]).to.be.lte(before[0]);
      expect(after[1]).to.be.lte(before[1]);
    }
    expect(await b.totalSupply()).to.equal(0n);
  });
});
