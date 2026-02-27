const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH, ENCODE_ONLY } = process.env;
const config = ReadConfig(CONFIG_PATH);
const encodeOnly = ENCODE_ONLY === 'true';
// FACETS_ONLY (config): true = batchSetFacet only; false/unset = full initializeV3 (default)
const useInitializeV3 = !config.FACETS_ONLY;

// Define all facets to deploy
const FACETS = [
  'TokenAdminFacet',
  'TokenExtensionsFacet',
  'ClaimableRewardsFacet',
  'MultiplierMgmtFacet',
  'PayoutGroupFacet'
];

/**
 * Extract function selectors from a facet contract interface
 * @param {Object} facetContract - Deployed facet contract with interface
 * @returns {string[]} Array of function selector bytes4 strings
 */
function getSelectorsFromFacet(facetContract) {
  const selectors = [];
  facetContract.interface.forEachFunction((func) => {
    selectors.push(func.selector);
  });
  return selectors;
}

/**
 * Deploy a single facet contract
 * @param {string} facetName - Name of the facet contract
 * @returns {Object} Deployed contract instance
 */
async function deployFacet(facetName) {
  console.log(`\nDeploying ${facetName}...`);
  const facetFactory = await ethers.getContractFactory(facetName);
  const facet = await facetFactory.deploy();
  await facet.waitForDeployment();

  await PrintContractDetails(facet, facetName);
  return facet;
}

/**
 * Atomic Upgrade Script
 *
 * This script performs an atomic upgrade from V2 to V3:
 * 1. Deploys all 5 facets (can be done in advance, facets are stateless)
 * 2. Deploys new implementation
 * 3. Encodes the initializeV3 call data
 * 4. (Unless ENCODE_ONLY=true) Calls upgradeToAndCall with initializeV3 to atomically:
 *    - Initialize V3 storage
 *    - Register all facet selectors
 *    - Set config (claimSource, minRate, maxRate)
 *
 * Environment variables:
 *   CONFIG_PATH    - Path to the JSON config file (required)
 *   ENCODE_ONLY    - Set to "true" to deploy contracts and output encoded callData
 *                    without executing the upgrade. Used in production where the
 *                    upgrade tx is signed via HSM (crypto-wallet repo).
 *   FACETS_ONLY     - Config boolean. true: call data is batchSetFacet for first facet; rest in separate txs.
 *                    false/unset (default): call data is initializeV3(...).
 */
