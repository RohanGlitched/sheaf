// Verifies a deployment through Blockscout's native v2 API (standard-JSON input,
// constructor arguments auto-detected). No API key needed. Use it where the
// Etherscan-compatible route in verify.js is refused, as happened for the
// mirror tokens on eth-sepolia.blockscout.com.
//
//   npx hardhat run scripts/verify-blockscout.js --network sepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isVerified(api, address) {
  try {
    const r = await fetch(`${api}/api/v2/smart-contracts/${address}`);
    if (!r.ok) return false;
    return (await r.json()).is_verified === true;
  } catch {
    return false;
  }
}

async function verifyOne(api, label, address, fqn) {
  if (await isVerified(api, address)) {
    console.log(`already verified ${label} ${address}`);
    return true;
  }
  const bi = await hre.artifacts.getBuildInfo(fqn);
  const fd = new FormData();
  fd.append("compiler_version", `v${bi.solcLongVersion}`);
  fd.append("license_type", "mit");
  fd.append("contract_name", fqn.split(":")[1]);
  fd.append("autodetect_constructor_args", "true");
  fd.append("files[0]", new Blob([JSON.stringify(bi.input)], { type: "application/json" }), "input.json");
  let r;
  for (let attempt = 1; ; attempt++) {
    r = await fetch(`${api}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: "POST", body: fd });
    // Keyless Blockscout instances rate-limit bursts; back off and retry.
    if (r.status !== 429 || attempt >= 8) break;
    await sleep(20000 * attempt);
  }
  if (!r.ok) {
    console.log(`could not submit ${label} ${address} - ${r.status} ${(await r.text()).slice(0, 200)}`);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    if (await isVerified(api, address)) {
      console.log(`verified ${label} ${address}`);
      return true;
    }
  }
  console.log(`timed out ${label} ${address}`);
  return false;
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const api = process.env.BLOCKSCOUT || d.explorer;
  const items = [
    ["factory", d.factory, "contracts/SheafFactory.sol:SheafFactory"],
    ["desk", d.desk, "contracts/CreationDesk.sol:CreationDesk"],
    ...d.baskets.map((b) => [b.symbol, b.address, "contracts/Basket.sol:Basket"]),
    ...d.tokens.filter((t) => t.isMirror).map((t) => [t.symbol, t.address, "contracts/mirrors/MockStock.sol:MockStock"]),
  ];
  if (d.stable.isMirror) items.push([d.stable.symbol, d.stable.address, "contracts/mirrors/MockDollar.sol:MockDollar"]);
  const ok = {};
  for (const [label, address, fqn] of items) ok[label] = await verifyOne(api, label, address, fqn);
  // Re-read before writing, so concurrent tools' fields are kept.
  const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
  fresh.verified = { via: `Blockscout ${api}`, at: new Date().toISOString(), contracts: ok };
  fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`${Object.values(ok).filter(Boolean).length}/${items.length} verified`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
