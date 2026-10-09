#!/usr/bin/env node
// Checks the Panta market window (web/lib/panta-window.ts) against the NYSE
// calendar: holiday Fridays, an early-close Friday, a Good Friday and a plain
// week. Transpiles the three TypeScript modules it needs with the repo's own
// TypeScript, so it runs with plain node and no build.
//
// Usage: node scripts/panta-window-test.mjs

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "web", "package.json"));
const ts = require("typescript");

const out = join(tmpdir(), "sheaf-panta-window-test");
mkdirSync(out, { recursive: true });
for (const name of ["clock", "universe", "panta-window"]) {
  const src = readFileSync(join(root, "web", "lib", `${name}.ts`), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from "\.\/(clock|universe)"/g, 'from "./$1.mjs"');
  writeFileSync(join(out, `${name}.mjs`), js);
}
const w = await import(pathToFileURL(join(out, "panta-window.mjs")).href);

const ny = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const iso = (unix) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message.split("\n").join("\n      ")}`);
  }
}

// Each case: a market opened at `now` (UTC), and the closes it must measure.
const cases = [
  {
    name: "plain week: opened Mon Oct 12 2026 measures Fri Oct 16 16:00 to Fri Oct 23 16:00",
    now: "2026-10-12T14:00:00Z",
    from: "2026-10-16T20:00:00Z",
    to: "2026-10-23T20:00:00Z",
  },
  {
    name: "Thanksgiving week: Fri Nov 27 2026 closes early at 13:00 New York",
    now: "2026-11-23T14:00:00Z",
    from: "2026-11-27T18:00:00Z",
    to: "2026-12-04T21:00:00Z",
  },
  {
    name: "Christmas: Fri Dec 25 2026 is closed, the week ends at Thu Dec 24's 13:00 early close",
    now: "2026-12-14T15:00:00Z",
    from: "2026-12-18T21:00:00Z",
    to: "2026-12-24T18:00:00Z",
  },
  {
    name: "New Year: Fri Jan 1 2027 is closed, the week ends at Thu Dec 31 16:00",
    now: "2026-12-21T15:00:00Z",
    from: "2026-12-24T18:00:00Z",
    to: "2026-12-31T21:00:00Z",
  },
  {
    name: "opened after Thu Dec 24's early close: that week is decided, so the window starts a week later",
    now: "2026-12-24T19:30:00Z",
    from: "2026-12-31T21:00:00Z",
    to: "2027-01-08T21:00:00Z",
  },
  {
    name: "Good Friday: Fri Mar 26 2027 is closed, the week ends Thu Mar 25 16:00",
    now: "2027-03-15T14:00:00Z",
    from: "2027-03-19T20:00:00Z",
    to: "2027-03-25T20:00:00Z",
  },
  {
    name: "Apr 2 2027 is an ordinary Friday",
    now: "2027-03-29T14:00:00Z",
    from: "2027-04-02T20:00:00Z",
    to: "2027-04-09T20:00:00Z",
  },
];

for (const c of cases) {
  check(c.name, () => {
    const win = w.marketWindow(ny(c.now));
    assert.equal(iso(win.fromClose), c.from, "fromClose");
    assert.equal(iso(win.toClose), c.to, "toClose (Panta endTime)");
    assert.ok(win.opens <= win.fromClose, "trading opens before the measured week starts");
    assert.equal(win.resolves, win.toClose + 2 * 3600, "resolutionTime is two hours after the close");
  });
}

check("closeDayAtOrBefore skips Christmas and uses Thursday's early close", () => {
  assert.equal(w.closeDayAtOrBefore(ny("2026-12-25T23:00:00Z")), 20261224);
  assert.equal(w.closeDayAtOrBefore(ny("2026-12-24T17:59:00Z")), 20261223, "before the 13:00 close it is still Wednesday's");
  assert.equal(w.closeDayAtOrBefore(ny("2026-11-27T18:05:00Z")), 20261127, "Nov 27 counts from 13:00");
});

check("closeOn gives the real close and fmtClose prints it", () => {
  assert.equal(iso(w.closeOn(20261127)), "2026-11-27T18:00:00Z");
  assert.match(w.fmtClose(w.closeOn(20261127)), /13:00 New York/);
  assert.match(w.fmtClose(w.closeOn(20261016)), /16:00 New York/);
});

check("the rule carries the recipe units", () => {
  const win = w.marketWindow(ny("2026-10-12T14:00:00Z"));
  const rule = w.resolutionRule("BIG5", "https://example/api/nav/X", win, [
    { base: "NVDA", unitsPerShare: "11270680", decimals: 8 },
    { base: "AAPL", unitsPerShare: "5857223", decimals: 8 },
  ]);
  assert.match(rule, /NVDA 0\.1127068, AAPL 0\.05857223/);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
