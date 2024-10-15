const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails, ValidateEnvironmentVariables } = require('./utils');

const { TOKEN_ADMIN_ADDRESS, TOKEN_OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS, TOKEN_CONTRACT_NAME } = process.env;

const INITIAL_DELAY = 10;
const PROXY_CONTRACT_NAME = "AdminUpgradeabilityProxy";

const initializerArgs = [
  INITIAL_DELAY,
  TOKEN_OWNER_ADDRESS,
  PAUSER_ADDRESS,
  ASSET_PROTECTOR_ADDRESS,
]

async function main() {
  ValidateEnvironmentVariables([...initializerArgs, TOKEN_CONTRACT_NAME])
  PrintDeployerDetails();

  console.log("\nDeploying Implementation contract...")
  const contractFactoryImplementation = await ethers.getContractFactory(TOKEN_CONTRACT_NAME);
  let contractImplementation = await contractFactoryImplementation.deploy();
  await contractImplementation.waitForDeployment();
  PrintContractDetails(contractImplementation, TOKEN_CONTRACT_NAME + " implementation ");

  const contractFactoryProxy = await ethers.getContractFactory(PROXY_CONTRACT_NAME);
  const contractProxy = await contractFactoryProxy.deploy(await contractImplementation.getAddress());
  await contractProxy.waitForDeployment();
  PrintContractDetails(contractProxy, PROXY_CONTRACT_NAME);
  await contractProxy.changeAdmin(TOKEN_ADMIN_ADDRESS);

  contract = await contractFactoryImplementation.attach(await contractProxy.getAddress());

  await contract.initialize(...initializerArgs);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
