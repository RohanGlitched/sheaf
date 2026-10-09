# Sheaf on Meteora

A Sheaf basket binds tokenized stocks into one share. Every share is backed by real components held in a vault the program controls. A basket's creator can also open a Meteora Dynamic Bonding Curve (DBC) beside the basket. It sells a separate launch token (`<SYMBOL>A`) whose curve is priced from the basket's own NAV: it opens at 0.5× NAV and graduates at 5× NAV (launches opened on the first preset, v1, graduate at 20× NAV; see §2). When the curve fills, it graduates into a Meteora DAMM v2 pool whose LP positions stay locked permanently.

The launch token is not a share: the vault does not back it, and it cannot be redeemed for the stocks. Frontier Labs, the one basket of pre-IPO SPV tokens (PreStocks for Anthropic, OpenAI, SpaceX and Anduril), keeps its launch only on its own basket page, with a warning: in May 2026 Anthropic and OpenAI said transfers of their stock without board approval, tokenized ones included, are void. Explore and the home page never promote it. Everything below runs on **devnet**, against the real DBC program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (the same address as mainnet) and DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.

| Piece | Where |
|---|---|
| Curve, fees, one-signature open (`createConfigAndPool`) | `web/lib/launch.ts`, preset in `web/lib/meteora-preset.json` |
| Addresses, official-launch check (identity and terms), raw-account decoder | `web/lib/dbc.ts` |
| Curve trades (`swap2`, PartialFill buys), DAMM v2 trades (`cp-amm swap2`), LP fee read and claim | `web/lib/trade.ts` |
| Card with buy, sell, graduate, creator claim, LP claim, and the lifecycle receipts | `web/components/launch-market.tsx` |
| Public feed and trade tape, no indexer | `GET /api/launches`, `GET /api/launches/trades?pool=` |
| Scripts: decoder, terms and anchor check (`meteora-check`), launch-size check, full lifecycle, squat test, exact-terms squat, rogue-terms test, rogue-anchor test, partner claims, one buy | `scripts/meteora-*.mjs` |

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

