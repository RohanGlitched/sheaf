// Deploys the v2 desk (Dutch auction, 0.10% protocol fee) and the plan desk next
// to an existing v1 deployment, and records them under "v2" in
// deployments/<network>.json. v1's factory, desk and baskets are untouched: the
// v2 desk serves the same factory's baskets, so every existing basket gets the
// auction and the protocol fee without being redeployed.
//
//   npx hardhat run scripts/deploy-v2.js --network tempoTestnet
//
// TREASURY=0x... overrides the treasury (default: the deployer, the house).
// Resumable: whatever is already recorded is skipped.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== d.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${d.chainId}`);
  const treasury = process.env.TREASURY || d.v2?.treasury || deployer.address;
  const save = () => {
    // Re-read so fields other tools wrote meanwhile are kept.
    const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
    fresh.v2 = d.v2;
    fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  };
  d.v2 = d.v2 || {
    desk: null,
    planDesk: null,
    treasury,
    protocolFeeBps: 10,
    cash: d.stable.address,
    factory: d.factory,
    txs: {},
    gasUsed: {},
  };
  console.log(`${d.label} (${chainId})  deployer ${deployer.address}  treasury ${treasury}`);

  const balBefore = await ethers.provider.getBalance(deployer.address);
  const deploy = async (key, name, args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    const r = await c.deploymentTransaction().wait();
    d.v2[key] = await c.getAddress();
    d.v2.txs[key] = r.hash;
    d.v2.gasUsed[key] = Number(r.gasUsed);
    if (key === "desk") d.v2.startBlock = r.blockNumber;
    save();
    console.log(`${name.padEnd(15)} ${d.v2[key]}  gas ${r.gasUsed}`);
    return r;
  };
  if (!d.v2.desk) await deploy("desk", "CreationDeskV2", [d.stable.address, d.factory, treasury]);
  if (!d.v2.planDesk) await deploy("planDesk", "PlanDesk", [d.v2.desk]);

  // Read back what the chain holds (retrying: public RPCs lag each other).
  const desk = await ethers.getContractAt("CreationDeskV2", d.v2.desk);
  const plans = await ethers.getContractAt("PlanDesk", d.v2.planDesk);
  for (let i = 0; ; i++) {
    try {
      const [fee, tr, cash, fac, pd] = await Promise.all([desk.PROTOCOL_FEE_BPS(), desk.treasury(), desk.cash(), desk.factory(), plans.desk()]);
      const same = (a, b) => a.toLowerCase() === b.toLowerCase();
      if (Number(fee) !== 10 || !same(tr, treasury) || !same(cash, d.stable.address) || !same(fac, d.factory) || !same(pd, d.v2.desk)) {
        throw new Error(`v2 read-back mismatch: fee ${fee} treasury ${tr} cash ${cash} factory ${fac} planDesk.desk ${pd}`);
      }
      break;
    } catch (e) {
      if (i >= 15 || /mismatch/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const balAfter = await ethers.provider.getBalance(deployer.address);
  // Tempo has no native balance (it reads a fixed placeholder); fees there are in pathUSD.
  if (network.name !== "tempoTestnet") d.v2.nativeSpent = ethers.formatEther(balBefore - balAfter);
  d.v2.deployedAt = d.v2.deployedAt || new Date().toISOString();
  save();
  console.log("v2 recorded", JSON.stringify({ desk: d.v2.desk, planDesk: d.v2.planDesk, treasury }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
