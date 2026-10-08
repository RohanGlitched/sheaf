// One-off: give controls and panels Sheaf's radius scale. Controls (bordered,
// padded, small text) get the 10px control radius; bordered surfaces with padding
// get the 18px panel radius. Anything that already sets a radius is left alone.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("../web/components/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const APP = new URL("../web/app/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let n = 0;

function fixClass(cls) {
  if (/\brounded/.test(cls)) return cls;
  const hasBorder = /\bborder\b/.test(cls);
  const padded = /\bp[xy]?-\d/.test(cls);
  const small = /\btext-(xs|sm)\b/.test(cls);
  const surface = /\bbg-(surface|raised|page|sunk)\b/.test(cls);
  if (hasBorder && /\bpx-\d/.test(cls) && /\bpy-\d/.test(cls) && small) {
    n++;
    return cls + " rounded-[var(--radius-control)]";
  }
  if (hasBorder && padded && surface) {
    n++;
    return cls + " rounded-[var(--radius-panel)]";
  }
  return cls;
}

function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "api" || name.name === "_og") continue;
      walk(p);
    } else if (name.name.endsWith(".tsx")) {
      const s = readFileSync(p, "utf8");
      const t = s
        .replace(/className="([^"]+)"/g, (_, c) => `className="${fixClass(c)}"`)
        .replace(/shadow-2xl shadow-black\/50/g, "shadow-[0_24px_48px_-24px_rgb(20_37_28/0.35)]");
      if (t !== s) writeFileSync(p, t);
    }
  }
}
walk(DIR);
walk(APP);
console.log({ rounded: n });
