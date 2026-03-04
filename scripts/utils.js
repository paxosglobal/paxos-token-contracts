const { ethers } = require("hardhat");
const fs = require('fs')
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const yaml = require('js-yaml');

async function PrintDeployerDetails() {
  const [deployer] = await ethers.getSigners();
  console.log('Deployer: %s', await deployer.getAddress());

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Account balance: %s', ethers.formatEther(balance));
}

async function PrintContractDetails(contract, contractName) {
  console.log("%s contract deployed at: %s", contractName, await contract.getAddress());
  console.log("%s contract deploy tx: %s", contractName, contract.deploymentTransaction().hash)
}

function ReadConfig(path) {
  const transactionData = fs.readFileSync(path, 'utf-8');
  return yaml.load(transactionData)
}

function WriteConfig(path, config) {
  const file = yaml.dump(config, { 
    lineWidth: -1,
    noRefs: true,
    forceQuotes: true,
  });
  fs.writeFileSync(path, file)
}

async function PrintProxyAndImplementation(contract, contractName) {
  console.log("%s proxy address: %s", contractName, await contract.getAddress());
  console.log('%s implementation address: %s', contractName, await getImplementationAddress(ethers.provider, contract.target))
  console.log("%s contract deploy tx: %s", contractName, contract.deploymentTransaction().hash)
}

// Throws an error if any of the arguments are falsy or undefined.
function ValidateEnvironmentVariables(args) {
  for (const arg of args) {
    if (!arg) {
      throw new Error('Missing environment variable');
    }
  }
}

// Gets the current nonce for an address on a specific hardhat network
async function getNonceForNetwork(address, hardhatNetworkName) {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid address: ${address}`);
  }
  
  if (!hardhatNetworkName) {
    throw new Error('Hardhat network name is required');
  }
  
  // Get the network config from hardhat
  const hre = require('hardhat');
  const networkConfig = hre.config.networks[hardhatNetworkName];
  
  if (!networkConfig || !networkConfig.url) {
    throw new Error(`Network configuration not found for ${hardhatNetworkName}. Make sure the corresponding URL environment variable is set.`);
  }
  
  // Create a provider for the specific network
  const provider = new ethers.JsonRpcProvider(networkConfig.url);
  
  // Get the transaction count (nonce)
  const nonce = await provider.getTransactionCount(address);
  return nonce;
}

module.exports = {
  PrintDeployerDetails,
  PrintContractDetails,
  PrintProxyAndImplementation,
  ReadConfig,
  WriteConfig,
  ValidateEnvironmentVariables,
  getNonceForNetwork,
}