const { ethers, upgrades } = require("hardhat");
const { PrintDeployerDetails, PrintProxyAndImplementation } = require('./utils');

const { OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS } = process.env;

const INITIAL_DELAY = 10;
const CONTRACT_NAME = "USDX";

const initializerArgs = [
  INITIAL_DELAY,
  OWNER_ADDRESS,
  PAUSER_ADDRESS,
  ASSET_PROTECTOR_ADDRESS,
];

async function main() {
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
