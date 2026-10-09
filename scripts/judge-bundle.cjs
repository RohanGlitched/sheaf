// A review bundle of the live site for judge agents: every page at desktop and
// phone width (full-page screenshots, sliced for reading) plus its visible text.
//   node scripts/judge-bundle.cjs [base]  -> ../.judge/pages/
const { chromium } = require("I:/Programs/ListofHackathon/hackathons/01-arbitrum-open-house/submission/video/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "https://sheaf.world";
const OUT = path.join(__dirname, "..", ".judge", "pages");
fs.mkdirSync(OUT, { recursive: true });
const ROUTES = [
  ["home", "/"],
  ["explore", "/explore"],
  ["basket-big5", "/basket/FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ"],
  ["basket-frontier", "/basket/6wDYMvCFE2q8vZgFmoYUkapVuz9Fst3BcCrSuyfpqruv"],
  ["compose", "/compose"],
  ["plans", "/plans"],
  ["chains", "/chains"],
  ["chain-robinhood-hood5", "/chains/robinhoodTestnet/HOOD5"],
  ["chain-tempo-mag8", "/chains/tempoTestnet/MAG8"],
  ["predict", "/predict"],
  ["portfolio", "/portfolio"],
  ["ledger", "/ledger"],
  ["method", "/method"],
  ["business", "/business"],
  ["voices", "/voices"],
  ["live", "/live"],
];

(async () => {
  const browser = await chromium.launch();
  for (const [vw, vh, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) {
    const page = await browser.newPage({ viewport: { width: vw, height: vh } });
    for (const [name, route] of ROUTES) {
      await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(9000);
      const file = path.join(OUT, `${name}-${tag}.png`);
      await page.screenshot({ path: file, fullPage: true });
      if (tag === "desktop") fs.writeFileSync(path.join(OUT, `${name}.txt`), await page.locator("body").innerText());
      // Slice tall pages so each image is readable.
      const { execFileSync } = require("child_process");
      execFileSync("python", ["-c", `
from PIL import Image
im=Image.open(r"${file}"); w,h=im.size; step=${tag === "desktop" ? 1800 : 2400}
for i in range((h+step-1)//step):
    c=im.crop((0,i*step,w,min(h,(i+1)*step)))
    if w>1000: c=c.resize((w//2,c.height//2))
    c.save(r"${file.replace(".png", "")}" + f"-{i}.png")
`]);
      fs.unlinkSync(file);
      console.log(tag, name);
    }
    await page.close();
  }
  await browser.close();
})();
