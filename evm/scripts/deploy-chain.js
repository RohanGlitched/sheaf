// Deploys a fresh Sheaf stack to one chain and writes deployments/<network>.json.
//
//   npx hardhat run scripts/deploy-chain.js --network robinhoodTestnet
//
// Per chain (see scripts/chains.js):
//   1. stock tokens: the real testnet stock tokens where they exist, otherwise
//      eight MockStock mirrors (TSLA NVDA AAPL MSFT AMZN GOOGL META PLTR);
//   2. the desk's dollar: a real testnet stablecoin where one exists, otherwise
//      a MockDollar mirror;
//   3. SheafFactory and CreationDesk;
//   4. the seed baskets, priced at $10 a share from live Robinhood quotes;
//   5. a little seed supply in every basket.
//
// The script is resumable: every address is written to the deployment file the
// moment it exists, and a re-run skips whatever is already there. Delete the
// file (or set FRESH=1) for a brand-new deployment.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { CHAINS, MIRROR_STOCKS, MIRROR_DOLLAR, fetchQuotes, recipe } = require("./chains");

const ERC20 = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";

async function main() {
  const cfg = CHAINS[network.name];
  if (!cfg) throw new Error(`no Sheaf plan for network ${network.name}`);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== cfg.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${cfg.chainId}`);

  const dir = path.join(__dirname, "..", "deployments");
  const file = path.join(dir, `${network.name}.json`);
  fs.mkdirSync(dir, { recursive: true });
  let d = !process.env.FRESH && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (!d) {
    d = {
      network: network.name,
      label: cfg.label,
      chainId,
      rpc: cfg.rpc,
      explorer: cfg.explorer,
      tokenSource: cfg.stocks,
      deployer: deployer.address,
      tokens: [],
      stable: null,
      factory: null,
      desk: null,
      startBlock: null,
      baskets: [],
    };
  }
  const save = () => fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`${cfg.label} (${chainId})  deployer ${deployer.address}`);

  const deploy = async (name, args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    const rcpt = await c.deploymentTransaction().wait();
    return { address: await c.getAddress(), block: rcpt.blockNumber };
  };

  // 1. stock tokens
  if (cfg.stocks === "real") {
    if (d.tokens.length === 0) d.tokens = cfg.realTokens.map((t) => ({ ...t, isMirror: false }));
  } else {
    for (const m of MIRROR_STOCKS) {
      if (d.tokens.find((t) => t.symbol === m.symbol)) continue;
      const name = `${m.company} (Sheaf testnet mirror)`;
      const { address } = await deploy("MockStock", [name, m.symbol]);
      d.tokens.push({ symbol: m.symbol, name, address, decimals: 18, isMirror: true });
      save();
      console.log(`mirror  ${m.symbol.padEnd(6)} ${address}`);
    }
  }

  // 2. the desk's dollar
  if (!d.stable) {
    if (cfg.stable) {
      d.stable = { ...cfg.stable };
    } else {
      const { address } = await deploy("MockDollar", [MIRROR_DOLLAR.name, MIRROR_DOLLAR.symbol]);
      d.stable = { ...MIRROR_DOLLAR, address, isMirror: true };
      console.log(`dollar  ${MIRROR_DOLLAR.symbol.padEnd(6)} ${address}`);
    }
    save();
  }

  // 3. factory and desk
  if (!d.factory) {
    const f = await deploy("SheafFactory", []);
    d.factory = f.address;
    d.startBlock = f.block;
    save();
  }
  if (!d.desk) {
    d.desk = (await deploy("CreationDesk", [d.stable.address, d.factory])).address;
    save();
  }
  console.log(`factory ${d.factory}\ndesk    ${d.desk}  (cash ${d.stable.symbol} ${d.stable.address})`);

  // 4. seed baskets
  const factory = await ethers.getContractAt("SheafFactory", d.factory);
  const symbols = [...new Set(cfg.seeds.flatMap((s) => Object.keys(s.weights)))];
  const prices = await fetchQuotes(symbols);
  console.log("quotes", prices);
  const addressOf = Object.fromEntries(d.tokens.map((t) => [t.symbol, t.address]));
  for (const seed of cfg.seeds) {
    if (d.baskets.find((b) => b.symbol === seed.symbol)) continue;
    const key = ethers.keccak256(ethers.toUtf8Bytes(seed.symbol));
    let addr = await factory.basketOf(deployer.address, key);
    if (addr === ethers.ZeroAddress) {
      const comps = recipe(seed.weights, addressOf, prices);
      await (await factory.createBasket(seed.name, seed.symbol, seed.feeBps, comps)).wait();
      addr = await factory.basketOf(deployer.address, key);
    }
    // Record the recipe as the chain holds it, so a resumed run cannot drift.
    const onChain = await (await ethers.getContractAt("Basket", addr)).components();
    const symOf = Object.fromEntries(d.tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
    d.baskets.push({
      symbol: seed.symbol,
      name: seed.name,
      address: addr,
      feeBps: seed.feeBps,
      navUsdAtLaunch: 10,
      components: onChain.map((c) => ({
        symbol: symOf[c.token.toLowerCase()],
        token: c.token,
        unitsPerShare: c.unitsPerShare.toString(),
        weightBps: Number(c.weightBps),
      })),
      pricedAt: Object.fromEntries(Object.keys(seed.weights).map((s) => [s, prices[s]])),
    });
    save();
    console.log(`basket  ${seed.symbol.padEnd(6)} ${addr}`);
  }

  // 5. seed supply
  const seedShares = ethers.parseEther(process.env.SEED_SHARES || cfg.seedShares);
  for (const b of d.baskets) {
    if (b.seeded) continue;
    const basket = await ethers.getContractAt("Basket", b.address);
    const need = await basket.previewMint(seedShares);
    const comps = await basket.components();
    for (let i = 0; i < comps.length; i++) {
      const meta = d.tokens.find((t) => t.address.toLowerCase() === comps[i].token.toLowerCase());
      if (meta.isMirror) {
        const mirror = await ethers.getContractAt("MockStock", comps[i].token);
        const have = await mirror.balanceOf(deployer.address);
        if (have < need[i]) await (await mirror.faucet(need[i] - have)).wait();
      }
      const erc = await ethers.getContractAt(ERC20, comps[i].token);
      if ((await erc.allowance(deployer.address, b.address)) < need[i]) {
        await (await erc.approve(b.address, need[i])).wait();
      }
    }
    await (await basket.mint(seedShares, deployer.address)).wait();
    b.seeded = ethers.formatEther(seedShares);
    save();
    console.log(`seeded  ${b.symbol} with ${b.seeded} shares`);
  }

  d.deployedAt = d.deployedAt || new Date().toISOString();
  save();
  console.log(`wrote deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
