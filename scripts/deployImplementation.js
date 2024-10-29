const { ethers } = require("hardhat");
const { TOKEN_CONTRACT_NAME} = process.env;

const { PrintDeployerDetails, PrintContractDetails, ValidateEnvironmentVariables } = require('./utils');

async function main() {
  ValidateEnvironmentVariables([TOKEN_CONTRACT_NAME])
  PrintDeployerDetails();

  console.log("\nDeploying Implementation contract...")
  const contractFactoryImplementation = await ethers.getContractFactory(TOKEN_CONTRACT_NAME);
  const contract = await contractFactoryImplementation.deploy();
  await contract.waitForDeployment();
  await PrintContractDetails(contract, TOKEN_CONTRACT_NAME + " implementation ")
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
