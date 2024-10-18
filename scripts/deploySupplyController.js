const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;
const { getImplementationAddress } = require('@openzeppelin/upgrades-core');
const { PrintDeployerDetails, PrintContractDetails } = require('./utils');

const { 
    SUPPLY_CONTROL_ADMIN_ADDRESS, SUPPLY_CONTROL_MANAGER_ADDRESS, TOKEN_PROXY_ADDRESS,
    COLD_SUPPLY_CONTROLLER_ADDRESS, COLD_MINT_BURN_ADDRESS_LIST,
    WARM_SUPPLY_CONTROLLER_ADDRESS, WARM_LIMIT_AMOUNT_PER_TX, WARM_LIMIT_AMOUNT_PER_TIME_PERIOD, WARM_REFILL_PER_SECOND, WARM_MINT_BURN_ADDRESS_LIST
 } = process.env;

const COLD_LIMIT_AMOUNT_PER_TX = MaxUint256;
const COLD_LIMIT_AMOUNT_PER_TIME_PERIOD = MaxUint256;
const COLD_REFILL_PER_SECOND = 0; //Special value to skip limit checking
const SUPPLY_CONTROL_CONTRACT_NAME = "SupplyControl";

const scInitializationConfig = 
  [
    [COLD_SUPPLY_CONTROLLER_ADDRESS, [COLD_LIMIT_AMOUNT_PER_TX, COLD_LIMIT_AMOUNT_PER_TIME_PERIOD, COLD_REFILL_PER_SECOND], COLD_MINT_BURN_ADDRESS_LIST.split(','), false], 
    [WARM_SUPPLY_CONTROLLER_ADDRESS, [WARM_LIMIT_AMOUNT_PER_TX, WARM_LIMIT_AMOUNT_PER_TIME_PERIOD, WARM_REFILL_PER_SECOND], WARM_MINT_BURN_ADDRESS_LIST.split(','), false]
  ]

const initializerArgs = [
  SUPPLY_CONTROL_ADMIN_ADDRESS,
  SUPPLY_CONTROL_MANAGER_ADDRESS,
  TOKEN_PROXY_ADDRESS,
  scInitializationConfig
]

async function main() {
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

  console.log("Cold supply controller config: \n  limit config: %s \n  mintAndBurnAddressList: %s\n  allowAnyMintAndBurnAddress: %s\n", coldScConfig.limitConfig, coldScConfig.mintAndBurnAddressSet, coldScConfig.allowAnyMintAndBurnAddress)
  console.log("Warm supply controller config: \n  limit config: %s \n  mintAndBurnAddressList: %s\n  allowAnyMintAndBurnAddress: %s\n", warmScConfig.limitConfig, warmScConfig.mintAndBurnAddressSet, warmScConfig.allowAnyMintAndBurnAddress)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
});
