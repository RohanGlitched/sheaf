// One-off: rename Tessera's dark-theme design tokens to Sheaf's light-theme names
// across the web app. Longest names first so "ground-deep" never becomes "page-deep".
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MAP = [
  ["ground-deep", "page"],
  ["ground-raised", "raised"],
  ["ground-high", "sunk"],
  ["ground", "surface"],
  ["ivory-faint", "ink-3"],
  ["ivory-dim", "ink-2"],
  ["ivory", "ink"],
  ["rule-bright", "line-strong"],
  ["rule", "line"],
  ["gold", "bind"],
];
// Only touch Tailwind-style utility uses: a prefix like bg-, text-, border-, from-, fill-, stroke-, ring-, outline-, divide-, decoration-, accent-, caret-, placeholder-, shadow-
const PREFIX = "(?<=\\b(?:bg|text|border|border-[trblxy]|from|via|to|fill|stroke|ring|outline|divide|decoration|accent|caret|placeholder|shadow)-)";

let files = 0, hits = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(name)) fix(p);
  }
}
function fix(p) {
  let s = readFileSync(p, "utf8");
  const before = s;
  for (const [from, to] of MAP) {
    const re = new RegExp(PREFIX + from + "(?![\\w-])", "g");
    s = s.replace(re, () => { hits++; return to; });
    // CSS custom properties: --color-<from>
    s = s.replace(new RegExp("--color-" + from + "(?![\\w-])", "g"), () => { hits++; return "--color-" + to; });
  }
  if (s !== before) { writeFileSync(p, s); files++; }
}
walk(join(ROOT, "components"));
walk(join(ROOT, "app"));
walk(join(ROOT, "lib"));
console.log({ files, hits });
