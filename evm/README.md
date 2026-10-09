# Sheaf on EVM

Sheaf baskets are index funds of tokenized stocks. One share is a fixed recipe of up to 8 stock
tokens held in an immutable vault. You mint and redeem shares in kind: hand over the recipe, get a
share; burn a share, get the recipe back. A `CreationDesk` lets a buyer who holds no stock tokens
escrow a dollar stablecoin for shares. Any filler who holds the components delivers them, the
desk mints the shares straight to the buyer, and the filler collects the cash.

This folder is the EVM side of Sheaf: Hardhat, Solidity 0.8.24, OpenZeppelin 5, via-IR, Cancun.
Everything here runs on free testnets only.

## Deployments

| Chain | Chain ID | Factory | Desk | Baskets | Stocks | Desk cash | Status |
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
| `contracts/CreationDesk.sol` | Cash creations. A buyer escrows the dollar token for N shares. Any filler delivers the components and is paid the escrow. The buyer can cancel at any time, and anyone can cancel after expiry. The cash token is called `usdg` in the ABI for compatibility; it is whatever stablecoin the chain's deployment uses. |
| `contracts/mirrors/MockStock.sol` | A labelled testnet stock mirror. 18 decimals, `isMirror() == true`, public `faucet(amount)` / `mint(to, amount)` capped at 100 tokens per call. Worth nothing. |
| `contracts/mirrors/MockDollar.sol` | A labelled 6-decimal dollar mirror (`sUSD`). Public faucet capped at 10,000 per call. Used only where no real testnet stablecoin exists. |
| `contracts/mocks/*` | Test-only tokens: `MockERC20`, `FeeOnTransferERC20`, and the hostile `ReentrantERC20` and `PausableERC20`. |

## Run it

```bash
cd evm
npm install
npx hardhat test          # 100 tests
```

All 100 tests pass. That is the 94 tests ported from the original suite plus 6 for the
mirror tokens. The suite covers rounding, the creator fee, CREATE2 addresses, recipe
validation, reentrancy, paused and blocklisted components, fee-on-transfer refusal, events,
gas, the absence of admin functions and selfdestruct, and seeded random-walk invariants (full
backing after every step, then a bank run).

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
node scripts/tempo-sip.mjs                                     # Tempo access-key SIP demo
```

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
