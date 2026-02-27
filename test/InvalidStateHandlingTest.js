const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles, setNextMultiplier } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Invalid State Handling Tests', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  describe('9.2.1 Account with Invalid Payout Group ID', function () {
    it('should reject claims for account with non-existent payout group', async function () {
      // Create and register account normally
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Delete the payout group
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Account now has invalid payout group reference (orphaned)
      // Attempting to claim should revert with InactivePayoutGroup
      await expect(
        this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address])
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should return zero rewards for account with deleted payout group', async function () {
      // Setup account with rewards
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify rewards exist before deletion
      const rewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewardsBefore).to.be.gt(0);

      // Delete payout group
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Rewards should now be zero (no valid payout group)
      const rewardsAfter = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewardsAfter).to.equal(0);
    });

    it('should handle view functions for orphaned accounts', async function () {
      // Create and delete payout group
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // View functions should return sensible defaults
      const rewards = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewards).to.equal(0);

      // payoutGroupIdOf should still return the old ID (orphaned state)
      const orphanedGroupId = await this.token.payoutGroupIdOf(this.acc2.address);
      expect(orphanedGroupId).to.equal(payoutGroupId);
    });
  });

  describe('9.2.2 Payout Group with Invalid Multiplier ID', function () {
    it('should prevent creating payout group with non-existent multiplier', async function () {
      // Try to create payout group with multiplier ID 999 (doesn't exist)
      // Fixture creates multipliers 0 and 1, so 999 is invalid
      await expect(
        this.token.connect(this.owner).createPayoutGroup(999, this.acc.address)
      ).to.be.reverted; // Will revert when trying to access invalid multiplier
    });

    it('should handle switching to invalid multiplier gracefully', async function () {
      // Create payout group with valid multiplier
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Try to switch to invalid multiplier ID (999)
      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 999)
      ).to.be.reverted; // Should revert when accessing invalid multiplier
    });

    it('should revert for invalid multiplier ID in view', async function () {
      // getActiveMultiplier with invalid ID should revert
      const invalidMultId = 999;
      await expect(this.token.getActiveMultiplier(invalidMultId))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(invalidMultId);
    });
  });

  describe('9.2.3 Deleted Payout Group References', function () {
    it('should reject operations on deleted payout group', async function () {
      // Create payout group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Delete it
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Try to use deleted group - should fail
      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 1)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should reject registration to deleted payout group', async function () {
      // Create, register, delete
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Try to register new account to deleted group
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should clear mappings when deleting payout group', async function () {
      // Create payout group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Verify it exists
      const claimerBefore = await this.token.getPayoutGroupClaimer(payoutGroupId);
      expect(claimerBefore).to.equal(this.acc.address);

      // Delete it
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Mappings should be cleared
      const claimerAfter = await this.token.getPayoutGroupClaimer(payoutGroupId);
      expect(claimerAfter).to.equal(ethers.ZeroAddress);
    });

    it('should clear payout data when deleting group', async function () {
      // Create payout group with accounts
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Verify group has balance
      const balanceBefore = await this.token.getPayoutGroupBalance(payoutGroupId);
      expect(balanceBefore).to.be.gt(0);

      // Delete group
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Balance should be zero (data cleared)
      const balanceAfter = await this.token.getPayoutGroupBalance(payoutGroupId);
      expect(balanceAfter).to.equal(0);
    });

    it('should emit PayoutGroupDeleted event', async function () {
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await expect(
        this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
      ).to.emit(this.token, 'PayoutGroupDeleted')
        .withArgs(payoutGroupId, this.acc.address);
    });
  });

  describe('9.2.4 Orphaned Accounts After Payout Deletion', function () {
    beforeEach(async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 100n);
    });

    it('should leave accounts orphaned when payout group is deleted', async function () {
      // Create group and register accounts
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER);

      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

      // Verify accounts are registered
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(payoutGroupId);

      // Delete payout group
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Accounts still reference deleted group (orphaned)
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(payoutGroupId);
    });

    it('should allow re-registering orphaned accounts to new payout group', async function () {
      // Create and delete group
      await setupMultiplierWithBounds(this);
      const oldGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(oldGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(oldGroupId);

      // Create new payout group (reuses same multiplier)
      const newGroupId = await createPayoutGroup(this, 1, this.acc3);

      // Re-register orphaned account to new group
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(newGroupId, this.acc2.address)
      ).to.not.be.reverted;

      // Verify account now in new group
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(newGroupId);
    });

    it('should allow re-registering orphaned accounts via Propose-Accept flow', async function () {
      // Create and delete group
      await setupMultiplierWithBounds(this);
      const oldGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(oldGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(oldGroupId);

      // Verify account is orphaned
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(oldGroupId);

      // Create new payout group (reuses same multiplier)
      const newGroupId = await createPayoutGroup(this, 1, this.acc3);

      // Re-register orphaned account to new group using Propose-Accept flow
      await expect(
        this.token.connect(this.owner).proposeRegisterRewardAddress(newGroupId, this.acc2.address)
      ).to.not.be.reverted;

      // Accept the registration as the account
      await expect(
        this.token.connect(this.acc2).acceptRegisterRewardAddress(newGroupId)
      ).to.not.be.reverted;

      // Verify account now in new group
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(newGroupId);
    });

    it('should maintain orphaned account balance data', async function () {
      // Create group, register, delete group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Account is orphaned but still has balance
      const balanceBefore = await this.token.balanceOf(this.acc2.address);
      expect(balanceBefore).to.equal(ONE_ETHER);

      // Verify orphaned state - account has deleted group ID
      const groupId = await this.token.payoutGroupIdOf(this.acc2.address);
      expect(groupId).to.equal(payoutGroupId); // Still points to deleted group
    });

    it('should allow transfers from orphaned accounts and cleanup invalid references', async function () {
      // Create group, register, delete
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Verify orphaned state before transfer
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);

      // Orphaned account CAN transfer (contract auto-cleans invalid reference)
      // This allows users to move their tokens even after rewards program ends
      await expect(
        this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER)
      ).to.not.be.reverted;

      // Verify transfer succeeded
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER);
      expect(await this.token.balanceOf(this.acc3.address)).to.equal(ONE_ETHER);

      // Verify orphaned reference was cleaned up
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);
    });

    it('should not earn rewards when orphaned', async function () {
      // Create group with rewards
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Set up rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify rewards exist
      const rewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewardsBefore).to.be.gt(0);

      // Delete group (orphans account)
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Fast forward more time
      await time.increase(86400);

      // Orphaned account should not earn new rewards
      const rewardsAfter = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewardsAfter).to.equal(0); // No valid group, no rewards
    });

    it('should block manual cleanup of orphaned accounts via unregister', async function () {
      // Create, register, delete
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Account is orphaned
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);

      // Unregister should fail (group data is zeroed, causing InactivePayoutGroup error)
      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should cleanup both orphaned accounts when transferring between them (same deleted group)', async function () {
      // Setup: Create payout group, register two accounts, then delete group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);

      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Verify both accounts are orphaned
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);

      // Transfer between orphaned accounts (same deleted group)
      await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);

      // EXPECTED: Both accounts should be cleaned up
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);

      // Verify balances are correct
      expect(await this.token.balanceOf(this.acc.address)).to.equal(ONE_ETHER);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER * 3n);
    });

    it('should handle multiple transfers between orphaned accounts correctly', async function () {
      // Setup: Create group with 3 accounts, then delete
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 3n);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 3n);
      await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 3n);

      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // All three accounts are orphaned
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(payoutGroupId);

      // Multiple transfers between orphaned accounts
      await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER);

      // All should be cleaned up
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);

      // Verify final balances
      expect(await this.token.balanceOf(this.acc.address)).to.equal(ONE_ETHER * 2n);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER * 3n);
      expect(await this.token.balanceOf(this.acc3.address)).to.equal(ONE_ETHER * 4n);
    });
  });

  describe('9.2.5 Edge Cases with Invalid States', function () {
    it('should handle claiming from inactive payout group', async function () {
      // Try to claim from non-existent group
      const fakeGroupId = 999;

      await expect(
        this.token.connect(this.acc).claimAll(fakeGroupId)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should handle querying non-existent payout group data', async function () {
      const nonExistentGroupId = 999;

      // Balance should be zero
      const balance = await this.token.getPayoutGroupBalance(nonExistentGroupId);
      expect(balance).to.equal(0);

      // Available rewards should be zero
      const rewards = await this.token.getPayoutGroupAvailableRewards(nonExistentGroupId);
      expect(rewards).to.equal(0);
    });

    it('should allow transfers from account registered to deleted group', async function () {
      // Setup orphaned account
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 5n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Transfer should succeed (contract auto-cleans orphaned reference)
      await expect(
        this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER)
      ).to.not.be.reverted;

      // Verify cleanup happened
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);
    });
  });
});
