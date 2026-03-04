const { deployAllFacets, createCombinedInterface } = require('./helpers/fixtures');
const { expect } = require('chai');
const { ethers, upgrades } = require("hardhat");

/**
 * Tests for fresh deploy initialization via initialize().
 *
 * Covers:
 * - initialize() parameter validation (claimSource, rate bounds)
 * - Facets available immediately after fresh deployment
 * - Facet selector registration after initialize()
 *
 * See UpgradeUSDGToRebaseClaimsTest.js for V2→V3 upgrade path tests (initializeV3).
 */
describe('Fresh Deploy Initialization Tests', function () {

  describe('initialize() validation', function () {

    it('should revert with ZeroAddress when claimSource is zero', async function () {
      const [owner, , assetProtector] = await ethers.getSigners();
      const facets = await deployAllFacets();

      const Factory = await ethers.getContractFactory("PaxosTokenClaimableRewards");

      await expect(
        upgrades.deployProxy(Factory, [
          0,                      // initialDelay
          owner.address,          // initialOwner
          owner.address,          // pauser
          assetProtector.address, // assetProtector
          facets.facetCuts,       // FacetCut[] array
          ethers.ZeroAddress,     // claimSource - INVALID
          0,
          0,
          {                       // V3RoleAddresses struct
            multAdmin: owner.address,
            multRateAdmin: owner.address,
            payoutGroupAdmin: owner.address,
            payoutGroupRegistrar: owner.address,
            claimOperator: owner.address,
            claimAdmin: owner.address
          }
        ], {
          initializer: "initialize",
          unsafeAllow: ['missing-initializer']
        })
      ).to.be.revertedWithCustomError(Factory, 'ZeroAddress');
    });

    it('should revert with InvalidRateBounds when minRate > maxRate', async function () {
      const [owner, , assetProtector] = await ethers.getSigners();
      const facets = await deployAllFacets();

      const Factory = await ethers.getContractFactory("PaxosTokenClaimableRewards");

      await expect(
        upgrades.deployProxy(Factory, [
          0,
          owner.address,
          owner.address,
          assetProtector.address,
          facets.facetCuts,       // FacetCut[] array
          owner.address,
          100,  // minRate
          50,   // maxRate < minRate - INVALID
          {                       // V3RoleAddresses struct
            multAdmin: owner.address,
            multRateAdmin: owner.address,
            payoutGroupAdmin: owner.address,
            payoutGroupRegistrar: owner.address,
            claimOperator: owner.address,
            claimAdmin: owner.address
          }
        ], {
          initializer: "initialize",
          unsafeAllow: ['missing-initializer']
        })
      ).to.be.revertedWithCustomError(Factory, 'InvalidRateBounds');
    });

    it('should succeed with minRate == maxRate (boundary case)', async function () {
      const [owner, , assetProtector] = await ethers.getSigners();
      const facets = await deployAllFacets();

      const Factory = await ethers.getContractFactory("PaxosTokenClaimableRewards");
      const rate = ethers.parseUnits("0.05", 10); // 5% APR

      const token = await upgrades.deployProxy(Factory, [
        0,
        owner.address,
        owner.address,
        assetProtector.address,
        facets.facetCuts,       // FacetCut[] array
        owner.address,
        rate,  // minRate
        rate,  // maxRate == minRate - VALID
        {                       // V3RoleAddresses struct
          multAdmin: owner.address,
          multRateAdmin: owner.address,
          payoutGroupAdmin: owner.address,
          payoutGroupRegistrar: owner.address,
          claimOperator: owner.address,
          claimAdmin: owner.address
        }
      ], {
        initializer: "initialize",
        unsafeAllow: ['missing-initializer']
      });

      // Verify rates were set correctly
      const combinedInterface = createCombinedInterface(token, facets);
      const tokenWithFacets = new ethers.Contract(await token.getAddress(), combinedInterface, owner);
      expect(await tokenWithFacets.getMinAPR()).to.equal(rate);
      expect(await tokenWithFacets.getMaxAPR()).to.equal(rate);
    });
  });

  describe('facets work immediately after initialize()', function () {

    it('should have all facet functions available immediately after fresh deployment', async function () {
      const [owner, user, assetProtector] = await ethers.getSigners();
      const facets = await deployAllFacets();

      const Factory = await ethers.getContractFactory("PaxosTokenClaimableRewards");
      const token = await upgrades.deployProxy(Factory, [
        0,
        owner.address,
        owner.address,
        assetProtector.address,
        facets.facetCuts,       // FacetCut[] array
        owner.address,  // claimSource
        0,              // minRate
        ethers.parseUnits("0.20", 10),  // maxRate 20%
        {                       // V3RoleAddresses struct
          multAdmin: owner.address,
          multRateAdmin: owner.address,
          payoutGroupAdmin: owner.address,
          payoutGroupRegistrar: owner.address,
          claimOperator: owner.address,
          claimAdmin: owner.address
        }
      ], {
        initializer: "initialize",
        unsafeAllow: ['missing-initializer']
      });

      // Create combined interface for facet access
      const combinedInterface = createCombinedInterface(token, facets);
      const tokenWithFacets = new ethers.Contract(await token.getAddress(), combinedInterface, owner);

      // Test TokenAdminFacet functions work immediately
      expect(await tokenWithFacets.paused()).to.equal(false);
      expect(await tokenWithFacets.isFrozen(user.address)).to.equal(false);

      // Test MultiplierMgmtFacet functions work immediately
      expect(await tokenWithFacets.getClaimSource()).to.equal(owner.address);
      expect(await tokenWithFacets.getMinAPR()).to.equal(0);
      expect(await tokenWithFacets.getMaxAPR()).to.equal(ethers.parseUnits("0.20", 10));
      expect(await tokenWithFacets.getMaturityPeriod()).to.equal(86400); // Default 1 day

      // Test PayoutGroupFacet functions work immediately
      expect(await tokenWithFacets.payoutGroupIdOf(user.address)).to.equal(0);
      expect(await tokenWithFacets.availableRewardsOf(user.address)).to.equal(0);
      expect(await tokenWithFacets.isPartnerSignedRegistrationsEnabled()).to.equal(false);

      // Test TokenExtensionsFacet functions work immediately
      expect(await tokenWithFacets.nonces(user.address)).to.equal(0);
    });

  });

  describe('facet selector registration validation', function () {

    it('should register all expected facet selectors after initialize()', async function () {
      const [owner, , assetProtector] = await ethers.getSigners();
      const facets = await deployAllFacets();

      const Factory = await ethers.getContractFactory("PaxosTokenClaimableRewards");
      const token = await upgrades.deployProxy(Factory, [
        0,
        owner.address,
        owner.address,
        assetProtector.address,
        facets.facetCuts,       // FacetCut[] array
        owner.address,
        0,
        ethers.parseUnits("0.20", 10),
        {
          multAdmin: owner.address,
          multRateAdmin: owner.address,
          payoutGroupAdmin: owner.address,
          payoutGroupRegistrar: owner.address,
          claimOperator: owner.address,
          claimAdmin: owner.address
        }
      ], {
        initializer: "initialize",
        unsafeAllow: ['missing-initializer']
      });

      // Get deployed facet contract instances for selector extraction
      const tokenAdminFacet = facets.contracts.tokenAdminFacet;
      const tokenExtensionsFacet = facets.contracts.tokenExtensionsFacet;
      const claimableRewardsFacet = facets.contracts.claimableRewardsFacet;
      const multiplierMgmtFacet = facets.contracts.multiplierMgmtFacet;
      const payoutGroupFacet = facets.contracts.payoutGroupFacet;

      // Verify key selectors from each facet are properly registered
      // TokenAdminFacet selectors
      const pauseSelector = tokenAdminFacet.interface.getFunction('pause').selector;
      const isFrozenSelector = tokenAdminFacet.interface.getFunction('isFrozen').selector;
      expect(await token.facets(pauseSelector)).to.equal(facets.tokenAdmin);
      expect(await token.facets(isFrozenSelector)).to.equal(facets.tokenAdmin);

      // TokenExtensionsFacet selectors
      const noncesSelector = tokenExtensionsFacet.interface.getFunction('nonces').selector;
      expect(await token.facets(noncesSelector)).to.equal(facets.tokenExtensions);

      // ClaimableRewardsFacet selectors
      const claimAllSelector = claimableRewardsFacet.interface.getFunction('claimAll').selector;
      expect(await token.facets(claimAllSelector)).to.equal(facets.claimableRewards);

      // MultiplierMgmtFacet selectors
      const getClaimSourceSelector = multiplierMgmtFacet.interface.getFunction('getClaimSource').selector;
      const getMinAPRSelector = multiplierMgmtFacet.interface.getFunction('getMinAPR').selector;
      expect(await token.facets(getClaimSourceSelector)).to.equal(facets.multiplierMgmt);
      expect(await token.facets(getMinAPRSelector)).to.equal(facets.multiplierMgmt);

      // PayoutGroupFacet selectors
      const payoutGroupIdOfSelector = payoutGroupFacet.interface.getFunction('payoutGroupIdOf').selector;
      const createPayoutGroupSelector = payoutGroupFacet.interface.getFunction('createPayoutGroup').selector;
      expect(await token.facets(payoutGroupIdOfSelector)).to.equal(facets.payoutGroup);
      expect(await token.facets(createPayoutGroupSelector)).to.equal(facets.payoutGroup);
    });

  });
});
