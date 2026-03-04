const { ethers } = require("hardhat");

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

module.exports = {
  PrintDeployerDetails,
  PrintContractDetails,
}
