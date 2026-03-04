const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Payout Group Deletion', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Setup multiplier before any payout group creation
    await setupMultiplierWithBounds(this);

    // Setup accounts
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
  });

  describe('Basic Deletion', function () {
    it('should delete payout group with zero balance', async function () {
      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Verify it exists
      expect(payoutGroupId).to.be.gt(0);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(this.acc.address);

      // Delete it
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.emit(this.token, 'PayoutGroupDeleted')
        .withArgs(payoutGroupId, this.acc.address);

      // Verify all mappings cleared
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(ZeroAddress);
      expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(ZeroAddress);
      expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(ZeroAddress);
      expect(await this.token.getPayoutGroupBalance(payoutGroupId)).to.equal(0);
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(0);
    });

    it('should clear manager and destination mappings on deletion', async function () {
      // Create payout group with manager and destination
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId, this.acc2.address);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

      // Verify setup
      expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(this.acc2.address);
      expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(this.acc3.address);

      // Delete
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Verify all cleared
      expect(await this.token.getPayoutGroupManager(payoutGroupId)).to.equal(ZeroAddress);
      expect(await this.token.getPayoutGroupDestination(payoutGroupId)).to.equal(ZeroAddress);
    });
  });

  describe('Deletion with Balance - EXPECTED BEHAVIOR', function () {
    it('should allow deletion with non-zero balance (balance preserved, zero rewards claimed)', async function () {
      // Create payout group and register account with balance
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Verify balance tracked
      const balanceBefore = await this.token.getPayoutGroupBalance(payoutGroupId);
      expect(balanceBefore).to.equal(ONE_ETHER);

      // Deletion should succeed (balances are not rewards, they stay with account)
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.not.be.reverted;

      // After deletion, payout group data is cleared
      expect(await this.token.getPayoutGroupBalance(payoutGroupId)).to.equal(0);

      // Account still has balance (balances are not rewards)
      expect(await this.token.balanceOf(this.acc.address)).to.equal(ONE_ETHER);

      // Account's payout group association remains (orphaned, but can be re-registered)
      const accountPayoutGroupId = await this.token.payoutGroupIdOf(this.acc.address);
      expect(accountPayoutGroupId).to.equal(payoutGroupId);
    });

    it('should claim pending rewards to destination before deletion', async function () {
      // Create payout group and register account
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Set destination to acc2 (NOT the claim source)
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc2.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify rewards exist
      const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsBefore).to.be.gt(0);

      const destBalanceBefore = await this.token.balanceOf(this.acc2.address);

      // Delete should claim rewards first
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      const destBalanceAfter = await this.token.balanceOf(this.acc2.address);

      // Verify rewards were claimed to destination
      expect(destBalanceAfter - destBalanceBefore).to.be.closeTo(rewardsBefore, 10n);

      // After deletion, account has orphaned payout group reference
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);

      // Available rewards returns 0 (already claimed)
      expect(await this.token.availableRewardsOf(this.acc.address)).to.equal(0);
    });
  });

  describe('Orphaned Accounts After Deletion', function () {
    it('should leave accounts orphaned after deletion', async function () {
      // Create and register
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Delete
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Account still references deleted payout group
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);

      // But payout group doesn't exist
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId)).to.equal(ZeroAddress);
    });

    it('should allow transfers from orphaned accounts and cleanup stale data', async function () {
      // Create, register, delete
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Verify account is orphaned before transfer
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);

      // Transfer should succeed (contract auto-cleans up orphaned data)
      await expect(
        this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER / 2n)
      ).to.not.be.reverted;

      // Verify balances updated correctly
      expect(await this.token.balanceOf(this.acc.address)).to.equal(ONE_ETHER / 2n);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER + ONE_ETHER / 2n);

      // Verify orphaned data was cleaned up (payoutGroupId reset to 0)
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
    });

    it('should return zero for orphaned account rewards', async function () {
      // Setup with rewards
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsBefore).to.be.gt(0);

      // Delete
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Rewards should be zero (payout group inactive)
      expect(await this.token.availableRewardsOf(this.acc.address)).to.equal(0);
    });

    it('should allow re-registration of orphaned account to new payout group', async function () {
      // Create, register, delete (orphaning acc2)
      const payoutGroupId1 = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId1, this.acc2.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId1);

      // Verify acc2 is orphaned (points to deleted group)
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId1);

      // Create new payout group
      const payoutGroupId2 = await createPayoutGroup(this, 1, this.acc3);

      // Should successfully re-register orphaned account
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId2, this.acc2.address)
      ).to.not.be.reverted;

      // Verify acc2 is now registered to new group
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId2);

      // Verify old orphaned state cleared - account balance tracked in new group
      expect(await this.token.getPayoutGroupBalance(payoutGroupId2)).to.equal(ONE_ETHER);
    });

    it('should cleanup orphaned account data when burning tokens', async function () {
      // Enable burning from any address for owner
      await this.supplyControl.updateAllowAnyMintAndBurnAddress(this.owner.address, true);

      // Create payout group and register account with balance
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Verify account is registered and has balance
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER);

      // Delete payout group (orphaning acc2)
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Verify account is orphaned (still points to deleted group)
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);

      // Burn tokens from orphaned account
      const burnAmount = ONE_ETHER / 2n;
      await expect(
        this.token.connect(this.owner).decreaseSupplyFromAddress(burnAmount, this.acc2.address)
      ).to.not.be.reverted;

      // Verify balance decreased
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER / 2n);

      // Account data should be cleared (payoutGroupId=0)
      // The burn operation detects the invalid payout group and cleans up the account data
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);

      // Account should have zero rewards after cleanup
      expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0);
    });
  });

  describe('Idempotent Deletion', function () {
    it('should be a no-op when deleting non-existent payout group', async function () {
      // Should not revert - idempotent behavior
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(999)
      ).to.not.be.reverted;

      // No event should be emitted
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(999)
      ).to.not.emit(this.token, 'PayoutGroupDeleted');
    });

    it('should be a no-op when deleting already deleted payout group', async function () {
      // Create and delete
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.emit(this.token, 'PayoutGroupDeleted');

      // Try to delete again - should not revert (idempotent)
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.not.be.reverted;

      // No event should be emitted on second delete
      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.not.emit(this.token, 'PayoutGroupDeleted');
    });

    it('should revert when called by non-registrar', async function () {
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await expect(
        this.token.connect(this.acc).deletePayoutGroup(payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('Payout ID Reuse', function () {
    it('should NOT reuse payout ID after deletion', async function () {
      // Create first payout group
      const payoutGroupId1 = await createPayoutGroup(this, 1, this.acc);
      expect(payoutGroupId1).to.equal(1);

      // Delete it
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId1);

      // Create new payout group - should get new ID
      const payoutGroupId2 = await createPayoutGroup(this, 1, this.acc2);

      expect(payoutGroupId2).to.equal(2); // Should be 2, not reusing 1
      expect(payoutGroupId2).to.not.equal(payoutGroupId1);
    });

    it('should increment payout IDs sequentially even with deletions', async function () {
      // Create multiple groups
      const id1 = await createPayoutGroup(this, 1, this.acc);

      const id2 = await createPayoutGroup(this, 1, this.acc2);

      const id3 = await createPayoutGroup(this, 1, this.acc3);

      expect(id1).to.equal(1);
      expect(id2).to.equal(2);
      expect(id3).to.equal(3);

      // Delete middle one
      await this.token.connect(this.owner).deletePayoutGroup(id2);

      // Create new one - should get ID 4, not reusing 2
      const signers = await ethers.getSigners();
      const newClaimer = signers[7];
      const id4 = await createPayoutGroup(this, 1, newClaimer);

      expect(id4).to.equal(4);
    });
  });

  describe('Multiple Account Cleanup', function () {
    it('should leave multiple accounts orphaned after deletion', async function () {
      // Create payout group and register multiple accounts
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER);

      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

      // Delete
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // All accounts should be orphaned
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(payoutGroupId);

      // All should have zero rewards
      expect(await this.token.availableRewardsOf(this.acc.address)).to.equal(0);
      expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0);
      expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(0);
    });
  });

  describe('Interaction with Other Operations', function () {
    it('should not be able to claim from deleted payout group', async function () {
      // Create, register, generate rewards
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Delete
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Try to claim - should fail
      await expect(
        this.token.connect(this.acc).claimAll(payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should not be able to register to deleted payout group', async function () {
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should not be able to modify deleted payout group settings', async function () {
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');

      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');

      // Try to create second multiplier for testing (with bounds already set)
      await setupMultiplierWithBounds(this);

      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });
  });

  describe('Claimer Address Reuse', function () {
    it('should allow same claimer address for new payout group after deletion', async function () {
      // Create first payout group
      const payoutGroupId1 = await createPayoutGroup(this, 1, this.acc);

      // Delete it
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId1);

      // Create new payout group with same claimer
      const payoutGroupId2 = await createPayoutGroup(this, 1, this.acc);

      expect(payoutGroupId2).to.be.gt(0);
      expect(payoutGroupId2).to.not.equal(payoutGroupId1);
    });
  });
});
