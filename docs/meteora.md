# Sheaf on Meteora

Sheaf baskets are index funds of tokenized stocks. Every share is backed by real components held in a vault the program controls. A new basket has no shares yet, and nobody wants to be the first to assemble every component. A Meteora Dynamic Bonding Curve (DBC) opens a market in front of the basket. It sells a separate launch token (`<SYMBOL>A`) whose curve is priced from the basket's own NAV: it opens at 0.5× NAV and graduates at 5× NAV (launches opened on the first preset, v1, graduate at 20× NAV; see §2). When the curve fills, it graduates into a Meteora DAMM v2 pool whose LP positions stay locked permanently.

The launch token is a bet on the basket, not a redemption right. Everything below runs on **devnet**, against the real DBC program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (the same address as mainnet) and DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.

| Piece | Where |
|---|---|
| Curve, fees, one-signature open (`createConfigAndPool`) | `web/lib/launch.ts`, preset in `web/lib/meteora-preset.json` |
| Addresses, official-launch check, raw-account decoder | `web/lib/dbc.ts` |
| Curve trades (`swap2`, PartialFill buys), DAMM v2 trades (`cp-amm swap2`), LP fee read and claim | `web/lib/trade.ts` |
| Card with buy, sell, graduate, creator claim, LP claim, and the lifecycle receipts | `web/components/launch-market.tsx` |
| Public feed, no indexer | `GET /api/launches` |
| Scripts: decoder check, full lifecycle, squat test, partner claims, one buy | `scripts/meteora-*.mjs` |

## 1. The whole life of a launch, on devnet

BIG5A sits in front of The Big Five (`FFGgfTHbv9jAAHHv54aPQM7cdWZcr49m2APrjcPuiEfJ`). `scripts/meteora-lifecycle.mjs` took it the whole way: buy-out from three throwaway wallets, graduation, trading on DAMM v2, and every claim. Every signature is in `web/lib/meteora-lifecycle.json`. The home page renders them in "The whole life of a launch".

- Curve: `6rUHFtrZeZAS9HXeSfbWWFLcmwDohrUrp81qD1LArS7s`
- DAMM v2 pool: `BWUie5pJaUMonq7RFx6Cyp19dbw9TBqH5rmVUVY9Uenj`
- Threshold: 1.1263 SOL, filled exactly by the PartialFill buy

