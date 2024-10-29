const { ethers } = require('ethers');
const { ValidateEnvironmentVariables } = require('./utils');

const initializeAbi = [
  "function initialize(uint48 initialDelay, address initialOwner, address pauser, address assetProtector)"
];

const { INITIAL_DELAY, TOKEN_OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS } = process.env;
ValidateEnvironmentVariables(INITIAL_DELAY, TOKEN_OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS )

const iface = new ethers.Interface(initializeAbi);

const data = iface.encodeFunctionData("initialize", [INITIAL_DELAY, TOKEN_OWNER_ADDRESS, PAUSER_ADDRESS, ASSET_PROTECTOR_ADDRESS]);

console.log(`Encoded data: ${data}`);
