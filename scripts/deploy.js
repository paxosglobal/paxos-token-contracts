const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH } = process.env;
const config = ReadConfig(CONFIG_PATH);

const PROXY_CONTRACT_NAME = "AdminUpgradeabilityProxy";

const initializerArgs = [
  config.INITIAL_DELAY,
  config.TOKEN_OWNER_ADDRESS,
  config.PAUSER_ADDRESS,
  config.ASSET_PROTECTOR_ADDRESS,
]

async function main() {
  ValidateEnvironmentVariables([CONFIG_PATH, ...initializerArgs, config.TOKEN_CONTRACT_NAME])
  PrintDeployerDetails();

  console.log("\nDeploying Implementation contract...")
  const contractFactoryImplementation = await ethers.getContractFactory(config.TOKEN_CONTRACT_NAME);
  let contractImplementation = await contractFactoryImplementation.deploy();
  await contractImplementation.waitForDeployment();
  PrintContractDetails(contractImplementation, config.TOKEN_CONTRACT_NAME + " implementation ");

  const contractFactoryProxy = await ethers.getContractFactory(PROXY_CONTRACT_NAME);
  const contractProxy = await contractFactoryProxy.deploy(await contractImplementation.getAddress());
  await contractProxy.waitForDeployment();
  PrintContractDetails(contractProxy, PROXY_CONTRACT_NAME);
  let tx = await contractProxy.changeAdmin(config.TOKEN_ADMIN_ADDRESS);
  await tx.wait(); //Need to wait since there is a brief period where the tx has been submitted successfully, but hasn't been confirmed.

  contract = await contractFactoryImplementation.attach(await contractProxy.getAddress());

  await contract.initialize(...initializerArgs);
  config['TOKEN_PROXY_ADDRESS'] = await contract.getAddress()
  WriteConfig(CONFIG_PATH, config)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
