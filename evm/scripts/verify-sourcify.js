// Verifies a deployment through a Sourcify v2 server. Tempo's verifier
// (https://contracts.tempo.xyz) speaks only the v2 API, which hardhat-verify 2.x
// does not, so this posts the standard-JSON input directly.
//
//   npx hardhat run scripts/verify-sourcify.js --network tempoTestnet
//   SOURCIFY_V2=https://sourcify.dev/server npx hardhat run scripts/verify-sourcify.js --network <net>
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const SERVERS = { tempoTestnet: "https://contracts.tempo.xyz" };

async function verifyOne(server, chainId, label, address, fqn) {
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
    await new Promise((res) => setTimeout(res, 3000));
    const s = await (await fetch(`${server}/v2/verify/${body.verificationId}`)).json();
    if (s.isJobCompleted) {
      if (s.contract && (s.contract.match || s.contract.runtimeMatch)) {
        console.log(`verified ${label} ${address} (${s.contract.match || s.contract.runtimeMatch})`);
        return true;
      }
      console.log(`failed ${label} ${address} - ${JSON.stringify(s.error || s).slice(0, 300)}`);
      return false;
    }
  }
  console.log(`timed out ${label} ${address}`);
  return false;
}

async function main() {
  const server = process.env.SOURCIFY_V2 || SERVERS[hre.network.name];
  if (!server) throw new Error(`no Sourcify v2 server for ${hre.network.name}`);
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = [
    ["SheafFactory", d.factory, "contracts/SheafFactory.sol:SheafFactory"],
    ["CreationDesk", d.desk, "contracts/CreationDesk.sol:CreationDesk"],
    ...d.baskets.map((b) => [`Basket ${b.symbol}`, b.address, "contracts/Basket.sol:Basket"]),
    ...d.tokens.filter((t) => t.isMirror).map((t) => [`MockStock ${t.symbol}`, t.address, "contracts/mirrors/MockStock.sol:MockStock"]),
  ];
  if (d.stable.isMirror) items.push(["MockDollar", d.stable.address, "contracts/mirrors/MockDollar.sol:MockDollar"]);
  const ok = {};
  for (const [label, address, fqn] of items) ok[label] = await verifyOne(server, d.chainId, label, address, fqn);
  d.verified = { via: server, at: new Date().toISOString(), contracts: ok };
  fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
