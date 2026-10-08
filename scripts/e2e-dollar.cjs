// End to end, in a real browser through the real wallet adapter: a fresh test
// wallet gets devnet SOL and test dollars, places a dollar order on a basket,
// and waits for a filler to deliver the shares.
//   node scripts/e2e-dollar.cjs [base] [basket]
const { chromium } = require("I:/Programs/ListofHackathon/hackathons/01-arbitrum-open-house/submission/video/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:3900";
const BASKET = process.argv[3] || "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";
const walletSrc = fs.readFileSync(path.join(__dirname, "browser-test-wallet.js"), "utf8").replace("export function", "function");

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Register the wallet before the app loads, the way an extension would.
  await context.addInitScript(`${walletSrc}; window.__testWallet = installTestWallet();`);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/429|Failed to load resource/.test(m.text()) && console.log("[page]", m.text().slice(0, 200)));
  await page.goto(`${BASE}/basket/${BASKET}`, { waitUntil: "domcontentloaded" });
  const address = await page.evaluate(() => window.__testWallet);
  console.log("wallet", address);

  const post = (url, body) => page.evaluate(async ([u, b]) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json(), [url, body]);
  console.log("sol", JSON.stringify(await post("/api/faucet/sol", { owner: address })).slice(0, 160));
  console.log("usdc", JSON.stringify(await post("/api/faucet", { owner: address, symbols: ["USDC"] })).slice(0, 160));

  await page.getByRole("button", { name: /Connect a wallet to buy with dollars/ }).click();
  await page.waitForTimeout(800);
  console.log("picker", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t).slice(0, 40))));
  await page.getByRole("button", { name: /Sheaf Test Wallet/ }).click();
  await page.waitForTimeout(2500);
  const place = page.getByRole("button", { name: /Place a \$100\.00 order/ });
  await place.waitFor({ timeout: 30000 });
  await place.click();
  console.log("placed, waiting for a filler");
  await page.waitForTimeout(15000);
  console.log("panel:", (await page.locator('[role="tablist"]').locator("xpath=../..").innerText()).replace(/\s+/g, " ").slice(0, 600));
  const t0 = Date.now();
  const poke = setInterval(async () => {
    const r = await fetch(`${BASE}/api/keeper`, { method: "POST" }).then((x) => x.json()).catch((e) => ({ e: e.message }));
    console.log(`  ${Math.round((Date.now() - t0) / 1000)}s keeper`, JSON.stringify(r).slice(0, 300));
  }, 30000);
  await page.getByText(/Filled\./).waitFor({ timeout: 200000 }).finally(() => clearInterval(poke));
  console.log(`filled after ${Math.round((Date.now() - t0) / 1000)}s:`, (await page.getByText(/Filled\./).textContent()).trim());
  await page.screenshot({ path: path.join(__dirname, "..", ".shots", "e2e-dollar.png") });
  await browser.close();
})().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
