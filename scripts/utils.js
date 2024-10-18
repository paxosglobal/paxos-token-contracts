const { ethers } = require("hardhat");
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');

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

async function PrintProxyAndImplementation(contract, contractName) {
  console.log("%s proxy address: %s", contractName, await contract.getAddress());
  console.log('%s implementation address: %s', contractName, await getImplementationAddress(ethers.provider, contract.target))
  console.log("%s contract deploy tx: %s", contractName, contract.deploymentTransaction().hash)
}

module.exports = {
  PrintDeployerDetails,
  PrintContractDetails,
  PrintProxyAndImplementation
}