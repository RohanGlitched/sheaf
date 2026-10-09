// Verifies every Sheaf contract of a deployment on the chain's Blockscout
// explorer, which needs no API key. Safe to re-run: already-verified contracts
// are skipped.
//
//   npx hardhat run scripts/verify.js --network robinhoodTestnet
//   npx hardhat run scripts/verify.js --network sepolia
//   npx hardhat run scripts/verify.js --network arbitrumSepolia
//   npx hardhat run scripts/verify.js --network baseSepolia
//
// Tempo: use scripts/verify-sourcify.js (Sourcify v2 at contracts.tempo.xyz).
const fs = require("fs");
const path = require("path");
const { run, network } = require("hardhat");

async function verify(label, address, constructorArguments, contract) {
  // Explorers rate-limit bursts of submissions, so retry with a pause.
  for (let attempt = 1; ; attempt++) {
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
      if (attempt < 4 && /failed to send|network request|timeout|429|rate/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 15000 * attempt));
        continue;
      }
      console.log(`could not verify ${label} ${address} - ${msg.split("\n")[0]}`);
      return false;
    }
  }
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const ok = {};
  ok.factory = await verify("SheafFactory", d.factory, [], "contracts/SheafFactory.sol:SheafFactory");
  ok.desk = await verify("CreationDesk", d.desk, [d.stable.address, d.factory], "contracts/CreationDesk.sol:CreationDesk");
  for (const b of d.baskets) {
    // Constructor arguments come from the deployment record, which deploy-chain.js
    // copied from the chain right after creation.
    const comps = b.components.map((c) => [c.token, BigInt(c.unitsPerShare), c.weightBps]);
    const args = [b.name, b.symbol, d.deployer, b.feeBps, comps];
    ok[b.symbol] = await verify(`Basket ${b.symbol}`, b.address, args, "contracts/Basket.sol:Basket");
  }
  for (const t of d.tokens.filter((x) => x.isMirror)) {
    ok[t.symbol] = await verify(`MockStock ${t.symbol}`, t.address, [t.name, t.symbol], "contracts/mirrors/MockStock.sol:MockStock");
  }
  if (d.stable.isMirror) {
    ok[d.stable.symbol] = await verify("MockDollar", d.stable.address, [d.stable.name, d.stable.symbol], "contracts/mirrors/MockDollar.sol:MockDollar");
  }
  d.verified = { via: "Blockscout (etherscan-compatible API)", at: new Date().toISOString(), contracts: ok };
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
