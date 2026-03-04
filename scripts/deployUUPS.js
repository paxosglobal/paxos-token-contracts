const { ethers, upgrades } = require("hardhat");
const { PrintDeployerDetails, PrintProxyAndImplementation, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH} = process.env;
const config = ReadConfig(CONFIG_PATH);

// Use TIMELOCK_ADDRESS as owner if configured, otherwise fall back to TOKEN_OWNER_ADDRESS
const tokenOwner = config.TIMELOCK_ADDRESS || config.TOKEN_OWNER_ADDRESS;

const initializerArgs = [
  config.INITIAL_DELAY,
  tokenOwner,
  config.PAUSER_ADDRESS,
  config.ASSET_PROTECTOR_ADDRESS,
];

async function main() {
  ValidateEnvironmentVariables([CONFIG_PATH, config.TOKEN_CONTRACT_NAME, tokenOwner, config.PAUSER_ADDRESS, config.ASSET_PROTECTOR_ADDRESS])
  await PrintDeployerDetails();

  console.log("\nToken Owner (DEFAULT_ADMIN_ROLE): %s", tokenOwner);
  if (config.TIMELOCK_ADDRESS) {
    console.log("(Using Timelock Controller as owner)");
  }

  console.log("\nDeploying the contract...")
  const contractFactory = await ethers.getContractFactory(config.TOKEN_CONTRACT_NAME);
  const contract = await upgrades.deployProxy(contractFactory, initializerArgs, {
    initializer: 'initialize',
    kind: 'uups',
    // Allow missing initializers in child contracts (initialization handled by parent contracts)
    unsafeAllow: ['missing-initializer']
  });

  await contract.waitForDeployment();

  await PrintProxyAndImplementation(contract, config.TOKEN_CONTRACT_NAME);
  config['TOKEN_PROXY_ADDRESS'] = await contract.getAddress()
  WriteConfig(CONFIG_PATH, config)
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
