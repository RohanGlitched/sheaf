// End to end, in a real browser through the real wallet adapter: a fresh test
// wallet gets devnet SOL and test dollars, places a dollar order on a basket,
// and waits for a filler to deliver the shares.
//   node scripts/e2e-dollar.cjs [base] [basket]
const { chromium } = require("I:/Programs/ListofHackathon/hackathons/01-arbitrum-open-house/submission/video/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:3900";
const BASKET = process.argv[3] || "FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ";
// One of the 100 fixed test wallets (web/lib/test-wallets.generated.ts): TEST_WALLET_INDEX, or one at random.
const INDEX = Number.isInteger(Number(process.env.TEST_WALLET_INDEX)) && process.env.TEST_WALLET_INDEX !== "" ? Number(process.env.TEST_WALLET_INDEX) : Math.floor(Math.random() * 100);
const walletSrc = fs.readFileSync(path.join(__dirname, "browser-test-wallet.js"), "utf8").replace("export function", "function");

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Register the wallet before the app loads, the way an extension would.
  await context.addInitScript(`${walletSrc}; window.__testWallet = installTestWallet({ index: ${INDEX} });`);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/429|Failed to load resource/.test(m.text()) && console.log("[page]", m.text().slice(0, 200)));
  await page.goto(`${BASE}/basket/${BASKET}`, { waitUntil: "domcontentloaded" });
  const address = await page.evaluate(() => window.__testWallet);
  console.log("wallet", address);

  const post = (url, body) => page.evaluate(async ([u, b]) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json(), [url, body]);
  console.log("sol", JSON.stringify(await post("/api/faucet/sol", { owner: address })).slice(0, 160));
  console.log("usdc", JSON.stringify(await post("/api/faucet", { owner: address, symbols: ["USDC"] })).slice(0, 160));

  await page.getByRole("tab", { name: "Monthly" }).click();
  await page.getByRole("button", { name: /Connect a wallet to start a plan/ }).click();
  await page.waitForTimeout(800);
  console.log("picker", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t).slice(0, 40))));
  await page.getByRole("button", { name: /Sheaf Test Wallet/ }).click();
  await page.getByRole("tab", { name: "Monthly" }).click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.getByRole("radio", { name: /Every 5 minutes/ }).click();
  const start = page.getByRole("button", { name: /Start a \$50\.00 plan/ });
  await start.waitFor({ timeout: 30000 });
  await start.click();
  await page.getByText("Your plan is running.").waitFor({ timeout: 60000 });
  console.log("plan opened; waiting for the first run to fill");
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/api/keeper`, { method: "POST" }).then((x) => x.json()).catch((e) => ({ e: e.message }));
    if ((r.plansRun || []).length || (r.ordersFilled || []).length || (r.errors || []).length) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(r).slice(0, 300));
    if ((r.ordersFilled || []).length) break;
    await new Promise((res) => setTimeout(res, 8000));
  }
  await page.goto(`${BASE}/plans`);
  await page.waitForTimeout(9000);
  console.log("plans page:", (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 700));
  await page.screenshot({ path: path.join(__dirname, "..", ".shots", "e2e-plan.png") });
  await browser.close();
})().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
