const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, createPayoutGroupWithRoles, setupMultiplierWithBounds, mintAndTransfer, registerAccount, setupClaimSource } = require('./helpers/testSetup');

/**
 * Consolidated Payout Group Admin Tests
 *
 * This file consolidates tests from:
 * - PayoutGroupCreationTest.js
 * - PayoutGroupAdminTest.js
 *
 * Organized into sections:
 * 1. Payout Group Creation
 * 2. Admin Functions (adminSetPayoutGroupClaimer)
 */
describe('Payout Group Admin Tests (Consolidated)', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Setup multiplier before any payout group creation
    await setupMultiplierWithBounds(this);

    // Get signers for tests
    const signers = await ethers.getSigners();
    this.claimer = this.acc;
    this.newClaimer = this.acc2;
    this.anotherClaimer = this.acc3;
  });

  // ===========================================================================
  // SECTION 1: PAYOUT GROUP CREATION
  // ===========================================================================
  describe('Payout Group Creation', function () {
    describe('Error Cases', function () {
      it('should reject creation with non-existent multiplier ID', async function () {
        await expect(
          this.token.connect(this.owner).createPayoutGroup(999, this.acc.address)
        ).to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound');
      });

      it('should reject creation with zero claimer address', async function () {
        await expect(
          this.token.connect(this.owner).createPayoutGroup(1, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should reject creation by non-registrar', async function () {
        await expect(
          this.token.connect(this.acc).createPayoutGroup(1, this.acc2.address)
        ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });
    });

    describe('Success Cases', function () {
      it('should create payout group with valid parameters', async function () {
        const expectedPayoutGroupId = 1;
        await expect(
          this.token.connect(this.owner).createPayoutGroup(1, this.acc.address)
        ).to.emit(this.token, 'PayoutGroupCreated')
          .withArgs(expectedPayoutGroupId, this.acc.address, 1);

        expect(await this.token.getPayoutGroupClaimer(expectedPayoutGroupId)).to.equal(this.acc.address);
      });

      it('should assign sequential IDs to payout groups', async function () {
        const id1 = await createPayoutGroup(this, 1, this.acc);

        const id2 = await createPayoutGroup(this, 1, this.acc2);

        const id3 = await createPayoutGroup(this, 1, this.acc3);

        expect(id1).to.equal(1);
        expect(id2).to.equal(2);
        expect(id3).to.equal(3);
      });
    });

    describe('Scalability', function () {
      it('should create 10 payout groups successfully', async function () {
        const signers = await ethers.getSigners();
        const ids = [];

        // Create 10 payout groups
        for (let i = 0; i < 10; i++) {
          const id = await createPayoutGroup(this, 1, signers[i]);
          ids.push(id);
        }

        // Verify sequential IDs
        for (let i = 0; i < ids.length; i++) {
          expect(ids[i]).to.equal(i + 1);
        }

        // Verify all are active
        for (let i = 0; i < ids.length; i++) {
          expect(await this.token.getPayoutGroupClaimer(ids[i])).to.equal(signers[i].address);
        }
      });
    });
  });

  // ===========================================================================
  // SECTION 2: ADMIN FUNCTIONS (adminSetPayoutGroupClaimer)
  // ===========================================================================
  describe('adminSetPayoutGroupClaimer', function() {
    it('should update claimer and bidirectional mappings', async function() {
      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

      // Verify initial state
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.claimer.address);

      // Admin sets new claimer
      await expect(this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId, this.newClaimer.address))
        .to.emit(this.token, 'PayoutClaimerUpdated')
        .withArgs(payoutGroupId, this.claimer.address, this.newClaimer.address);

      // Verify new claimer is set
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.newClaimer.address);
    });

    it('should handle multiple claimer changes', async function() {
      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

      // Change claimer to newClaimer
      await this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId, this.newClaimer.address);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.newClaimer.address);

      // Change claimer to anotherClaimer
      await this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId, this.anotherClaimer.address);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.anotherClaimer.address);
    });

    it('should revert when non-admin tries to change claimer', async function() {
      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

      // Non-admin tries to change claimer
      await expect(this.token.connect(this.acc).adminSetPayoutGroupClaimer(payoutGroupId, this.newClaimer.address))
        .to.be.reverted;
    });

    it('should revert when setting zero address as claimer', async function() {
      const { ZeroAddress } = require("hardhat").ethers;

      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

      // Try to set zero address
      await expect(this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId, ZeroAddress))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should allow setting claimer even if address was previously a claimer', async function() {
      // Create two payout groups
      const payoutGroupId1 = await createPayoutGroup(this, 1, this.claimer);

      const payoutGroupId2 = await createPayoutGroup(this, 1, this.newClaimer);

      // First, change payoutGroup2's claimer to someone else
      await this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId2, this.anotherClaimer.address);

      // Now newClaimer is free, can be assigned to payoutGroup1
      await expect(this.token.connect(this.owner).adminSetPayoutGroupClaimer(payoutGroupId1, this.newClaimer.address))
        .to.emit(this.token, 'PayoutClaimerUpdated')
        .withArgs(payoutGroupId1, this.claimer.address, this.newClaimer.address);

      expect(await this.token.getPayoutGroupClaimer(payoutGroupId1)).to.equal(this.newClaimer.address);
    });

    it('should revert for non-existent payout group', async function() {
      const invalidPayoutId = 999;

      await expect(this.token.connect(this.owner).adminSetPayoutGroupClaimer(invalidPayoutId, this.newClaimer.address))
        .to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });
  });

  // ===========================================================================
  // SECTION 3: CREATE PAYOUT GROUP WITH MANAGER/DESTINATION OPTIONS
  // ===========================================================================
  describe('createPayoutGroup with manager and destination', function() {
    describe('Success Cases', function() {
      it('should create payout group with all parameters', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const destination = signers[5];

        const tx = await this.token.connect(this.owner).createPayoutGroupWithRoles(
          1, this.claimer.address, manager.address, destination.address
        );
        const receipt = await tx.wait();

        // Extract payoutGroupId from PayoutGroupCreated event
        const event = receipt.logs.find(log => {
          try {
            const parsed = this.token.interface.parseLog(log);
            return parsed && parsed.name === 'PayoutGroupCreated';
          } catch (e) {
            return false;
          }
        });
        const parsed = this.token.interface.parseLog(event);
        const payoutGroupId = parsed.args.payoutGroupId;

        // Verify all values are set correctly
        expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.claimer.address);
        expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(manager.address);
        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(destination.address);
      });

      it('should emit all events correctly', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const destination = signers[5];

        await expect(
          this.token.connect(this.owner).createPayoutGroupWithRoles(
            1, this.claimer.address, manager.address, destination.address
          )
        ).to.emit(this.token, 'PayoutGroupCreated')
          .and.to.emit(this.token, 'PayoutGroupManagerSet')
          .and.to.emit(this.token, 'PayoutGroupDestinationSet');
      });

      it('should create with manager only (destination = address(0))', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];

        const payoutGroupId = await createPayoutGroupWithRoles(
          this, 1, this.claimer, manager.address, ethers.ZeroAddress
        );

        expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.claimer.address);
        expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(manager.address);
        // Destination defaults to claimer when not set
        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(this.claimer.address);
      });

      it('should create with destination only (manager = address(0))', async function() {
        const signers = await ethers.getSigners();
        const destination = signers[5];

        const payoutGroupId = await createPayoutGroupWithRoles(
          this, 1, this.claimer, ethers.ZeroAddress, destination.address
        );

        expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.claimer.address);
        expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(ethers.ZeroAddress);
        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(destination.address);
      });

      it('should create with both as address(0) - equivalent to simple create', async function() {
        const payoutGroupId = await createPayoutGroupWithRoles(
          this, 1, this.claimer, ethers.ZeroAddress, ethers.ZeroAddress
        );

        expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.claimer.address);
        expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(ethers.ZeroAddress);
        // Destination defaults to claimer when not set
        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(this.claimer.address);
      });

      it('should allow manager to perform manager functions after creation', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const newDestination = signers[6];

        const payoutGroupId = await createPayoutGroupWithRoles(
          this, 1, this.claimer, manager.address, ethers.ZeroAddress
        );

        // Manager should be able to set destination
        await expect(
          this.token.connect(manager).setPayoutGroupDestination(payoutGroupId, newDestination.address)
        ).to.emit(this.token, 'PayoutGroupDestinationSet');

        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(newDestination.address);
      });

      it('should use destination for claims after creation', async function() {
        const signers = await ethers.getSigners();
        const destination = signers[5];
        const account = signers[6];

        // Setup claim source
        await setupClaimSource(this, ethers.parseUnits("10000", 6));

        const payoutGroupId = await createPayoutGroupWithRoles(
          this, 1, this.claimer, ethers.ZeroAddress, destination.address
        );

        // Fund and register an account
        await mintAndTransfer(this, account, ethers.parseUnits("1000", 6));
        await registerAccount(this, payoutGroupId, account);

        // Verify destination is set correctly
        expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(destination.address);
      });
    });

    describe('Error Cases', function() {
      it('should reject creation with zero claimer', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const destination = signers[5];

        await expect(
          this.token.connect(this.owner).createPayoutGroupWithRoles(
            1, ethers.ZeroAddress, manager.address, destination.address
          )
        ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should reject creation with non-existent multiplier', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const destination = signers[5];

        await expect(
          this.token.connect(this.owner).createPayoutGroupWithRoles(
            999, this.claimer.address, manager.address, destination.address
          )
        ).to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound');
      });

      it('should reject creation with frozen destination address', async function() {
        const signers = await ethers.getSigners();
        const manager = signers[4];
        const destination = signers[5];

        // Freeze the destination address using the assetProtectionRole
        await this.token.connect(this.assetProtectionRole).freeze(destination.address);

        await expect(
          this.token.connect(this.owner).createPayoutGroupWithRoles(
            1, this.claimer.address, manager.address, destination.address
          )
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should reject creation by non-PAYOUT_GROUP_REGISTRAR_ROLE', async function() {
        const signers = await ethers.getSigners();
        const nonRegistrar = signers[7];
        const manager = signers[4];
        const destination = signers[5];

        await expect(
          this.token.connect(nonRegistrar).createPayoutGroupWithRoles(
            1, this.claimer.address, manager.address, destination.address
          )
        ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });
    });
  });
});
