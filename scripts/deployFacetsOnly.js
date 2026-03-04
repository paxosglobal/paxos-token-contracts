const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails, ReadConfig, WriteConfig, ValidateEnvironmentVariables } = require('./utils');

const { CONFIG_PATH } = process.env;
const config = ReadConfig(CONFIG_PATH);

// Define all facets to deploy
const FACETS = [
  'ClaimableRewardsFacet',
  'MultiplierMgmtFacet',
  'PayoutGroupFacet',
  'TokenAdminFacet',
  'TokenExtensionsFacet'
];

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

async function main() {
  ValidateEnvironmentVariables([CONFIG_PATH]);
  await PrintDeployerDetails();

  const deployedFacets = {};

  // Deploy all facets
  console.log('\n========================================');
  console.log('DEPLOYING FACETS (without registration)');
  console.log('========================================');

  for (const facetName of FACETS) {
    const facet = await deployFacet(facetName);
    const facetAddress = await facet.getAddress();
    deployedFacets[facetName] = facetAddress;

    // Save to config using uppercase facet name
    config[`${facetName.toUpperCase()}_ADDRESS`] = facetAddress;
  }

  // Save updated config
  WriteConfig(CONFIG_PATH, config);
  console.log(`\n✓ Configuration saved to ${CONFIG_PATH}`);

  // Summary
  console.log('\n========================================');
  console.log('DEPLOYMENT SUMMARY');
  console.log('========================================');
  for (const facetName of FACETS) {
    console.log(`${facetName}: ${deployedFacets[facetName]}`);
  }
  console.log('\nNote: Facets are deployed but NOT registered with the proxy.');
  console.log('Run facet registration after upgrading the proxy to PaxosTokenClaimableRewards.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
