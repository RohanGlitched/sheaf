// Live smoke test against a deployed chain. Uses the deployer as minter, buyer
// and filler, and checks every balance delta exactly.
//
//   npx hardhat run scripts/smoke.js --network robinhoodTestnet
//
// Steps: faucet-mint mirror components (mirror chains only) -> mint 1 share in
// kind -> redeem half -> place a desk order for 1 share -> fill it -> check the
// order, the shares, the components and the cash. Appends the result and the
// transaction hashes to deployments/<network>.json under "smoke".
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";

function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [me] = await ethers.getSigners();
  const txs = {};
  // Public RPCs are often load-balanced across nodes that lag each other, so
  // every read is pinned to the block of the last transaction mined (retrying
  // until the node serving the read has that block).
  let tag = await ethers.provider.getBlockNumber();
  const at = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn({ blockTag: tag });
      } catch (e) {
        if (i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };
  const send = async (label, p) => {
    const r = await (await p).wait();
    txs[label] = r.hash;
    tag = Math.max(tag, r.blockNumber);
    return r;
  };

  const b = d.baskets[0];
  const basket = await ethers.getContractAt("Basket", b.address);
  const desk = await ethers.getContractAt("CreationDesk", d.desk);
  const cash = await ethers.getContractAt(ERC20, d.stable.address);
  const comps = await basket.components();
  const tokens = await Promise.all(comps.map((c) => ethers.getContractAt(ERC20, c.token)));
  console.log(`${d.label}: smoke test on ${b.symbol} ${b.address}`);

  const ONE = ethers.parseEther("1");
  const HALF = ONE / 2n;
  const mintNeed = await basket.previewMint(ONE);
  // Enough components for an in-kind mint and a desk fill of one share each.
  for (let i = 0; i < comps.length; i++) {
    const meta = d.tokens.find((t) => t.address.toLowerCase() === comps[i].token.toLowerCase());
    if (!meta.isMirror) continue;
    const want = mintNeed[i] * 2n;
    const have = await at((o) => tokens[i].balanceOf(me.address, o));
    if (have < want) {
      const mirror = await ethers.getContractAt("MockStock", comps[i].token);
      await send(`faucet_${meta.symbol}`, mirror.faucet(want - have));
    }
  }
  if (d.stable.isMirror) {
    const dollar = await ethers.getContractAt("MockDollar", d.stable.address);
    await send("faucet_dollar", dollar.faucet(100n * 10n ** 6n));
  }
  const bal = async () => ({
    shares: await at((o) => basket.balanceOf(me.address, o)),
    supply: await at((o) => basket.totalSupply(o)),
    comps: await Promise.all(tokens.map((t) => at((o) => t.balanceOf(me.address, o)))),
    vault: await at((o) => basket.vaultBalances(o)),
    cash: await at((o) => cash.balanceOf(me.address, o)),
    deskCash: await at((o) => cash.balanceOf(d.desk, o)),
  });

  // In-kind mint.
  let before = await bal();
  for (let i = 0; i < tokens.length; i++) await send(`approve_basket_${i}`, tokens[i].approve(b.address, mintNeed[i]));
  await send("mint", basket.mint(ONE, me.address));
  let after = await bal();
  const [net, fee] = await basket.previewNetShares(ONE);
  // The deployer created the seed basket, so it also receives the creator fee.
  const creatorIsMe = (await basket.creator()).toLowerCase() === me.address.toLowerCase();
  check(after.shares - before.shares === net + (creatorIsMe ? fee : 0n), `mint: received ${ethers.formatEther(net)} net shares${creatorIsMe ? " plus the creator fee" : ""}`);
  check(after.supply - before.supply === ONE, "mint: total supply grew by exactly one share");
  check(after.comps.every((v, i) => before.comps[i] - v === mintNeed[i]), "mint: paid exactly previewMint(1) of every component");
  check(after.vault.every((v, i) => v - before.vault[i] === mintNeed[i]), "mint: vault holds the deposit");

  // Redeem half.
  before = after;
  const redeemOut = await basket.previewRedeem(HALF);
  await send("redeem", basket.redeem(HALF, me.address));
  after = await bal();
  check(before.shares - after.shares === HALF, "redeem: burned half a share");
  check(after.comps.every((v, i) => v - before.comps[i] === redeemOut[i]), "redeem: received previewRedeem(0.5) of every component");

  // Desk: cash order for one share, filled by the same account.
  before = after;
  const cashAmount = 10n ** BigInt(d.stable.decimals) * 101n / 10n; // 10.10 dollars
  await send("approve_desk_cash", cash.approve(d.desk, cashAmount));
  const expiry = (await ethers.provider.getBlock("latest")).timestamp + 3600;
  const placed = await send("placeOrder", desk.placeOrder(b.address, ONE, cashAmount, expiry));
  // The order id comes from the OrderPlaced event, never from a possibly stale read.
  const id = placed.logs.map((l) => desk.interface.parseLog(l)).find((e) => e && e.name === "OrderPlaced").args.id;
  check((await at((o) => cash.balanceOf(d.desk, o))) - before.deskCash === cashAmount, "desk: escrowed 10.10 of the cash token");
  for (let i = 0; i < tokens.length; i++) await send(`approve_desk_${i}`, tokens[i].approve(d.desk, mintNeed[i]));
  await send("fill", desk.fill(id));
  after = await bal();
  const o = await at((ov) => desk.getOrder(id, ov));
  check(Number(o.status) === 2, `desk: order ${id} is Filled`);
  check(after.shares - before.shares === net + (creatorIsMe ? fee : 0n), "desk: buyer received the shares");
  check(after.cash === before.cash, "desk: cash went out at placeOrder and back to the filler at fill (same account)");
  check(after.deskCash === before.deskCash, "desk: holds no residual cash from this order");
  check(after.comps.every((v, i) => before.comps[i] - v === mintNeed[i]), "desk: filler delivered previewMint(1) of every component");

  // Backing invariant.
  const owed = await basket.previewRedeem(after.supply);
  check(after.vault.every((v, i) => v >= owed[i]), "every share is fully backed");

  d.smoke = { passedAt: new Date().toISOString(), basket: b.symbol, orderId: Number(id), txs };
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`\n${d.label}: smoke test passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
