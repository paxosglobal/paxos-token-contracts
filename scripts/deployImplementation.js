const { ethers } = require("hardhat");
const { TOKEN_CONTRACT_NAME} = process.env;

const { PrintDeployerDetails, PrintContractDetails } = require('./utils');

async function main() {
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
