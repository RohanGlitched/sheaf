// One-off: rename the brand from Tessera to Sheaf across the web app and scripts.
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIRS = ["web/app", "web/components", "web/lib", "scripts"];
const FILES = ["web/.env.example", "web/.env.local", "package.json"];
const SKIP = new Set(["rename-brand.mjs", "retheme.mjs"]);

const RULES = [
  [/teserra\.world/g, "sheaf.vercel.app"],
  [/TESSERA/g, "SHEAF"],
  [/Tesserae/g, "Sheaves"],
  [/tesserae/g, "sheaves"],
  [/Tessera/g, "Sheaf"],
  [/tessera/g, "sheaf"],
];

let changed = 0;
function fix(p) {
  if (SKIP.has(p.split(/[\\/]/).pop())) return;
  const before = readFileSync(p, "utf8");
  let s = before;
  for (const [re, to] of RULES) s = s.replace(re, to);
  if (s !== before) {
    writeFileSync(p, s);
    changed++;
  }
}
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs|js|json|css|sh|md)$/.test(name)) fix(p);
  }
}
for (const d of DIRS) walk(join(ROOT, d));
for (const f of FILES) if (existsSync(join(ROOT, f))) fix(join(ROOT, f));

for (const [from, to] of [
  ["web/lib/tessera.ts", "web/lib/sheaf.ts"],
  ["web/lib/tessera-idl.json", "web/lib/sheaf-idl.json"],
]) {
  if (existsSync(join(ROOT, from))) renameSync(join(ROOT, from), join(ROOT, to));
}
console.log({ changed });
