require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const pk = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = pk ? [pk] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 500 }, viaIR: true, evmVersion: "cancun" },
  },
  networks: {
    hardhat: process.env.FORK
      ? { forking: { url: "https://rpc.testnet.chain.robinhood.com" }, chainId: 46630 }
      : {},
    localFork: { url: "http://127.0.0.1:8545", chainId: 46630, accounts },
    robinhoodTestnet: { url: "https://rpc.testnet.chain.robinhood.com", chainId: 46630, accounts },
    arbitrumSepolia: { url: "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614, accounts },
  },
  etherscan: {
    apiKey: { robinhoodTestnet: "blockscout", arbitrumSepolia: process.env.ARBISCAN_API_KEY || "none" },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};
