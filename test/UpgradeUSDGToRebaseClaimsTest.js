const { deployUSDGv2Fixture, deployAllFacets, createCombinedInterface } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect, assert } = require('chai');
const { ethers, upgrades } = require("hardhat");
const { isStorageLayoutModified } = require('./helpers/storageLayout');

/**
 * Encode initializeV3 call data for atomic upgrade.
 * @param {Object} implContract - The deployed V3 implementation contract
 * @param {Object} facets - Deployed facets from deployAllFacets() (includes facetCuts)
 * @param {string} adminAddress - Address to use for claimSource and all V3 roles
 * @param {bigint} minRate - Minimum APR bound (default 0)
 * @param {bigint} maxRate - Maximum APR bound (default 0)
 */
function encodeInitializeV3(implContract, facets, adminAddress, minRate = 0, maxRate = 0) {
  return implContract.interface.encodeFunctionData('initializeV3', [
    facets.facetCuts,
    adminAddress,
    minRate,
    maxRate,
    {
      multAdmin: adminAddress,
      multRateAdmin: adminAddress,
      payoutGroupAdmin: adminAddress,
      payoutGroupRegistrar: adminAddress,
      claimOperator: adminAddress,
      claimAdmin: adminAddress
    }
  ]);
}

// Testing the upgrade from USDG V2 (PaxosTokenV2-based) to USDG V3 (PaxosTokenClaimableRewards-based)
// CRITICAL: This V2→V3 upgrade migrates frozen state storage format:
//   V2: mapping(address => bool) internal frozen
//   V3: mapping(address => uint8) internal tokenAccountFlags (bit-packed: bit 0 = isFrozen, bit 1 = isRewardSource)
// Goals:
// 1. Verify existing state (balances, roles, totalSupply) is preserved
// 2. Verify new rebase functionality works after upgrade
// 3. Verify facets are properly registered
describe('Upgrade USDG to ClaimableRewards', function () {
  let owner, admin, recipient, assetProtectionRole, acc, acc2, acc3;
  let supply, amount, subAmount;

  beforeEach(async function () {
    [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();

    supply = ethers.parseUnits("1000", 6); // 1000 USDG (6 decimals)
    amount = ethers.parseUnits("100", 6);
    subAmount = ethers.parseUnits("10", 6);

    // Deploy old USDG (V2-based)
    const fixture = await loadFixture(deployUSDGv2Fixture);
    this.token = fixture.token;
    this.supplyControl = fixture.supplyControl;

    // Set up test data on V2 contract before upgrade
    await this.token.connect(owner).increaseSupply(supply);
    await this.token.connect(owner).transfer(acc.address, amount);
    await this.token.connect(owner).transfer(acc2.address, amount);

    // Make an approval
    await this.token.connect(acc).approve(acc3.address, subAmount);

    // Capture state before upgrade
    this.preUpgradeOwnerBalance = await this.token.balanceOf(owner.address);
    this.preUpgradeAccBalance = await this.token.balanceOf(acc.address);
    this.preUpgradeAcc2Balance = await this.token.balanceOf(acc2.address);
    this.preUpgradeTotalSupply = await this.token.totalSupply();
    this.preUpgradeApproval = await this.token.allowance(acc.address, acc3.address);
    this.preUpgradePaused = await this.token.paused();

    // Capture EIP712 and metadata state (for additional validation)
    this.preUpgradeDomainSeparator = await this.token.DOMAIN_SEPARATOR();
    this.preUpgradeName = await this.token.name();
    this.preUpgradeSymbol = await this.token.symbol();
    this.preUpgradeDecimals = await this.token.decimals();

    // Capture AccessControl role state
    this.DEFAULT_ADMIN_ROLE = await this.token.DEFAULT_ADMIN_ROLE();
    this.preUpgradeOwnerHasAdmin = await this.token.hasRole(this.DEFAULT_ADMIN_ROLE, owner.address);
    this.preUpgradeDefaultAdmin = await this.token.defaultAdmin();
  });

  it('preserves balances and state during upgrade', async function () {
    // Deploy all facets first (can be done in advance)
    const facets = await deployAllFacets();

    // Deploy new USDG implementation (ClaimableRewards-based)
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    // Atomic upgrade: upgradeToAndCall with initializeV3 including facet addresses
    // This registers all facets in the same transaction as initialization
    const initData = encodeInitializeV3(newImplementation, facets, owner.address);

    await this.token.connect(owner).upgradeToAndCall(await newImplementation.getAddress(), initData);

    // Attach new interface with all facets
    const combinedInterface = createCombinedInterface(USDGFactory.attach(await this.token.getAddress()), facets);
    this.token = new ethers.Contract(await this.token.getAddress(), combinedInterface, owner);

    // Verify state preservation (basic token functions)
    expect(await this.token.balanceOf(owner.address)).to.equal(this.preUpgradeOwnerBalance);
    expect(await this.token.balanceOf(acc.address)).to.equal(this.preUpgradeAccBalance);
    expect(await this.token.balanceOf(acc2.address)).to.equal(this.preUpgradeAcc2Balance);
    expect(await this.token.totalSupply()).to.equal(this.preUpgradeTotalSupply);
    expect(await this.token.allowance(acc.address, acc3.address)).to.equal(this.preUpgradeApproval);
    expect(await this.token.paused()).to.equal(this.preUpgradePaused);

    // Verify balanceData struct fields are zero (no payout groups or rewards before upgrade)
    expect(await this.token.payoutGroupIdOf(owner.address)).to.equal(0, "owner should have no payout group");
    expect(await this.token.payoutGroupIdOf(acc.address)).to.equal(0, "acc should have no payout group");
    expect(await this.token.payoutGroupIdOf(acc2.address)).to.equal(0, "acc2 should have no payout group");
    expect(await this.token.availableRewardsOf(owner.address)).to.equal(0, "owner should have no rewards");
    expect(await this.token.availableRewardsOf(acc.address)).to.equal(0, "acc should have no rewards");
    expect(await this.token.availableRewardsOf(acc2.address)).to.equal(0, "acc2 should have no rewards");

    // Verify EIP712 DOMAIN_SEPARATOR preserved (critical for EIP2612/EIP3009 compatibility)
    expect(await this.token.DOMAIN_SEPARATOR()).to.equal(
      this.preUpgradeDomainSeparator,
      "DOMAIN_SEPARATOR must be preserved for EIP712/EIP2612/EIP3009 compatibility"
    );

    // Verify token metadata preserved
    expect(await this.token.name()).to.equal(this.preUpgradeName, "Token name must be preserved");
    expect(await this.token.symbol()).to.equal(this.preUpgradeSymbol, "Token symbol must be preserved");
    expect(await this.token.decimals()).to.equal(this.preUpgradeDecimals, "Token decimals must be preserved");

    // Verify AccessControl roles preserved (critical for security)
    expect(await this.token.hasRole(this.DEFAULT_ADMIN_ROLE, owner.address)).to.equal(
      this.preUpgradeOwnerHasAdmin,
      "Owner DEFAULT_ADMIN_ROLE must be preserved (critical for security)"
    );
    expect(await this.token.defaultAdmin()).to.equal(
      this.preUpgradeDefaultAdmin,
      "Default admin address must be preserved"
    );
  });

  it('allows transfers after upgrade', async function () {
    // Deploy all facets first
    const facets = await deployAllFacets();

    // Upgrade atomically
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    const tokenAddress = await this.token.getAddress();
    const initData = encodeInitializeV3(newImplementation, facets, owner.address);
    await this.token.connect(owner).upgradeToAndCall(await newImplementation.getAddress(), initData);
    this.token = USDGFactory.attach(tokenAddress).connect(owner);

    // Test transfer still works
    const transferAmount = ethers.parseUnits("5", 6);
    const accBalanceBefore = await this.token.balanceOf(acc.address);
    const acc2BalanceBefore = await this.token.balanceOf(acc2.address);

    await this.token.connect(acc).transfer(acc2.address, transferAmount);

    expect(await this.token.balanceOf(acc.address)).to.equal(accBalanceBefore - transferAmount);
    expect(await this.token.balanceOf(acc2.address)).to.equal(acc2BalanceBefore + transferAmount);
  });

  it('allows mint/burn after upgrade', async function () {
    // Deploy all facets first
    const facets = await deployAllFacets();

    // Upgrade atomically
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    const tokenAddress = await this.token.getAddress();
    const initData = encodeInitializeV3(newImplementation, facets, owner.address);
    await this.token.connect(owner).upgradeToAndCall(await newImplementation.getAddress(), initData);
    this.token = USDGFactory.attach(tokenAddress).connect(owner);

    // Test mint
    const mintAmount = ethers.parseUnits("50", 6);
    const totalSupplyBefore = await this.token.totalSupply();
    const ownerBalanceBefore = await this.token.balanceOf(owner.address);

    await this.token.connect(owner).increaseSupply(mintAmount);

    expect(await this.token.totalSupply()).to.equal(totalSupplyBefore + mintAmount);
    expect(await this.token.balanceOf(owner.address)).to.equal(ownerBalanceBefore + mintAmount);

    // Test burn
    const burnAmount = ethers.parseUnits("25", 6);
    const totalSupplyAfterMint = await this.token.totalSupply();
    const ownerBalanceAfterMint = await this.token.balanceOf(owner.address);

    await this.token.connect(owner).decreaseSupply(burnAmount);

    expect(await this.token.totalSupply()).to.equal(totalSupplyAfterMint - burnAmount);
    expect(await this.token.balanceOf(owner.address)).to.equal(ownerBalanceAfterMint - burnAmount);
  });

  it('rejects upgrade from non-admin', async function () {
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    // Should revert when non-admin tries to upgrade
    await expect(
      this.token.connect(acc).upgradeTo(await newImplementation.getAddress())
    ).to.be.reverted;
  });

  it('facet functions work IMMEDIATELY after atomic initializeV3', async function () {
    // This test verifies the key benefit of atomic upgrade:
    // Facet functions are available in the same transaction, with no gap

    // Deploy all facets first (can be done in advance)
    const facets = await deployAllFacets();

    // Deploy new implementation
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    // Atomic upgrade with facet registration
    const initData = encodeInitializeV3(newImplementation, facets, owner.address, 0, ethers.parseUnits("1", 10));

    await this.token.connect(owner).upgradeToAndCall(await newImplementation.getAddress(), initData);

    // Attach interface with facets
    const combinedInterface = createCombinedInterface(USDGFactory.attach(await this.token.getAddress()), facets);
    this.token = new ethers.Contract(await this.token.getAddress(), combinedInterface, owner);

    // CRITICAL: Verify facet functions work IMMEDIATELY (no separate registration needed)
    // TokenAdminFacet functions
    expect(await this.token.paused()).to.equal(false, "paused() should work immediately");
    expect(await this.token.isFrozen(acc.address)).to.equal(false, "isFrozen() should work immediately");

    // MultiplierMgmtFacet functions
    expect(await this.token.getClaimSource()).to.equal(owner.address, "getClaimSource() should work immediately");
    expect(await this.token.getMinAPR()).to.equal(0, "getMinAPR() should work immediately");
    expect(await this.token.getMaxAPR()).to.equal(ethers.parseUnits("1", 10), "getMaxAPR() should return configured value");

    // PayoutGroupFacet functions
    expect(await this.token.payoutGroupIdOf(acc.address)).to.equal(0, "payoutGroupIdOf() should work immediately");
    expect(await this.token.availableRewardsOf(acc.address)).to.equal(0, "availableRewardsOf() should work immediately");

    // TokenExtensionsFacet functions
    expect(await this.token.nonces(acc.address)).to.equal(0, "nonces() should work immediately");
  });

  it('preserves frozen state during upgrade with bit-packed flags', async function () {
    // CRITICAL TEST: Verifies that bool frozen mapping correctly migrates to uint8 tokenAccountFlags
    // Old: mapping(address => bool) internal frozen
    // New: mapping(address => uint8) internal tokenAccountFlags (bit 0 = isFrozen)

    // Freeze two accounts BEFORE upgrade
    await this.token.connect(assetProtectionRole).freeze(acc.address);
    await this.token.connect(assetProtectionRole).freeze(acc2.address);

    // Capture frozen states before upgrade
    expect(await this.token.isFrozen(acc.address)).to.equal(true);
    expect(await this.token.isFrozen(acc2.address)).to.equal(true);
    expect(await this.token.isFrozen(acc3.address)).to.equal(false);

    // Deploy all facets first
    const facets = await deployAllFacets();

    // Upgrade atomically
    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImplementation = await USDGFactory.deploy();
    await newImplementation.waitForDeployment();

    const initData = encodeInitializeV3(newImplementation, facets, owner.address);
    await this.token.connect(owner).upgradeToAndCall(await newImplementation.getAddress(), initData);

    // Attach new interface with all facets
    const combinedInterface = createCombinedInterface(USDGFactory.attach(await this.token.getAddress()), facets);
    this.token = new ethers.Contract(await this.token.getAddress(), combinedInterface, owner);

    // CRITICAL VERIFICATION: Frozen states must be preserved after upgrade
    // This verifies that bool (0/1) is preserved in frozen mapping
    expect(await this.token.isFrozen(acc.address)).to.equal(true, "acc should remain frozen after upgrade");
    expect(await this.token.isFrozen(acc2.address)).to.equal(true, "acc2 should remain frozen after upgrade");
    expect(await this.token.isFrozen(acc3.address)).to.equal(false, "acc3 should remain unfrozen after upgrade");
  });

  it('should revert when initializeV3 called twice (reinitializer guard)', async function () {
    const facets = await deployAllFacets();

    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImpl = await USDGFactory.deploy();
    await newImpl.waitForDeployment();

    // First call via upgradeToAndCall should succeed
    const initData = encodeInitializeV3(newImpl, facets, owner.address);
    await this.token.connect(owner).upgradeToAndCall(await newImpl.getAddress(), initData);

    // Second call should fail (reinitializer prevents re-initialization)
    const v3Token = USDGFactory.attach(await this.token.getAddress());
    await expect(
      v3Token.connect(owner).initializeV3(
        facets.facetCuts,
        owner.address, 0, 0,
        {
          multAdmin: owner.address,
          multRateAdmin: owner.address,
          payoutGroupAdmin: owner.address,
          payoutGroupRegistrar: owner.address,
          claimOperator: owner.address,
          claimAdmin: owner.address
        }
      )
    ).to.be.reverted;
  });

  it('should register all expected facet selectors after initializeV3()', async function () {
    const facets = await deployAllFacets();

    const USDGFactory = await ethers.getContractFactory("USDG");
    const newImpl = await USDGFactory.deploy();
    await newImpl.waitForDeployment();

    const initData = encodeInitializeV3(newImpl, facets, owner.address, 0, ethers.parseUnits("0.10", 10));
    await this.token.connect(owner).upgradeToAndCall(await newImpl.getAddress(), initData);

    const v3Token = USDGFactory.attach(await this.token.getAddress());

    // Verify key selectors from each facet are properly registered
    const tokenAdminFacet = facets.contracts.tokenAdminFacet;
    const tokenExtensionsFacet = facets.contracts.tokenExtensionsFacet;
    const multiplierMgmtFacet = facets.contracts.multiplierMgmtFacet;
    const payoutGroupFacet = facets.contracts.payoutGroupFacet;

    const pauseSelector = tokenAdminFacet.interface.getFunction('pause').selector;
    expect(await v3Token.facets(pauseSelector)).to.equal(facets.tokenAdmin);

    const noncesSelector = tokenExtensionsFacet.interface.getFunction('nonces').selector;
    expect(await v3Token.facets(noncesSelector)).to.equal(facets.tokenExtensions);

    const getClaimSourceSelector = multiplierMgmtFacet.interface.getFunction('getClaimSource').selector;
    expect(await v3Token.facets(getClaimSourceSelector)).to.equal(facets.multiplierMgmt);

    const payoutGroupIdOfSelector = payoutGroupFacet.interface.getFunction('payoutGroupIdOf').selector;
    expect(await v3Token.facets(payoutGroupIdOfSelector)).to.equal(facets.payoutGroup);
  });

  it('has intentionally modified storage layout for packed struct and bit-packed flags', async function () {
    this.timeout(120000); // 2 minute timeout for storage layout comparison
    const oldFullQualifiedName = "contracts/archive/USDGv2.sol:USDGv2";
    const newFullQualifiedName = "contracts/stablecoins/USDG.sol:USDG";

    // V2→V3 upgrade intentionally modifies storage for optimization:
    // - balances (uint256) → balanceData (struct TokenAccountData) - slot 1
    // - frozen (bool) → tokenAccountFlags (uint8 bit-packed) - slot 6
    // Similar to V1→V2 upgrade, storage layout is modified but data is preserved via slot-level reinterpretation
    assert.isTrue(await isStorageLayoutModified(oldFullQualifiedName, newFullQualifiedName),
      "V2→V3 upgrade intentionally modifies storage layout for packed structs and bit-packed flags");
  });
});
