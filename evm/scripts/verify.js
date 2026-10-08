// Verifies every Sheaf contract of a deployment on the chain's explorer.
// Safe to re-run: already-verified contracts are skipped.
//
//   npx hardhat run scripts/verify.js --network robinhoodTestnet   (Blockscout, no key)
//   npx hardhat run scripts/verify.js --network baseSepolia        (Blockscout, no key)
//   Tempo: use scripts/verify-sourcify.js (Sourcify v2 at contracts.tempo.xyz).
//   ETHERSCAN_API_KEY=... npx hardhat run scripts/verify.js --network sepolia
const fs = require("fs");
const path = require("path");
const { run, ethers, network } = require("hardhat");

async function verify(label, address, constructorArguments, contract) {
  try {
    await run("verify:verify", { address, constructorArguments, contract });
    console.log(`verified ${label} ${address}`);
    return true;
  } catch (e) {
    const msg = String(e.message || e);
    if (/already verified/i.test(msg)) {
      console.log(`already verified ${label} ${address}`);
      return true;
    }
    console.log(`could not verify ${label} ${address} - ${msg.split("\n")[0]}`);
    return false;
  }
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const ok = {};
  ok.factory = await verify("SheafFactory", d.factory, [], "contracts/SheafFactory.sol:SheafFactory");
  ok.desk = await verify("CreationDesk", d.desk, [d.stable.address, d.factory], "contracts/CreationDesk.sol:CreationDesk");
  for (const b of d.baskets) {
    const basket = await ethers.getContractAt("Basket", b.address);
    const comps = (await basket.components()).map((c) => [c.token, c.unitsPerShare, c.weightBps]);
    const args = [await basket.name(), await basket.symbol(), await basket.creator(), await basket.creatorFeeBps(), comps];
    ok[b.symbol] = await verify(`Basket ${b.symbol}`, b.address, args, "contracts/Basket.sol:Basket");
  }
  for (const t of d.tokens.filter((x) => x.isMirror)) {
    ok[t.symbol] = await verify(`MockStock ${t.symbol}`, t.address, [t.name, t.symbol], "contracts/mirrors/MockStock.sol:MockStock");
  }
  if (d.stable.isMirror) {
    ok[d.stable.symbol] = await verify("MockDollar", d.stable.address, [d.stable.name, d.stable.symbol], "contracts/mirrors/MockDollar.sol:MockDollar");
  }
  d.verified = { via: "etherscan-compatible API (Blockscout on Robinhood Chain and Base Sepolia)", at: new Date().toISOString(), contracts: ok };
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
