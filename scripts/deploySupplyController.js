const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { PrintDeployerDetails, ValidateEnvironmentVariables } = require('./utils');

const { 
    SUPPLY_CONTROL_ADMIN_ADDRESS, SUPPLY_CONTROL_MANAGER_ADDRESS, TOKEN_PROXY_ADDRESS,
    COLD_SUPPLY_CONTROLLER_ADDRESS, COLD_MINT_ADDRESS_LIST, WARM_SUPPLY_CONTROLLER_ADDRESS, 
    WARM_LIMIT_CAPACITY, WARM_REFILL_PER_SECOND, WARM_MINT_ADDRESS_LIST
 } = process.env;

const COLD_LIMIT_CAPACITY = 0;
const COLD_REFILL_PER_SECOND = 0; //Special value to skip limit checking
const SUPPLY_CONTROL_CONTRACT_NAME = "SupplyControl";

const scInitializationConfig = 
  [
    [COLD_SUPPLY_CONTROLLER_ADDRESS, [COLD_LIMIT_CAPACITY, COLD_REFILL_PER_SECOND], COLD_MINT_ADDRESS_LIST.split(','), false], 
    [WARM_SUPPLY_CONTROLLER_ADDRESS, [WARM_LIMIT_CAPACITY, WARM_REFILL_PER_SECOND], WARM_MINT_ADDRESS_LIST.split(','), false]
  ]

const initializerArgs = [
  SUPPLY_CONTROL_ADMIN_ADDRESS,
  SUPPLY_CONTROL_MANAGER_ADDRESS,
  TOKEN_PROXY_ADDRESS,
  scInitializationConfig
]

async function main() {
  ValidateEnvironmentVariables([
    SUPPLY_CONTROL_ADMIN_ADDRESS, SUPPLY_CONTROL_MANAGER_ADDRESS, TOKEN_PROXY_ADDRESS,
    COLD_SUPPLY_CONTROLLER_ADDRESS, COLD_MINT_ADDRESS_LIST, WARM_SUPPLY_CONTROLLER_ADDRESS, 
    WARM_LIMIT_CAPACITY, WARM_REFILL_PER_SECOND, WARM_MINT_ADDRESS_LIST]
  )
  PrintDeployerDetails();

  const supplyControlFactory = await ethers.getContractFactory(SUPPLY_CONTROL_CONTRACT_NAME);
  const supplyControl = await upgrades.deployProxy(supplyControlFactory, initializerArgs, {
    initializer: "initialize",
  });
  await supplyControl.waitForDeployment();

  console.log("%s contract deploy tx: %s", SUPPLY_CONTROL_CONTRACT_NAME, supplyControl.deploymentTransaction().hash)

  console.log('%s contract proxy address: %s (add this value to .env)', SUPPLY_CONTROL_CONTRACT_NAME, supplyControl.target);
  console.log('%s implementation address: %s\n', SUPPLY_CONTROL_CONTRACT_NAME, await getImplementationAddress(ethers.provider, supplyControl.target))

  console.log("Supply controller addresses: %s\n", await supplyControl.getAllSupplyControllerAddresses())

  const coldScConfig = await supplyControl.getSupplyControllerConfig(COLD_SUPPLY_CONTROLLER_ADDRESS)
  const warmScConfig = await supplyControl.getSupplyControllerConfig(WARM_SUPPLY_CONTROLLER_ADDRESS)

  console.log("Cold supply controller config: \n  limit config: %s \n  mintAddressWhitelist: %s\n  allowAnyMintAndBurnAddress: %s\n", coldScConfig.limitConfig, coldScConfig.mintAddressWhitelist, coldScConfig.allowAnyMintAndBurnAddress)
  console.log("Warm supply controller config: \n  limit config: %s \n  mintAddressWhitelist: %s\n  allowAnyMintAndBurnAddress: %s\n", warmScConfig.limitConfig, warmScConfig.mintAddressWhitelist, warmScConfig.allowAnyMintAndBurnAddress)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
