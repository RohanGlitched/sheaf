// Full-page screenshots of the local site for design review.
// node scripts/shots.cjs [base] [route ...]  -> ../.shots/<name>.png
const { chromium } = require("I:/Programs/ListofHackathon/hackathons/01-arbitrum-open-house/submission/video/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", ".shots");
fs.mkdirSync(OUT, { recursive: true });
const [base = "http://localhost:3900", ...routes] = process.argv.slice(2);
const list = routes.length ? routes : ["/"];
const mobile = process.env.MOBILE === "1";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  for (const r of list) {
    await page.goto(base + r, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(Number(process.env.WAIT || 6000));
    const name = (r === "/" ? "home" : r.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")) + (mobile ? "-m" : "");
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: process.env.FULL !== "0" });
    console.log(file);
  }
  await browser.close();
})();
