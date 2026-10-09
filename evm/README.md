# Sheaf on EVM

Sheaf baskets are index funds of tokenized stocks. One share is a fixed recipe of up to 8 stock
tokens held in an immutable vault. You mint and redeem shares in kind: hand over the recipe, get a
share; burn a share, get the recipe back. A `CreationDesk` lets a buyer who holds no stock tokens
escrow a dollar stablecoin for shares. Any filler who holds the components delivers them, the
desk mints the shares straight to the buyer, and the filler collects the cash.

This folder is the EVM side of Sheaf: Hardhat, Solidity 0.8.24, OpenZeppelin 5, via-IR, Cancun.
Everything here runs on free testnets only.

There are three desk versions, deployed side by side. Contracts here are immutable, so each version is
a new deployment rather than an upgrade, and every older address keeps working.

| | v1 `CreationDesk` | v2 `CreationDeskV2` + `PlanDesk` | v3 `CreationDeskV2` + `PlanDeskV3` |
| --- | --- | --- | --- |
| Price | A fixed-price limit order: N shares for X dollars | A Dutch auction on share count, as on Solana: the shares the buyer must receive fall from `startShares` to `endShares` over the auction | The same auction (same contract code) |
| Protocol fee | None | 0.10% of the gross shares each fill creates. The immutable treasury is **the deployer**, `0x59d3…0285`, which is also the house filler and the Tempo keeper key | 0.10%, to a **separate treasury key**, `0xEcb68aa1ec3749173B49F84eCA45659DF4E67355`, held by the founder. It is a fresh key that has never deployed, filled, kept or signed anything, and it is in no server environment (not in Vercel, not in any `.env`). It is not a multisig or hardware wallet: on mainnet it would be one |
| Creator fee | Charged by the basket | Charged by the basket | Charged by the basket |
| Recurring buys | None on chain | `PlanDesk`: amount, interval and fixed bounds on each run's fair count. A normal monthly move takes the fair count outside the bounds and the plan stops | `PlanDeskV3`: a trailing window of ±10% around what the last run filled at, inside the owner's hard bounds; the owner can re-centre at any time |
| Tempo SIP access key scope | `CreationDesk.placeOrder`, so the key picks the price | `PlanDesk.instalment`, so the key runs the owner's plan and cannot rewrite it | `PlanDeskV3.instalment` only: it cannot re-centre, rewrite or close the plan |
| Baskets | v1 factory's baskets | The same baskets | The same baskets. Nothing was redeployed |

New dollar orders and new plans go to v3. v2 desks and plans keep working and are still filled and run.
The disclosure that matters: **the v2 desks' protocol fee goes to the deployer key for as long as they
exist** (immutable, no owner to change it), so the app moved new orders to v3.

## v3 deployments (Oct 9)

