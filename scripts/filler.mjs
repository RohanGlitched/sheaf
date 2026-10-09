/**
 * An independent filler for Sheaf dollar orders. Reference code: copy it, read
 * it, change the pricing, run it against the house keeper.
 *
 * A dollar order escrows cash and runs a Dutch auction on share count. Whoever
 * delivers the stocks for the current count first takes the escrowed cash. This
 * script watches every open order, prices the stocks it would have to hand over
 * at Solana mainnet prices, and fills when the cash it would receive beats that
 * cost by the margin you choose. It needs the component tokens in its own wallet
 * (on devnet, the site's faucet hands them out) and keeps the cash it is paid.
 *
 * The decision code lives in web/lib/filler-core.ts, which the site's own second
 * filler (/api/filler2) runs too, so the two cannot drift. Node 22.18 or newer
 * runs that TypeScript file directly.
 *
 * Run it (in Linux, macOS or WSL):
 *
 *   node scripts/filler.mjs --keypair ~/.config/solana/id.json --dry-run --once
 *   node scripts/filler.mjs --keypair ~/.config/solana/id.json --edge-bps 20
 *
 *   --keypair <path>     wallet that delivers the stocks and is paid (default ~/.config/solana/id.json)
 *   --edge-bps <n>       minimum margin over cost, in basis points (default 20)
 *   --cash-mint <addr>   the only cash mint it accepts (default CASH_MINT in web/lib/cash.generated.ts)
 *   --rpc <url>          write cluster (default https://api.devnet.solana.com)
 *   --site <url>         where mainnet quotes and lookup tables come from (default https://sheaf.world)
 *   --dry-run            price and simulate, print what it would fill, sign and send nothing
 *   --once               one pass, then exit
 *
 * Defences. place_order is permissionless, so anyone can post an order in any
 * token. A filler that trusts the order is a free vending machine for stocks.
 * Before it sends anything, the core:
 *
 *   1. Accepts one cash mint. Every order in any other mint is skipped and
 *      logged. A token someone minted for free is worth nothing, whatever the
 *      raw amount says.
 *   2. Reads that mint from chain: its owner must be a token program and must
 *      match the order's cash program, and decimals come from the mint, not an
 *      assumption.
 *   3. Prices the payout net of the mint's Token-2022 transfer fee for the
 *      current epoch. A mint whose fee config cannot be read is skipped.
 *   4. Reads the basket's recipe from chain, not from the site, and prices the
 *      stocks it must deliver including any transfer-fee gross-up on them.
 *   5. Simulates the exact signed transaction and checks the filler's cash
 *      account grows by at least the expected net payout, and that no component
 *      leaves the wallet in a larger amount than was priced. Else it skips.
 *
 * Baskets of 7 or 8 components need an address lookup table to fit one packet;
 * it is read from --site's /api/alt and then from chain.
 *
 * What it still trusts: the quotes from --site (replace quoteFor to use your own
 * feed), the mirror maps in web/lib/*.generated.ts that link each devnet mint to
 * the mainnet stock it stands for, and that one whole unit of the accepted cash
 * mint is one dollar.
 *
 * Instruction and account layouts come from web/lib/sheaf-idl.json (the IDL the
 * program emits) and programs/sheaf/src/lib.rs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, runFillerPass } from "../web/lib/filler-core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** CASH_MINT as scripts/setup-cash.mjs wrote it, read as text so this file needs no TypeScript. */
function defaultCashMint() {
  const text = fs.readFileSync(path.join(ROOT, "web/lib/cash.generated.ts"), "utf8");
  const m = text.match(/export const CASH_MINT\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
  if (!m) throw new Error("CASH_MINT not found in web/lib/cash.generated.ts; pass --cash-mint");
  return m[1];
}

const RPC = arg("rpc", "https://api.devnet.solana.com");
const SITE = arg("site", "https://sheaf.world").replace(/\/$/, "");
const EDGE_BPS = Number(arg("edge-bps", "20"));
const CASH_MINT = new PublicKey(arg("cash-mint", null) ?? defaultCashMint());
const DRY_RUN = flag("dry-run");
const ONCE = flag("once");
const keypairPath = arg("keypair", path.join(os.homedir(), ".config/solana/id.json")).replace(/^~/, os.homedir());
const filler = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "web/lib/sheaf-idl.json"), "utf8"));
const connection = new Connection(RPC, "confirmed");

/** devnet mirror mint -> mainnet symbol, from the generated mirror maps. */
function mirrorSymbols() {
  const text = ["mirror.generated.ts", "mirror-prestocks.generated.ts"]
    .map((f) => fs.readFileSync(path.join(ROOT, "web/lib", f), "utf8"))
    .join("\n");
  const map = new Map();
  for (const m of text.matchAll(/"?([A-Za-z0-9]+)"?\s*:\s*\{[^}]*?writeMint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)) map.set(m[2], m[1]);
  return map;
}
const symbols = mirrorSymbols();

/** Mainnet quotes by symbol, from --site. Replace this to price from your own feed. */
async function quotesBySymbol() {
  const market = await fetch(`${SITE}/api/market`).then((r) => r.json());
  return new Map(market.quotes.map((q) => [q.symbol, q]));
}

/** The basket's lookup table: its address from --site, its contents from chain. */
async function lookupTable(basket) {
  const res = await fetch(`${SITE}/api/alt?basket=${basket.address.toBase58()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!res?.alt) return null;
  return (await connection.getAddressLookupTable(new PublicKey(res.alt))).value;
}

console.log(`filler ${filler.publicKey.toBase58()} on ${RPC}, cash mint ${CASH_MINT.toBase58()}, edge ${EDGE_BPS} bps${DRY_RUN ? ", dry run" : ""}`);
do {
  try {
    const quotes = await quotesBySymbol();
    await runFillerPass({
      connection,
      filler,
      idl,
      cashMint: CASH_MINT,
      edgeBps: EDGE_BPS,
      dryRun: DRY_RUN,
      quote: (mint) => quotes.get(symbols.get(mint.toBase58())),
      lookupTable,
      log: (line) => console.log(new Date().toISOString(), line),
    });
  } catch (e) {
    console.log("tick failed:", e.message);
  }
  if (!ONCE) await new Promise((r) => setTimeout(r, 5000));
} while (!ONCE);
