require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const pk = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = pk ? [pk] : [];

// Every target chain was probed with an eth_call of PUSH0, TSTORE, TLOAD and
// MCOPY and accepts all four, so one Cancun build serves them all. (Arbitrum
// chains reject BLOBBASEFEE, which these contracts never use.) To build for a
// chain without Cancun, set EVM_VERSION=paris and recompile.
const evmVersion = process.env.EVM_VERSION || "cancun";

// hardhat-ethers asks for a 1 gwei priority fee by default. Chains that charge
// the priority fee (Ethereum Sepolia, OP-stack Base Sepolia, HyperEVM) then cost
// up to 1000x what they should: Sepolia's base fee is a few wei and its going
// tip is ~0.001 gwei. These fixed legacy gas prices (in wei) can be overridden
// with GAS_PRICE_WEI. Arbitrum chains and Tempo ignore or price tips themselves.
const gasPrice = (dflt) => Number(process.env.GAS_PRICE_WEI || dflt);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 500 }, viaIR: true, evmVersion },
  },
  networks: {
    hardhat: {},
    robinhoodTestnet: { url: "https://rpc.testnet.chain.robinhood.com", chainId: 46630, accounts },
    arbitrumSepolia: { url: "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614, accounts },
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
      gasPrice: gasPrice(1_200_000),
    },
    baseSepolia: { url: "https://sepolia.base.org", chainId: 84532, accounts, gasPrice: gasPrice(12_000_000) },
    // Tempo has no native gas token: fees are paid in a TIP-20 dollar (pathUSD
    // by default for calls to non-TIP-20 contracts). Plain EIP-1559 transactions
    // from ethers work as long as the sender holds pathUSD.
    tempoTestnet: { url: "https://rpc.moderato.tempo.xyz", chainId: 42431, accounts },
    hyperEvmTestnet: {
      url: "https://rpc.hyperliquid-testnet.xyz/evm",
      chainId: 998,
      accounts,
      gasPrice: gasPrice(110_000_000),
    },
  },
  etherscan: {
    apiKey: {
      robinhoodTestnet: "blockscout",
      // Every testnet here has a keyless Blockscout instance; Etherscan-family
      // explorers would need an API key.
      arbitrumSepolia: "blockscout",
      sepolia: "blockscout",
      baseSepolia: "blockscout",
    },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
      {
        network: "sepolia",
        chainId: 11155111,
        urls: { apiURL: "https://eth-sepolia.blockscout.com/api", browserURL: "https://eth-sepolia.blockscout.com" },
      },
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://arbitrum-sepolia.blockscout.com/api",
          browserURL: "https://arbitrum-sepolia.blockscout.com",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: { apiURL: "https://base-sepolia.blockscout.com/api", browserURL: "https://base-sepolia.blockscout.com" },
      },
    ],
  },
  // Tempo verifies through its own Sourcify v2 server: scripts/verify-sourcify.js.
  sourcify: { enabled: false },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
  mocha: { timeout: 120000 },
};
