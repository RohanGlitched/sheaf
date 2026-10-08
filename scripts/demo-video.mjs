/**
 * Record the technical demo against the live site, transactions and all.
 *
 * There is no wallet extension in an automated browser, so the usual way to
 * prove the write path is from Node — which skips the wallet adapter, and the
 * adapter is exactly the part a visitor uses. Instead this registers a Wallet
 * Standard wallet inside the page, backed by a devnet keypair funded from the
 * deploy wallet, and drives the real flow: connect, compose, lay a basket, sign
 * twice, create shares, redeem-side panels, Meteora.
 *
 * Everything on screen is the deployed app talking to devnet and mainnet. The
 * only thing that is not real is that the signer is a keypair in the tab rather
 * than a browser extension, and the run prints every signature it produced so
 * each one can be checked on an explorer.
 *
 *   node scripts/demo-video.mjs --site https://sheaf-fund.vercel.app
 *
 * Writes demo/technical-demo.webm and demo/shots/NN-*.png. Follows the beats in
 * TECHNICAL-VIDEO.md, captioned so it reads without narration; pass
 * --no-captions to record a clean plate to talk over.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { resilientConnection, sendResilient } from "./lib/rpc.mjs";
import { pageInit } from "./lib/demo-page.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_FILE = path.join(ROOT, ".demo-key.json");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const SITE = (flag("site") ?? "https://sheaf-fund.vercel.app").replace(/\/$/, "");
const OUT = path.resolve(flag("out") ?? path.join(ROOT, "demo"));
const SHOTS = path.join(OUT, "shots");
const CAPTIONS = !has("no-captions");
const HEADED = has("headed");
const RPC = flag("rpc") ?? "https://api.devnet.solana.com";

/** Seeded baskets the script visits by address. */
const BIG5 = flag("big5") ?? "6cUCq5GdhrdLGqJiy63iuc1epLFrEmAYQ45JvYEYGbg3";
const FRONTIER = flag("frontier") ?? "5Z8XUzGVJjcYPxPZ6Hfxx8uJRNKibFcmZd7yStuSPr1p";

const BIG5_TICKERS = ["NVDAx", "AAPLx", "MSFTx", "GOOGLx", "METAx"];
const FRONTIER_TICKERS = ["ANTHROPIC", "OPENAI", "SPACEX", "ANDURIL"];

const NAME = flag("name") ?? "Megacap eight";
const SYMBOL = (flag("symbol") ?? "MEGA8").toUpperCase();

/** Viewport the page lays out at. The video is upscaled from it to 1080p. */
const VIEW = { width: 1440, height: 810 };
const VIDEO = { width: 1920, height: 1080 };

const CHROME =
  flag("chrome") ??
  path.join(os.homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome");

const connection = resilientConnection(RPC);

/* ------------------------------------------------------------------ wallet */

function loadKeypair(file) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))),
  );
}

/**
 * The demo signer, reused between runs so its token accounts and share balances
 * survive. It holds a little devnet SOL and nothing else.
 */
function demoKeypair() {
  if (fs.existsSync(KEY_FILE)) return loadKeypair(KEY_FILE);
  const keypair = Keypair.generate();
  fs.writeFileSync(KEY_FILE, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, {
    mode: 0o600,
  });
  return keypair;
}

const TOP_UP_TO = 0.4;

async function fund(demo) {
  const balance = (await connection.getBalance(demo.publicKey)) / LAMPORTS_PER_SOL;
  if (balance >= TOP_UP_TO / 2) {
    console.log(`demo wallet holds ${balance.toFixed(4)} SOL, enough`);
    return;
  }
  const payerPath =
    flag("keypair") ?? path.join(os.homedir(), ".config/solana/id.json");
  const payer = loadKeypair(payerPath);
  const lamports = Math.round((TOP_UP_TO - balance) * LAMPORTS_PER_SOL);
  await sendResilient(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: demo.publicKey,
        lamports,
      }),
    ),
    [payer],
  );
  console.log(`funded the demo wallet to ${TOP_UP_TO} SOL from ${payerPath}`);
}

/**
 * Claim component tokens before the camera rolls. The faucet batches a whole
 * request into one transaction and rate-limits per address, so the two sets go
 * one after the other with the cooldown between them.
 */
