// Shared fixtures and utilities for the Sheaf test suite.
const { ethers } = require("hardhat");

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const ONE_SHARE = E18;

/// Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence, on every
/// machine, so a failing randomized run can be replayed exactly.
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /// Uniform-ish BigInt in [0, max] built from 32-bit draws.
    big: (max) => {
      if (max <= 0n) return 0n;
      let r = 0n;
      for (let i = 0; i < 8; i++) r = (r << 32n) | BigInt(Math.floor(next() * 4294967296));
      return r % (max + 1n);
    },
  };
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

async function approveAll(tokens, owner, spender) {
  for (const t of tokens) await t.connect(owner).approve(spender, ethers.MaxUint256);
}

/// Deploys three mock stock tokens, a 6-decimal USDG, the factory, the desk
/// and one 3-component basket ("SAS", 0.50% creator fee).
async function deployCore() {
  const [creator, alice, bob, ap, carol, dave] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const tsla = await Mock.deploy("Tesla", "TSLA", 18);
  const amzn = await Mock.deploy("Amazon", "AMZN", 18);
  const nflx = await Mock.deploy("Netflix", "NFLX", 18);
  const usdg = await Mock.deploy("Global Dollar", "USDG", 6);
  const factory = await (await ethers.getContractFactory("SheafFactory")).deploy();
  const desk = await (await ethers.getContractFactory("CreationDesk")).deploy(usdg, factory);

  for (const t of [tsla, amzn, nflx]) {
    for (const s of [alice, bob, ap, carol, dave]) await t.mint(s, 1000n * E18);
  }
  for (const s of [alice, bob, carol]) await usdg.mint(s, 1_000_000n * E6);

  const recipe = [
    { token: await tsla.getAddress(), unitsPerShare: (2n * E18) / 100n, weightBps: 3300 },
    { token: await amzn.getAddress(), unitsPerShare: (3n * E18) / 100n, weightBps: 3000 },
    { token: await nflx.getAddress(), unitsPerShare: (7n * E18) / 1000n, weightBps: 3700 },
  ];
  await factory.connect(creator).createBasket("Streaming and Stuff", "SAS", 50, recipe);
  const basket = await ethers.getContractAt("Basket", (await factory.allBaskets())[0]);
  const stocks = [tsla, amzn, nflx];
  return { creator, alice, bob, ap, carol, dave, tsla, amzn, nflx, stocks, usdg, factory, desk, basket, recipe };
}

/// Publishes a basket through the factory and returns the attached contract.
async function createBasket(factory, signer, name, symbol, feeBps, recipe) {
  const addr = await factory.connect(signer).createBasket.staticCall(name, symbol, feeBps, recipe);
  await factory.connect(signer).createBasket(name, symbol, feeBps, recipe);
  return ethers.getContractAt("Basket", addr);
}

/// N fresh 18-decimal tokens, each with a recipe slot of equal weight.
async function freshRecipe(n, units = E18) {
  const Mock = await ethers.getContractFactory("MockERC20");
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(await Mock.deploy(`T${i}`, `T${i}`, 18));
  const base = Math.floor(10000 / n);
  const recipe = await Promise.all(
    tokens.map(async (t, i) => ({
      token: await t.getAddress(),
      unitsPerShare: units,
      weightBps: i === 0 ? 10000 - base * (n - 1) : base,
    })),
  );
  return { tokens, recipe };
}

/// deployCore plus the v2 desk (treasury: a signer that holds nothing) and the
/// plan desk on top of it.
async function deployV2() {
  const f = await deployCore();
  const signers = await ethers.getSigners();
  const treasury = signers[6];
  const keeper = signers[7];
  const deskV2 = await (await ethers.getContractFactory("CreationDeskV2")).deploy(f.usdg, f.factory, treasury.address);
  const plans = await (await ethers.getContractFactory("PlanDesk")).deploy(deskV2);
  return { ...f, treasury, keeper, deskV2, plans };
}

/// The v2 fill split for `out` shares to the buyer on a basket with
/// `creatorBps`: gross created, creator cut, protocol cut, buyer's shares.
function v2Split(out, creatorBps, protocolBps = 10n) {
  const B = 10_000n;
  const gross = ceilDiv(out * B, B - creatorBps - protocolBps);
  const creator = (gross * creatorBps) / B;
  const protocol = (gross * protocolBps) / B;
  return { gross, creator, protocol, buyer: gross - creator - protocol };
}

/// SheafAuction.sharesAt, in BigInt.
function sharesAt(start, end, startTs, endTs, now) {
  if (now <= startTs) return start;
  if (now >= endTs) return end;
  return start - ((start - end) * (now - startTs)) / (endTs - startTs);
}

module.exports = {
  E18,
  E6,
  ONE_SHARE,
  prng,
  ceilDiv,
  approveAll,
  deployCore,
  deployV2,
  v2Split,
  sharesAt,
  createBasket,
  freshRecipe,
};
