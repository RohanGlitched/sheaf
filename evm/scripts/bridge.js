// Bridges testnet ETH from Ethereum Sepolia to Arbitrum Sepolia and Base Sepolia
// through their canonical bridges, so the same deployer has gas on both L2s.
//
//   BRIDGE_ETH=0.012 npx hardhat run scripts/bridge.js --network sepolia
//
// Arbitrum Sepolia: Inbox.depositEth() on Sepolia (delayed inbox, ~10 min).
// Base Sepolia: L1StandardBridge.depositETH(minGasLimit, extraData) (~2-5 min).
// Addresses from docs.arbitrum.io (contract addresses) and docs.base.org (Base contracts).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ARB_SEPOLIA_INBOX = "0xaAe29B0366299461418F5324a79Afc425BE5ae21";
const BASE_SEPOLIA_L1_STANDARD_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";

async function main() {
  if (network.name !== "sepolia") throw new Error("run this on --network sepolia");
  const [me] = await ethers.getSigners();
  const value = ethers.parseEther(process.env.BRIDGE_ETH || "0.012");
  const targets = (process.env.BRIDGE_TO || "arbitrumSepolia,baseSepolia").split(",");
  for (const a of [ARB_SEPOLIA_INBOX, BASE_SEPOLIA_L1_STANDARD_BRIDGE]) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`no code at ${a}`);
  }
  console.log(`Sepolia balance ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH`);
  const log = { from: me.address, at: new Date().toISOString(), value: ethers.formatEther(value), txs: {} };

  if (targets.includes("arbitrumSepolia")) {
    const inbox = new ethers.Contract(ARB_SEPOLIA_INBOX, ["function depositEth() payable returns (uint256)"], me);
    const r = await (await inbox.depositEth({ value })).wait();
    log.txs.arbitrumSepolia = { via: `Inbox ${ARB_SEPOLIA_INBOX}`, tx: r.hash };
    console.log(`arbitrumSepolia  depositEth ${ethers.formatEther(value)} ETH  tx ${r.hash}`);
  }
  if (targets.includes("baseSepolia")) {
    const bridge = new ethers.Contract(
      BASE_SEPOLIA_L1_STANDARD_BRIDGE,
      ["function depositETH(uint32 _minGasLimit, bytes _extraData) payable"],
      me,
    );
    const r = await (await bridge.depositETH(200000, "0x", { value })).wait();
    log.txs.baseSepolia = { via: `L1StandardBridge ${BASE_SEPOLIA_L1_STANDARD_BRIDGE}`, tx: r.hash };
    console.log(`baseSepolia      depositETH ${ethers.formatEther(value)} ETH  tx ${r.hash}`);
  }
  console.log(`Sepolia balance ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH`);
  const dir = path.join(__dirname, "..", "deployments");
  fs.writeFileSync(path.join(dir, "bridges.json"), `${JSON.stringify(log, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
