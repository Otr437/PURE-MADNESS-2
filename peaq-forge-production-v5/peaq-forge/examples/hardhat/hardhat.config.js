require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    peaq: {
      url:      process.env.PEAQ_MAINNET_RPC || "https://peaq.api.onfinality.io/public",
      chainId:  3338,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      timeout:  60000,
    },
    agung: {
      url:      process.env.PEAQ_AGUNG_RPC || "https://rpcpc1-qa.agung.peaq.network",
      chainId:  9990,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      timeout:  60000,
    },
    krest: {
      url:      process.env.PEAQ_KREST_RPC || "https://erpc.krest.peaq.network",
      chainId:  2241,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      timeout:  60000,
    },
    local: {
      url:     "http://127.0.0.1:8545",
      chainId: 4242,
    },
  },
  etherscan: {
    apiKey: {
      peaq:  "no-key-needed",
      agung: "no-key-needed",
      krest: "no-key-needed",
    },
    customChains: [
      {
        network: "peaq",
        chainId: 3338,
        urls: { apiURL: "https://peaq.subscan.io/api", browserURL: "https://peaq.subscan.io" },
      },
      {
        network: "agung",
        chainId: 9990,
        urls: { apiURL: "https://agung.subscan.io/api", browserURL: "https://agung.subscan.io" },
      },
      {
        network: "krest",
        chainId: 2241,
        urls: { apiURL: "https://krest.subscan.io/api", browserURL: "https://krest.subscan.io" },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
