const { getComparison } = require('../test/helpers/storageLayout');
const hre = require('hardhat');
const { parseFullyQualifiedName } = require('hardhat/utils/contract-names');

/**
 * Get storage layout for a contract
 */
async function getStorageLayout(fullyQualifiedName) {
  const info = await hre.artifacts.getBuildInfo(fullyQualifiedName);
  const { sourceName, contractName } = parseFullyQualifiedName(fullyQualifiedName);
  const storage = info.output.contracts[sourceName][contractName].storageLayout.storage;
  const types = info.output.contracts[sourceName][contractName].storageLayout.types;

  return storage.map(({ label, offset, slot, type }) => ({
    label,
    slot: parseInt(slot),
    offset: parseInt(offset),
    type: types[type].label
  }));
}

/**
 * Verify that main contract and facet have aligned storage
 */
async function verifyFacetAlignment(mainFQN, facetFQN, facetName) {
  console.log(`\n--- Verifying ${facetName} alignment ---`);

  const mainLayout = await getStorageLayout(mainFQN);
  const facetLayout = await getStorageLayout(facetFQN);

  // Check key ranges
  const mainV3Vars = mainLayout.filter(v => v.slot >= 252);
  const facetV3Vars = facetLayout.filter(v => v.slot >= 252);

  console.log(`Main contract V3 storage: ${mainV3Vars.length} variables (slots 252+)`);
  console.log(`${facetName} V3 storage: ${facetV3Vars.length} variables (slots 252+)`);

  // Verify critical variables are at same slots
  const criticalVars = ['payoutData', 'multipliers', '_roles'];
  let aligned = true;

  for (const varName of criticalVars) {
    const mainVar = mainLayout.find(v => v.label === varName);
    const facetVar = facetLayout.find(v => v.label === varName);

    if (mainVar && facetVar) {
      if (mainVar.slot !== facetVar.slot) {
        console.log(`❌ MISALIGNMENT: ${varName} at slot ${mainVar.slot} in main vs slot ${facetVar.slot} in facet`);
        aligned = false;
      } else {
        console.log(`✅ ${varName} aligned at slot ${mainVar.slot}`);
      }
    }
  }

  if (aligned) {
    console.log(`✅ ${facetName} storage alignment verified`);
  } else {
    console.log(`❌ ${facetName} storage MISALIGNED - CRITICAL ERROR`);
    process.exit(1);
  }
}

async function exec() {
  const oldFullQualifiedName = "contracts/PaxosTokenV2.sol:PaxosTokenV2";
  const newFullQualifiedName = "contracts/PaxosTokenClaimableRewards.sol:PaxosTokenClaimableRewards";

  console.log("\n=== Comparing Storage Layout: V2 → V3 (ClaimableRewards) ===\n");

  const comparison = await getComparison(oldFullQualifiedName, newFullQualifiedName);

  // Filter to show only relevant entries (non-empty and changed/modified)
  const relevantEntries = comparison.filter(entry => {
    // Show all modified entries
    if (entry.changed === 'modified' && !entry.entryOld.startsWith('__gap_')) return true;
    // Show appended V3 storage
    if (entry.changed === 'append') return true;
    // Show important storage variables (AccessControl, etc)
    if (entry.entryOld && (
      entry.entryOld.includes('_roles') ||
      entry.entryOld.includes('DOMAIN_SEPARATOR') ||
      entry.entryOld.includes('_nonces') ||
      entry.entryOld.includes('_authorizationStates')
    )) return true;
    if (entry.entryNew && (
      entry.entryNew.includes('_roles') ||
      entry.entryNew.includes('DOMAIN_SEPARATOR') ||
      entry.entryNew.includes('payoutData') ||
      entry.entryNew.includes('multipliers')
    )) return true;

    return false;
  });

  console.table(relevantEntries);

  // Check for modifications
  const modifications = comparison.filter(entry =>
    entry.changed === 'modified' && !entry.entryOld.startsWith('__gap_')
  );

  if (modifications.length > 0) {
    console.log("\n❌ STORAGE LAYOUT MODIFIED - UPGRADE UNSAFE!");
    console.log("\nModified entries:");
    console.table(modifications);
    process.exit(1);
  } else {
    console.log("\n✅ STORAGE LAYOUT PRESERVED - UPGRADE SAFE!");
    console.log("\nKey findings:");

    // Find AccessControl slot
    const rolesEntry = comparison.find(e => e.entryOld && e.entryOld.includes('_roles'));
    if (rolesEntry) {
      const slot = Math.floor(rolesEntry.bytesStart / 32);
      console.log(`   • AccessControl _roles at slot ${slot} (preserved from V2)`);
    }

    // Find V3 storage start
    const firstV3Entry = comparison.find(e => e.changed === 'append');
    if (firstV3Entry) {
      const slot = Math.floor(firstV3Entry.bytesStart / 32);
      console.log(`   • V3 storage begins at slot ${slot} (after AccessControl)`);
    }

    console.log("\nAll V2 storage slots preserved. V3 storage safely appended.\n");
  }

  // DIAMOND PATTERN VERIFICATION
  console.log("\n=== Verifying Diamond Pattern Storage Alignment ===\n");

  const mainContractFQN = "contracts/PaxosTokenClaimableRewards.sol:PaxosTokenClaimableRewards";
  const facets = [
    { fqn: "contracts/facets/PayoutGroupFacet.sol:PayoutGroupFacet", name: "PayoutGroupFacet" },
    { fqn: "contracts/facets/TokenAdminFacet.sol:TokenAdminFacet", name: "TokenAdminFacet" },
    { fqn: "contracts/facets/ClaimableRewardsFacet.sol:ClaimableRewardsFacet", name: "ClaimableRewardsFacet" }
  ];

  for (const facet of facets) {
    await verifyFacetAlignment(mainContractFQN, facet.fqn, facet.name);
  }

  console.log("\n✅ ALL STORAGE VERIFICATIONS PASSED\n");
}

exec().catch(error => {
  console.error(error);
  process.exit(1);
});
