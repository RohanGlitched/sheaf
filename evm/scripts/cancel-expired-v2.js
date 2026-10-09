// Cancels every expired, unfilled v2 desk order on a chain. Anyone may do this
// after an auction ends; the cash always goes back to the order's buyer.
//
//   npx hardhat run scripts/cancel-expired-v2.js --network <network>
const { ethers, network } = require("hardhat");
const d = require(`../deployments/${network.name}.json`);

async function main() {
  const desk = await ethers.getContractAt("CreationDeskV2", d.v2.desk);
  const n = Number(await desk.orderCount());
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  for (let id = 0; id < n; id++) {
    const o = await desk.getOrder(id);
    if (Number(o.status) !== 1 || Number(o.endTs) >= now) continue;
    const r = await (await desk.cancel(id)).wait();
    console.log(`cancelled order ${id}: ${ethers.formatUnits(o.cashAmount, d.stable.decimals)} ${d.stable.symbol} back to ${o.buyer} (${r.hash})`);
  }
  console.log(`${network.name}: ${n} v2 orders checked`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
