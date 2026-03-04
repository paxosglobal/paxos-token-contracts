const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

describe('adminSetPayoutGroupMultiplier - Claim All Before Change', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  describe('Basic Claim All Behavior', function () {
    it('should claim all rewards to destination before changing multiplier', async function () {
      // Setup: Create two multipliers
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

      // Create payout group with acc3 as destination
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

      // Register accounts
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify rewards are available
      const rewardsBefore = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      expect(rewardsBefore).to.be.gt(0);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc3.address);

      // Change multiplier - should claim all first
      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2)
      ).to.emit(this.token, 'ClaimAllExecuted')
        .withArgs(payoutGroupId, this.owner.address, this.acc3.address, rewardsBefore)
        .to.emit(this.token, 'PayoutGroupMultiplierUpdated')
        .withArgs(payoutGroupId, this.acc.address, 1, 2);

      const destinationBalanceAfter = await this.token.balanceOf(this.acc3.address);

      // Verify destination received rewards
      expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(rewardsBefore, 10n);

      // Verify payout group has no available rewards after change
      const rewardsAfter = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      expect(rewardsAfter).to.equal(0);

      // Verify multiplier was changed
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(2);
    });

    it('should update lastClaimAllBaseMultiplier to new multiplier value', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Change to multiplier 2
      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

      // The lastClaimAllMultiplier should now be the value of multiplier 2 at the time of change
      // Since we just changed to mult 2, its value should be 1.0 (default)
      const multValue = await this.token.getActiveMultiplier(2);
      expect(multValue).to.equal(ethers.parseUnits("1", 12)); // 1.0 at 12 decimals
    });
  });

  describe('Multiple Registered Accounts', function () {
    it('should claim rewards for all registered accounts in the payout group', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup three accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create payout group with acc as claimer (to avoid owner being both source and destination)
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Register all accounts
      for (const account of accounts) {
        await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, account);
      }

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify all accounts have rewards
      for (const account of accounts) {
        const accountRewards = await this.token.availableRewardsOf(account);
        expect(accountRewards).to.be.gt(0);
      }

      const totalRewardsBefore = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Change multiplier - should claim all rewards from all accounts
      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);

      // Verify all rewards were claimed
      expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(totalRewardsBefore, 20n);

      // Verify individual accounts have no rewards after claim
      for (const account of accounts) {
        const accountRewards = await this.token.availableRewardsOf(account);
        expect(accountRewards).to.equal(0);
      }
    });

    it('should work correctly with different balance distributions', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup accounts with DIFFERENT balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 3n);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 1n);
      await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

      // Create payout group with dedicated claimer address (to avoid owner being both source and destination)
      // We need to mint a token to a temp address first to use as claimer
      const tempClaimer = this.acc2; // Use acc2 as claimer, will register acc, acc3 only
      const payoutGroupId = await createPayoutGroup(this, 1, tempClaimer);

      // Register only acc and acc3 (acc2 is the claimer so rewards go to them)
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      const acc1Rewards = await this.token.availableRewardsOf(this.acc.address);
      const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

      // Rewards should be proportional to balances (3:2 ratio for acc:acc3)
      // acc has 3 ETHER, acc3 has 2 ETHER
      expect(acc1Rewards).to.be.closeTo((acc3Rewards * 3n) / 2n, ONE_ETHER / 100n);

      const totalRewards = acc1Rewards + acc3Rewards;
      const destinationBalanceBefore = await this.token.balanceOf(tempClaimer.address);

      // Change multiplier
      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

      const destinationBalanceAfter = await this.token.balanceOf(tempClaimer.address);

      // Verify total rewards claimed (acc2/tempClaimer received the rewards)
      expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(totalRewards, 20n);
    });
  });

  describe('Idempotent Behavior', function () {
    it('should return early without claiming when changing to same multiplier', async function () {
      // Setup multiplier and account
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Create payout group with mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsBefore).to.be.gt(0);

      // Change to SAME multiplier (0) - should return early without claiming
      const tx = await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId,  1);
      const receipt = await tx.wait();

      // Should NOT emit ClaimAllExecuted event
      const claimEvents = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'ClaimAllExecuted';
        } catch {
          return false;
        }
      });
      expect(claimEvents.length).to.equal(0);

      // Rewards should still be available (not claimed)
      const rewardsAfter = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsAfter).to.be.closeTo(rewardsBefore, 10n);
    });
  });

  describe('Zero Rewards Case', function () {
    it('should handle changing multiplier when no rewards are available', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Don't create any rewards - change multiplier immediately
      const destinationBalanceBefore = await this.token.balanceOf(this.owner.address);

      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2)
      ).to.emit(this.token, 'PayoutGroupMultiplierUpdated');

      const destinationBalanceAfter = await this.token.balanceOf(this.owner.address);

      // No rewards should be transferred
      expect(destinationBalanceAfter).to.equal(destinationBalanceBefore);

      // Multiplier should be changed
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(2);
    });
  });

  describe('Destination Handling', function () {
    it('should claim to claimer when no destination is set', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

      // Create payout group - NO destination set (defaults to claimer)
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      const rewardsBefore = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      const claimerBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Change multiplier - should claim to claimer (acc)
      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

      const claimerBalanceAfter = await this.token.balanceOf(this.acc.address);

      // Claimer should receive rewards
      expect(claimerBalanceAfter - claimerBalanceBefore).to.be.closeTo(rewardsBefore, 10n);
    });

    it('should claim to configured destination when set', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Setup account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

      // Create payout group with custom destination
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      const rewardsBefore = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      const destinationBalanceBefore = await this.token.balanceOf(this.acc3.address);
      const claimerBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Change multiplier - should claim to destination (acc3), NOT claimer
      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

      const destinationBalanceAfter = await this.token.balanceOf(this.acc3.address);
      const claimerBalanceAfter = await this.token.balanceOf(this.acc.address);

      // Destination should receive rewards
      expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(rewardsBefore, 10n);

      // Claimer should NOT receive rewards
      expect(claimerBalanceAfter).to.equal(claimerBalanceBefore);
    });

    it('should handle claiming when destination equals claimSource', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2

      // Get the claimSource (which is owner in the fixture)
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);

      // Setup account with balance
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Create payout group with acc as claimer
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Explicitly set destination to claimSource (owner) - this is the edge case
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.owner.address);

      // Register acc in the payout group
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 100% max APR (10,000% absolute max)
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify rewards are available
      const rewardsBefore = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      expect(rewardsBefore).to.be.gt(0);

      const claimSourceBalanceBefore = await this.token.balanceOf(claimSource);

      // Change multiplier - should trigger claim all with destination == claimSource
      const tx = await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);
      const receipt = await tx.wait();

      const claimSourceBalanceAfter = await this.token.balanceOf(claimSource);

      // Verify ClaimAllExecuted event was emitted with destination == claimSource
      await expect(tx)
        .to.emit(this.token, 'ClaimAllExecuted')
        .withArgs(payoutGroupId, this.owner.address, claimSource, rewardsBefore);

      // Verify Transfer event shows Transfer(claimSource, claimSource, amount)
      const transferEvents = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'Transfer' && parsed.args.from === claimSource && parsed.args.to === claimSource;
        } catch {
          return false;
        }
      });
      expect(transferEvents.length).to.be.gte(1); // At least one self-transfer event

      // Verify balance of claimSource remains unchanged (transfer to self)
      // Allow for small rounding differences
      expect(claimSourceBalanceAfter).to.be.closeTo(claimSourceBalanceBefore, 10n);

      // Verify rewards were properly claimed (should be 0 after)
      const rewardsAfter = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      expect(rewardsAfter).to.equal(0);

      // Verify multiplier was changed successfully
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(2);
    });
  });

  describe('Error Cases', function () {
    it('should revert when multiplier ID is invalid', async function () {
      // Create payout group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Try to change to non-existent multiplier
      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 999)
      ).to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound');
    });

    it('should revert when payout group is inactive', async function () {
      // Create second multiplier
      await setupMultiplierWithBounds(this);

      // Try to change multiplier for non-existent payout group
      await expect(
        this.token.connect(this.owner).adminSetPayoutGroupMultiplier(999, 2)
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');
    });

    it('should revert when called by non-registrar', async function () {
      // Setup: Create second multiplier
      await setupMultiplierWithBounds(this);

      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Try to change as non-registrar (acc does not have PAYOUT_GROUP_REGISTRAR_ROLE)
      await expect(
        this.token.connect(this.acc).adminSetPayoutGroupMultiplier(payoutGroupId, 2)
      ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('Sequential Multiplier Changes', function () {
    it('should handle multiple multiplier changes correctly', async function () {
      // Setup: Create three multipliers
      await setupMultiplierWithBounds(this); // Creates multiplier ID 1
      await setupMultiplierWithBounds(this); // Creates multiplier ID 2
      await setupMultiplierWithBounds(this); // Creates multiplier ID 3

      // Setup account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Create payout group
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Configure rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 1000% max APR to allow large multiplier changes

      // First change: 0 -> 2 (with rewards)
      let futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
      await time.increase(3601);

      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(2);
      expect(await this.token.getPayoutGroupAvailableRewards(payoutGroupId)).to.equal(0);

      // Second change: 2 -> 3 (accumulate new rewards first)
      // Use longer time period to allow reasonable APR
      futureTime = (await time.latest()) + (86400 * 5); // 5 days
      await setNextMultiplier(this.token, this.owner, 2, ethers.parseUnits("1.03", 12), futureTime);
      await time.increase(86400 * 5 + 1);

      const rewardsBeforeSecondChange = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);
      expect(rewardsBeforeSecondChange).to.be.gt(0);

      await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 3);
      expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(3);
      expect(await this.token.getPayoutGroupAvailableRewards(payoutGroupId)).to.equal(0);
    });
  });
});