async function main() {
  ValidateEnvironmentVariables([CONFIG_PATH, config.TOKEN_PROXY_ADDRESS]);
  await PrintDeployerDetails();

  // Get the signer
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeployer address: ${deployer.address}`);

  // Get the proxy contract
  console.log(`\nConnecting to proxy at ${config.TOKEN_PROXY_ADDRESS}...`);

  // Attach as the old contract first (for upgrade call)
  const oldContract = await ethers.getContractAt('PaxosTokenV2', config.TOKEN_PROXY_ADDRESS);
  console.log('✓ Connected to proxy');

  // Deploy all facets
  console.log('\n========================================');
  console.log('STEP 1: DEPLOY FACETS');
  console.log('========================================');

  const deployedFacets = {};
  for (const facetName of FACETS) {
    const facet = await deployFacet(facetName);
    const facetAddress = await facet.getAddress();
    deployedFacets[facetName] = {
      address: facetAddress,
      contract: facet
    };

    // Save to config
    config[`${facetName.toUpperCase()}_ADDRESS`] = facetAddress;
  }

  // Deploy new implementation
  console.log('\n========================================');
  console.log('STEP 2: DEPLOY NEW IMPLEMENTATION');
  console.log('========================================');

  // Get the implementation contract name from config or use USDG as default
  const implementationName = config.IMPLEMENTATION_NAME || 'USDG';
  console.log(`\nDeploying ${implementationName}...`);

  const implFactory = await ethers.getContractFactory(implementationName);
  const newImplementation = await implFactory.deploy();
  await newImplementation.waitForDeployment();
  const newImplAddress = await newImplementation.getAddress();

  await PrintContractDetails(newImplementation, implementationName);
  config.NEW_IMPLEMENTATION_ADDRESS = newImplAddress;

  // Prepare atomic upgrade
  console.log('\n========================================');
  console.log('STEP 3: ATOMIC UPGRADE WITH INITIALIZATION');
  console.log('========================================');

  const FACET_ORDER = ['TokenAdminFacet', 'TokenExtensionsFacet', 'ClaimableRewardsFacet', 'MultiplierMgmtFacet', 'PayoutGroupFacet'];
  const facetCuts = FACET_ORDER.map(facetName => ({
    facet: deployedFacets[facetName].address,
    selectors: getSelectorsFromFacet(deployedFacets[facetName].contract)
  }));

  let callData;
  if (useInitializeV3) {
    // Configuration for initializeV3 - all values must be set in the config file
    const requiredV3Config = [
      'CLAIM_SOURCE_ADDRESS',
      'MIN_APR',
      'MAX_APR',
      'MULT_ADMIN_ADDRESS',
      'MULT_RATE_ADMIN_ADDRESS',
      'PAYOUT_GROUP_ADMIN_ADDRESS',
      'PAYOUT_GROUP_REGISTRAR_ADDRESS',
      'CLAIM_OPERATOR_ADDRESS',
      'CLAIM_ADMIN_ADDRESS'
    ];
    const missingConfig = requiredV3Config.filter(key => config[key] === undefined || config[key] === null || config[key] === '');
    if (missingConfig.length > 0) {
      throw new Error(`Missing required V3 config values: ${missingConfig.join(', ')}`);
    }

    const claimSource = config.CLAIM_SOURCE_ADDRESS;
    const minRate = config.MIN_APR;
    const maxRate = config.MAX_APR;
    const multAdmin = config.MULT_ADMIN_ADDRESS;
    const multRateAdmin = config.MULT_RATE_ADMIN_ADDRESS;
    const payoutGroupAdmin = config.PAYOUT_GROUP_ADMIN_ADDRESS;
    const payoutGroupRegistrar = config.PAYOUT_GROUP_REGISTRAR_ADDRESS;
    const claimOperator = config.CLAIM_OPERATOR_ADDRESS;
    const claimAdmin = config.CLAIM_ADMIN_ADDRESS;

    console.log(`\nInit mode: initializeV3 (full init + facet registration)`);
    console.log(`InitializeV3 parameters:`);
    for (let i = 0; i < FACET_ORDER.length; i++) {
      const name = FACET_ORDER[i].padEnd(22);
      console.log(`  ${name} ${facetCuts[i].facet} (${facetCuts[i].selectors.length} selectors)`);
    }
    console.log(`  claimSource:            ${claimSource}`);
    console.log(`  minRate:                ${minRate}`);
    console.log(`  maxRate:                ${maxRate}`);
    console.log(`  multAdmin:              ${multAdmin}`);
    console.log(`  multRateAdmin:          ${multRateAdmin}`);
    console.log(`  payoutGroupAdmin:       ${payoutGroupAdmin}`);
    console.log(`  payoutGroupRegistrar:   ${payoutGroupRegistrar}`);
    console.log(`  claimOperator:          ${claimOperator}`);
    console.log(`  claimAdmin:             ${claimAdmin}`);

    callData = newImplementation.interface.encodeFunctionData('initializeV3', [
      facetCuts,
      claimSource,
      minRate,
      maxRate,
      {
        multAdmin: multAdmin,
        multRateAdmin: multRateAdmin,
        payoutGroupAdmin: payoutGroupAdmin,
        payoutGroupRegistrar: payoutGroupRegistrar,
        claimOperator: claimOperator,
        claimAdmin: claimAdmin
      }
    ]);
  } else {
    // batchSetFacet mode: register all facets in one upgrade call via batchSetFacet(facetCuts)
    console.log(`\nInit mode: batchSetFacet (facet registration only, no V3 config)`);
    for (let i = 0; i < FACET_ORDER.length; i++) {
      console.log(`  ${FACET_ORDER[i].padEnd(22)} ${facetCuts[i].facet} (${facetCuts[i].selectors.length} selectors)`);
    }
    callData = newImplementation.interface.encodeFunctionData('batchSetFacet', [facetCuts]);
  }

  console.log(`\nEncoded callData:`);
  console.log(callData);

  // Save updated config (includes deployed addresses and encoded init data)
  config.CALL_DATA = callData;
  WriteConfig(CONFIG_PATH, config);
  console.log(`\n✓ Configuration saved to ${CONFIG_PATH}`);

  if (encodeOnly) {
    // In production, the encoded data is provided to the HSM-signed tx generation step
    console.log('\n========================================');
    console.log('ENCODE_ONLY MODE - Transaction not executed');
    console.log('========================================');
    console.log(`Proxy Address:          ${config.TOKEN_PROXY_ADDRESS}`);
    console.log(`New Implementation:     ${newImplAddress}`);
    console.log(`\nUse the encoded callData above with upgradeToAndCall(${newImplAddress}, callData)`);
    if (!useInitializeV3) {
      console.log(`\nNote: FACETS_ONLY=true — callData is batchSetFacet(facetCuts) and registers all facets in one call.`);
    }
    return;
  }

  // Execute atomic upgrade
  console.log('\n========================================');
  console.log('STEP 4: EXECUTE UPGRADE');
  console.log('========================================');

  console.log(`\nExecuting upgradeToAndCall...`);
  const tx = await oldContract.upgradeToAndCall(newImplAddress, callData);
  console.log(`Transaction hash: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✓ Atomic upgrade complete (block: ${receipt.blockNumber})`);

  // In batchSetFacet mode, all facets were registered in the upgrade call
  if (!useInitializeV3) {
    console.log(`✓ All facets registered via batchSetFacet(facetCuts) in upgrade call`);
  }

  // Verify upgrade
  console.log('\n========================================');
  console.log('STEP 5: VERIFICATION');
  console.log('========================================');

  // Attach new interface
  const newContract = implFactory.attach(config.TOKEN_PROXY_ADDRESS);

  // Create combined interface with all facets
  const combinedInterface = new ethers.Interface([
    ...newContract.interface.fragments,
    ...deployedFacets['TokenAdminFacet'].contract.interface.fragments,
    ...deployedFacets['TokenExtensionsFacet'].contract.interface.fragments,
    ...deployedFacets['ClaimableRewardsFacet'].contract.interface.fragments,
    ...deployedFacets['MultiplierMgmtFacet'].contract.interface.fragments,
    ...deployedFacets['PayoutGroupFacet'].contract.interface.fragments,
  ]);

  const tokenWithFacets = new ethers.Contract(config.TOKEN_PROXY_ADDRESS, combinedInterface, deployer);

  // Test facet functions work immediately
  console.log('\nVerifying facet functions work immediately:');

  try {
    const paused = await tokenWithFacets.paused();
    console.log(`  ✓ paused() = ${paused} (TokenAdminFacet)`);
  } catch (e) {
    console.log(`  ✗ paused() failed: ${e.message}`);
  }

  try {
    const claimSourceResult = await tokenWithFacets.getClaimSource();
    console.log(`  ✓ getClaimSource() = ${claimSourceResult} (MultiplierMgmtFacet)`);
  } catch (e) {
    console.log(`  ✗ getClaimSource() failed: ${e.message}`);
  }

  try {
    const nonces = await tokenWithFacets.nonces(deployer.address);
    console.log(`  ✓ nonces() = ${nonces} (TokenExtensionsFacet)`);
  } catch (e) {
    console.log(`  ✗ nonces() failed: ${e.message}`);
  }

  // Summary
  console.log('\n========================================');
  console.log('ATOMIC UPGRADE SUMMARY');
  console.log('========================================');
  console.log(`Proxy Address:          ${config.TOKEN_PROXY_ADDRESS}`);
  console.log(`New Implementation:     ${newImplAddress}`);
  console.log(`TokenAdminFacet:        ${deployedFacets['TokenAdminFacet'].address}`);
  console.log(`TokenExtensionsFacet:   ${deployedFacets['TokenExtensionsFacet'].address}`);
  console.log(`ClaimableRewardsFacet:  ${deployedFacets['ClaimableRewardsFacet'].address}`);
  console.log(`MultiplierMgmtFacet:    ${deployedFacets['MultiplierMgmtFacet'].address}`);
  console.log(`PayoutGroupFacet:       ${deployedFacets['PayoutGroupFacet'].address}`);
  console.log(`\n✓ All facet functions available immediately after upgrade!`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
