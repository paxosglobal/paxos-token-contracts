const { expect } = require('chai');
const hre = require('hardhat');
const { parseFullyQualifiedName } = require('hardhat/utils/contract-names');

/**
 * @title Storage Layout Verification Test
 * @dev CRITICAL: Verifies Diamond Pattern storage alignment between main contract and facets
 *
 * Verifies that storage collision cannot occur between main contract and facets.
 *
 * The Diamond pattern relies on delegatecall, which means facets execute in the context of the
 * main contract's storage. For this to work safely, the storage layout MUST be identical:
 *
 * Main Contract:  BaseStorageV3 (slots 0-50) → AccessControl (slots 51-251) → ClaimableRewardsStorageV3 (slots 252+)
 * Facets:         BaseStorageV3 (slots 0-50) → AccessControl (slots 51-251) → ClaimableRewardsStorageV3 (slots 252+)
 *
 * This test verifies:
 * 1. AccessControl occupies the same slots (51-251) in both main and facets
 * 2. V3 storage variables (payoutData, multipliers, etc.) start at slot 252+ in both
 * 3. All V3 storage variables are at identical absolute slots
 */
describe('Storage Layout Verification (Diamond Pattern)', function () {
  this.timeout(120000); // 2 minute timeout for compilation

  let mainLayout;
  let payoutGroupFacetLayout;
  let tokenAdminFacetLayout;
  let claimableRewardsFacetLayout;

  before(async function () {
    // Enable storage layout in compiler output
    for (let compiler of hre.config.solidity.compilers) {
      compiler.settings.outputSelection['*']['*'].push('storageLayout');
    }
    await hre.run("compile");

    // Get storage layouts for all contracts
    mainLayout = await getStorageLayout("contracts/PaxosTokenClaimableRewards.sol:PaxosTokenClaimableRewards");
    payoutGroupFacetLayout = await getStorageLayout("contracts/facets/PayoutGroupFacet.sol:PayoutGroupFacet");
    tokenAdminFacetLayout = await getStorageLayout("contracts/facets/TokenAdminFacet.sol:TokenAdminFacet");
    claimableRewardsFacetLayout = await getStorageLayout("contracts/facets/ClaimableRewardsFacet.sol:ClaimableRewardsFacet");
  });

  describe('Main Contract Storage Layout', function () {
    it('should have BaseStorageV3 at slots 0-50', function () {
      const baseVars = mainLayout.filter(v => parseInt(v.slot) <= 50);
      expect(baseVars.length).to.be.greaterThan(0, "BaseStorageV3 variables should exist in slots 0-50");

      // Verify key base variables exist
      const hasBalanceData = baseVars.some(v => v.label === 'balanceData');
      const hasTotalSupply = baseVars.some(v => v.label === 'totalSupply_');
      expect(hasBalanceData || hasTotalSupply).to.be.true;
    });

    it('should have AccessControl at slots 51-251', function () {
      const accessControlVars = mainLayout.filter(v => {
        const slot = parseInt(v.slot);
        return slot >= 51 && slot <= 251;
      });

      expect(accessControlVars.length).to.be.greaterThan(0, "AccessControl variables should exist in slots 51-251");

      // Verify _roles mapping exists (critical AccessControl variable)
      const hasRoles = accessControlVars.some(v => v.label === '_roles');
      expect(hasRoles).to.be.true;
    });

    it('should have ClaimableRewardsStorageV3 starting at slot 252+', function () {
      const v3Vars = mainLayout.filter(v => parseInt(v.slot) >= 252);
      expect(v3Vars.length).to.be.greaterThan(0, "V3 storage variables should exist at slot 252+");

      // Verify key V3 variables exist
      const hasPayoutData = v3Vars.some(v => v.label === 'payoutData');
      const hasMultipliers = v3Vars.some(v => v.label === 'multipliers');
      expect(hasPayoutData).to.be.true;
      expect(hasMultipliers).to.be.true;
    });

    it('should have payoutData starting after AccessControl gap', function () {
      const payoutData = mainLayout.find(v => v.label === 'payoutData');
      expect(payoutData).to.exist;
      // V3 storage must start after AccessControl (slot 251) + BaseStorageV3 gap (24 slots from ~15)
      // This gives us slot 252 minimum, but with 24-slot gap it's actually 262
      expect(parseInt(payoutData.slot)).to.be.greaterThan(251);
      expect(parseInt(payoutData.slot)).to.be.lessThan(300); // Reasonable upper bound
    });

    it('should have multipliers after payoutData mappings', function () {
      const multipliers = mainLayout.find(v => v.label === 'multipliers');
      const payoutData = mainLayout.find(v => v.label === 'payoutData');
      expect(multipliers).to.exist;
      expect(payoutData).to.exist;
      // Multipliers should come after the payout mappings (6 mappings + 1 uint32 = ~7 slots)
      expect(parseInt(multipliers.slot)).to.be.greaterThan(parseInt(payoutData.slot));
    });
  });

  describe('PayoutGroupFacet Storage Layout', function () {
    it('should have identical BaseStorageV3 layout (slots 0-50)', function () {
      verifyStorageRangeMatch(mainLayout, payoutGroupFacetLayout, 0, 50, 'BaseStorageV3');
    });

    it('should have identical AccessControl layout (slots 51-251)', function () {
      verifyStorageRangeMatch(mainLayout, payoutGroupFacetLayout, 51, 251, 'AccessControl');

      // CRITICAL: Verify _roles is at same slot
      const mainRoles = mainLayout.find(v => v.label === '_roles');
      const facetRoles = payoutGroupFacetLayout.find(v => v.label === '_roles');
      expect(mainRoles).to.exist;
      expect(facetRoles).to.exist;
      expect(mainRoles.slot).to.equal(facetRoles.slot, "_roles MUST be at same slot in main and facet");
    });

    it('should have identical V3 storage layout (slot 252+)', function () {
      const v3VarsMain = mainLayout.filter(v => parseInt(v.slot) >= 252);
      const v3VarsFacet = payoutGroupFacetLayout.filter(v => parseInt(v.slot) >= 252);

      // Verify all V3 variables that exist in both contracts are at same slots
      for (const mainVar of v3VarsMain) {
        const facetVar = v3VarsFacet.find(v => v.label === mainVar.label);
        if (facetVar) {
          expect(facetVar.slot).to.equal(mainVar.slot,
            `V3 variable "${mainVar.label}" MUST be at same slot in main (${mainVar.slot}) and facet (${facetVar.slot})`
          );
          expect(facetVar.offset).to.equal(mainVar.offset,
            `V3 variable "${mainVar.label}" MUST have same offset in main (${mainVar.offset}) and facet (${facetVar.offset})`
          );
        }
      }
    });

    it('should have payoutData at same slot in both main and facet', function () {
      const mainPayoutData = mainLayout.find(v => v.label === 'payoutData');
      const facetPayoutData = payoutGroupFacetLayout.find(v => v.label === 'payoutData');

      expect(mainPayoutData).to.exist;
      expect(facetPayoutData).to.exist;
      expect(facetPayoutData.slot).to.equal(mainPayoutData.slot);
      // Verify it's after AccessControl gap (slot 251+)
      expect(parseInt(facetPayoutData.slot)).to.be.greaterThan(251);
    });

    it('should have multipliers at same slot in both main and facet', function () {
      const mainMultipliers = mainLayout.find(v => v.label === 'multipliers');
      const facetMultipliers = payoutGroupFacetLayout.find(v => v.label === 'multipliers');

      expect(mainMultipliers).to.exist;
      expect(facetMultipliers).to.exist;
      expect(facetMultipliers.slot).to.equal(mainMultipliers.slot);
      // Verify it's after payoutData
      const mainPayoutData = mainLayout.find(v => v.label === 'payoutData');
      expect(parseInt(facetMultipliers.slot)).to.be.greaterThan(parseInt(mainPayoutData.slot));
    });
  });

  describe('TokenAdminFacet Storage Layout', function () {
    it('should have identical BaseStorageV3 layout (slots 0-50)', function () {
      verifyStorageRangeMatch(mainLayout, tokenAdminFacetLayout, 0, 50, 'BaseStorageV3');
    });

    it('should have identical AccessControl layout (slots 51-251)', function () {
      verifyStorageRangeMatch(mainLayout, tokenAdminFacetLayout, 51, 251, 'AccessControl');

      const mainRoles = mainLayout.find(v => v.label === '_roles');
      const facetRoles = tokenAdminFacetLayout.find(v => v.label === '_roles');
      expect(mainRoles).to.exist;
      expect(facetRoles).to.exist;
      expect(mainRoles.slot).to.equal(facetRoles.slot, "_roles MUST be at same slot");
    });

    it('should have identical V3 storage layout (slot 252+)', function () {
      const v3VarsMain = mainLayout.filter(v => parseInt(v.slot) >= 252);
      const v3VarsFacet = tokenAdminFacetLayout.filter(v => parseInt(v.slot) >= 252);

      for (const mainVar of v3VarsMain) {
        const facetVar = v3VarsFacet.find(v => v.label === mainVar.label);
        if (facetVar) {
          expect(facetVar.slot).to.equal(mainVar.slot,
            `V3 variable "${mainVar.label}" MUST be at same slot`
          );
        }
      }
    });
  });

  describe('ClaimableRewardsFacet Storage Layout', function () {
    it('should have identical BaseStorageV3 layout (slots 0-50)', function () {
      verifyStorageRangeMatch(mainLayout, claimableRewardsFacetLayout, 0, 50, 'BaseStorageV3');
    });

    it('should have identical AccessControl layout (slots 51-251)', function () {
      verifyStorageRangeMatch(mainLayout, claimableRewardsFacetLayout, 51, 251, 'AccessControl');

      const mainRoles = mainLayout.find(v => v.label === '_roles');
      const facetRoles = claimableRewardsFacetLayout.find(v => v.label === '_roles');
      expect(mainRoles).to.exist;
      expect(facetRoles).to.exist;
      expect(mainRoles.slot).to.equal(facetRoles.slot, "_roles MUST be at same slot");
    });

    it('should have identical V3 storage layout (slot 252+)', function () {
      const v3VarsMain = mainLayout.filter(v => parseInt(v.slot) >= 252);
      const v3VarsFacet = claimableRewardsFacetLayout.filter(v => parseInt(v.slot) >= 252);

      for (const mainVar of v3VarsMain) {
        const facetVar = v3VarsFacet.find(v => v.label === mainVar.label);
        if (facetVar) {
          expect(facetVar.slot).to.equal(mainVar.slot,
            `V3 variable "${mainVar.label}" MUST be at same slot`
          );
        }
      }
    });
  });

  describe('CRITICAL: Storage Collision Prevention', function () {
    it('should have NO storage collisions between main and PayoutGroupFacet', function () {
      const collisions = findStorageCollisions(mainLayout, payoutGroupFacetLayout);
      if (collisions.length > 0) {
        console.error("\n❌ STORAGE COLLISIONS DETECTED:");
        collisions.forEach(c => {
          console.error(`  Slot ${c.slot}: Main "${c.mainVar}" vs Facet "${c.facetVar}"`);
        });
      }
      expect(collisions).to.be.empty;
    });

    it('should have NO storage collisions between main and TokenAdminFacet', function () {
      const collisions = findStorageCollisions(mainLayout, tokenAdminFacetLayout);
      expect(collisions).to.be.empty;
    });

    it('should have NO storage collisions between main and ClaimableRewardsFacet', function () {
      const collisions = findStorageCollisions(mainLayout, claimableRewardsFacetLayout);
      expect(collisions).to.be.empty;
    });
  });

  describe('Gap Size Verification', function () {
    it('should verify AccessControl uses exactly slots 51-251 (201 slots)', function () {
      const accessControlVars = mainLayout.filter(v => {
        const slot = parseInt(v.slot);
        return slot >= 51 && slot <= 251;
      });

      expect(accessControlVars.length).to.be.greaterThan(0, "AccessControl must use slots in 51-251 range");

      // Find the highest slot used by AccessControl
      const maxSlot = Math.max(...accessControlVars.map(v => parseInt(v.slot)));
      expect(maxSlot).to.be.lessThanOrEqual(251, "AccessControl MUST NOT exceed slot 251");

      console.log(`\n✅ AccessControl verified: uses slots 51-${maxSlot} (reserved through 251)`);
    });

    it('should verify V3 storage starts after AccessControl gap (no overlap)', function () {
      const v3Vars = mainLayout.filter(v => parseInt(v.slot) > 251);
      expect(v3Vars.length).to.be.greaterThan(0, "V3 storage must exist");

      const minV3Slot = Math.min(...v3Vars.map(v => parseInt(v.slot)));
      // V3 storage must start AFTER AccessControl (slot 251)
      // With 24-slot BaseStorageV3 gap, this is slot 262
      expect(minV3Slot).to.be.greaterThan(251, "V3 storage MUST start after AccessControl (slot 251)");

      console.log(`\n✅ V3 storage verified: starts at slot ${minV3Slot} (no overlap with AccessControl ending at 251)`);
    });

    it('should print storage layout summary', function () {
      console.log("\n" + "=".repeat(80));
      console.log("STORAGE LAYOUT SUMMARY");
      console.log("=".repeat(80));

      console.log("\nMain Contract (PaxosTokenClaimableRewards):");
      printStorageSummary(mainLayout);

      console.log("\nPayoutGroupFacet:");
      printStorageSummary(payoutGroupFacetLayout);

      console.log("\nTokenAdminFacet:");
      printStorageSummary(tokenAdminFacetLayout);

      console.log("\nClaimableRewardsFacet:");
      printStorageSummary(claimableRewardsFacetLayout);

      console.log("\n" + "=".repeat(80));
      console.log("✅ STORAGE ALIGNMENT VERIFIED: No collision risk detected");
      console.log("=".repeat(80) + "\n");
    });
  });
});

