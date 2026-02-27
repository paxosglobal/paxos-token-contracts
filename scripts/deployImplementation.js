const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH, CONTRACT_NAME } = process.env;
const config = ReadConfig(CONFIG_PATH);

async function main() {
  ValidateEnvironmentVariables([CONFIG_PATH, CONTRACT_NAME])
  PrintDeployerDetails();

  console.log("\nDeploying Implementation contract...")
  const contractFactoryImplementation = await ethers.getContractFactory(CONTRACT_NAME);
  const contract = await contractFactoryImplementation.deploy();
  await contract.waitForDeployment();
  await PrintContractDetails(contract, CONTRACT_NAME + " implementation ")

  config[CONTRACT_NAME + '_IMPLEMENTATION_ADDRESS'] = await contract.getAddress()
  WriteConfig(CONFIG_PATH, config)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