`scripts/meteora-partner.mjs` repeats the treasury side for every official launch in the feed. Its first run also claimed partner curve fees on QAENU6A, a launch opened by our own QA test wallet ([345YAudJ…](https://explorer.solana.com/tx/345YAudJsLyVHa8pZN2qE9UR4xRBR75FEATMnxAwYxs72gLYGHYkCtV2hYU2GAyytF9ijqd9buDtc4hcPLq7n3jU?cluster=devnet)) and PROXYA ([5PfCe1E9…](https://explorer.solana.com/tx/5PfCe1E9jrsBbSEJTynDgDghbMuqHcHkcwnP9dTWNge3NyKtYHKxW17DUSZLKV3QJQo1xqQpkf4AUbUe5Jyb3HAM?cluster=devnet)).

**What the run taught us.** BIG5A was opened on the first preset (v1). One wallet's 0.30 SOL bought 548M tokens, more than half the supply, for 27% of the raise. Graduation put only about 6% of supply into DAMM v2. A single 46M-token sell then took the pool from a 18.5 SOL graduation cap down to about 6.2 SOL. Those are the two failure modes in §2. The v2 preset fixes both, and every launch opened now uses it.

## 2. Curve and fee rationale (preset `sheaf-nav-shelf-v2`)

The preset is `web/lib/meteora-preset.json`. Anyone can reuse it: market caps are multiples of a NAV you supply in the quote token. `buildLaunch` turns it into a DBC config with `buildCurveWithCustomSqrtPrices`.

- **Anchor.** The curve opens at 0.5× the basket's NAV (in SOL at open) and graduates at 5× NAV.
- **Shape.** There are four segments. The breakpoints are 1 → 1.5 → 2.5 → 5 → 10 × the opening cap, and the liquidity weights are 3 : 3 : 3 : 4. Four segments is the most that still fits the config and the pool in one transaction.
- **Supply.** 1B, Token-2022, 6 decimals, `Immutable` authority. 74.1% is sold on the curve, 24.9% goes into the graduated DAMM v2 pool, and the remaining 1% is leftover to the treasury.

Measured with the SDK's own builder at NAV = 10 SOL (every figure scales linearly with NAV):

| | v1 (BIG5A, FRNTRA; QAENU6A, opened by our QA test wallet) | **v2 (PROXYA and every new launch; QA3KRAA and the other QA launches are ours too)** |
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
- **Fees.** Curve fees are collected in SOL. The DBC program keeps 20% of every fee for Meteora (`PROTOCOL_FEE_PERCENT`), and `creator_trading_fee_percentage = 50` splits the other 80% evenly, so **the creator and Sheaf's treasury each get 40% of every curve fee**, not half. On BIG5A the curve charged 0.017513 SOL in fees: Meteora 0.003503 (20.0%), creator 0.007005 (40.0%), treasury 0.007005 (40.0%). There is a 1% migration fee, all of it to the treasury. 100% of graduated LP is permanently locked, half for the creator and half for the treasury. DAMM v2 also keeps 20% of the pool's fees (BIG5A's pool: 0.001175 to the protocol against 0.004701 to LP), so each locked half earns 40% of every graduated-pool fee. The split is also in the preset (`feeSplit`) and in the feed.

The first v2 launch is PROXYA (slot 1, see §3): pool `3HX35pe7XTfD38o9EZEwhYKfVLZuE7Vx7SZfaLvjz8hV`, opened in one signature ([xRNiKFgd…](https://explorer.solana.com/tx/xRNiKFgdw4DNUBVGUpMxGhjSktu6cMqVk7QFUFBSrU7vCNiJ67tchr8DehBr4dPMVDEPCgEEqNaaESqGp8z61qs?cluster=devnet)). Its config decodes as `activation timestamp, cliff 250000000, 60 periods of 10, reduction 522`. BIG5A, FRNTRA and QAENU6A (our QA test wallet's) keep their v1 curves; PROXYA and QA3KRAA (also ours, from a QA run) are v2. The UI reads every multiple from each pool's own config, so both kinds display correctly.

## 3. Indexer-free discovery, and why neither a squatter nor a creator on other terms gets the official label

Each basket's launch lives at addresses derived from the basket: config and mint keypairs come from `sha256("sheaf-launch-v1:{role}:{basket}")`. Anyone can find a launch with one batched `getMultipleAccounts`. The secrets of those keys are public, so anyone can also create *something* there. Discovery therefore never trusts an address. `checkLaunch` (`web/lib/dbc.ts`) decodes both accounts and accepts a pool only if all of these hold:

| Check | Offset |
|---|---|
| Both accounts are owned by the DBC program | — |
| `pool.config` is this config and `pool.base_mint` is this mint | VirtualPool 72, 136 |
| `config.fee_claimer` is Sheaf's treasury | PoolConfig 40 |
| `config.leftover_receiver` is Sheaf's treasury | PoolConfig 72 |
| `config.quote_mint` is wrapped SOL | PoolConfig 8 |
| `config.migration_option` is 1 (DAMM v2) | PoolConfig 233 |
| `pool.creator` is the basket's creator (required: no creator, no official launch) | VirtualPool 104 |
| **Terms:** no unlocked or vesting LP (`partner_liquidity_percentage`, `creator_liquidity_percentage`, both vesting percentages all 0), and locked LP split 50/50 | PoolConfig 240, 242, 185, 201; 239, 241 |
| **Terms:** `token_update_authority` is 1 (Immutable), `token_type` is 1 (Token-2022), and the mint has no mint authority | PoolConfig 246, 237; mint 0 |
| **Terms:** fees in SOL, `creator_trading_fee_percentage` is 50 | PoolConfig 232, 245 |
| **Terms:** `migration_fee_option` is 6 (Customizable), `migration_fee_percentage` ≤ 1, `creator_migration_fee_percentage` is 0 | PoolConfig 243, 247, 248 |
| **Terms:** no locked vesting supply | PoolConfig 296, 328 |
| **Terms:** the curve, fee schedule, volatility fee and DAMM v2 fee are exactly v1 or v2 (breakpoints and liquidity weights within 0.2%) | PoolConfig 104–148, 234, 362, 364, 392, 408… |
| **Anchor** (server side, `app/api/launch/anchor.ts`): the opening market cap ÷ 0.5, times SOL's price in the hour of the open, is within 10% of the basket's NAV at the last US close before the open | VirtualPool 296 (`activation_point`), PoolConfig 392 |

The creator check is the one a squatter cannot pass: DBC requires the pool creator's signature to create a pool. The terms checks are the ones a creator cannot pass. The anchor check closes the last gap: the terms compare the curve with its own start price, so without it a creator could script the exact v2 shape opening at 0.01× or 100× NAV. The open time comes from the pool's own `activation_point`, SOL's price from Coinbase's hourly candles (Kraken's as a fallback), and the NAV from `/api/nav/<basket>?at=<open time>`. Nothing the creator wrote is used. A mismatch makes the launch unofficial, in the feed and on the card. A basket with a pre-IPO component has no listed close, so its anchor is reported as `unverifiable`, never as verified. On a basket whose holdings are all listed, `unverifiable` only means a price source or the NAV read failed, so the pool is not treated as official until the check answers: the feed marks it `official: false` with `unofficialReason: "checking the opening price"`, the metadata carries `provenance.checking: true`, and the card stays read-only. The tolerance is 10%. Every listed launch measured so far is within 2.4% (IDXA within 0.1%, BIG5A −0.80%, PROXYA +1.74%, QA3KRAA +1.65%), and the card prints the measured figure ("½ × NAV: +1.7% vs the 2026-10-08 close"), not just "verified". FRNTRA is unverifiable (pre-IPO).

The anchor runs on the server over every pool on the published terms, in slot order (`resolveLaunch` in `app/api/launch/anchor.ts`). The first pool that is not a mismatch is the launch. A mismatched pool, or a later pool on the same terms, is listed as unofficial with its reason, so nothing found at a basket's addresses disappears. `buildLaunch` treats a refused slot as used, not as the launch, so a creator whose first pool was refused can still open a correct one.

**Rogue anchor, proven on devnet.** `scripts/meteora-anchor-test.mjs` had IDX's own creator (the house key) open a pool in IDX's free slot 1 ([4fuB2dGq…](https://explorer.solana.com/tx/4fuB2dGqG8SuUEXsTY4QiRLNy2og6ESqWNQDBWhR7dPCppyqQ4BP6EVpLVdfqUPMpHUFVhbUhnSbYREj3M9edvan?cluster=devnet), pool `HGECig2uZGtNG4dsHVqbPQLWfW3V1U9ESazBx3dAEfxo`, 0.0146 SOL). It uses the exact v2 terms with every price doubled, so the curve opens at 1× NAV. The creator and terms checks pass. The anchor check refuses it: "The curve opened at 0.99x the basket's NAV, not 0.5x" (+98.97%). IDXA in slot 0 stays the launch. The receipt is `rogueAnchor` in `web/lib/meteora-squat.json`. `scripts/meteora-check.mjs` asserts all of this against the site's `/api/launch/<basket>` on every run:
- IDXA, PROXYA and BIG5A verified within 5%;
- the rogue-anchor pool refused. A creator can skip the UI and script `createConfigAndPool` on any terms at a free slot of their own basket, so every claim the card makes ("liquidity locked for good", "immutable", the fee split, the preset) is now read from the config, and a pool that breaks one is unofficial, with the broken term as the reason. Every offset is from the `PoolConfig` struct in the SDK 1.5.12 IDL and is asserted against the SDK's decoder by `scripts/meteora-check.mjs`.

- **Squat.** A pool that fails the checks is never shown as the launch. `/api/launches` lists it under `unofficial` with the reason. The basket page lists it too: under the live card, in "Pools Sheaf refused at this basket's addresses", or as a note when the basket has no launch.
- **DoS.** Sending lamports to a derived key, or squatting it, only burns that slot. A basket has `LAUNCH_SLOTS = 4` derived slots. Slot 1 and later are salted: `sheaf-launch-v2:{role}:{basket}:{n}`. `buildLaunch` opens in the first slot whose pool, config and mint are all empty, and refuses if an official launch already exists. That refusal makes `/api/admin/launch` idempotent.
- **Readers.** `openLaunches`, `findLaunch`, `readDbcState`, `/api/launches`, `LaunchHoldings`, `FeaturedLaunch` and `BasketLaunch` all go through the check.

**Proven on devnet.** `scripts/meteora-squat-test.mjs` squatted PROXY's slot 0 with the public keys ([4idbhKkH…](https://explorer.solana.com/tx/4idbhKkH8RXQroStBLrsUDBovzeLsjCZddnGqVvvDutLjr6ZkGTb8uAZJVG6NM3MhYE5bHox49FR7D2Qm9KcXX45?cluster=devnet)). That first squat also broke the terms (90% of its LP unlocked, a different curve), and it is reported as "not opened by the basket's creator" only because the creator is checked first. `/api/launches` reports `{"slot":0,"reason":"It was not opened by the basket's creator."}`. The house then opened PROXY's real launch, which went into slot 1 automatically. Receipts are in `web/lib/meteora-squat.json`.

**The exact-terms squat isolates the creator check.** `scripts/meteora-squat-exact.mjs` had a key that is not IDX's creator (our own lifecycle wallet 1, `7gVx…Y4CT`, playing a stranger) open IDX's slot 2 ([4dza5yaR…](https://explorer.solana.com/tx/4dza5yaR29kbSoDtkbWYhtMhjx6fVMxNnAWS6mRrnk62cJYY4sauBCU8jvMxhXKqWrBL53StERSwv3swjgWktS5U?cluster=devnet), 0.0146 SOL). Everything else matches: the exact v2 preset, the real launch's own prices (so it opens at half of NAV), locked LP, fees and leftover to the treasury, DAMM v2, even the per-slot metadata URL. Its terms pass (`launchTerms` → v2), and it is refused on the creator check alone: "It was not opened by the basket's creator." The receipt is `squatExact` in `meteora-squat.json`. With the rogue-terms and rogue-anchor receipts, each of the three checks (creator, terms, anchor) now has a pool that fails it and only it.

**Rogue terms, proven on devnet.** `scripts/meteora-rogue-test.mjs` had PROXY's own creator (the house key) open a pool in PROXY's free slot 2 ([2r73HUpR…](https://explorer.solana.com/tx/2r73HUpR8p6nLJjZ2N6tQqJwcWSZcFZ94WXoyF3Ppz9sXREzpyyuQYjE7ZVCzrWCU5AL17NGQXDKt69ybNj8saxo?cluster=devnet), pool `6vcMztC7j2oSREJ8cQ2gZEHq9THaNuDtfnv6ESwLJQHD`, 0.0146 SOL of rent). It copies the v2 preset exactly, the same price points as the real launch, fees to the treasury, DAMM v2, with one rogue term: the creator's half of the graduated liquidity is unlocked (`creator_liquidity_percentage = 50`). The creator check passes. `/api/launches` reports `{"slot":2,"reason":"50% of its graduated liquidity is not permanently locked and can be withdrawn after graduation."}`, and `meteora-check.mjs` asserts that verdict (and the squat's) on every run. The receipt is `rogueTerms` in `web/lib/meteora-squat.json`.

Honest limit: four slots raise the cost of bricking from one rent-exempt account to eight. A determined griefer can still burn all four for about 0.01 SOL. The full fix is to record the pool in the Sheaf basket account, which needs a program change. The other option is random keys plus `getProgramAccounts` with a memcmp on `pool.creator` (offset 104), which the browser RPC proxy does not allow today.

`scripts/meteora-check.mjs` decodes eight pools with both the hand offsets and the SDK, field by field (45 fields each), and runs the terms check on each:
- BIG5A v1, FRNTRA v1, PROXYA v2, IDXA v2;
- the rogue anchor v2 and the exact squat v2 (both pass the terms on purpose);
- the first squat and the rogue terms rejected.

It then asks the site for each verdict that needs prices or the creator: IDXA, PROXYA and BIG5A anchored within 5%; the rogue anchor refused as a mismatch; the exact squat refused on the creator; and the per-slot metadata for the refused slots answering "Not an official Sheaf launch". It exits non-zero on any mismatch. A layout upgrade or a broken check therefore fails loudly instead of silently.

`GET /api/launches` returns one entry per basket with these fields:

- `basket {address, name, symbol, creator}`
- `test`: true for launches our own QA runs opened (a test basket, or one a team test wallet created). They are **left out unless `?tests=1`**
- `launch {pool, config, mint, symbol, slot}`
- `open`, `official`, `preset` (`v1` or `v2`) and `presetId`
- `raisedSol`, `thresholdSol`
- `marketCapSol`, `openCapSol`, `graduationCapSol`, `graduated`
- `totalFeesSol` (every curve fee ever charged, Meteora's share included), `meteoraFeesSol`, `creatorFeesEarnedSol` and `partnerFeesEarnedSol` (40% each, always equal)
- `creatorFeesUnclaimedSol`, `partnerFeesUnclaimedSol`: what each side has not claimed yet. These differ once one side claims; the split does not
- `anchor`: `{status: verified | mismatch | unverifiable, deviationPct, openedAt, navSolAtOpen, solUsdAtOpen, navUsdAtClose, closeDay, navProof}` (`navProof` links to `https://sheaf.world/api/nav/<basket>?at=<open time>`)
- `preIpo`: the pre-IPO companies in the basket, when there are any
- `feeSchedulerCounts` (`slots` or `seconds`)
- `shape`, the curve's own breakpoints
- `unofficial`, when present

At the top level: `feeSplit`, `launchesOpened`, `onCurve` and `graduated` (a graduated launch counts once, as graduated; `openLaunches` is kept as an alias of `onCurve`), `solRaisedOnCurves` (every curve, graduated ones included), `solOnCurvesNow` and `solRaisedByGraduated`, and `testLaunchesHidden`. The feed does not tag wallets. The team's wallets are listed in `web/lib/team-wallets.ts`, which is used only to leave QA launches out.

`GET /api/launches/trades?pool=<DBC pool>` is the trade tape: every recent swap on the curve and, once graduated, on the DAMM v2 pool, read from the pool's SOL vault change in each transaction: signature, time, wallet, side, SOL moved and market. Wallets are not tagged. The card lists it as "Recent trades". It reads only the pools of official launches (refreshed once a minute), refuses other sites' origins, and allows 20 calls a minute per IP, so the work behind it is bounded by the number of launches.

`GET /api/launch/<basket>/<slot>` is a launch token's metadata: every launch opened since 9 October is minted with it. It answers with the official metadata only when that slot holds the basket's launch, and with "Not an official Sheaf launch", the reason and the official mint for anything else (a squat, a refused pool, or a mint that borrows the URL). `GET /api/launch/<basket>` serves the first launches' immutable URIs (BIG5A, FRNTRA, PROXYA, IDXA). It starts its description with "Describes mint … only" and carries `official_mint` and `official_pool` attributes, so a token that points its own URI there is told apart. Its `external_url`, `image` and NAV proof link point at `https://sheaf.world`; only the minted URI stays on `sheaf-index.vercel.app`, because a token's URI cannot change. Besides name, symbol and image, it carries the provenance as attributes: `preset`, `opened_at`, `nav_sol_at_open`, `sol_usd_at_open`, `nav_usd_at_last_close`, `anchor`, `redeemable: no`, and `pre_ipo_components` where they apply. The full anchor, with the NAV proof link, is under `provenance`, with `provenance.refused` listing every pool refused at the basket's addresses and `provenance.rejected` the ones the anchor refused. The routes allow 60 reads a minute per IP and redirects any URL with a query string to the bare one (308), so the edge cache always answers.

Both responses are cached 30 seconds at the edge. They need no indexer and no SDK.

## 4. House buys (ours, not traction)

To give the v2 curve a visible shape, the house key bought PROXYA three times on 9 October with `WALLET=house scripts/meteora-buy.mjs`. These are Sheaf's own buys, from the house key listed in `web/lib/team-wallets.ts`. PROXYA was not graduated.

| Buy | Fee paid | Signature |
|---|---|---|
| 0.020 SOL | 1.05% | [3ijvbVH1…](https://explorer.solana.com/tx/3ijvbVH1HRzBb6Z5dwzuiAqTSu4w6EtVN8eWs7ALmGAyNgDBBWRNphdY92GqZDkAJvkAyLptPMnnHvE5dy6ZHMMP?cluster=devnet) |
| 0.015 SOL | 1.20% | [46rr2T3i…](https://explorer.solana.com/tx/46rr2T3iPEptUZQdZcCdCg7qrK6xtVZFhSx4RMaNXgJxZLv1muLxzUNQPNRnBcbPdzUqLUX5k5vy2pynj5sNSWLt?cluster=devnet) |
| 0.025 SOL | 1.20% | [5mf7qu1w…](https://explorer.solana.com/tx/5mf7qu1we7SjxhgTVmVhgy3zxJSFD5rjQmaDtjCCrbfixBNLQ98sDMYrf5iXqsFQxskNuwEMn31BHNJxHKkXSA84?cluster=devnet) |

PROXYA now holds 0.0678 SOL of its 0.578 SOL threshold. Every buy on it so far is ours: the first (0.01 SOL, 3FdswP7j…) came from lifecycle wallet 2. Receipts are in `web/lib/meteora-house-buys.json`.

## 5. UI fixes

Round 3:

- The home card now features PROXYA, the first launch on the v2 curve, through `FEATURED_LAUNCH`. FRNTRA stays reachable from Frontier Labs' own basket page, and the method page keeps Frontier Labs as its running example basket. (Since round 7 the home card and the method page feature IDXA instead: PROXYA's metadata URI is on the retired domain, see §6.)
- The curve marker is right from the first frame. The tween starts at the pool's own value, and the dot and its label always come from the settled state; only the fill animates after a trade. A graduated pool's dot sits at the end of the curve, and amounts under 0.1 SOL show three significant figures (PROXYA read "0 SOL in" while it held 0.0085 SOL).
- Every card links its preset (v2 to `meteora-preset.json`, v1 to §2 here) and lists recent trades.
- A graduated pool whose market cap is below half its graduation figure says why on its card. The graduation figure is the market cap at the curve's last price, not SOL raised. On v1 only 6% of supply went into the pool, so BIG5A's one stress sell after graduation took it from 18.48 SOL to about 6.4 SOL.
- The copy gives the real fee split: 40% to the creator, 40% to the treasury, 20% to Meteora.

Round 2:

- The featured card read "FRNTRAA". `FeaturedLaunch` now passes the basket's own name and symbol (`FEATURED_BASKET`: Frontier Labs, FRNTR).
- When no SOL has been raised, the card reads "Opens at X SOL. Be the first buyer." instead of showing zeros.
- A full curve blocks both buys and sells, with a clear message (`CURVE_FULL`). `buildCurveTrade` refuses before sending, and the program's `PoolIsCompleted` error maps to the same text.
- The multiple in "Graduates at" is computed from each pool (20× for v1, 5× for v2). The copy no longer claims "less than a quarter" or "within the hour".
- The card border uses `border-line`.

## 6. Mainnet plan

- **Same program ids, no code change** beyond `TREASURY` and the cluster split in `lib/config.ts`.
- **Keeper migration thresholds.** Meteora's mainnet keepers auto-migrate SOL-quoted pools at a `migration_quote_threshold` of at least 10 SOL, and USDC pools at 750. v2 needs 1.258 SOL per SOL of NAV, so a basket would need about 8 SOL of NAV per share to clear 10 SOL. Mainnet launches will therefore floor the threshold at `max(1.258 × NAV, 10 SOL)` by raising the anchor, or quote in USDC with a 750 floor (which also stops "0.5× NAV" drifting with SOL/USD). Below the floor, graduation depends on anyone pressing Graduate, which the card already offers to every visitor.
- **NAV provenance (built, derived, not written).** For a few hours on 9 October, `buildLaunch` put `?nav=&sol=&t=&preset=` in the token URI. That pushed the one-transaction open to 1,268 bytes against Solana's 1,232-byte limit, and "Open the launch market" failed for every new basket. No launch ever opened with that URI. The URI is now short, fixed to the production host and keyed by slot: `https://sheaf-index.vercel.app/api/launch/<basket>/<slot>` (IDXA, opened before the slot was added, carries `/api/launch/<basket>`). The provenance is derived from the pool's own accounts and independent prices instead (the anchor check in §3), so nothing a creator writes is trusted. `scripts/meteora-launch-size.mjs` builds the real launch transaction for a 32-character name and fails above 1,232 bytes. With the slot in the URI and the plain basket name (no ", early access"), it measures 1,213 bytes for a 32-character name. IDXA was then opened through the real builder (`/api/admin/launch`, v2 preset): [2CWDhhPx…](https://explorer.solana.com/tx/2CWDhhPxNvDgNn8LHp3Vag3q7Bkf3pUxaDM8bfz43yJK9f1E343QYX1BQbBos83UACi2LtaFdW79CsCmsZWWnY8X?cluster=devnet), pool `FtpxNnWB5HdBRG8jDvvFbQoXbvMkVn8LCRy6DmaF5eVi`. Its mint's URI is on the right domain, its mint authority is null, and its anchor verifies within 0.1% (NAV $250.53 implied against $250.51 at the 8 October close).
- **Known issue: three metadata URIs on a domain we no longer control.** BIG5A, FRNTRA and PROXYA were opened before the site moved to sheaf-index.vercel.app. Their immutable token URIs point at `https://sheaf.vercel.app/api/launch/<basket>`, which now serves an unrelated app. Wallets and explorers therefore show no metadata for these three tokens, and whoever controls that domain could serve any JSON for them. The tokens are `Immutable`, so this cannot be changed. Their cards say so, and their real provenance is served at `/api/launch/<basket>`. None of the three is featured. Every launch since, including IDXA and the QA launches, points at sheaf-index.vercel.app, which Sheaf still controls; the site itself now lives at sheaf.world.
- **Partner ops** run from `scripts/meteora-partner.mjs` on a schedule, using the treasury key from the environment.
- No mainnet transaction has been sent. Mainnet needs real SOL and the owner's go-ahead.

## 7. What is devnet, and what is not built

- **Devnet.** Every pool, trade, graduation and claim above. The house (faucet) key funds throwaway wallets. Their keys are in `.keys/lifecycle-wallets.json`, which is gitignored.
- **Not built.**
  - **DLMM NAV-band pool for the basket share.** Share mints on devnet are Token-2022 mirrors with no external price feed, and DLMM needs a bin-step and rebalancing keeper to hold ±0.5% of NAV. That is a day of work, not hours.
  - **Share-quoted curves** (quote in the basket share itself).
  - **`createConfigAndPoolWithFirstBuy`** for creator first buys.
  - **Partner metadata.**
  - **An indexed swap tape.** `/api/launches/trades` reads the last 100 signatures per market on request. Past that the tape is incomplete.