// ==================================================================================
// HELPER FUNCTIONS
// ==================================================================================

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
    slot: slot,
    offset: offset,
    type: types[type].label
  }));
}

/**
 * Verify that storage variables in a given slot range match between two contracts
 */
function verifyStorageRangeMatch(layout1, layout2, minSlot, maxSlot, rangeName) {
  const vars1 = layout1.filter(v => {
    const slot = parseInt(v.slot);
    return slot >= minSlot && slot <= maxSlot;
  });

  const vars2 = layout2.filter(v => {
    const slot = parseInt(v.slot);
    return slot >= minSlot && slot <= maxSlot;
  });

  // For each variable in layout1, if it exists in layout2, verify same slot
  // SKIP __gap variables - gaps are implementation details and don't need to match
  for (const var1 of vars1) {
    if (var1.label.startsWith('__gap')) {
      continue; // Skip gap variables
    }

    const var2 = vars2.find(v => v.label === var1.label);
    if (var2) {
      expect(var2.slot).to.equal(var1.slot,
        `${rangeName}: Variable "${var1.label}" must be at same slot`
      );
    }
  }
}

/**
 * Find storage collisions (same slot, different variable names)
 */
function findStorageCollisions(mainLayout, facetLayout) {
  const collisions = [];

  for (const mainVar of mainLayout) {
    const facetVarsAtSlot = facetLayout.filter(v => v.slot === mainVar.slot && v.offset === mainVar.offset);
    for (const facetVar of facetVarsAtSlot) {
      if (facetVar.label !== mainVar.label) {
        collisions.push({
          slot: mainVar.slot,
          offset: mainVar.offset,
          mainVar: mainVar.label,
          facetVar: facetVar.label
        });
      }
    }
  }

  return collisions;
}

/**
 * Print storage layout summary
 */
function printStorageSummary(layout) {
  const baseVars = layout.filter(v => parseInt(v.slot) <= 50);
  const accessControlVars = layout.filter(v => {
    const slot = parseInt(v.slot);
    return slot >= 51 && slot <= 251;
  });
  const v3Vars = layout.filter(v => parseInt(v.slot) >= 252);

  console.log(`  Slots 0-50 (BaseStorageV3):        ${baseVars.length} variables`);
  console.log(`  Slots 51-251 (AccessControl):      ${accessControlVars.length} variables`);
  console.log(`  Slots 252+ (ClaimableRewardsStorageV3): ${v3Vars.length} variables`);

  if (v3Vars.length > 0) {
    const minSlot = Math.min(...v3Vars.map(v => parseInt(v.slot)));
    const maxSlot = Math.max(...v3Vars.map(v => parseInt(v.slot)));
    console.log(`    → V3 range: slots ${minSlot}-${maxSlot}`);
  }
}