| Chain | CreationDeskV2 (separate treasury key) | PlanDeskV3 | Verified | Live smoke test |
| --- | --- | --- | --- | --- |
| Robinhood Chain testnet (46630) | [`0x00F3A2f7e7Fc3038767feC055F8c37f814FA7c69`](https://explorer.testnet.chain.robinhood.com/address/0x00F3A2f7e7Fc3038767feC055F8c37f814FA7c69#code) | [`0x8C681091820d187cE77F670a8b9A4f66020a5045`](https://explorer.testnet.chain.robinhood.com/address/0x8C681091820d187cE77F670a8b9A4f66020a5045#code) | Blockscout | Passed |
| Tempo testnet (42431) | [`0xD54dA8527aDA17FB27C14A42fAa6837393EA940c`](https://explore.testnet.tempo.xyz/address/0xD54dA8527aDA17FB27C14A42fAa6837393EA940c) | [`0x1AFe2b2af89D238797523387722cea2c8A8123b4`](https://explore.testnet.tempo.xyz/address/0x1AFe2b2af89D238797523387722cea2c8A8123b4) | Sourcify (exact match) | Passed, plus the v3 access-key SIP run |
| Ethereum Sepolia (11155111) | [`0x5dDd10C17ed83bb926A75AcF787A5d11297F2D5A`](https://eth-sepolia.blockscout.com/address/0x5dDd10C17ed83bb926A75AcF787A5d11297F2D5A) | [`0x59EaDb2f720654A58fC18C712C74288De0cC62a9`](https://eth-sepolia.blockscout.com/address/0x59EaDb2f720654A58fC18C712C74288De0cC62a9) | Blockscout | Passed |
| Arbitrum Sepolia (421614) | [`0x316B48D22e4344cDda7Af29555e92F72B314da0F`](https://arbitrum-sepolia.blockscout.com/address/0x316B48D22e4344cDda7Af29555e92F72B314da0F) | [`0x6bDc853Ef6488d8e5941767A2f1fcd2fF65405EA`](https://arbitrum-sepolia.blockscout.com/address/0x6bDc853Ef6488d8e5941767A2f1fcd2fF65405EA) | Sourcify (exact match) | Passed |
| Base Sepolia (84532) | [`0x9526c52DE4ff94f9dF5eA4b2B5a0742e71EfB30D`](https://base-sepolia.blockscout.com/address/0x9526c52DE4ff94f9dF5eA4b2B5a0742e71EfB30D) | [`0x663c70243e15F3B47eDCc6f769B6C8Eac6e24e48`](https://base-sepolia.blockscout.com/address/0x663c70243e15F3B47eDCc6f769B6C8Eac6e24e48) | Blockscout | Passed |

The v3 smoke test (`scripts/smoke-v3.js`) does the following on each chain:

- **An auction order.** It places one, fills it, and checks that the fee went to the separate treasury key, not the deployer.
- **A trailing plan.** It opens a plan with a 60-second interval and runs it once.
- **Two refusals.** A second run inside the interval is refused (`TooSoon`), and so is a fair count under the window
  (`FairOutOfBounds`).
- **A re-centred second run.** After the interval, it runs again at 5% more shares than the first fill. The plan
  re-centres on that fill (`Recentered`) and runs.

The hashes are under `v3.smoke` in each `deployments/<network>.json`. All four Base Sepolia plan
desks (v2 and v3) are now verified; the earlier record of v2's `PlanDesk` as unverified was stale.

Cost of the v3 rollout (deploy, smoke test, verification, and the Tempo SIP recording):

| Chain | Deploy gas (desk + plans) | Smoke-test gas | Spent |
| --- | --- | --- | --- |
| Robinhood Chain testnet | 1.54M + 1.55M | 3.13M | 0.00006 ETH |
| Tempo testnet | 7.64M + 7.72M | 11.2M | 0.023 pathUSD |
| Ethereum Sepolia | 10.76M + 10.88M | 6.93M | 0.00003 ETH |
| Arbitrum Sepolia | 1.54M + 1.55M | 3.54M | 0.0007 ETH, house fills of QA orders included |
| Base Sepolia | 1.54M + 1.55M | 3.32M (after two runs cut short by RPC lag) | 0.00014 ETH |

## v2 deployments (Oct 9)

| Chain | CreationDeskV2 | PlanDesk | Verified | Live smoke test |
| --- | --- | --- | --- | --- |
| Robinhood Chain testnet (46630) | [`0x5C49b021F5E53514B6457907b92fA5Eb6DdeBa24`](https://explorer.testnet.chain.robinhood.com/address/0x5C49b021F5E53514B6457907b92fA5Eb6DdeBa24#code) | [`0xF1C863cbdeBDFac4a4Adb6B440567F7772619c05`](https://explorer.testnet.chain.robinhood.com/address/0xF1C863cbdeBDFac4a4Adb6B440567F7772619c05#code) | Blockscout | Passed (HOOD5, real stock tokens, real USDG) |
| Tempo testnet (42431) | [`0x18556B83da661B0341C4dc9218137FBfA81B4742`](https://explore.testnet.tempo.xyz/address/0x18556B83da661B0341C4dc9218137FBfA81B4742) | [`0xEB0482405811264c6F46479516F6c523750851f2`](https://explore.testnet.tempo.xyz/address/0xEB0482405811264c6F46479516F6c523750851f2) | Sourcify (`contracts.tempo.xyz`, exact match) | Passed (MAG8, AlphaUSD), plus the v2 access-key SIP run |
| Ethereum Sepolia (11155111) | [`0x5F6607dd194304fd8DC28Dac683136bf5Fd051d6`](https://eth-sepolia.blockscout.com/address/0x5F6607dd194304fd8DC28Dac683136bf5Fd051d6) | [`0x43e50Ed35ae6250dB43713AA4d89eB90c81d2330`](https://eth-sepolia.blockscout.com/address/0x43e50Ed35ae6250dB43713AA4d89eB90c81d2330) | Blockscout | Passed |
| Arbitrum Sepolia (421614) | [`0xd47a3957e7D66fAb781A47cEe0E7076c3157E9fB`](https://arbitrum-sepolia.blockscout.com/address/0xd47a3957e7D66fAb781A47cEe0E7076c3157E9fB) | [`0xFD0cA910186c9dD613B57DAa52Dad20B057908FE`](https://arbitrum-sepolia.blockscout.com/address/0xFD0cA910186c9dD613B57DAa52Dad20B057908FE) | Sourcify (`sourcify.dev`, exact match) | Passed |
| Base Sepolia (84532) | [`0x2B14dC27D9b5202AEBEDbB4fa70bdF7A8B123432`](https://base-sepolia.blockscout.com/address/0x2B14dC27D9b5202AEBEDbB4fa70bdF7A8B123432) | [`0x74a4f663Fee63462d43D04769C9b14526D644B6c`](https://base-sepolia.blockscout.com/address/0x74a4f663Fee63462d43D04769C9b14526D644B6c) | Blockscout | Passed |

On every chain the v2 desk takes the same dollar as v1 (USDG, AlphaUSD or the sUSD mirror) and
the v1 factory's baskets. The treasury is the deployer, `0x59d3E1239708a1CDD6Ef876688B3cd69d4aB0285`.
The records are under `v2` in [`deployments/<network>.json`](deployments): addresses, deploy
hashes and gas, verification results, and the smoke-test hashes. Tempo's file also holds the
v2 SIP run under `v2.sip`. On Base Sepolia, one of the cut-short runs left a plan order unfilled.
After its auction ended, `cancel-expired-v2.js` cancelled it from the deployer, and the 10.10 sUSD
went back to the buyer. That was a live refund after expiry.

Cost of the v2 rollout (deploy, smoke test and verification together):

| Chain | Deploy gas (desk + plans) | Smoke-test gas | Spent |
| --- | --- | --- | --- |
| Robinhood Chain testnet | 1.54M + 1.18M | 2.23M | 0.00005 ETH |
| Tempo testnet | 7.64M + 5.96M | 8.84M | 0.024 pathUSD, SIP run included |
| Ethereum Sepolia | 10.76M + 8.21M | 5.27M | 0.00003 ETH |
| Arbitrum Sepolia | 1.54M + 1.18M | 2.69M | 0.00035 ETH |
| Base Sepolia | 1.54M + 1.18M | 2.40M, after two runs cut short by RPC lag | 0.0001 ETH |

## v1 deployments

| Chain | Chain ID | Factory | Desk (v1) | Baskets | Stocks | Desk cash | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Robinhood Chain testnet | 46630 | [`0xC836…89B1`](https://explorer.testnet.chain.robinhood.com/address/0xC836C83E283DA57aBD13c271Dd73D22B65dF89B1#code) | [`0x4184…951C`](https://explorer.testnet.chain.robinhood.com/address/0x4184eb1540908CB0DbEd533c45Fba7123991951C#code) | HOOD5, CHIPS, PRIME | **real** Robinhood test stock tokens | **real** testnet USDG | Live, verified, smoke test passed |
| Tempo testnet (Moderato) | 42431 | [`0x4925…95e7`](https://explore.testnet.tempo.xyz/address/0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7) | [`0x4EB6…2Eb0`](https://explore.testnet.tempo.xyz/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | MAG8, AICORE, EVDY | 8 labelled mirrors | **real** AlphaUSD (TIP-20) | Live, verified (Sourcify), smoke test and SIP demo passed |
| Ethereum Sepolia | 11155111 | [`0x08Ec…D9E0`](https://eth-sepolia.blockscout.com/address/0x08Ec8CD0db8c09b27b349e0F1e495083961cD9E0) | [`0x336c…26E4`](https://eth-sepolia.blockscout.com/address/0x336cd7CF93e6b4CF4072C8C99D189B9eAc8126E4) | MAG8, AICORE, EVDY | 8 labelled mirrors | sUSD mirror | Live, 14/14 verified (Blockscout), smoke test passed |
| Arbitrum Sepolia | 421614 | [`0x4EB6…2Eb0`](https://arbitrum-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | [`0x3A9b…09A0`](https://arbitrum-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) | MAG8, AICORE, EVDY | 8 labelled mirrors | sUSD mirror | Live, 14/14 verified (Sourcify), smoke test passed |
| Base Sepolia | 84532 | [`0x4EB6…2Eb0`](https://base-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) | [`0x3A9b…09A0`](https://base-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) | MAG8, AICORE, EVDY | 8 labelled mirrors | sUSD mirror | Live, 14/14 verified (Blockscout), smoke test passed |
| HyperEVM testnet | 998 | – | – | – | mirrors | sUSD mirror | Not deployed: needs about 0.002 HYPE, has 0.0005 |

The full addresses, token lists (symbol, address, decimals, `isMirror`), recipes, launch prices,
smoke-test transaction hashes and verification results are in
[`deployments/<network>.json`](deployments). The web app should read those files.

### Robinhood Chain testnet (46630)

This is a fresh Sheaf deployment. Contracts deployed earlier on this chain by a predecessor project are untouched.

| Contract | Address |
| --- | --- |
| SheafFactory | [`0xC836C83E283DA57aBD13c271Dd73D22B65dF89B1`](https://explorer.testnet.chain.robinhood.com/address/0xC836C83E283DA57aBD13c271Dd73D22B65dF89B1#code) |
| CreationDesk (cash: USDG `0x7E95…802F`) | [`0x4184eb1540908CB0DbEd533c45Fba7123991951C`](https://explorer.testnet.chain.robinhood.com/address/0x4184eb1540908CB0DbEd533c45Fba7123991951C#code) |
| HOOD5 "Robinhood Five" (TSLA/AMZN/AMD/PLTR/NFLX, 20% each, 0.25% fee) | [`0x6536F45D0305bb3aE0E7A012534876e3b915A959`](https://explorer.testnet.chain.robinhood.com/address/0x6536F45D0305bb3aE0E7A012534876e3b915A959#code) |
| CHIPS "Compute Rush" (AMD 50 / PLTR 30 / TSLA 20, 0.50% fee) | [`0xBeEC7DfC91BA0Aa397D8e4b7Da714cf66bF09311`](https://explorer.testnet.chain.robinhood.com/address/0xBeEC7DfC91BA0Aa397D8e4b7Da714cf66bF09311#code) |
| PRIME "Prime Time" (AMZN 55 / NFLX 45, no fee) | [`0xF27F9802B96DB4a311Dc27E6503B71091E5671D9`](https://explorer.testnet.chain.robinhood.com/address/0xF27F9802B96DB4a311Dc27E6503B71091E5671D9#code) |

The components are the official Robinhood test stock tokens: TSLA `0xC9f9…Bd4E`, AMZN
`0x5884…9E02`, AMD `0x7117…778d`, PLTR `0x1FBE…98d0` and NFLX `0x3b82…8C93`. All have 18
decimals; the full addresses are in [`scripts/robinhood.js`](scripts/robinhood.js). Each basket
was priced at $10 a share from live Robinhood quotes and seeded with 1 share.

### Tempo testnet, Moderato (42431)

| Contract | Address |
| --- | --- |
| SheafFactory | [`0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7`](https://explore.testnet.tempo.xyz/address/0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7) |
| CreationDesk (cash: AlphaUSD `0x20c0…0001`) | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://explore.testnet.tempo.xyz/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) |
| MAG8 "Magnificent Eight" (all 8, 12.5% each, 0.25% fee) | [`0xf7e3484B94F42643762913173E47B4Ad020A3af9`](https://explore.testnet.tempo.xyz/address/0xf7e3484B94F42643762913173E47B4Ad020A3af9) |
| AICORE "AI Core" (NVDA 40 / MSFT 25 / GOOGL 20 / PLTR 15, 0.50% fee) | [`0x34140EeF33a3Dc746886432317E251EAa4c93a46`](https://explore.testnet.tempo.xyz/address/0x34140EeF33a3Dc746886432317E251EAa4c93a46) |
| EVDY "Everyday Tech" (AAPL 30 / AMZN 30 / META 20 / TSLA 20, no fee) | [`0x8EdF6718E08Bc481283D611EeaD5dBcE49336506`](https://explore.testnet.tempo.xyz/address/0x8EdF6718E08Bc481283D611EeaD5dBcE49336506) |

Mirror stock tokens, each named "&lt;Company&gt; (Sheaf testnet mirror)", 18 decimals, public
faucet:

| Symbol | Address | Symbol | Address |
| --- | --- | --- | --- |
| TSLA | `0xaeF91E3De7a4b96063EB6Fe89890dc8339aB7676` | AMZN | `0x22192F8114E74f69CCbf0edd5DC9e4482D57b490` |
| NVDA | `0xf17DDb38765e74D1130330ac600bD6BE9CFb68ab` | GOOGL | `0x2217FaFDeaEC218CFfbf250308c777EFB1C6BD63` |
| AAPL | `0x26bCb45d2090e7FE4e4E307eB89128EB3d60C80a` | META | `0xE2902eD38905Ec5431E4C86c05FB8f11063bA36b` |
| MSFT | `0x200d5C9353fb8b3dECf2Da665a0033DC29dE4646` | PLTR | `0x40a5ac8738412f0Ae897452051BD81175eE7b986` |

Each basket was priced at $10 a share from live Robinhood quotes for the underlying stocks and
seeded with 10 shares. All 13 contracts are verified (exact match) on Tempo's Sourcify server,
`contracts.tempo.xyz`.

The three Sepolia-family chains use the same mirror plan as Tempo: eight MockStock tokens named
"<Company> (Sheaf testnet mirror)" with a public faucet, a 6-decimal `sUSD` MockDollar as the desk's
cash, and the same three seed baskets priced at $10 a share and seeded with 10 shares each.
Arbitrum Sepolia and Base Sepolia share addresses because the deployer's nonces lined up on both;
Sepolia's are shifted by the two bridge transactions sent from it first.

### Ethereum Sepolia (11155111)

| Contract | Address |
| --- | --- |
| SheafFactory | [`0x08Ec8CD0db8c09b27b349e0F1e495083961cD9E0`](https://eth-sepolia.blockscout.com/address/0x08Ec8CD0db8c09b27b349e0F1e495083961cD9E0) |
| CreationDesk (cash: sUSD mirror) | [`0x336cd7CF93e6b4CF4072C8C99D189B9eAc8126E4`](https://eth-sepolia.blockscout.com/address/0x336cd7CF93e6b4CF4072C8C99D189B9eAc8126E4) |
| MAG8 "Magnificent Eight" | [`0x6a47aC82a3eE22FCC2b80D5c1F45Daba23e06141`](https://eth-sepolia.blockscout.com/address/0x6a47aC82a3eE22FCC2b80D5c1F45Daba23e06141) |
| AICORE "AI Core" | [`0xa8A54a6cd0136A645c36EAd5371016f32Ae6b121`](https://eth-sepolia.blockscout.com/address/0xa8A54a6cd0136A645c36EAd5371016f32Ae6b121) |
| EVDY "Everyday Tech" | [`0xd77442895e899201D9C5Cc03b1661E88d9eB56e1`](https://eth-sepolia.blockscout.com/address/0xd77442895e899201D9C5Cc03b1661E88d9eB56e1) |
| sUSD "Sheaf Test Dollar (mirror)", 6 decimals | [`0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0`](https://eth-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) |

Mirror stocks: TSLA `0x26bCb45d2090e7FE4e4E307eB89128EB3d60C80a`, NVDA `0x200d5C9353fb8b3dECf2Da665a0033DC29dE4646`, AAPL `0x22192F8114E74f69CCbf0edd5DC9e4482D57b490`, MSFT `0x2217FaFDeaEC218CFfbf250308c777EFB1C6BD63`, AMZN `0xE2902eD38905Ec5431E4C86c05FB8f11063bA36b`, GOOGL `0x40a5ac8738412f0Ae897452051BD81175eE7b986`, META `0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7`, PLTR `0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`.

### Arbitrum Sepolia (421614)

| Contract | Address |
| --- | --- |
| SheafFactory | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://arbitrum-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) |
| CreationDesk (cash: sUSD mirror) | [`0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0`](https://arbitrum-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) |
| MAG8 "Magnificent Eight" | [`0xc1238636d6171c59176fD10a8193E6E33f14095C`](https://arbitrum-sepolia.blockscout.com/address/0xc1238636d6171c59176fD10a8193E6E33f14095C) |
| AICORE "AI Core" | [`0xE5A089FDDfA7907Ee8661b5CAfFb47562115645E`](https://arbitrum-sepolia.blockscout.com/address/0xE5A089FDDfA7907Ee8661b5CAfFb47562115645E) |
| EVDY "Everyday Tech" | [`0x7aa1d6065b1A5eeFd386f0A8B0A1E7C3136180Bd`](https://arbitrum-sepolia.blockscout.com/address/0x7aa1d6065b1A5eeFd386f0A8B0A1E7C3136180Bd) |
| sUSD "Sheaf Test Dollar (mirror)", 6 decimals | [`0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7`](https://arbitrum-sepolia.blockscout.com/address/0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7) |

Mirror stocks: TSLA `0xaeF91E3De7a4b96063EB6Fe89890dc8339aB7676`, NVDA `0xf17DDb38765e74D1130330ac600bD6BE9CFb68ab`, AAPL `0x26bCb45d2090e7FE4e4E307eB89128EB3d60C80a`, MSFT `0x200d5C9353fb8b3dECf2Da665a0033DC29dE4646`, AMZN `0x22192F8114E74f69CCbf0edd5DC9e4482D57b490`, GOOGL `0x2217FaFDeaEC218CFfbf250308c777EFB1C6BD63`, META `0xE2902eD38905Ec5431E4C86c05FB8f11063bA36b`, PLTR `0x40a5ac8738412f0Ae897452051BD81175eE7b986`.

### Base Sepolia (84532)

| Contract | Address |
| --- | --- |
| SheafFactory | [`0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0`](https://base-sepolia.blockscout.com/address/0x4EB6955e6bD0912EA2E5230f0B3D8DD4Bc7a2Eb0) |
| CreationDesk (cash: sUSD mirror) | [`0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0`](https://base-sepolia.blockscout.com/address/0x3A9b55976D4f385AD00acdCdb29Fe3DD43aB09A0) |
| MAG8 "Magnificent Eight" | [`0xc49DCde2E4F0f9bC20F6FAc5aC5352dd5c2349B5`](https://base-sepolia.blockscout.com/address/0xc49DCde2E4F0f9bC20F6FAc5aC5352dd5c2349B5) |
| AICORE "AI Core" | [`0xc0D0A036988ABE5A89312C131469C219F5Ad1FAb`](https://base-sepolia.blockscout.com/address/0xc0D0A036988ABE5A89312C131469C219F5Ad1FAb) |
| EVDY "Everyday Tech" | [`0xe843E1Cc12aEb0824a054D2101333da12b4B3456`](https://base-sepolia.blockscout.com/address/0xe843E1Cc12aEb0824a054D2101333da12b4B3456) |
| sUSD "Sheaf Test Dollar (mirror)", 6 decimals | [`0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7`](https://base-sepolia.blockscout.com/address/0x4925f418fac49b26C68Ac7016Ba3591cDbF895e7) |

Mirror stocks: TSLA `0xaeF91E3De7a4b96063EB6Fe89890dc8339aB7676`, NVDA `0xf17DDb38765e74D1130330ac600bD6BE9CFb68ab`, AAPL `0x26bCb45d2090e7FE4e4E307eB89128EB3d60C80a`, MSFT `0x200d5C9353fb8b3dECf2Da665a0033DC29dE4646`, AMZN `0x22192F8114E74f69CCbf0edd5DC9e4482D57b490`, GOOGL `0x2217FaFDeaEC218CFfbf250308c777EFB1C6BD63`, META `0xE2902eD38905Ec5431E4C86c05FB8f11063bA36b`, PLTR `0x40a5ac8738412f0Ae897452051BD81175eE7b986`.

## Contracts

| File | What it is |
| --- | --- |
| `contracts/Basket.sol` | The vault and share token. The recipe is written once, at construction. There is no owner, no pause, no upgrade path and no oracle. Mints round up and redemptions round down. The creator fee (at most 1%) is paid in newly issued shares, never out of the vault. Tokens that skim on transfer are refused. |
| `contracts/SheafFactory.sol` | Anyone can publish a basket. The factory validates the recipe (1 to 8 distinct components, non-zero units, weights summing to 100%, fee ≤ 1%, one symbol per creator) and deploys the basket with CREATE2. |
| `contracts/CreationDesk.sol` | v1 cash creations. A buyer escrows the dollar token for N shares. Any filler delivers the components and is paid the escrow. The buyer can cancel at any time, and anyone can cancel after expiry. The cash token is called `usdg` in the ABI for compatibility; it is whatever stablecoin the chain's deployment uses. |
| `contracts/CreationDeskV2.sol` | v2 cash creations: a Dutch auction on share count plus the 0.10% protocol fee. See [The v2 desk](#the-v2-desk). No owner, no setter, no pause. |
| `contracts/PlanDesk.sol` | v2 recurring buys, with the amount, the interval and fixed bounds written on chain by the owner. See [Plans and the Tempo price cap](#plans-and-the-tempo-price-cap). |
| `contracts/PlanDeskV3.sol` | v3 recurring buys: a trailing window around the last fill, inside the owner's hard bounds, and an owner-only `recenter`. See [v3 plans: trailing bounds](#v3-plans-trailing-bounds). |
| `contracts/SheafAuction.sol` | The auction math both share: the linear decay (`sharesAt`) and the band around a fair count (`bounds`). It matches the Solana program's `required_shares` and `plan_bounds`. |
| `contracts/mirrors/MockStock.sol` | A labelled testnet stock mirror. 18 decimals, `isMirror() == true`, public `faucet(amount)` / `mint(to, amount)` capped at 100 tokens per call. Worth nothing. |
| `contracts/mirrors/MockDollar.sol` | A labelled 6-decimal dollar mirror (`sUSD`). Public faucet capped at 10,000 per call. Used only where no real testnet stablecoin exists. |
| `contracts/mocks/*` | Test-only tokens: `MockERC20`, `FeeOnTransferERC20`, and the hostile `ReentrantERC20` and `PausableERC20`. |

## The v2 desk

A buyer escrows a fixed amount of cash and posts a falling share count.

- **The auction.** The shares the buyer must receive are `startShares` until `startTs`, then fall
  linearly to `endShares` at `endTs`. After `endTs` the order cannot be filled. The decay rounds
  down, so between the endpoints the buyer keeps the rounding. A filler takes the order as soon
  as the count is one they can deliver at a profit. The buyer pays the going rate, and never
  worse than `endShares` for the cash.
- **Placing.** `placeOrder(basket, cash, startShares, endShares, startTs, endTs)` takes explicit
  terms. `placeAuction(basket, cash, fairShares, bandBps, auctionSecs, minShares)` takes the usual
  shape: it starts now at fair plus the band and ends `auctionSecs` later at fair minus the band,
  never below the buyer's own `minShares`. The fair count is the buyer's own number; the desk
  never reads a price. Bands are capped at 50% and auctions at 30 days, as on Solana.
  `placeOrderFor(buyer, ...)` lets the caller pay for an order that belongs to `buyer`. The
  plan desk uses it.
- **Filling.** `fill(id)` works out the gross shares the fill must create:
  `gross = ceil(count × 10000 / (10000 − creatorFeeBps − 10))`. It pulls
  `basket.previewMint(gross)` of each component from the filler and mints `gross` in kind. The
  basket sends its creator fee to the creator, as on every mint. The desk sends
  `floor(gross × 10 / 10000)` to the treasury and the rest to the buyer, then pays the filler the
  escrow. Because both fees are floored, the buyer gets at least the auction's count and at most
  2 raw units more. `quoteFill(id)` returns the count, the gross and the component amounts for
  the current block. The count only falls, so an approval sized at the quote covers any later
  fill.
- **Refunds.** The buyer can cancel at any time. After `endTs` anyone can, and the cash always goes
  back to the buyer.
- **Safety.**
  - Every mutating function is `nonReentrant`, and state is written before any token moves.
  - A cash token that skims on transfer is refused at placement (`ShortCash`).
  - The basket already refuses skimming components.
  - Orders pack into five storage slots, and placing one writes four. This matters on Tempo,
    where a new slot costs 250k gas.

**Where it differs from Solana.** On Solana the protocol fee is part of the basket and is charged
on in-kind mints too. On EVM the v1 baskets are immutable and have no protocol fee, so v2
charges it on desk fills only. In-kind `Basket.mint` and `redeem` stay fee-free apart from the
creator fee. The fee is still fixed for every basket: it is a constant of an immutable desk.

### Plans and the Tempo price cap

`PlanDesk` makes a recurring buy whose terms the trigger cannot change.

- **Opening.** `openPlan(basket, cashPerRun, interval, auctionSecs, bandBps, minShares, maxShares, keeper)`
  stores the plan with the caller as owner.
- **The cap.** `minShares` is the owner's price cap: the fewest shares a run of `cashPerRun` may
  ever buy. That makes the maximum price `cashPerRun / minShares`. `maxShares` stops a trigger
  from posting a fair count so high that no filler would take the run.
- **Running.** `instalment(id, fairShares)` checks four things:
  - the caller is the owner, or the plan's `keeper` if one is named;
  - the plan is open;
  - at least `interval` has passed since the last run (`TooSoon`);
  - `fairShares` is inside `[minShares, maxShares]` (`FairOutOfBounds`).

  It then pulls exactly `cashPerRun` from the owner. It posts
  `placeOrderFor(owner, …, bounds(fair, band, minShares), now, now + auctionSecs)` on the v2 desk,
  so the shares and any refund belong to the owner. No auction ever ends below `minShares`.
- **Closing.** `closePlan(id)` is owner-only and stops the plan for good. Orders already posted
  stay refundable on the desk.

**On Tempo**, the visitor's root key opens the plan. It then authorizes the keeper's access key
with a recurring AlphaUSD limit and exactly two scopes:

- `AlphaUSD.approve(address,uint256)`, with `PlanDesk` as the only allowed spender;
- `PlanDesk.instalment(uint256,uint256)`.

A key signing for the account is `msg.sender == owner`, so `openPlan` and `closePlan` must stay
out of its scope. The key can then run the owner's plan but never rewrite it.

**The worst a compromised house key can do** is run one instalment per interval of exactly
`cashPerRun`, at a fair count of `minShares`, and fill it at the end of the auction itself. The
visitor still receives at least `minShares` for `cashPerRun`, at the price they chose. In v1 the
same key could post `placeOrder(basket, 1 wei, budget)` and fill it.

**Without access keys** (Robinhood Chain, the Sepolias), the owner names a `keeper` and gives
`PlanDesk` a standing allowance. The same on-chain terms bound the keeper, so it can take at
most `cashPerRun` per interval at no worse than the cap.

## v3 plans: trailing bounds

v2's fixed bounds made a monthly plan a one-shot. At 30% annual volatility a month moves about 9%,
so a ±3–5% band stops the plan most months. `PlanDeskV3` keeps two kinds of bound.

**Hard bounds** (`hardMin`, `hardMax`, in shares per run):
- The owner sets them at opening, and only the owner can change them.
- `hardMin` is the price cap. No run's fair count may be below it, and no run's auction ever ends
  below it, so no run ever buys fewer than `hardMin` shares for `cashPerRun`.
- The plan panels (Tempo, and the Robinhood Chain and Sepolia panel) sign hard bounds of 85% and
  120% of the fair count at signing, with a ±10% step. That puts the worst price per share at about
  1.18 times the signing-day price. The recorded Tempo run below used wider bounds (70%–150%).

**A trailing window** of ±`stepBps` (10% on the Tempo panel) around a reference count:
- The reference starts at the owner's `refShares`.
- At each instalment, the reference first moves to what the previous run filled at, clamped into
  the hard bounds. It stays put if that run never filled.
- A run's fair count must sit inside the window and inside the hard bounds (`FairOutOfBounds`
  otherwise). A plan therefore follows the price by up to a step a run, and never past the
  owner's limits.

**Re-centring.**
- A move bigger than one step between runs pauses the plan. The keeper reports it as "Paused"
  and posts nothing.
- The owner then calls `recenter(id, ref, hardMin, hardMax)` with their own key. That moves the
  reference and resets the hard bounds.
- On Tempo, the access key's scope is `PlanDeskV3.instalment` only, so the key can't call
  `recenter`, `openPlan` or `closePlan`. The recorded run shows the chain refusing a re-centre by
  the key with `CallNotAllowed`.

**Who sets "fair".** The keeper names each run's fair count; nothing on chain reads a price. The
contract bounds it twice. It must sit within one step of what the plan's previous run *actually
filled at*, a number the keeper doesn't control once a fill lands, and inside the owner's hard
bounds. So the keeper is never the sole source of the price, only of where inside that window a run
starts.

**The worst case with one filler.** Today the house is both keeper and the only filler. It could
post each run's fair count at the window's low edge and fill at the auction's end. That walks the
reference down by up to the step plus the 2% band a run, and reaches the hard floor in about two
runs. From then on, every run still buys at least `hardMin` for `cashPerRun`. With the panels'
defaults, that is 85% of the signing-day count, a price at most about 1.18 times the signing-day
price. Both panels say this in one line. A test runs 24 such runs and checks that every run bought at
least `hardMin` and that the reference stopped at the floor. Competition is what keeps fills near
fair, as on Solana.

### Plans on Robinhood Chain and the Sepolias

PlanDeskV3 doesn't need Tempo's access keys.

- **Opening.** On every chain except Tempo, the basket page's plan panel
  (`web/components/evm-plan-panel.tsx`) sends two wallet transactions:
  - one approves the plan desk for a fixed number of runs;
  - the other calls `openPlan(..., keeper = house)`.
- **Cadence.** Every 10 minutes for 3 runs (a demo with a 15-minute auction, so the 5-minute cron
  never misses the house's price), or every 30 days for 12 runs.
- **The keeper loop.** `runPlanSchedule` in `web/lib/evm-server.ts` is called from every
  `/api/evm-keeper` sweep. It finds the plans that are active, name the house as keeper and are
  due, then:
  - checks that the owner's allowance and balance cover a run;
  - prices the run from live quotes;
  - skips a fair count outside the window ("paused"; the owner can re-centre);
  - calls `instalment(id, fair)` as the keeper.
- **Bounds.** The owner can re-centre or close a plan from the same panel. The allowance caps the
  total, and the contract caps every run.

**The recorded Tempo run** (`scripts/tempo-sip-v3.mjs`, Oct 9, hashes under `v3.sip` in
`deployments/tempoTestnet.json`):

1. The investor's root key opens plan 1: 10.10 AlphaUSD a run, ±10% step, hard bounds 0.70–1.50
   MAG8. The interval is 2 minutes, so the recording can show two runs.
2. The investor authorizes a fresh keeper key, scoped to `AlphaUSD.approve(PlanDeskV3)` and
   `PlanDeskV3.instalment`.
3. The chain or the plan refuses four things the key tries:
   - a run at 1 raw share unit: `FairOutOfBounds`;
   - a direct desk order: `CallNotAllowed`;
   - an `openPlan`: `CallNotAllowed`;
   - a `recenter`: `CallNotAllowed`.
4. Run 1 fills at 1.0192 MAG8. A second run at once is refused (`TooSoon`).
5. After the interval, run 2 asks 1.0701 MAG8, 5% above run 1's fill. The plan re-centres on
   1.0192 (`Recentered`), the window is 0.9173–1.1211, and run 2 fills at 1.0910 MAG8.
6. The protocol fee of both runs went to the separate treasury key.

## Run it

```bash
cd evm
npm install
npx hardhat test          # 174 tests
```

All 174 tests pass:

- **100 v1 tests:** the 94 ported from the original suite plus 6 for the mirror tokens. They
  cover rounding, the creator fee, CREATE2 addresses, recipe validation, reentrancy, paused and
  blocklisted components, fee-on-transfer refusal, events, gas, the absence of admin functions
  and selfdestruct, and seeded random-walk invariants (full backing after every step, then a
  bank run).
- **37 tests for `CreationDeskV2`** (`test/desk-v2.test.js`):
  - auction math at the start, before the start, at the midpoint, a quarter in, at the last
    second and after it, including the rounding;
  - fee math for 0%, 0.50% and 1% baskets, a fill too small to pay a protocol fee, and a seeded
    randomized sweep of share counts and creator fees that checks exact fees and full backing;
  - `quoteFill` against an actual fill;
  - refunds by the buyer, and by anyone after expiry;
  - re-entry from hostile component and cash tokens into `fill`, `cancel` and all three place
    functions;
  - paused and skimming tokens;
  - v1 and v2 serving the same basket.
- **16 tests for `PlanDesk`** (`test/plan-desk.test.js`):
  - the price cap, including the 1-wei attack;
  - the band floor, the exact amount, and the interval;
  - unfilled runs refunded after expiry;
  - keeper permissions, and the drain bound with a standing allowance;
  - closing a plan;
  - re-entry.
- **5 tests for v2 immutability and gas** (`test/v2.immutability.test.js`): the mutating
  functions, no admin names, no DELEGATECALL or SELFDESTRUCT, and a gas snapshot.
- **16 tests for `PlanDeskV3`** (`test/plan-desk-v3.test.js`):
  - the window and the hard bounds;
  - trailing the last fill, including a plan that survives a steady 6%-a-month rise for six months;
  - an unfilled run leaving the reference alone;
  - a 24-run uncompetitive walk-down that never crosses the hard floor;
  - the ceiling clamp;
  - the owner's `recenter` (owner only, sane bounds, not on a closed plan);
  - the amount, the interval and keeper permissions;
  - re-entry;
  - the admin surface.

v2 gas on a local Cancun node:

| Call | Gas |
| --- | --- |
| Deploy `CreationDeskV2` | 1.54M |
| Deploy `PlanDesk` | 1.18M |
| `placeOrder` | 186k |
| `placeAuction` | 152k |
| `fill` (3 components, both fees) | 445k |
| `cancel` | 45k |
| `openPlan` | 198k |
| `instalment` | 190k to 207k |

Hardhat warns that Node 21 is unsupported. The suite still passes on Node 21.7.0; Node 20 or
22 LTS removes the warning.

### Deploy

```bash
cp .env.example .env      # DEPLOYER_PRIVATE_KEY=... (testnet-only key)
npx hardhat run scripts/deploy-chain.js --network <network>
npx hardhat run scripts/smoke.js        --network <network>
npx hardhat run scripts/verify.js       --network <network>   # Blockscout, Etherscan-style API
npx hardhat run scripts/verify-blockscout.js --network <network>   # Blockscout native v2 API
npx hardhat run scripts/verify-sourcify.js --network tempoTestnet  # Tempo's Sourcify v2
SOURCIFY_V2=https://sourcify.dev/server npx hardhat run scripts/verify-sourcify.js --network arbitrumSepolia
BRIDGE_ETH=0.012 npx hardhat run scripts/bridge.js --network sepolia   # Sepolia -> Arbitrum + Base Sepolia
node scripts/tempo-sip.mjs                                     # Tempo access-key SIP demo (v1)

# v2, next to an existing v1 deployment (TREASURY=0x... to override the deployer)
npx hardhat run scripts/deploy-v2.js  --network <network>
npx hardhat run scripts/smoke-v2.js   --network <network>
npx hardhat run scripts/verify-v2.js  --network <network>
npx hardhat run scripts/cancel-expired-v2.js --network <network>   # refund any expired v2 order
node scripts/tempo-sip-v2.mjs                                  # Tempo access-key SIP on PlanDesk

# v3 (treasury: the address in ../.keys/evm-treasury.json; only the address is read)
npx hardhat run scripts/deploy-v3.js  --network <network>
npx hardhat run scripts/smoke-v3.js   --network <network>
V=3 npx hardhat run scripts/verify-v2.js --network <network>
node scripts/tempo-sip-v3.mjs                                  # Tempo access-key SIP on PlanDeskV3
```

`smoke-v2.js` places a `placeAuction` order (10.10 dollars, fair 1 share, ±2%, 10 minutes, floor
0.98), fills it, opens a daily plan, runs one instalment, checks that a second run is refused
(`TooSoon`) and that a fair below the cap is refused (`FairOutOfBounds`), and fills the run. It
checks each `OrderFilled` against the fee formula, and checks every share delta exactly.

The networks are `robinhoodTestnet`, `tempoTestnet`, `arbitrumSepolia`, `sepolia`,
`baseSepolia` and `hyperEvmTestnet`. For a local dry run, use `localhost` after starting
`npx hardhat node`.

`deploy-chain.js` reads its per-chain plan from [`scripts/chains.js`](scripts/chains.js):

- **Stock tokens:** real tokens where the testnet has them (Robinhood Chain); otherwise it
  deploys eight `MockStock` mirrors (TSLA NVDA AAPL MSFT AMZN GOOGL META PLTR).
- **Desk cash:** a real testnet stablecoin where one exists (USDG on Robinhood Chain, AlphaUSD on
  Tempo); otherwise a `MockDollar`.
- **Contracts and baskets:** the factory, the desk, and three seed baskets priced at $10 a share
  from Robinhood's public price API (with fallback prices if the API is down).
- **Seed supply:** a few shares minted into every basket.

The script is resumable. Each address is written to `deployments/<network>.json` as soon as it
exists, so after a flaky RPC you just re-run it. Set `FRESH=1` to start over. Every read that
follows a write is pinned to the block that write landed in (public RPCs are load-balanced
across nodes that lag each other), and each run's total gas and native spend is appended under
`runs`.

`smoke.js` uses the deployer as minter, buyer and filler. It runs these steps and checks every
balance delta exactly:

1. Faucet-mints the mirror components.
2. Mints 1 share in kind.
3. Redeems half a share.
4. Places a desk order for 1 share at 10.10 dollars.
5. Fills the order.
6. Checks that the order is filled, the shares were delivered, the components were pulled, the
   cash went out and came back, the desk holds no residue, and the vault is fully backed.

## Tempo: native recurring buys (SIP)

Tempo access keys can carry recurring TIP-20 spending limits and call scopes. That makes them
Tempo's native primitive for a SIP (systematic investment plan): the investor signs one key
authorization, and a keeper buys every month within a hard budget. No custody and no allowance
games are needed.

`scripts/tempo-sip.mjs` (viem 2.56.8, `viem/tempo`) runs the flow live:

1. The investor authorizes a fresh P256 keeper key with these limits:
   - **25 AlphaUSD per 30-day period** (recurring), plus 2 pathUSD per period for fees.
   - **Scope:** only `AlphaUSD.approve` with the Sheaf desk as spender, and only
     `CreationDesk.placeOrder`.
2. The keeper places this month's instalment in **one atomic Tempo transaction** (approve and
   placeOrder in `calls[]`), and the budget drops from 25.00 to 14.90.
3. An instalment above the remaining budget is refused (`SpendingLimitExceeded`).
4. A transfer outside the scope is refused (`CallNotAllowed`).
5. The investor fills the order as the participant, and the basket shares land with the
   investor.

The transaction hashes are recorded under `sip` in `deployments/tempoTestnet.json`. The keeper key
lives only in memory for the run. A production keeper would persist it in a KMS and fire on a
schedule.

That v1 scope limits which functions the key may call but not their arguments: the key chose the
share count and the price of every order. `scripts/tempo-sip-v2.mjs` runs the v2 plan, where the
price cap is on chain. These steps ran on Oct 9; the hashes are under `v2.sip`:

1. The investor's root key opens plan 2 on `PlanDesk`: 10.10 AlphaUSD every 30 days, a ±2%
   auction over an hour, and no run below 0.97 MAG8. The fair count is bounded to 0.97–1.05.
2. The investor authorizes a fresh P256 keeper key:
   - **Limits:** 25 AlphaUSD and 2 pathUSD per 30 days.
   - **Scopes:** `AlphaUSD.approve` with `PlanDesk` as spender, and `PlanDesk.instalment`.
3. The keeper tries what the v1 scope allowed, and each attempt is refused:
   - An instalment at 1 raw share unit for 10.10 AlphaUSD: `FairOutOfBounds`, from the contract.
   - A direct `CreationDeskV2.placeOrder` at its own price: `CallNotAllowed`, from the chain.
   - A new plan with its own terms: `CallNotAllowed`, from the chain.
4. The keeper runs the month's instalment in one atomic transaction (approve + instalment), and the
   budget drops from 25.00 to 14.90. A second run straight after is refused: `TooSoon`.
5. The investor fills the auction as the participant and receives 1.02 MAG8. That is the count
   at the moment of the fill, after the creator fee and the 0.10% protocol fee.

## Chain notes and quirks

- **Opcodes:** every target chain was probed with an `eth_call` of PUSH0, TSTORE, TLOAD and MCOPY.
  All six accept them, so a single Cancun build serves every chain. Arbitrum chains (Robinhood
  Chain and Arbitrum Sepolia) reject `BLOBBASEFEE`, which these contracts never use. Set
  `EVM_VERSION=paris` to rebuild for a chain without Cancun.
- **Tempo:**
  - **Fees:** Tempo has no native gas token. Fees are paid in a TIP-20 dollar, which defaults to
    pathUSD for calls to non-TIP-20 contracts. Plain EIP-1559 transactions from Hardhat and ethers
    work unchanged once the sender holds pathUSD.
  - **Faucet:** the free `tempo_fundAddress` RPC method (no login) gave the deployer 1M each of
    pathUSD, AlphaUSD, BetaUSD, ThetaUSD and OUSD. The whole deployment, verification and smoke
    test cost about 0.36 pathUSD.
  - **Native balances:** `eth_getBalance` returns a huge placeholder, and `msg.value` and
    `BALANCE` always read 0. Sheaf uses neither: no payable functions, no native-balance checks.
  - **Gas costs:** new storage slots cost 250k gas and contract code 1,000 gas per byte, so deploys
    use 5 to 10 times the gas they would on Ethereum. They still fit easily under the 30M per-tx
    cap.
  - **Verification:** Tempo verifies through Sourcify v2 at `https://contracts.tempo.xyz`.
    hardhat-verify 2.x speaks only the v1 Sourcify API, so `scripts/verify-sourcify.js` posts the
    standard-JSON input directly.
- **Robinhood Chain:** gas is about 0.01 gwei. The full deployment, verification and smoke test
  cost about 0.0001 testnet ETH. The explorer is Blockscout, which verifies without an API key.
- **The 1 gwei tip trap:** hardhat-ethers asks for a 1 gwei priority fee unless told otherwise.
  On Sepolia, where the base fee is a few wei and the going tip is about 0.001 gwei, that is
  1000 times too much. The first seven Sepolia mirror deploys paid it (about 0.025 testnet ETH)
  before `hardhat.config.js` pinned legacy gas prices for Sepolia (0.0012 gwei), Base Sepolia
  (0.012 gwei) and HyperEVM (0.11 gwei). With the fix, the rest of the Sepolia deployment (factory,
  desk, dollar, a mirror, three baskets, seeding) cost 0.00008 ETH for 68M gas.
- **Sepolia state-creation gas:** contract creation on Sepolia now costs about 6.5 times what a
  local Cancun node charges (a MockStock deploy is 3.54M gas there against 0.55M locally; the
  factory is 14.8M). The full Sepolia deployment used about 93M gas. Arbitrum Sepolia and Base
  Sepolia charge the usual amounts (Base: about 13.6M gas for everything).
- **Bridging:** 0.012 ETH each went from Sepolia to Arbitrum Sepolia through the delayed Inbox
  (`0xaAe2…ae21`, `depositEth`) and to Base Sepolia through the L1StandardBridge (`0xfd0B…3120`,
  `depositETH`), via `scripts/bridge.js`. Both landed within minutes. The transaction hashes are
  in `deployments/bridges.json`.
- **Verification:** `eth-sepolia.blockscout.com` refused the mirror tokens through the
  Etherscan-style route ("Failed to send contract verification request") but took them through its
  native v2 API (`scripts/verify-blockscout.js`). `base-sepolia.blockscout.com` rate-limits bursts
  (HTTP 429), so the script backs off. The `arbitrum-sepolia.blockscout.com` API sits behind a
  Cloudflare bot challenge, so Arbitrum Sepolia is verified on Sourcify (`sourcify.dev`, exact
  match), which Blockscout reads.
- **HyperEVM:** HYPE is the gas token, and the base fee is about 0.1 gwei. Small blocks now
  have a 3M gas limit, so SheafFactory (2.08M) and an 8-component basket (1.87M) fit without
  opting into big blocks. A full mirror deployment needs about 13.6M gas, plus about 1.2M for the
  smoke test, which comes to about 0.0017 HYPE. The deployer holds 0.0005 HYPE (enough for about
  4.5M gas), so nothing was deployed: a partial stack would be useless. About 0.002 HYPE in total
  is enough; a reduced plan of 5 mirrors and 2 baskets would need about 0.0012 HYPE.
  - HIP-3 stock perps (trade.xyz `xyz`, testnet dex 65) expose oracle and mark prices through
    precompiles `0x…0807` and `0x…0806`, at index `65*10000 + asset` (for example NVDA = 650002).
    A NAV-reporting basket view could read them for free on chain once gas is available.
- **Same address, different contract:** the deployer's nonce-0 address, `0xaeF9…7676`, is the TSLA
  mirror on Tempo, Arbitrum Sepolia and Base Sepolia. On Robinhood Chain the same address is a
  predecessor project's factory, and on Tempo `0x4925…95e7` is the factory while on the Sepolia
  L2s it is the sUSD mirror. EVM addresses are only meaningful together with a chain ID.

## Getting more gas

The deployer is `0x59d3E1239708a1CDD6Ef876688B3cd69d4aB0285`. Only HyperEVM testnet is still
short: it needs about 0.0015 more HYPE. Every free faucet below needs a browser, a login, a
captcha or a mainnet balance, so none was attempted from here. Once a chain has gas, run
`deploy-chain.js`, `smoke.js` and one of the verify scripts for it.

| Chain | Faucet | Requirement |
| --- | --- | --- |
| Ethereum Sepolia | https://cloud.google.com/application/web3/faucet/ethereum/sepolia | Google login |
| Ethereum Sepolia | https://sepolia-faucet.pk910.de | Browser proof-of-work mining; no account |
| Ethereum Sepolia / Base Sepolia | https://portal.cdp.coinbase.com/products/faucet | Coinbase Developer Platform login |
| Base Sepolia | https://www.alchemy.com/faucets/base-sepolia | Alchemy login, about 0.001 ETH on mainnet |
| Arbitrum Sepolia | https://bridge.arbitrum.io (bridge Sepolia ETH) | Sepolia ETH first; about 10 minutes |
| Arbitrum Sepolia | https://www.alchemy.com/faucets/arbitrum-sepolia | Alchemy login, about 0.001 ETH on mainnet |
| HyperEVM testnet | https://faucet.chainstack.com/hyperliquid-testnet-faucet | Chainstack account plus API key; 1 HYPE a day |
| HyperEVM testnet | https://app.hyperliquid-testnet.xyz/drip | The same address must have deposited on Hyperliquid mainnet (real funds; do not use) |

## Honest notes

- **Mirrors are not stocks.** Outside Robinhood Chain, the components are free test tokens named
  "(Sheaf testnet mirror)". No testnet has xStocks, Ondo or Robinhood mainnet tokens. Dinari's
  sandbox needs a partner account.
- **The smoke test uses one account.** Buyer, filler and creator are all the deployer, so the
  desk's cash leg nets to zero; the test checks that exactly. The cross-account flows are
  covered by the unit tests.
- **No audit.** The contracts have no admin and no oracle, and the suite is thorough. They are
  still unaudited testnet code.
- **The NAV is set once.** It is fixed at $10 at launch from live quotes. After that, a basket's
  value floats with its components. The contracts never read a price.
