const dotenv = require('dotenv');
require("@nomicfoundation/hardhat-ethers");
require('@nomicfoundation/hardhat-toolbox');
require('@openzeppelin/hardhat-upgrades');
require("hardhat-contract-sizer");
require('@okxweb3/hardhat-explorer-verify');

dotenv.config();

const {
  PRIVATE_KEY,
  URL_ETH_MAINNET,
  URL_ETH_SEPOLIA,
  URL_INK_MAINNET,
  URL_INK_SEPOLIA,
  URL_ARB_MAINNET,
  URL_ARB_SEPOLIA,
  URL_XLAYER_TESTNET,
  URL_XLAYER_MAINNET,
  GAS_REPORTING,
  EXPLORER_ETH_API_KEY,
  EXPLORER_INK_API_KEY_MAINNET,
  EXPLORER_INK_API_KEY_SEPOLIA,
  EXPLORER_ARB_API_KEY_MAINNET,
  EXPLORER_ARB_API_KEY_SEPOLIA,
  EXPLORER_XLAYER_API_KEY_MAINNET
} = process.env;

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      allowBlocksWithSameTimestamp: true,
      allowUnlimitedContractSize: false,
      // Specify hardfork version to avoid EDR issues with forking
      hardfork: "shanghai",
      httpTimeout: 30000
    },
    ethMain: {
      url: URL_ETH_MAINNET,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    ethSepolia: {
      url: URL_ETH_SEPOLIA,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    inkMain: {
      url: URL_INK_MAINNET,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    inkSepolia: {
      url: URL_INK_SEPOLIA,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    arbMain: {
      url: URL_ARB_MAINNET,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    arbSepolia: {
      url: URL_ARB_SEPOLIA,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
    xlayerTestnet: {
      url: URL_XLAYER_TESTNET,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
      timeout: 300000, // 5 minutes
      httpTimeout: 300000, // 5 minutes for HTTP requests
      gasPrice: "auto",
    },
    xlayer: {
      url: URL_XLAYER_MAINNET,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
      timeout: 300000, // 5 minutes
      gasPrice: "auto",
    },
  },
  gasReporter: {
    enabled: (GAS_REPORTING ? GAS_REPORTING == "true" : true),
  },
  mocha: {
    reporter: 'spec',
    timeout: 120000
  },
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      },
      {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      },
      {
        version: "0.4.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      },
    ]
  },
  okxweb3explorer: {
    apiKey: {
      xlayer: EXPLORER_XLAYER_API_KEY_MAINNET || "",
    },
    customChains: [
      {
        network: "xlayer",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER",
          browserURL: "https://www.oklink.com/xlayer"
        }
      }
    ]
  },
  etherscan: {
    apiKey: {
      mainnet: EXPLORER_ETH_API_KEY,
      sepolia: EXPLORER_ETH_API_KEY,
      inkMain: EXPLORER_INK_API_KEY_MAINNET,
      inkSepolia: EXPLORER_INK_API_KEY_SEPOLIA,
      arbMain: EXPLORER_ARB_API_KEY_MAINNET,
      arbSepolia: EXPLORER_ARB_API_KEY_SEPOLIA,
    },
    customChains: [
      {
        network: "inkMain",
        chainId: 57073,
        urls: {
          apiURL: "https://explorer.inkonchain.com/api",
          browserURL: "https://explorer.inkonchain.com/"
        }
      },
      {
        network: "inkSepolia",
        chainId: 763373,
        urls: {
          apiURL: "https://explorer-sepolia.inkonchain.com/api",
          browserURL: "https://explorer-sepolia.inkonchain.com/"
        }
      },
      {
        network: "arbMain",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io/"
        }
      },
      {
        network: "arbSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io/"
        }
      }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
};
