const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { PrintDeployerDetails, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH } = process.env;
const config = ReadConfig(CONFIG_PATH);

const SUPPLY_CONTROL_CONTRACT_NAME = "SupplyControl";

// ABI for token contract interactions
const TOKEN_ABI = [
  "function decimals() view returns (uint8)"
];

async function main() {

  // Use TIMELOCK_ADDRESS as admin if configured, otherwise fall back to SUPPLY_CONTROL_ADMIN_ADDRESS
  const supplyControlAdmin = config.TIMELOCK_ADDRESS || config.SUPPLY_CONTROL_ADMIN_ADDRESS;

  ValidateEnvironmentVariables([
    CONFIG_PATH, supplyControlAdmin, config.SUPPLY_CONTROL_MANAGER_ADDRESS, config.TOKEN_PROXY_ADDRESS]
  )
  await PrintDeployerDetails();

  // Get token decimals for rate limit calculations
  const tokenContract = new ethers.Contract(config.TOKEN_PROXY_ADDRESS, TOKEN_ABI, ethers.provider);
  const decimals = await tokenContract.decimals();
  console.log(`Token decimals: ${decimals}`);

  const scInitializationConfig = []

  // Iterate through all supply controllers in SUPPLY_CONTROLLERS
  if (config.SUPPLY_CONTROLLERS) {
    for (const [controllerName, controller] of Object.entries(config.SUPPLY_CONTROLLERS)) {
      console.log(`Processing ${controllerName}...`);
      console.log(controller)
      // Validate all required fields
      ValidateEnvironmentVariables([controller.ADDRESS, controller.MINT_ADDRESS_LIST, controller.LIMIT_CAPACITY, controller.REFILL_PER_SECOND])

      // Adjust values based on token decimals
      const limitCapacity = ethers.parseUnits(controller.LIMIT_CAPACITY.toString(), decimals);
      const refillPerSecond = ethers.parseUnits(controller.REFILL_PER_SECOND.toString(), decimals);

      scInitializationConfig.push([
        controller.ADDRESS,
        [limitCapacity, refillPerSecond],
        controller.MINT_ADDRESS_LIST.split(',').map(addr => addr.trim()),
        controller.OVERRIDE_WHITELIST
      ])
    }
  }

  const initializerArgs = [
    supplyControlAdmin,
    config.SUPPLY_CONTROL_MANAGER_ADDRESS,
    config.TOKEN_PROXY_ADDRESS,
    scInitializationConfig
  ]

  console.log("\nSupplyControl Admin: %s", supplyControlAdmin);

  console.log("\nDeploying SupplyControl contract...");
  const supplyControlFactory = await ethers.getContractFactory(SUPPLY_CONTROL_CONTRACT_NAME);
  const supplyControl = await upgrades.deployProxy(supplyControlFactory, initializerArgs, {
    initializer: "initialize",
    kind: 'uups'
  });
  await supplyControl.waitForDeployment();

  console.log("%s contract deploy tx: %s", SUPPLY_CONTROL_CONTRACT_NAME, supplyControl.deploymentTransaction().hash)

  console.log('%s contract proxy address: %s (add this value to .env)', SUPPLY_CONTROL_CONTRACT_NAME, supplyControl.target);
  console.log('%s implementation address: %s\n', SUPPLY_CONTROL_CONTRACT_NAME, await getImplementationAddress(ethers.provider, supplyControl.target))

  console.log("Supply controller addresses: %s\n", await supplyControl.getAllSupplyControllerAddresses())

  // Display config for all supply controllers
  if (config.SUPPLY_CONTROLLERS) {
    for (const [controllerName, controller] of Object.entries(config.SUPPLY_CONTROLLERS)) {
      const scConfig = await supplyControl.getSupplyControllerConfig(controller.ADDRESS)
      console.log("%s config: \n  limit config: %s \n  mintAddressWhitelist: %s\n  allowAnyMintAndBurnAddress: %s\n",
        controllerName, scConfig.limitConfig, scConfig.mintAddressWhitelist, scConfig.allowAnyMintAndBurnAddress)
    }
  }

  // Note: setSupplyControl() must be called via Timelock if TIMELOCK_ADDRESS is configured
  // as the Token owner. This is done separately after deployment.

  config['SUPPLY_CONTROL_PROXY_ADDRESS'] = supplyControl.target;
  WriteConfig(CONFIG_PATH, config)

  console.log("\n=== Deployment Summary ===");
  console.log("SupplyControl Proxy: %s", supplyControl.target);
  console.log("Token Proxy: %s", config.TOKEN_PROXY_ADDRESS);
  if (config.TIMELOCK_ADDRESS) {
    console.log("Timelock Controller: %s", config.TIMELOCK_ADDRESS);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
