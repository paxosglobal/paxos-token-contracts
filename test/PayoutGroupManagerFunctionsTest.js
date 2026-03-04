const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('PayoutGroup Manager Functions', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

    // Grant necessary roles
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Get additional signers
    const signers = await ethers.getSigners();
    this.claimer = this.acc;
    this.manager = this.acc2;
    this.newClaimer = this.acc3;
    this.newManager = signers[7] || (await ethers.Wallet.createRandom().connect(ethers.provider));
    this.newDestination = signers[8] || (await ethers.Wallet.createRandom().connect(ethers.provider));

    // Setup multiplier with bounds before creating payout group
    await setupMultiplierWithBounds(this);

    // Create payout group
    this.payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

    // Set manager for the payout group
    await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.manager.address);
  });

  describe('setPayoutGroupClaimer', function() {
    it('should allow manager to change claimer', async function() {
      const oldClaimer = await this.token.getPayoutGroupClaimer(this.payoutGroupId);
      expect(oldClaimer).to.equal(this.claimer.address);

      await expect(this.token.connect(this.manager).setPayoutGroupClaimer(this.payoutGroupId, this.newClaimer.address))
        .to.emit(this.token, 'PayoutClaimerUpdated')
        .withArgs(this.payoutGroupId, this.claimer.address, this.newClaimer.address);

      const newClaimerAddr = await this.token.getPayoutGroupClaimer(this.payoutGroupId);
      expect(newClaimerAddr).to.equal(this.newClaimer.address);
    });

    it('should revert when non-manager tries to change claimer', async function() {
      await expect(this.token.connect(this.claimer).setPayoutGroupClaimer(this.payoutGroupId, this.newClaimer.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should revert when setting zero address as claimer', async function() {
      const { ZeroAddress } = require("hardhat").ethers;
      await expect(this.token.connect(this.manager).setPayoutGroupClaimer(this.payoutGroupId, ZeroAddress))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('setPayoutGroupManager', function() {
    it('should allow manager to change manager', async function() {
      const oldManager = await this.token.getPayoutGroupManager(this.payoutGroupId);
      expect(oldManager).to.equal(this.manager.address);

      await expect(this.token.connect(this.manager).setPayoutGroupManager(this.payoutGroupId, this.newManager.address))
        .to.emit(this.token, 'PayoutGroupManagerSet')
        .withArgs(this.payoutGroupId, this.manager.address, this.newManager.address);

      const newManagerAddr = await this.token.getPayoutGroupManager(this.payoutGroupId);
      expect(newManagerAddr).to.equal(this.newManager.address);
    });

    it('should allow manager to remove manager (set to zero address)', async function() {
      const { ZeroAddress } = require("hardhat").ethers;

      await expect(this.token.connect(this.manager).setPayoutGroupManager(this.payoutGroupId, ZeroAddress))
        .to.emit(this.token, 'PayoutGroupManagerSet')
        .withArgs(this.payoutGroupId, this.manager.address, ZeroAddress);

      const managerAddr = await this.token.getPayoutGroupManager(this.payoutGroupId);
      expect(managerAddr).to.equal(ZeroAddress);
    });

    it('should revert when non-manager tries to change manager', async function() {
      await expect(this.token.connect(this.claimer).setPayoutGroupManager(this.payoutGroupId, this.newManager.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('setPayoutGroupDestination', function() {
    it('should allow manager to set destination', async function() {
      const { ZeroAddress } = require("hardhat").ethers;

      // Initially destination is not set (defaults to claimer)
      const oldDestination = await this.token.getPayoutGroupDestination(this.payoutGroupId);
      expect(oldDestination).to.equal(this.claimer.address); // Defaults to claimer

      await expect(this.token.connect(this.manager).setPayoutGroupDestination(this.payoutGroupId, this.newDestination.address))
        .to.emit(this.token, 'PayoutGroupDestinationSet')
        .withArgs(this.payoutGroupId, ZeroAddress, this.newDestination.address);

      const newDestinationAddr = await this.token.getPayoutGroupDestination(this.payoutGroupId);
      expect(newDestinationAddr).to.equal(this.newDestination.address);
    });

    it('should allow manager to reset destination to default (zero address defaults to claimer)', async function() {
      const { ZeroAddress } = require("hardhat").ethers;

      // First set a destination
      await this.token.connect(this.manager).setPayoutGroupDestination(this.payoutGroupId, this.newDestination.address);

      // Then reset it to zero address
      await expect(this.token.connect(this.manager).setPayoutGroupDestination(this.payoutGroupId, ZeroAddress))
        .to.emit(this.token, 'PayoutGroupDestinationSet')
        .withArgs(this.payoutGroupId, this.newDestination.address, ZeroAddress);

      const destination = await this.token.getPayoutGroupDestination(this.payoutGroupId);
      expect(destination).to.equal(this.claimer.address); // Defaults to claimer
    });

    it('should revert when non-manager tries to change destination', async function() {
      await expect(this.token.connect(this.claimer).setPayoutGroupDestination(this.payoutGroupId, this.newDestination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('isPartnerSignedRegistrationsEnabled', function() {
    it('should return true when partner signed registrations are enabled', async function() {
      await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(true);

      const enabled = await this.token.isPartnerSignedRegistrationsEnabled();
      expect(enabled).to.be.true;
    });

    it('should return false when partner signed registrations are disabled', async function() {
      await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(false);

      const enabled = await this.token.isPartnerSignedRegistrationsEnabled();
      expect(enabled).to.be.false;
    });
  });
});
