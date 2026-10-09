// Verifies the v2 desk and the plan desk where each chain's explorer reads
// verified sources: Tempo's Sourcify v2 server, sourcify.dev for Arbitrum
// Sepolia (its Blockscout API sits behind a bot challenge), and Blockscout's
// native v2 API everywhere else. Records the result under v2.verified.
//
//   npx hardhat run scripts/verify-v2.js --network <network>
//   V=3 npx hardhat run scripts/verify-v2.js --network <network>   # the v3 pair
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOURCIFY = { tempoTestnet: "https://contracts.tempo.xyz", arbitrumSepolia: "https://sourcify.dev/server" };

async function sourcify(server, chainId, label, address, fqn) {
  const existing = await fetch(`${server}/v2/contract/${chainId}/${address}`);
  if (existing.ok) {
    const j = await existing.json();
    if (j.match || j.runtimeMatch || j.creationMatch) {
      console.log(`already verified ${label} ${address} (${j.match || j.runtimeMatch})`);
      return true;
    }
  }
  const bi = await hre.artifacts.getBuildInfo(fqn);
  const r = await fetch(`${server}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput: bi.input, compilerVersion: bi.solcLongVersion, contractIdentifier: fqn }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.verificationId) {
    console.log(`could not submit ${label} ${address} - ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const s = await (await fetch(`${server}/v2/verify/${body.verificationId}`)).json();
    if (s.isJobCompleted) {
      const ok = !!(s.contract && (s.contract.match || s.contract.runtimeMatch));
      console.log(`${ok ? "verified" : "failed"} ${label} ${address} ${ok ? `(${s.contract.match || s.contract.runtimeMatch})` : JSON.stringify(s.error || s).slice(0, 300)}`);
      return ok;
    }
  }
  console.log(`timed out ${label} ${address}`);
  return false;
}

async function blockscoutVerified(api, address) {
  try {
    const r = await fetch(`${api}/api/v2/smart-contracts/${address}`);
    return r.ok && (await r.json()).is_verified === true;
  } catch {
    return false;
  }
}

async function blockscout(api, label, address, fqn) {
  if (await blockscoutVerified(api, address)) {
    console.log(`already verified ${label} ${address}`);
    return true;
  }
  const bi = await hre.artifacts.getBuildInfo(fqn);
  let r;
  for (let attempt = 1; ; attempt++) {
    const fd = new FormData();
    fd.append("compiler_version", `v${bi.solcLongVersion}`);
    fd.append("license_type", "mit");
    fd.append("contract_name", fqn.split(":")[1]);
    fd.append("autodetect_constructor_args", "true");
    fd.append("files[0]", new Blob([JSON.stringify(bi.input)], { type: "application/json" }), "input.json");
    r = await fetch(`${api}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: "POST", body: fd });
    if (r.status !== 429 || attempt >= 8) break;
    await sleep(20000 * attempt);
  }
  if (!r.ok) {
    console.log(`could not submit ${label} ${address} - ${r.status} ${(await r.text()).slice(0, 200)}`);
    return false;
  }
  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    if (await blockscoutVerified(api, address)) {
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
  const key = process.env.V === "3" ? "v3" : "v2";
  const rec = d[key];
  if (!rec?.desk) throw new Error(`no ${key} deployment recorded`);
  const items = [
    ["CreationDeskV2", rec.desk, "contracts/CreationDeskV2.sol:CreationDeskV2"],
    key === "v3"
      ? ["PlanDeskV3", rec.planDesk, "contracts/PlanDeskV3.sol:PlanDeskV3"]
      : ["PlanDesk", rec.planDesk, "contracts/PlanDesk.sol:PlanDesk"],
  ];
  const server = SOURCIFY[hre.network.name];
  const api = process.env.BLOCKSCOUT || d.explorer;
  const ok = {};
  for (const [label, address, fqn] of items) {
    ok[label] = server ? await sourcify(server, d.chainId, label, address, fqn) : await blockscout(api, label, address, fqn);
  }
  const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
  fresh[key].verified = { via: server ? `Sourcify ${server}` : `Blockscout ${api}`, at: new Date().toISOString(), contracts: ok };
  fs.writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`${Object.values(ok).filter(Boolean).length}/${items.length} verified`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
