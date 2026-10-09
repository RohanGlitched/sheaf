/**
 * Asserts that the transaction `buildLaunch` (web/lib/launch.ts) builds fits
 * in Solana's 1,232-byte packet, at the worst case: a 32-character basket name
 * (the launch name is cut to 32) and a 10-character launch symbol. A longer
 * token URI once pushed it to 1,268 bytes and broke "Open the launch market"
 * for every new basket; this check fails loudly instead.
 *
 * It runs the real builder: web/lib is transpiled
 * with the project's own TypeScript into web/node_modules/.cache and loaded
 * as they are, against devnet. Nothing is signed by a wallet or sent.
 *
 *   node scripts/meteora-launch-size.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, connection, houseKey, web3 } from "./meteora-lib.mjs";

const LIMIT = 1232;
const WEB = path.join(ROOT, "web");
const require = createRequire(path.join(WEB, "package.json"));
const ts = require("typescript");

const OUT = path.join(WEB, "node_modules", ".cache", "meteora-launch-size");
fs.mkdirSync(OUT, { recursive: true });
// Every module in web/lib, so whatever launch.ts and dbc.ts import (mirror, prestocks, generated tables) resolves.
for (const file of fs.readdirSync(path.join(WEB, "lib"))) {
  const from = path.join(WEB, "lib", file);
  if (file.endsWith(".json")) fs.copyFileSync(from, path.join(OUT, file));
  if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
  const { outputText } = ts.transpileModule(fs.readFileSync(from, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true },
  });
  fs.writeFileSync(path.join(OUT, file.replace(/\.ts$/, ".js")), outputText);
}
const { buildLaunch, launchUri } = require(path.join(OUT, "launch.js"));

const { Keypair } = web3;
const cases = [
  { name: "A basket name of 32 characters!!", symbol: "ABCDEFGHI" },
  { name: "Thirty-two chars, plus a tail that is cut", symbol: "QAZZZZ9" },
  { name: "X", symbol: "X" },
];
let failures = 0;
for (const c of cases) {
  // A fresh address, so every derived slot is free and the builder goes all the way.
  const basket = { address: Keypair.generate().publicKey.toBase58(), ...c };
  const tx = await buildLaunch({ connection, creator: houseKey().publicKey, basket, navSol: 0.4321 });
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  const ok = bytes <= LIMIT;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${bytes} / ${LIMIT} bytes  name "${c.name.slice(0, 32)}"  uri ${launchUri(basket.address, 3).length} chars`);
}
if (failures) {
  console.error(`${failures} launch transaction(s) over ${LIMIT} bytes.`);
  process.exit(1);
}
console.log("Every launch transaction fits in one packet.");
