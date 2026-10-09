// Deploys the v3 pair next to v1 and v2 and records it under "v3" in
// deployments/<network>.json: a CreationDeskV2 (the same audited-by-tests auction
// desk) whose immutable treasury is a separate key the founder holds, and PlanDeskV3 (trailing
// bounds under the owner's hard floor, and an owner recenter) on top of it.
// v1 and v2 are untouched and keep working.
//
//   npx hardhat run scripts/deploy-v3.js --network tempoTestnet
//
// The treasury is the address in ../.keys/evm-treasury.json (only the address is
// read; the key never leaves that file). TREASURY=0x... overrides it.
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
  const keyFile = path.join(__dirname, "..", "..", ".keys", "evm-treasury.json");
  const treasury = process.env.TREASURY || d.v3?.treasury || (fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, "utf8")).address : null);
  if (!treasury) throw new Error("no treasury: create .keys/evm-treasury.json or set TREASURY");
  if (treasury.toLowerCase() === deployer.address.toLowerCase()) throw new Error("the v3 treasury must not be the deployer");
  const save = () => {
    // Re-read so fields other tools wrote meanwhile are kept.
    const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
    fresh.v3 = d.v3;
    fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  };
  d.v3 = d.v3 || {
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
    d.v3[key] = await c.getAddress();
    d.v3.txs[key] = r.hash;
    d.v3.gasUsed[key] = Number(r.gasUsed);
    if (key === "desk") d.v3.startBlock = r.blockNumber;
    save();
    console.log(`${name.padEnd(15)} ${d.v3[key]}  gas ${r.gasUsed}`);
    return r;
  };
  if (!d.v3.desk) await deploy("desk", "CreationDeskV2", [d.stable.address, d.factory, treasury]);
  if (!d.v3.planDesk) await deploy("planDesk", "PlanDeskV3", [d.v3.desk]);

  // Read back what the chain holds (retrying: public RPCs lag each other).
  const desk = await ethers.getContractAt("CreationDeskV2", d.v3.desk);
  const plans = await ethers.getContractAt("PlanDeskV3", d.v3.planDesk);
  for (let i = 0; ; i++) {
    try {
      const [fee, tr, cash, fac, pd] = await Promise.all([desk.PROTOCOL_FEE_BPS(), desk.treasury(), desk.cash(), desk.factory(), plans.desk()]);
      const same = (a, b) => a.toLowerCase() === b.toLowerCase();
      if (Number(fee) !== 10 || !same(tr, treasury) || !same(cash, d.stable.address) || !same(fac, d.factory) || !same(pd, d.v3.desk)) {
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
  if (network.name !== "tempoTestnet") d.v3.nativeSpent = ethers.formatEther(balBefore - balAfter);
  d.v3.deployedAt = d.v3.deployedAt || new Date().toISOString();
  save();
  console.log("v3 recorded", JSON.stringify({ desk: d.v3.desk, planDesk: d.v3.planDesk, treasury }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
