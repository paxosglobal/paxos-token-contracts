const { ethers, upgrades } = require("hardhat");
const { PrintDeployerDetails, PrintProxyAndImplementation, ValidateEnvironmentVariables } = require('./utils');

const { TOKEN_OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS } = process.env;

const INITIAL_DELAY = 10800;
const CONTRACT_NAME = "USDG";

const initializerArgs = [
  INITIAL_DELAY,
  TOKEN_OWNER_ADDRESS,
  PAUSER_ADDRESS,
  ASSET_PROTECTOR_ADDRESS,
];

async function main() {
  ValidateEnvironmentVariables(initializerArgs)
  await PrintDeployerDetails();

  console.log("\nDeploying the contract...")
  const contractFactory = await ethers.getContractFactory(CONTRACT_NAME);
  const contract = await upgrades.deployProxy(contractFactory, initializerArgs, {
    initializer: 'initialize',
    kind: 'uups',
  });

  await contract.waitForDeployment();

  await PrintProxyAndImplementation(contract, CONTRACT_NAME);
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
