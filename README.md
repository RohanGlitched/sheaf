<div align="center">

<img src=".github/readme/cover.png" alt="Sheaf: bind any eight stocks into one share. A basket drawn as a sheaf of stalks tied by one blue band." width="100%">

**Baskets of tokenized stocks.** Bind up to eight tokenized stocks into one share, backed in kind by an onchain vault and redeemable for those stocks at any time. Each basket is a fixed recipe, like a unit investment trust: no manager and no rebalancing; a new mix is a new basket.

[**Open Sheaf**](https://sheaf-index.vercel.app) · [How it works](https://sheaf-index.vercel.app/method) · [Ledger](https://sheaf-index.vercel.app/ledger) · [Chains](https://sheaf-index.vercel.app/chains) · [Program reference](docs/program.md)

![Solana devnet](https://img.shields.io/badge/Solana-devnet-14251c?style=flat-square) ![5 EVM testnets](https://img.shields.io/badge/EVM-5%20testnets-14251c?style=flat-square) ![74 program tests](https://img.shields.io/badge/program%20tests-74%20%2B%2016%20unit-3438c9?style=flat-square) ![174 EVM tests](https://img.shields.io/badge/EVM%20tests-174%20passing-3438c9?style=flat-square) ![MIT](https://img.shields.io/badge/license-MIT-65726a?style=flat-square)

</div>

---

Tokenized stocks now trade around the clock on Solana and several EVM chains, but you still cannot hold a theme ("the AI builders", "the S&P plus gold") as one position. Today that means buying five tokens one by one and tracking them yourself, or trusting someone's fund. **Sheaf turns a list of stocks and weights into one token.** The program writes the recipe once and never changes it. A share is created by depositing exactly the stocks the recipe names and redeemed by taking exactly those back. The program reads no price, and no share can exist without the stocks behind it. On top of that core: dollar orders and sell orders filled by competing fillers in Dutch auctions, monthly plans anyone can run when due, a Meteora launch market per basket, a Panta prediction market per basket, and a live mainnet tape through Solami.

## Live

| | |
|---|---|
| App | [sheaf-index.vercel.app](https://sheaf-index.vercel.app): connect any Solana wallet set to devnet, or choose **Use a wallet in this browser** (nothing to install); an empty wallet gets test SOL and test dollars in one click |
| Create a basket | [/compose](https://sheaf-index.vercel.app/compose): 28 tokenized stocks (20 xStocks, 8 PreStocks pre-IPO tokens such as OpenAI, Anthropic, SpaceX) |
| Browse | [/explore](https://sheaf-index.vercel.app/explore) · [/plans](https://sheaf-index.vercel.app/plans) · [/predict](https://sheaf-index.vercel.app/predict) · [/portfolio](https://sheaf-index.vercel.app/portfolio) |
| Proof | [/ledger](https://sheaf-index.vercel.app/ledger) (every program event, decoded from the chain and cached) · [/business](https://sheaf-index.vercel.app/business) (fees, the protocol-fee claim receipt) · [/live](https://sheaf-index.vercel.app/live) (mainnet xStock trades through Solami) · [/chains](https://sheaf-index.vercel.app/chains) (each EVM vault read from its own chain) |
| Program | [`GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz`](https://explorer.solana.com/address/GaYNg5YZdNRa82Qn1383mvF1aEKhjVNmbsWg1UBNt8zz?cluster=devnet) on Solana devnet |

Try it in two minutes on Solana: **Connect** → **Use a wallet in this browser** → **Get test SOL and test dollars**. Open **The Big Five**, buy $20 with dollars; a filler delivers the stocks, usually within a minute or two (live medians on /ledger), and the shares land in your wallet. Sell some back for dollars from the same panel, or start a **Monthly** plan on a 5-minute period to watch it run.

On Robinhood Chain or Arbitrum Sepolia: open [/chains](https://sheaf-index.vercel.app/chains), pick a basket, connect (or use a wallet in this browser), take test stocks and dollars from the faucet, then create shares in kind or place a dollar auction the house fills. On Tempo: open the MAG8 basket and run the monthly plan panel; the chain itself refuses an overpay, an early run and any call outside the plan.

## How it works

```mermaid
flowchart LR
  R["Recipe<br/>up to 8 stocks, fixed units"] --> V["Vault<br/>owned by the basket PDA"]
  K["In kind<br/>deposit the stocks"] --> V
  D["With dollars<br/>auction, a filler delivers"] --> V
  P["Every month<br/>a dollar order on schedule"] --> D
  V --> S["Shares<br/>Token-2022, transferable"]
  S --> X["Redeem<br/>the stocks come back"]
```

| Step | What happens | Instructions |
|---|---|---|
| **Bind** | Anyone writes a recipe: 1 to 8 Token-2022 mints, raw units per share, weights, and a creator fee of at most 1%. The basket PDA becomes the share mint's authority; no instruction edits the recipe. | `create_basket` |
| **Buy in kind** | Deposit exactly the recipe for N shares and receive N shares (less the creator fee, minted to the creator as new shares). Deposits round up and are grossed up for any component transfer fee, so the vault always nets the full recipe. | `mint_shares` |
| **Buy with dollars** | Escrow dollars for a share count that falls linearly over the auction (the site uses 90 seconds, from 2% above the fair count to 2% below). The first filler to deliver the stocks at the current count takes the dollars; the vault receives the stocks through the same deposit path. Fillers compete on timing, so no price feed is read. The buyer, or anyone after expiry, can cancel for a full refund. | `place_order`, `fill_order`, `cancel_order` |
| **Every month** | A plan approves exactly `cash_per_run × runs` to the plan PDA once. When a run is due, anyone can turn it into a dollar order bracketing a reference rate. Each fill moves the reference to the rate the market cleared at; plans opened since Oct 9 re-center their bounds at ±6% around each fill, so a plan follows the market while no single run can be pushed far. | `open_plan`, `run_plan`, `update_plan`, `close_plan` |
| **Sell for dollars** | Escrow shares for a dollar amount that starts 2% above fair and falls to the seller's own floor, 2% below, over 90 seconds. The first filler to pay the current amount takes the shares and can redeem them in the same transaction. No protocol fee. | `place_sell_order`, `fill_sell_order`, `cancel_sell_order` |
| **Redeem** | Burn shares and take the components back, rounded down. Always available to any holder. | `redeem_shares` |

Every instruction, account, seed, event and error is in [docs/program.md](docs/program.md).

## Proof

What you can check without trusting this README:

- **Backing.** Every basket page has a backing table and, under it, the two RPC calls that reproduce it: the share mint's supply and each vault's balance. If vault ≥ supply × units per share for every component, every share is backed.
- **History.** [/ledger](https://sheaf-index.vercel.app/ledger) decodes every creation, redemption, order, fill and plan run from the program's own events. The server caches the decoded history; anyone can rebuild it from the chain, and the page falls back to decoding in the browser.
- **Tests.** `tests/sheaf.ts`, `tests/mainnet-clone.ts` and `tests/tx-size.ts` hold 74 integration tests as mocha counts them (`anchor test`) and `lib.rs` 16 unit tests (`cargo test -p sheaf --lib`, on the default and the `devnet` build): backing through 40 random creations and redemptions, transfer-fee gross-up, auction math at start, middle and end, plan scheduling and bounds, and the attacks that matter (impostor vaults, redirected shares and fees, stale fills, early cancels, hostile mint extensions), plus a basket of byte-for-byte clones of mainnet TSLAx, NVDAx and a PreStock created, minted and redeemed with every issuer power intact. The EVM suite in `evm/` has 174 tests.
- **Launch lifecycle.** A full Meteora launch on devnet, from first buy through graduation to every fee claim, with each signature: [docs/meteora.md](docs/meteora.md).
- **EVM vaults.** The same vault and recipe as Solidity contracts, deployed and source-verified on five testnets. The EVM v3 dollar desk runs the same Dutch auction as Solana, with a 0.10% protocol fee on fills paid to a separate treasury key (`0xEcb6…7355`) that the server does not hold; in-kind EVM mints have no protocol fee, because the v1 baskets are immutable. `PlanDeskV3` holds monthly plans whose amount, interval and owner's hard price limits are on chain, with bounds that trail each fill. The earlier v2 desks (whose fee went to the house key) and the v1 fixed-price desk stay live beside them; all addresses are in evm/README.md:

| Chain | Chain ID | SheafFactory | CreationDesk (v1) | Dollar desk (v3) | PlanDeskV3 | Verified on |
|---|---|---|---|---|---|---|
| Robinhood Chain testnet | 46630 | [`0xC836C83E283DA57aBD13c271Dd73D22B65dF89B1`](https://explorer.testnet.chain.robinhood.com/address/0xC836C83E283DA57aBD13c271Dd73D22B65dF89B1#code) | [`0x4184eb1540908CB0DbEd533c45Fba7123991951C`](https://explorer.testnet.chain.robinhood.com/address/0x4184eb1540908CB0DbEd533c45Fba7123991951C#code) | [`0x00F3…7c69`](https://explorer.testnet.chain.robinhood.com/address/0x00F3A2f7e7Fc3038767feC055F8c37f814FA7c69#code) | [`0x8C68…5045`](https://explorer.testnet.chain.robinhood.com/address/0x8C681091820d187cE77F670a8b9A4f66020a5045#code) | Blockscout |
| Tempo testnet (Moderato) | 42431 | [`0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7`](https://explore.testnet.tempo.xyz/address/0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7) | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://explore.testnet.tempo.xyz/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | [`0xD54d…940c`](https://explore.testnet.tempo.xyz/address/0xD54dA8527aDA17FB27C14A42fAa6837393EA940c) | [`0x1AFe…23b4`](https://explore.testnet.tempo.xyz/address/0x1AFe2b2af89D238797523387722cea2c8A8123b4) | Sourcify (contracts.tempo.xyz) |
| Ethereum Sepolia | 11155111 | [`0x08Ec8CD0db8c09b27b349e0F1e495083961cD9E0`](https://eth-sepolia.blockscout.com/address/0x08Ec8CD0db8c09b27b349e0F1e495083961cD9E0) | [`0x336cd7CF93e6b4CF4072C8C99D189B9eAc8126E4`](https://eth-sepolia.blockscout.com/address/0x336cd7CF93e6b4CF4072C8C99D189B9eAc8126E4) | [`0x5dDd…2D5A`](https://eth-sepolia.blockscout.com/address/0x5dDd10C17ed83bb926A75AcF787A5d11297F2D5A) | [`0x59Ea…62a9`](https://eth-sepolia.blockscout.com/address/0x59EaDb2f720654A58fC18C712C74288De0cC62a9) | Blockscout |
| Arbitrum Sepolia | 421614 | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://arbitrum-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | [`0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0`](https://arbitrum-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) | [`0x316B…da0F`](https://arbitrum-sepolia.blockscout.com/address/0x316B48D22e4344cDda7Af29555e92F72B314da0F) | [`0x6bDc…05EA`](https://arbitrum-sepolia.blockscout.com/address/0x6bDc853Ef6488d8e5941767A2f1fcd2fF65405EA) | Sourcify |
| Base Sepolia | 84532 | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://base-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | [`0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0`](https://base-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) | [`0x9526…B30D`](https://base-sepolia.blockscout.com/address/0x9526c52DE4ff94f9dF5eA4b2B5a0742e71EfB30D) | [`0x663c…4e48`](https://base-sepolia.blockscout.com/address/0x663c70243e15F3B47eDCc6f769B6C8Eac6e24e48) | Blockscout |

Basket, stock-token and stablecoin addresses for each chain, plus smoke-test hashes, are in [evm/README.md](evm/README.md) and [`web/lib/deployments/`](web/lib/deployments).

## Sponsor integrations

| Sponsor | What Sheaf does with it | Doc |
|---|---|---|
| **Meteora** | Each basket can open a Dynamic Bonding Curve priced from its own NAV (opens at 0.5× NAV, graduates at 5× NAV into a DAMM v2 pool with all LP permanently locked). Launch addresses derive from the basket, so discovery needs no indexer, and a pool only counts if the basket's creator opened it. One launch has been taken through its whole life on devnet. | [docs/meteora.md](docs/meteora.md) |
| **Panta** | Each basket whose holdings are all listed carries a market, "Will this basket beat SPY this week?". It resolves from the basket's recipe (its units written into the rule) valued at two week-ending NYSE closes (adjusted closes × each mint's multiplier, read on mainnet through Solami) against SPY's adjusted close, published with every input at `/api/nav/<basket>?at=<close>`. Baskets holding pre-IPO companies get no market. Discovery, quotes, create, trade, positions and claims run through Panta's API against its sandbox (`pk_test_` key), where the wallet signs a stand-in that is never broadcast. | [docs/panta.md](docs/panta.md) |
| **Solami** | Mainnet reads go through Solami's RPC: every xStock's dividend multiplier (which sets NAV) and a live tape of tokenized-stock trades, decoded every few seconds. Watch it at [/live](https://sheaf-index.vercel.app/live). The same key reads the dividend multipliers behind every basket's value and every Panta resolution. | [docs/solami.md](docs/solami.md) |

## Chains

| Chain | What runs there | Stocks | Cash |
|---|---|---|---|
| Solana devnet | The Sheaf program: baskets, dollar orders, plans; Meteora launch markets | Mirrors of the 28 mainnet mints | Sheaf test dollar (Token-2022) |
| Solana mainnet | Read only: prices, dividend multipliers, the tape | xStocks, PreStocks | – |
| Robinhood Chain testnet | Factory, desk, 3 baskets (HOOD5, CHIPS, PRIME) | Robinhood's own test stock tokens | USDG (testnet) |
| Tempo testnet | Factory, v1, v2 and v3 desks, 3 baskets; monthly plans on PlanDeskV3 through Tempo access keys, with a recurring spending limit and the price cap on chain | 8 labeled mirrors | AlphaUSD (TIP-20) |
| Ethereum Sepolia | Factory, desk, 3 baskets | 8 labeled mirrors | sUSD mirror |
| Arbitrum Sepolia | Factory, desk, 3 baskets | 8 labeled mirrors | sUSD mirror |
| Base Sepolia | Factory, desk, 3 baskets | 8 labeled mirrors | sUSD mirror |
| Hyperliquid (HyperEVM testnet) | Read only: a recipe priced from HyperCore stock perps through precompiles; nothing deployed | – | – |

## Business

Full breakdown with sources: [/business](https://sheaf-index.vercel.app/business).

| Who earns | What | Source |
|---|---|---|
| Sheaf (protocol) | 0.10% of every share created, fixed per basket when the basket is created and never changeable, accrued in the basket and claimed to the treasury as shares. Redeeming is free. Baskets created before this fee shipped carry none, for good. | `PROTOCOL_FEE_BPS` in `programs/sheaf/src/lib.rs` |
| Basket creator | 0% to 1% of every share created (`MAX_CREATOR_FEE_BPS = 100`), minted as new shares, never taken from the vault. The composer defaults to 0.25%. | `programs/sheaf/src/lib.rs` |
| Fillers, including Sheaf's house filler | A dollar order's share count starts 2% above fair and falls to 2% below over 90 seconds; the first filler to deliver keeps the difference. The house filler waits until it earns 0.15% over fair, so any filler willing to take less fills first. | `FILL_MARGIN_BPS` in `web/lib/keeper-server.ts` |
| Sheaf and the creator | Launch-market curve fees: Meteora keeps 20%, then 50/50, so 40% each. A 25% anti-snipe fee decays to 1% over 600 seconds. | `web/lib/meteora-preset.json` |
| Sheaf | A 1% migration fee at graduation, the 1% of launch-token supply left over after the curve, and half the fees of the graduated pool's locked LP. | `web/lib/meteora-preset.json` |

Holding a share costs nothing a year; there is no management fee. Monthly plans are free; each run pays the same fees as a dollar order. The first customers are non-custodial wallets and front ends that already list xStocks, adding baskets and monthly plans as a module; no platform has signed yet.

## Run it yourself

```bash
# Program (Linux or WSL, Anchor 0.31.1)
anchor test                      # 74 integration tests on a local validator
cargo test -p sheaf --lib        # 16 unit tests
anchor build                     # mainnet build: trusts only Backed's and PreStocks' issuer keys
anchor build -- --features devnet  # devnet build: adds the house stand-in issuer used by the mirrors

# Web app
cd web && pnpm install && pnpm dev

# EVM contracts
cd evm && npm install && npx hardhat test    # 174 tests
```

The web app reads these variables (see [web/.env.example](web/.env.example); only names are listed here):

| Variable | Secret | Purpose |
|---|---|---|
| `NEXT_PUBLIC_WRITE_CLUSTER` | no | `devnet` or `localnet` |
| `NEXT_PUBLIC_SHEAF_PROGRAM_ID` | no | the deployed program |
| `NEXT_PUBLIC_SITE_URL` | no | public URL for share images and the sitemap |
| `NEXT_PUBLIC_MAINNET_RPC` | no | mainnet fallback when `SOLAMI_API_KEY` is unset |
| `HELIUS_API_KEY` | yes | devnet RPC behind `/api/rpc` |
| `SOLAMI_API_KEY` | yes | mainnet reads |
| `PANTA_API_KEY` | yes | `pk_test_` runs against Panta's sandbox |
| `PANTA_API_BASE` | no | Panta API base URL override |
| `FAUCET_SECRET_KEY` | yes | mint authority of the devnet mirrors, for `/api/faucet` and the house keeper |
| `EVM_FAUCET_PRIVATE_KEY` | yes | testnet deployer key for the EVM faucet and keeper |
| `ADMIN_TOKEN` | yes | guards `/api/admin/launch` |

### Run your own filler

[`scripts/filler.mjs`](scripts/filler.mjs) is a standalone filler anyone can run against the house keeper. It needs the component tokens in its wallet (the site's faucet hands out devnet mirrors) and keeps the dollars it is paid.

```bash
node scripts/filler.mjs --keypair ~/.config/solana/id.json --dry-run --once   # price and simulate only
node scripts/filler.mjs --keypair ~/.config/solana/id.json --edge-bps 20
```

| Flag | Default | |
|---|---|---|
| `--keypair` | `~/.config/solana/id.json` | wallet that delivers the stocks and is paid |
| `--edge-bps` | `20` | minimum margin over the stocks' cost |
| `--cash-mint` | `CASH_MINT` from `web/lib/cash.generated.ts` | the only cash mint it fills; every other mint is skipped |
| `--rpc` | `https://api.devnet.solana.com` | write cluster |
| `--site` | `https://sheaf-index.vercel.app` | source of mainnet quotes |
| `--dry-run` | off | print what it would fill; sign nothing |
| `--once` | off | one pass, then exit |

Because `place_order` is permissionless, an order can name any token as cash. The filler refuses every cash mint but one, reads decimals and the Token-2022 transfer fee from that mint, reads the recipe from chain rather than the site, and simulates each fill to check that its cash balance rises by at least the expected net payout before it sends anything.

## Trust model

- **The program reads no price.** Creation and redemption are in kind, and backing is checked by the program itself. Dollar orders are auctions on share count bounded by the buyer's own terms; a plan's reference is its own last fill. Prices shown on the site, the house filler's quotes and Panta resolution come from Jupiter and listed closes, off chain.
- **No editable recipe.** No admin key, no rebalance authority, no fee switch: every fee is fixed per basket at creation. The share mint's authority is the basket PDA.
- **The program is upgradeable on devnet.** Its upgrade authority is a single deploy key. Before it holds real tokens it moves to a multisig after an audit. The multisig is kept, not burned, so new issuers (Ondo, Robinhood, Dinari) can be added to `KNOWN_ISSUERS`; an upgrade can change any code, so the multisig, a public timelock and a verifiable build are the safeguards.
- **Devnet, with mirror mints.** The program is unaudited, so it does not take custody of real stocks. Prices, dividend multipliers and the tape come from mainnet; vaults hold devnet mirrors. The mirrors match the real mints' decimals, metadata, `ScaledUiAmount` dividend multiplier and (for PreStocks) transfer fee. They do not carry the issuer powers the real mints have.
- **Issuer powers.** Real xStocks and PreStocks carry a freeze authority, a permanent delegate and a pause authority held by their issuer. Sheaf accepts those powers only when Backed or PreStocks hold them (`KNOWN_ISSUERS` in `lib.rs`) and refuses them under anyone else, including the basket creator. This is tested against byte-for-byte clones of mainnet TSLAx, NVDAx and a PreStock; the devnet mirrors themselves carry only metadata, ScaledUiAmount and transfer-fee extensions. An issuer that pauses or freezes one component blocks redemption of the whole basket until it lifts it.
- **The EVM contracts** have no owner, no pause and no upgrade path, and read no price; they refuse tokens that skim on transfer. Outside Robinhood Chain the stocks are labeled mirrors worth nothing.
- **Fill competition.** Today the house keeper and a second filler running the published reference code (both ours) do the filling. A filler with no competition can wait for the bottom of every auction; a plan's hard floor is still the owner's own `min_ref`, trailing or not, and no fill can move it past that.

## India

India's monthly-plan habit (10 crore SIP accounts, ₹32,297 crore a month; AMFI, Aug 2026) meets a capped fund route to US stocks. Sheaf's plan form takes rupee amounts and the [/plans](https://sheaf-index.vercel.app/plans) page sets out the rules with sources: Indian residents face the LRS limit, TCS, 30% crypto tax plus 1% TDS and an unsettled FEMA position, so the first users are Indians abroad where xStocks are sold and the wallets that serve them; residents come once the rules are clear. The page carries an India waitlist.

## Who builds it

Rohan Borade, solo, in India ([GitHub](https://github.com/RohanGlitched)).

## History and disclosure

Sheaf started as Tessera on Sep 13, 2026, one day before the hackathon window opened. The first commit that day (28,698 lines in 85 files) imported the Tessera codebase as it stood; treat everything in it as pre-existing. It was renamed Sheaf on Oct 8. Tessera was also entered in Stocklana, and the EVM vault contracts (`evm/contracts/Basket.sol`, `CreationDesk.sol`) were also entered in Arbitrum Open House (Robinhood Chain), submitted Oct 4. Everything in this repo after Sep 14 was built during the Crypto World's Fair window: the new program with dollar orders and monthly plans and its hardening release, the EVM vaults on five chains, the Panta and Solami integrations, the Meteora lifecycle, and the redesign.

## Repository

```
programs/sheaf   the Solana program (Anchor, Token-2022)
tests            74 integration tests
web              Next.js app: pages, the house keeper, the RPC proxy, share images
evm              Solidity vaults, desks, plans and mirrors for EVM chains, 174 tests
scripts          devnet setup, the reference filler, Meteora lifecycle scripts
docs             program reference, Meteora, Panta, Solami
```

<p align="center">
  <img src=".github/readme/home.png" alt="The home page: a live basket drawn as a sheaf, each stalk a company, tied by a band that reads 100.0% backed." width="49%">
  <img src=".github/readme/basket.png" alt="A basket page: the recipe as a sheaf and weight bars, and a panel to buy it with dollars, start a monthly plan, or create shares in kind." width="49%">
</p>
<p align="center">
  <img src=".github/readme/plans.png" alt="Plans: monthly plans drawn as sheaves that grow one stalk per filled run." width="49%">
  <img src=".github/readme/chains.png" alt="Chains: each chain's vaults read from its own chain." width="49%">
</p>

---

MIT licensed. Built by Rohan Borade. Not investment advice. xStocks are issued by Backed Finance and PreStocks by PreStocks; Sheaf issues neither and only holds them in the vaults a basket writes to.