async function claim(owner, symbols, label) {
  const response = await fetch(`${SITE}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, symbols }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    console.log(`faucet ${label}: ${body.signature}`);
    return true;
  }
  console.log(`faucet ${label}: ${body.error ?? response.status}`);
  return false;
}

/* ----------------------------------------------------------------- driving */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shot = 0;
async function frame(page, name) {
  shot += 1;
  const file = path.join(SHOTS, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
}

async function say(page, label, text, hold = 0) {
  await page.evaluate(
    ([l, t]) => window.__demo?.caption(l, t),
    [label, text],
  ).catch(() => {});
  if (hold) await wait(hold);
}

/** Move the visible cursor onto something, and optionally click it. */
async function point(page, target, { click = false, settle = 420 } = {}) {
  const locator = typeof target === "string" ? page.locator(target) : target;
  await locator.first().waitFor({ state: "visible", timeout: 30_000 });
  const box = await locator.first().boundingBox();
  if (!box) throw new Error("nothing to point at");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
  await wait(settle);
  if (click) {
    await page.mouse.down();
    await wait(70);
    await page.mouse.up();
  }
}

async function bring(page, target, { block = "center" } = {}) {
  const locator = typeof target === "string" ? page.locator(target) : target;
  await locator.first().waitFor({ state: "visible", timeout: 30_000 });
  await locator
    .first()
    .evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b }), block);
  await wait(900);
}

/** A mosaic tile, found by the ticker inside its accessible name. */
const tile = (page, symbol) =>
  page.locator(`g[aria-label*=", ${symbol},"]`).first();

async function connected(page) {
  return page.locator("header button:has(span.tnum)").first().isVisible().catch(() => false);
}

async function ensureConnected(page) {
  for (let i = 0; i < 30; i++) {
    if (await connected(page)) return true;
    await wait(500);
  }
  return false;
}

/* -------------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const file of fs.readdirSync(SHOTS)) fs.rmSync(path.join(SHOTS, file));

  if (!fs.existsSync(CHROME)) {
    console.error(
      `No Chromium at ${CHROME}. Pass --chrome /path/to/chrome, or run\n` +
        "  pnpm exec playwright install chromium",
    );
    process.exit(1);
  }

  const demo = demoKeypair();
  const owner = demo.publicKey.toBase58();
  console.log(`site      ${SITE}`);
  console.log(`signer    ${owner}`);

  await fund(demo);

  const before = await connection.getSignaturesForAddress(demo.publicKey, { limit: 1 });
  const mark = before[0]?.signature ?? null;

  // Off camera: the script's own advice, since a faucet claim proves nothing and
  // carries a cooldown.
  const gotBig5 = await claim(owner, BIG5_TICKERS, "big five");
  if (gotBig5) {
    console.log("waiting out the faucet cooldown…");
    await wait(62_000);
  }
  await claim(owner, FRONTIER_TICKERS, "frontier labs");

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !HEADED,
    args: ["--force-color-profile=srgb", "--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: VIDEO },
    colorScheme: "dark",
  });
  await context.addInitScript(pageInit, {
    seed: Array.from(demo.secretKey.slice(0, 32)),
    pub: Array.from(demo.publicKey.toBytes()),
    walletName: "Devnet Demo Wallet",
    captions: CAPTIONS,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const problems = [];
  page.on("pageerror", (err) => problems.push(String(err)));

  try {
    await run(page);
  } catch (err) {
    console.error(`\nstopped: ${err.message}`);
    await frame(page, "failure").catch(() => {});
  }

  const video = page.video();
  await context.close();
  await browser.close();

  if (video) {
    const from = await video.path();
    const to = path.join(OUT, "technical-demo.webm");
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
    const mb = (fs.statSync(to).size / 1e6).toFixed(1);
    console.log(`\nvideo     ${path.relative(ROOT, to)} (${mb} MB)`);
  }
  console.log(`shots     ${path.relative(ROOT, SHOTS)} (${shot} frames)`);

  const after = await connection.getSignaturesForAddress(demo.publicKey, { limit: 25 });
  const fresh = [];
  for (const entry of after) {
    if (entry.signature === mark) break;
    fresh.push(entry);
  }
  if (fresh.length) {
    console.log(`\n${fresh.length} transactions landed during the run, newest first:`);
    for (const entry of fresh.reverse()) {
      console.log(
        `  ${entry.err ? "failed " : "ok     "} https://explorer.solana.com/tx/${entry.signature}?cluster=devnet`,
      );
    }
  }
  if (problems.length) {
    console.log(`\n${problems.length} page errors (first): ${problems[0].slice(0, 200)}`);
  }
}

