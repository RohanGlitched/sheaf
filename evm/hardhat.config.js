require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const pk = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = pk ? [pk] : [];

// Every target chain was probed with an eth_call of PUSH0, TSTORE, TLOAD and
// MCOPY and accepts all four, so one Cancun build serves them all. (Arbitrum
// chains reject BLOBBASEFEE, which these contracts never use.) To build for a
// chain without Cancun, set EVM_VERSION=paris and recompile.
const evmVersion = process.env.EVM_VERSION || "cancun";

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
    sepolia: { url: process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111, accounts },
    baseSepolia: { url: "https://sepolia.base.org", chainId: 84532, accounts },
    // Tempo has no native gas token: fees are paid in a TIP-20 dollar (pathUSD
    // by default for calls to non-TIP-20 contracts). Plain EIP-1559 transactions
    // from ethers work as long as the sender holds pathUSD.
    tempoTestnet: { url: "https://rpc.moderato.tempo.xyz", chainId: 42431, accounts },
    hyperEvmTestnet: { url: "https://rpc.hyperliquid-testnet.xyz/evm", chainId: 998, accounts },
  },
  etherscan: {
    apiKey: {
      robinhoodTestnet: "blockscout",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || "none",
      sepolia: process.env.ETHERSCAN_API_KEY || "none",
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