| Step | Instruction | Signature |
|---|---|---|
| House funds 3 wallets | system transfer | [4RarDmfw…f7njKc](https://explorer.solana.com/tx/4RarDmfwf5fBqvwyanzZQEPhZY98gMoF9uE6g1b9BK7FeK7qcZCJqBMvZaiVr97HQbvuEteHe3FXtzTPkAf7njKc?cluster=devnet) |
| Wallet 1 buys 0.30 SOL | DBC `swap2` ExactIn | [3DVMgn6a…HVMpGd](https://explorer.solana.com/tx/3DVMgn6aXdiA3fMQV8UZyDsAQRDMkshSTELX4bLny5ka3qKVFKYseBoakr2GtDoyPV5J4AQnc8LZ367tiKHVMpGd?cluster=devnet) |
| Wallet 2 buys 0.35 SOL | DBC `swap2` ExactIn | [4zdBokM1…FvqhFg](https://explorer.solana.com/tx/4zdBokM1pui3h26e2cjcHYkzmsmd2XUSiPJXRZF7SQLXmnBCeFHLdmszFAcRcK8DZT1UCXcCxkDt9T1PxDFvqhFg?cluster=devnet) |
| Wallet 1 sells a fifth back | DBC `swap2` base→quote | [5MsQcm7Z…UZQ6jY](https://explorer.solana.com/tx/5MsQcm7ZdpwQXMLYtJ8HfH7RdJRea3FFmtRc8M3apEXNmMSuMGjtLxsSYGHjiMCe91inh6CPjY18oa9gPJUZQ6jY?cluster=devnet) |
| Wallet 3 buys out the curve | DBC `swap2` PartialFill | [UtF86mMN…8Ak8wd](https://explorer.solana.com/tx/UtF86mMN2KZU7WZ7zDKbGEzq6G7JByCsQc6a3xFqVx18yYbYr8QGpH5mE3ZBQ1J3PsuwPTeuXg75ZhkEj8Ak8wd?cluster=devnet) |
| A buyer (not the creator) graduates it | `migrateToDammV2` | [3HEuEK78…fv1UdA](https://explorer.solana.com/tx/3HEuEK78b68fgM87BEBhUK4A1pAR7AZ8eW8CD67GuZ7uopNFU4NmNom2GWD2cGc35zJWP4RWFdo8xT4dMyfv1UdA?cluster=devnet) |
| Buy on DAMM v2 | cp-amm `swap2` | [5iguwzaA…e4Z9wX](https://explorer.solana.com/tx/5iguwzaAzPmjELS2RMHfLjiJiZSMGLyzuegreURRP63UyJxPE8YSmSu7oshD11aDFmu2SaBcvtQrPD6JpYe4Z9wX?cluster=devnet) |
| Sell on DAMM v2 | cp-amm `swap2` | [4RrQSbHQ…px3DS7](https://explorer.solana.com/tx/4RrQSbHQaKRSNE27ZjseqZoLvbT85BNVvNmdPQFvemfbw4S1ac4rnyuijUkvnT8E3haJV8F9WuEaz1xPwFpx3DS7?cluster=devnet) |
| Creator claims curve fees (0.007005 SOL) | `claimCreatorTradingFee` | [3vnLmZUG…XAgcHJ](https://explorer.solana.com/tx/3vnLmZUGYinqsTbtto8AXfdK2VmBUbAMwCseDNLH8r918ziuJ9hXfmKqxg1tWZztZmyLof4m1ih2uKevoyXAgcHJ?cluster=devnet) |
| Creator claims locked-LP fees (0.002271 SOL) | cp-amm `claimPositionFee` | [5Ycg7UPR…3MN5JU](https://explorer.solana.com/tx/5Ycg7UPR447Arxdpjmkox3Jd3okibcyrozBZsjcNScLUoq7FEXq6wpFhCAqa71sQA4zDt72rGp3EPkFDMg3MN5JU?cluster=devnet) |
| Treasury claims partner curve fees (0.007005 SOL) | `claimPartnerTradingFee` | [4TGcxFKA…Zt2WSx](https://explorer.solana.com/tx/4TGcxFKATcQ1UJs4BT4GLVmXtabDLY1Uh3rZiF7LLXj9C7VJqvj5waAVTNuN2bdPd1HhUSxWrTUsvrYZ2iZt2WSx?cluster=devnet) |
| Treasury withdraws the 1% migration fee (~0.0113 SOL) | `partnerWithdrawMigrationFee` | [2pNjWEWF…xy2gqZ](https://explorer.solana.com/tx/2pNjWEWFjjUruKJc65WRxRH1ZQvr6uV9wWDnMxsbfvVC5xuHEM8X7bjU9xFGeXCJM2ppSR82AXFGkvEv4Dxy2gqZ?cluster=devnet) |
| Treasury withdraws partner surplus | `partnerWithdrawSurplus` | [3ZkkiBLY…GNe42q](https://explorer.solana.com/tx/3ZkkiBLYpf6hQ6tyVNKhvsCn3rPGBrFvC1tuwHF8Xmgg6hhC2uRQH69qSVfrWSbWPPQQoDRtzCFjPKS1yCGNe42q?cluster=devnet) |
| Leftover 1% supply to the treasury | `withdrawLeftover` | [3woVQFFw…GFqF2W](https://explorer.solana.com/tx/3woVQFFw522NMXVpkuajQUMcJ8uuVfvtwUEicg6t4i6yuE48XPfByNh1q4EwsUqf5AfQzb3CHmF9kWuBdMGFqF2W?cluster=devnet) |
| Treasury claims locked-LP fees (0.002271 SOL) | cp-amm `claimPositionFee` | [5FBcxq3i…gDYXEn](https://explorer.solana.com/tx/5FBcxq3iF1XmNYVzeU8XzcYg752UBP1TTE4rKfym7EAdyocPbJUve4VMJSzfRq6fzJBvxcefVEQQmDs5J2gDYXEn?cluster=devnet) |

`scripts/meteora-partner.mjs` repeats the treasury side for every official launch in the feed. Its first run also claimed partner curve fees on QAENU6A ([345YAudJ…](https://explorer.solana.com/tx/345YAudJsLyVHa8pZN2qE9UR4xRBR75FEATMnxAwYxs72gLYGHYkCtV2hYU2GAyytF9ijqd9buDtc4hcPLq7n3jU?cluster=devnet)) and PROXYA ([5PfCe1E9…](https://explorer.solana.com/tx/5PfCe1E9jrsBbSEJTynDgDghbMuqHcHkcwnP9dTWNge3NyKtYHKxW17DUSZLKV3QJQo1xqQpkf4AUbUe5Jyb3HAM?cluster=devnet)).

**What the run taught us.** BIG5A was opened on the first preset (v1). One wallet's 0.30 SOL bought 548M tokens, more than half the supply, for 27% of the raise. Graduation put only about 6% of supply into DAMM v2. A single 46M-token sell then took the pool from a 18.5 SOL graduation cap down to about 6.2 SOL. Those are the two failure modes in §2. The v2 preset fixes both, and every launch opened now uses it.

## 2. Curve and fee rationale (preset `sheaf-nav-shelf-v2`)

The preset is `web/lib/meteora-preset.json`. Anyone can reuse it: market caps are multiples of a NAV you supply in the quote token. `buildLaunch` turns it into a DBC config with `buildCurveWithCustomSqrtPrices`.

- **Anchor.** The curve opens at 0.5× the basket's NAV (in SOL at open) and graduates at 5× NAV.
- **Shape.** There are four segments. The breakpoints are 1 → 1.5 → 2.5 → 5 → 10 × the opening cap, and the liquidity weights are 3 : 3 : 3 : 4. Four segments is the most that still fits the config and the pool in one transaction.
- **Supply.** 1B, Token-2022, 6 decimals, `Immutable` authority. 74.1% is sold on the curve, 24.9% goes into the graduated DAMM v2 pool, and the remaining 1% is leftover to the treasury.

Measured with the SDK's own builder at NAV = 10 SOL (every figure scales linearly with NAV):

| | v1 (BIG5A, FRNTRA, QAENU6A) | **v2 (PROXYA, QA3KRAA, every new launch)** |
|---|---|---|
| Opens at | 0.5× NAV | **0.5× NAV** |
| Graduation | 20× NAV (40× the opening cap) | **5× NAV (10× the opening cap)** |
| Cap breakpoints, × opening cap | 1 → 1.26 → 2 → 6.3 → 40 | **1 → 1.5 → 2.5 → 5 → 10** |
| Liquidity weights | 16 : 6 : 2 : 1 | **3 : 3 : 3 : 4** |
| SOL to graduate, per SOL of NAV | 1.219 | **1.258** |
| Supply sold on the curve | 93.0% | **74.1%** |
| Supply in the graduated DAMM v2 pool | 6.0% | **24.9%** |
| Supply bought by the first fifth of the raise | 43.5% | **33.7%** |
| Price at the first fifth of the raise | +26% | +123% |
| Market cap when half the raise is in | not recorded | ~2.5× NAV |
| Anti-snipe fee | 4% → 1% over 3,600 **slots** (about 24 minutes) | **25% → 1% over 600 seconds** |
| Fee clock | `ActivationType.Slot` | **`ActivationType.Timestamp`** |
| DAMM v2 fee | flat 1% | **2% → 1% market-cap scheduler** |

Why these choices:

- **A real graduated pool.** The DAMM v2 pool gets roughly `threshold / graduation cap` of supply. At 20× NAV that was 6%, so the first sell after graduation cratered the price (see BIG5A). At 5× NAV, 24.9% of supply is locked in the pool for good. 5× NAV is also a number an index product can defend; 20× was meme economics.
- **No half-the-token whale.** v1's heavy first segment (weight 16) sold 43.5% of supply for the first 20% of SOL. v2 spreads the weight, so the same money buys about a third. The early price is still the lowest on the curve; it just is not a shelf that one wallet can clear.
- **A bot tax that ends.** The exponential fee scheduler runs 60 periods of 10 seconds, with a reduction factor of 522 / 10,000 per period. A buy in the opening block pays 25%, a buy at one minute about 18%, at five minutes about 5%, and at ten minutes 1%. On devnet a 0.01 SOL buy 98 seconds after PROXYA opened paid 15.43% ([3FdswP7j…](https://explorer.solana.com/tx/3FdswP7jGShqdzic17P4V65Ga3VNsRpSYB3gVH7WP9bECiRa6tKVoL5iXkpqghKgRGCRBiAJRbCCP4yABttvuk54?cluster=devnet)). The dynamic fee stays on for volatility.
- **A graduation cushion.** The DAMM v2 base fee uses `FeeMarketCapSchedulerExponential`. It opens at 2% and falls to 1% only as the market cap doubles from graduation (10 steps, 7-day expiry). Selling into a falling pool right after graduation pays the locked LP more. A token that holds its price trades at 1%.
- **Fees.** Curve fees are collected in SOL, split 50/50 creator/partner. There is a 1% migration fee to the partner. 100% of graduated LP is permanently locked, half for the creator and half for the partner, and both halves keep earning.

The first v2 launch is PROXYA (slot 1, see §3): pool `3HX35pe7XTfD38o9EZEwhYKfVLZuE7Vx7SZfaLvjz8hV`, opened in one signature ([xRNiKFgd…](https://explorer.solana.com/tx/xRNiKFgdw4DNUBVGUpMxGhjSktu6cMqVk7QFUFBSrU7vCNiJ67tchr8DehBr4dPMVDEPCgEEqNaaESqGp8z61qs?cluster=devnet)). Its config decodes as `activation timestamp, cliff 250000000, 60 periods of 10, reduction 522`. BIG5A, FRNTRA and QAENU6A keep their v1 curves; PROXYA and QA3KRAA are v2. The UI reads every multiple from each pool's own config, so both kinds display correctly.

## 3. Indexer-free discovery, and why a squatter cannot take a launch

Each basket's launch lives at addresses derived from the basket: config and mint keypairs come from `sha256("sheaf-launch-v1:{role}:{basket}")`. Anyone can find a launch with one batched `getMultipleAccounts`. The secrets of those keys are public, so anyone can also create *something* there. Discovery therefore never trusts an address. `checkLaunch` (`web/lib/dbc.ts`) decodes both accounts and accepts a pool only if all of these hold:

| Check | Offset |
|---|---|
| Both accounts are owned by the DBC program | — |
| `pool.config` is this config and `pool.base_mint` is this mint | VirtualPool 72, 136 |
| `config.fee_claimer` is Sheaf's treasury | PoolConfig 40 |
| `config.leftover_receiver` is Sheaf's treasury | PoolConfig 72 |
| `config.quote_mint` is wrapped SOL | PoolConfig 8 |
| `config.migration_option` is 1 (DAMM v2) | PoolConfig 233 |
| `pool.creator` is the basket's creator | VirtualPool 104 |

The last check is the one a squatter cannot pass: DBC requires the pool creator's signature to create a pool.

- **Squat.** A pool that fails the checks is never shown as the launch. `/api/launches` lists it under `unofficial` with the reason, and the basket page names it as unofficial.
- **DoS.** Sending lamports to a derived key, or squatting it, only burns that slot. A basket has `LAUNCH_SLOTS = 4` derived slots. Slot 1 and later are salted: `sheaf-launch-v2:{role}:{basket}:{n}`. `buildLaunch` opens in the first slot whose pool, config and mint are all empty, and refuses if an official launch already exists. That refusal makes `/api/admin/launch` idempotent.
- **Readers.** `openLaunches`, `findLaunch`, `readDbcState`, `/api/launches`, `LaunchHoldings`, `FeaturedLaunch` and `BasketLaunch` all go through the check.

**Proven on devnet.** `scripts/meteora-squat-test.mjs` squatted PROXY's slot 0 with the public keys ([4idbhKkH…](https://explorer.solana.com/tx/4idbhKkH8RXQroStBLrsUDBovzeLsjCZddnGqVvvDutLjr6ZkGTb8uAZJVG6NM3MhYE5bHox49FR7D2Qm9KcXX45?cluster=devnet)). The squat copied everything it could: fees to the treasury, leftover to the treasury, migration to DAMM v2. Only the creator differed. `/api/launches` reports `{"slot":0,"reason":"It was not opened by the basket's creator."}`. The house then opened PROXY's real launch, which went into slot 1 automatically. Receipts are in `web/lib/meteora-squat.json`.

Honest limit: four slots raise the cost of bricking from one rent-exempt account to eight. A determined griefer can still burn all four for about 0.01 SOL. The full fix is to record the pool in the Sheaf basket account, which needs a program change. The other option is random keys plus `getProgramAccounts` with a memcmp on `pool.creator` (offset 104), which the browser RPC proxy does not allow today.

`scripts/meteora-check.mjs` decodes BIG5A, FRNTRA and PROXYA with both the hand offsets and the SDK, field by field, and exits non-zero on any mismatch. A layout upgrade therefore fails loudly instead of silently.

`GET /api/launches` returns one entry per basket with these fields:

- `launch {pool, config, mint, symbol, slot}`
- `open`, `official`
- `raisedSol`, `thresholdSol`
- `marketCapSol`, `openCapSol`, `graduationCapSol`, `graduated`
- `creatorFeesSol`, `partnerFeesSol`, `totalFeesSol`
- `feeSchedulerCounts` (`slots` or `seconds`)
- `shape`, the curve's own breakpoints
- `unofficial`, when present

The response is cached 30 seconds at the edge. It needs no indexer and no SDK.

## 4. UI fixes in this pass

- The featured card read "FRNTRAA". `FeaturedLaunch` now passes the basket's own name and symbol (`FEATURED_BASKET`: Frontier Labs, FRNTR).
- When no SOL has been raised, the card reads "Opens at X SOL. Be the first buyer." instead of showing zeros.
- A full curve blocks both buys and sells, with a clear message (`CURVE_FULL`). `buildCurveTrade` refuses before sending, and the program's `PoolIsCompleted` error maps to the same text.
- The multiple in "Graduates at" is computed from each pool (20× for v1, 5× for v2). The copy no longer claims "less than a quarter" or "within the hour".
- The card border uses `border-line`.

## 5. Mainnet plan

- **Same program ids, no code change** beyond `TREASURY` and the cluster split in `lib/config.ts`.
- **Keeper migration thresholds.** Meteora's mainnet keepers auto-migrate SOL-quoted pools at a `migration_quote_threshold` of at least 10 SOL, and USDC pools at 750. v2 needs 1.258 SOL per SOL of NAV, so a basket would need about 8 SOL of NAV per share to clear 10 SOL. Mainnet launches will therefore floor the threshold at `max(1.258 × NAV, 10 SOL)` by raising the anchor, or quote in USDC with a 750 floor (which also stops "0.5× NAV" drifting with SOL/USD). Below the floor, graduation depends on anyone pressing Graduate, which the card already offers to every visitor.
- **NAV provenance.** Write the NAV used, the SOL price and the timestamp into the launch metadata at `/api/launch/[address]`, so readers can check "opened at 0.5× NAV".
- **Partner ops** run from `scripts/meteora-partner.mjs` on a schedule, using the treasury key from the environment.
- No mainnet transaction has been sent. Mainnet needs real SOL and the owner's go-ahead.

## 6. What is devnet, and what is not built

- **Devnet.** Every pool, trade, graduation and claim above. The house (faucet) key funds throwaway wallets. Their keys are in `.keys/lifecycle-wallets.json`, which is gitignored.
- **Not built.**
  - **DLMM NAV-band pool for the basket share.** Share mints on devnet are Token-2022 mirrors with no external price feed, and DLMM needs a bin-step and rebalancing keeper to hold ±0.5% of NAV. That is a day of work, not hours.
  - **Share-quoted curves** (quote in the basket share itself).
  - **`createConfigAndPoolWithFirstBuy`** for creator first buys.
  - **Partner metadata.**
  - **Swap-event tape.**
