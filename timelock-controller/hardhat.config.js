const path = require("path");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("@okxweb3/hardhat-explorer-verify");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const {
  PRIVATE_KEY,
  URL_ETH_MAINNET,
  URL_ETH_SEPOLIA,
  URL_INK_MAINNET,
  URL_INK_SEPOLIA,
  URL_ARB_MAINNET,
  URL_ARB_SEPOLIA,
  URL_XLAYER_MAINNET,
  URL_XLAYER_TESTNET,
  ETHERSCAN_API_KEY,
  ARBISCAN_API_KEY,
  INKSCAN_API_KEY,
  EXPLORER_XLAYER_API_KEY,
} = process.env;

const networks = {
  hardhat: {},
};

if (URL_ETH_MAINNET) {
  networks.ethMain = {
    url: URL_ETH_MAINNET,
    chainId: 1,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_ETH_SEPOLIA) {
  networks.ethSepolia = {
    url: URL_ETH_SEPOLIA,
    chainId: 11155111,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_INK_MAINNET) {
  networks.inkMain = {
    url: URL_INK_MAINNET,
    chainId: 57073,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_INK_SEPOLIA) {
  networks.inkSepolia = {
    url: URL_INK_SEPOLIA,
    chainId: 763373,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_ARB_MAINNET) {
  networks.arbMain = {
    url: URL_ARB_MAINNET,
    chainId: 42161,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_ARB_SEPOLIA) {
  networks.arbSepolia = {
    url: URL_ARB_SEPOLIA,
    chainId: 421614,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_XLAYER_MAINNET) {
  networks.xlayer = {
    url: URL_XLAYER_MAINNET,
    chainId: 196,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

if (URL_XLAYER_TESTNET) {
  networks.xlayerTestnet = {
    url: URL_XLAYER_TESTNET,
    chainId: 1952,
    ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
  };
}

module.exports = {
  defaultNetwork: "hardhat",
  networks,
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY || "",
      sepolia: ETHERSCAN_API_KEY || "",
      arbMain: ARBISCAN_API_KEY || ETHERSCAN_API_KEY || "",
      arbSepolia: ARBISCAN_API_KEY || ETHERSCAN_API_KEY || "",
      inkMain: INKSCAN_API_KEY || "",
      inkSepolia: INKSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "arbMain",
        chainId: 42161,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=42161",
          browserURL: "https://arbiscan.io/",
        },
      },
      {
        network: "arbSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=421614",
          browserURL: "https://sepolia.arbiscan.io/",
        },
      },
      {
        network: "inkMain",
        chainId: 57073,
        urls: {
          apiURL: "https://explorer.inkonchain.com/api",
          browserURL: "https://explorer.inkonchain.com/",
        },
      },
      {
        network: "inkSepolia",
        chainId: 763373,
        urls: {
          apiURL: "https://explorer-sepolia.inkonchain.com/api",
          browserURL: "https://explorer-sepolia.inkonchain.com/",
        },
      },
    ],
  },
  okxweb3explorer: {
    apiKey: EXPLORER_XLAYER_API_KEY || "",
    customChains: [
      {
        network: "xlayer",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER",
          browserURL: "https://www.oklink.com/xlayer",
        },
      },
      {
        network: "xlayerTestnet",
        chainId: 1952,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET",
          browserURL: "https://www.oklink.com/xlayer-test",
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
