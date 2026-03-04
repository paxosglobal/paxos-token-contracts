const { ethers } = require('ethers');
const { ValidateEnvironmentVariables, ReadConfig } = require('./utils');

const initializeAbi = [
  "function initialize(uint48 initialDelay, address initialOwner, address pauser, address assetProtector)"
];

const { CONFIG_PATH } = process.env;
const config = ReadConfig(CONFIG_PATH);
ValidateEnvironmentVariables(CONFIG_PATH, config.INITIAL_DELAY, config.TOKEN_OWNER_ADDRESS, config.PAUSER_ADDRESS, config.ASSET_PROTECTOR_ADDRESS)

const iface = new ethers.Interface(initializeAbi);

const data = iface.encodeFunctionData("initialize", [config.INITIAL_DELAY, config.TOKEN_OWNER_ADDRESS, config.PAUSER_ADDRESS, config.ASSET_PROTECTOR_ADDRESS]);

console.log(`Encoded data: ${data}`);
