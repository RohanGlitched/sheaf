// Verifies the factory, the desk and every seed basket on the Robinhood Chain
// Blockscout explorer. Safe to re-run: already-verified contracts are skipped.
const fs = require("fs");
const path = require("path");
const { run, ethers, network } = require("hardhat");

async function verify(address, constructorArguments, contract) {
  try {
    await run("verify:verify", { address, constructorArguments, contract });
    console.log("verified", address);
  } catch (e) {
    const msg = String(e.message || e);
    if (/already verified/i.test(msg)) console.log("already verified", address);
    else console.log("could not verify", address, "-", msg.split("\n")[0]);
  }
}

async function main() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  await verify(d.factory, [], "contracts/SheafFactory.sol:SheafFactory");
  await verify(d.desk, [d.usdg, d.factory], "contracts/CreationDesk.sol:CreationDesk");
  for (const b of d.baskets) {
    const basket = await ethers.getContractAt("Basket", b.address);
    const comps = (await basket.components()).map((c) => [c.token, c.unitsPerShare, c.weightBps]);
    const args = [await basket.name(), await basket.symbol(), await basket.creator(), await basket.creatorFeeBps(), comps];
    await verify(b.address, args, "contracts/Basket.sol:Basket");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