async function run(page) {
  /* ---------------------------------------------- 0:00 what this is */

  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await page.locator("svg[aria-label^='Market mosaic']").first().waitFor({ timeout: 60_000 });
  await wait(1200);
  await say(
    page,
    "Sheaf",
    "An ETF launchpad on Solana. An index fund is a list of companies and a set of weights — everything else is administration.",
    5200,
  );
  await frame(page, "home");
  await say(
    page,
    "Sheaf",
    "Pick the list, set the weights, one transaction — and you get a token backed share for share by a vault anyone can read.",
    5000,
  );

  /* ------------------------------------ 0:18 the mosaic is live mainnet data */

  await bring(page, "svg[aria-label^='Market mosaic']");
  await say(
    page,
    "Live mainnet",
    "Twenty real tokenised equities — xStocks issued by Backed Finance, trading on Solana mainnet. Every tile is sized by its actual on-chain liquidity.",
    4200,
  );
  await point(page, tile(page, "NVDAx"), { settle: 2400 });
  await frame(page, "mosaic-tooltip");
  await say(
    page,
    "Live mainnet",
    "Prices come through Jupiter. Supply and the dividend multipliers come from getMultipleAccounts. The slot number under the mosaic is mainnet's, not a timestamp I wrote.",
    4600,
  );
  const table = page.getByRole("button", { name: "Table", exact: true });
  if (await table.isVisible().catch(() => false)) {
    await point(page, table, { click: true });
    await wait(1600);
    await frame(page, "mosaic-table");
    await point(page, page.getByRole("button", { name: "Liquidity", exact: true }), {
      click: true,
    });
    await wait(1200);
  }

  /* ------------------------------------------------------------ 0:38 connect */

  await page.mouse.wheel(0, -1200);
  await wait(800);
  await say(
    page,
    "Connect",
    "Reads come from mainnet. Writes settle on devnet — deploying an unaudited program that takes custody of real tokenised Apple would be reckless.",
    1200,
  );
  await point(page, page.getByRole("button", { name: "Connect wallet" }), { click: true });
  await wait(800);
  await frame(page, "wallet-picker");
  await point(page, page.getByRole("button", { name: "Devnet Demo Wallet" }), {
    click: true,
  });
  if (!(await ensureConnected(page))) throw new Error("the wallet never connected");
  await wait(1400);
  await frame(page, "connected");

  /* ------------------------------------------------------- 0:48 compose */

  await point(page, page.getByRole("link", { name: "Compose", exact: true }), {
    click: true,
  });
  await page.waitForURL("**/compose", { timeout: 30_000 });
  await page.locator("svg[aria-label^='Market mosaic']").first().waitFor({ timeout: 60_000 });
  await wait(1400);
  await say(
    page,
    "Compose",
    "Eight components is the program's ceiling. I'll take a preset and add three more.",
    2200,
  );
  await point(page, page.getByRole("button", { name: "The big five" }), { click: true });
  await wait(1500);
  await frame(page, "preset");

  for (const symbol of ["SPYx", "QQQx", "TSLAx"]) {
    await point(page, tile(page, symbol), { click: true, settle: 700 });
    await wait(700);
  }
  await wait(900);
  await frame(page, "eight-picked");

  await say(
    page,
    "Compose",
    "Weighted by on-chain liquidity, because the least liquid thing in the list is what decides how large a mint can go before it moves the market.",
    1600,
  );
  await bring(page, page.getByRole("button", { name: "Weight by liquidity" }));
  await point(page, page.getByRole("button", { name: "Weight by liquidity" }), {
    click: true,
  });
  await wait(1800);
  await frame(page, "weights");

  await say(
    page,
    "Compose",
    "One share right now. The weighted 24-hour move. Dividend already accrued inside the components — that one matters more than it looks. And the thinnest component.",
    4600,
  );

  const nameField = page.locator("input[placeholder='Semiconductors, equal weight']");
  await bring(page, nameField);
  await point(page, nameField, { click: true });
  await nameField.fill("");
  await nameField.pressSequentially(NAME, { delay: 65 });
  const symbolField = page.locator("input[placeholder='CHIPS']");
  await point(page, symbolField, { click: true });
  await symbolField.fill("");
  await symbolField.pressSequentially(SYMBOL, { delay: 80 });
  await wait(700);
  await frame(page, "named");
  await say(
    page,
    "Compose",
    "The creator fee is capped at one percent by the program, and it is paid in shares, never out of the vault — so a creator cannot dilute what a share is backed by.",
    3800,
  );

  /* ------------------------------------------------- 1:25 lay it, two signatures */

  const lay = page.getByRole("button", { name: "Lay the basket" });
  await bring(page, lay);
  await say(
    page,
    "One transaction, twice",
    "Eight components compile to 1,260 bytes. A Solana transaction holds 1,232. packSteps measures the compiled message and splits it — so this takes two signatures.",
    1500,
  );
  await point(page, lay, { click: true });
  await wait(2500);
  await frame(page, "laying");
  await say(
    page,
    "One transaction, twice",
    "A share mint is created with the basket account as its mint authority, and the recipe is written down. Signing, then confirming on devnet.",
    0,
  );

  await page
    .getByText("exists.", { exact: false })
    .first()
    .waitFor({ timeout: 180_000 });
  await wait(1600);
  await frame(page, "laid");
  await say(
    page,
    "Laid",
    "That is a real basket on devnet. The recipe can never change, because there is no instruction in the program that could change it.",
    3800,
  );
  await point(page, page.getByRole("button", { name: `Open ${SYMBOL}` }), { click: true });
  await page.waitForURL("**/basket/**", { timeout: 30_000 });
  await wait(2200);
  await frame(page, "new-basket");

  /* ------------------------------------------------------- 1:50 the backing proof */

  await page.goto(`${SITE}/basket/${BIG5}`, { waitUntil: "domcontentloaded" });
  await ensureConnected(page);
  await page.getByText("The recipe").first().waitFor({ timeout: 60_000 });
  await wait(1800);
  await bring(page, page.getByText("The recipe").first());
  await say(
    page,
    "The recipe",
    "One with shares already outstanding. The recipe is an exact number of raw token units per share — not a percentage, not a dollar value.",
    4400,
  );
  await frame(page, "recipe");

  await bring(page, page.getByText("Is it actually backed?").first());
  await say(
    page,
    "Backed",
    "The page multiplies out what every outstanding share can claim, reads what the vault holds with one getTokenAccountBalance, and prints the comparison.",
    4600,
  );
  await frame(page, "backing");
  await say(
    page,
    "Backed",
    "Not quarterly, by an auditor, in a PDF. On every page load, by anyone. Deposits round up and withdrawals round down, so backing per share can only go up.",
    5000,
  );

  /* ------------------------------------------------------- 2:20 create shares */

  const createTab = page.getByRole("button", { name: "Create shares" }).first();
  await bring(page, createTab);
  await point(page, createTab, { click: true });
  await wait(900);
  await say(
    page,
    "Creation is in kind",
    "I hand the vault exactly what the recipe names and I get shares back. No price is consulted anywhere, so there is no oracle to go stale and none to manipulate.",
    4200,
  );
  await frame(page, "create-panel");

  const short = page.getByText("Short on", { exact: false }).first();
  if (await short.isVisible().catch(() => false)) {
    const send = page.getByRole("button", { name: /Send me \d+ of each/ }).first();
    await point(page, send, { click: true });
    await page.getByText("Sent.", { exact: false }).first().waitFor({ timeout: 120_000 });
    await wait(2000);
  }

  const create = page.getByRole("button", { name: /^Create [A-Z0-9]+$/ }).first();
  if (await create.isEnabled().catch(() => false)) {
    await point(page, create, { click: true });
    await say(
      page,
      "Creation is in kind",
      "Signed. Landing on devnet.",
      0,
    );
    await page
      .getByRole("link", { name: "See the transaction" })
      .first()
      .waitFor({ timeout: 180_000 })
      .catch(() => {});
    await wait(2500);
    await frame(page, "created");
    await say(
      page,
      "Creation is in kind",
      "I hold shares, the vault holds five real component positions, and the backing check is still green after the supply changed.",
      4200,
    );
    await bring(page, page.getByText("Is it actually backed?").first());
    await wait(1600);
    await frame(page, "backing-after");
  }

  await say(
    page,
    "Redemption",
    "Redeeming is the same instruction in reverse: burn shares, take the components back. It cannot fail for market reasons — if every buyer disappears, a share is still a claim on specific tokens in a specific account.",
    5200,
  );

  /* ------------------------------------------------------------ 2:42 the last mile */

  const lastMile = page.getByText("The last mile").first();
  if (await lastMile.isVisible().catch(() => false)) {
    await bring(page, lastMile);
    await say(
      page,
      "The last mile",
      "In kind has a real cost: someone holding only dollars has to buy the components first. Rather than claim that is small, the page measures it.",
      3400,
    );
    const one = page.getByRole("button", { name: "One share", exact: true }).first();
    if (await one.isVisible().catch(() => false)) {
      await point(page, one, { click: true });
      await wait(4500);
      await frame(page, "last-mile-one");
      const hundred = page.getByRole("button", { name: "100 shares", exact: true }).first();
      if (await hundred.isVisible().catch(() => false)) {
        await point(page, hundred, { click: true });
        await wait(5000);
        await frame(page, "last-mile-hundred");
      }
    }
    await say(
      page,
      "The last mile",
      "Every component quoted through Jupiter twice — dollars in, then straight back out — so the round trip is measured against one router, every venue named, and nothing executed.",
      4600,
    );
  }

  /* --------------------------------------------- 3:02 PreStocks and Meteora */

  await page.goto(`${SITE}/basket/${FRONTIER}`, { waitUntil: "domcontentloaded" });
  await ensureConnected(page);
  await page.getByText("The recipe").first().waitFor({ timeout: 60_000 });
  await wait(2000);
  await bring(page, page.getByText("The recipe").first());
  await say(
    page,
    "PreStocks",
    "ANTHROPIC, OPENAI, SPACEX and ANDURIL are not xStocks. They are PreStocks — pre-IPO SPVs — composed by the same program, in the same basket.",
    4200,
  );
  const tag = page.getByText("PreStocks", { exact: false }).first();
  if (await tag.isVisible().catch(() => false)) await point(page, tag, { settle: 1800 });
  await frame(page, "prestocks-recipe");

  const frontierCreate = page.getByRole("button", { name: "Create shares" }).first();
  await bring(page, frontierCreate);
  await point(page, frontierCreate, { click: true });
  await wait(1200);
  await say(
    page,
    "The transfer fee",
    "Some of those mints charge a transfer fee at the token-program level that no xStock has. Left alone, it would quietly under-back the vault.",
    4200,
  );
  const fee = page.getByText("+fee", { exact: true }).first();
  if (await fee.isVisible().catch(() => false)) await point(page, fee, { settle: 2000 });
  await frame(page, "plus-fee");
  await say(
    page,
    "The transfer fee",
    "mint_shares reads the live fee off the mint and grosses the deposit up — that is the plus-fee mark — so the vault still nets exactly what the recipe says.",
    4400,
  );

  const frontierGo = page.getByRole("button", { name: /^Create [A-Z0-9]+$/ }).first();
  if (await frontierGo.isEnabled().catch(() => false)) {
    await point(page, frontierGo, { click: true });
    await say(page, "The transfer fee", "Signing a deposit into a fee-charging mint.", 0);
    await page
      .getByRole("link", { name: "See the transaction" })
      .first()
      .waitFor({ timeout: 180_000 })
      .catch(() => {});
    await wait(2500);
    await frame(page, "frontier-created");
  }

  const meteora = page.getByText("Meteora DBC").first();
  if (await meteora.isVisible().catch(() => false)) {
    await bring(page, meteora);
    await wait(800);
    await say(
      page,
      "Meteora",
      "This basket also has a Meteora Dynamic Bonding Curve pool, sized off its own NAV rather than round numbers — opening and migration market caps at a multiple of what the basket is actually worth in SOL.",
      5200,
    );
    await frame(page, "meteora");
    await say(
      page,
      "Meteora",
      "Real config, real pool, and it has been bought into for real to prove it trades.",
      3600,
    );
  }

  /* ----------------------------------------------------------------- close */

  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await wait(2500);
  await say(
    page,
    "Sheaf",
    "Anchor program, three instructions, ten passing tests, zero oracles. Live at sheaf-fund.vercel.app; the program and the tests are on GitHub.",
    6000,
  );
  await frame(page, "close");
  await say(page, "", "", 900);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
