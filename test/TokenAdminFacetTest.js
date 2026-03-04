const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles, setNextMultiplier } = require('./helpers/testHelpers');
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

describe("TokenAdminFacet - Asset Protection", function () {
  const initialBalance = 100e6;

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.increaseSupply(initialBalance);
    await this.token.transfer(this.owner.address, initialBalance);

    // Setup test addresses
    this.freezableAddress = this.acc2.address;
    this.freezableAddress2 = this.acc3.address;
  });

  describe("unfreezeBatch", function() {
    it("should unfreeze multiple addresses", async function() {
      // First freeze the addresses using assetProtectionRole (the role that has freeze permission)
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress2);

      // Verify they are frozen
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
      expect(await this.token.isFrozen(this.freezableAddress2)).to.be.true;

      // Unfreeze batch using assetProtectionRole
      await expect(this.token.connect(this.assetProtectionRole).unfreezeBatch([this.freezableAddress, this.freezableAddress2]))
            .to.emit(this.token, "UnfreezeAddress")
            .withArgs(this.freezableAddress);

      // Verify they are unfrozen
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.false;
      expect(await this.token.isFrozen(this.freezableAddress2)).to.be.false;
    });

    it("should handle empty array", async function() {
      await expect(this.token.connect(this.assetProtectionRole).unfreezeBatch([]))
            .to.not.emit(this.token, "UnfreezeAddress");
    });
  });

  describe("freezeBatch", function() {
    it("should freeze multiple addresses", async function() {
      await expect(this.token.connect(this.assetProtectionRole).freezeBatch([this.freezableAddress, this.freezableAddress2]))
            .to.emit(this.token, "FreezeAddress")
            .withArgs(this.freezableAddress);

      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
      expect(await this.token.isFrozen(this.freezableAddress2)).to.be.true;
    });

    it("should handle empty array", async function() {
      await expect(this.token.connect(this.assetProtectionRole).freezeBatch([]))
            .to.not.emit(this.token, "FreezeAddress");
    });
  });

  describe("freeze with payout groups", function() {
    const { ethers } = require("hardhat");
    
    beforeEach(async function() {
      // Setup payout group
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10));
      
      const initialRate = ethers.parseUnits("0.05", 10);
      const multiplierId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);
      
      this.payoutGroupId = await createPayoutGroup(this, multiplierId, this.owner);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc.address);
      
      // Give freezable address balance and register to payout group
      await this.token.connect(this.owner).transfer(this.freezableAddress, 50e6);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.freezableAddress);
      
      // Generate rewards
      const futureTime = (await time.latest()) + 86400;
      await setNextMultiplier(this.token, this.owner, multiplierId, ethers.parseUnits("1.001", 12), futureTime);
      await time.increase(86401);
    });

    it("should freeze rewards when freezing (no claim, rewards stored for potential restoration)", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);
      const accountBalanceBefore = await this.token.balanceOf(this.freezableAddress);

      // Freeze should freeze rewards (not claim them)
      const tx = await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Check FreezeAddress event was emitted
      await expect(tx)
        .to.emit(this.token, "FreezeAddress")
        .withArgs(this.freezableAddress);

      // Verify NO RewardsClaimed event (rewards are frozen, not claimed)
      await expect(tx).to.not.emit(this.token, "RewardsClaimed");

      // Verify destination balance unchanged (rewards not claimed)
      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);
      expect(destinationBalanceAfter).to.equal(destinationBalanceBefore);

      // Verify account balance unchanged
      expect(await this.token.balanceOf(this.freezableAddress)).to.equal(accountBalanceBefore);

      // Verify no rewards remaining (they were frozen)
      expect(await this.token.availableRewardsOf(this.freezableAddress)).to.equal(0);

      // Verify account is frozen
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;

      // Verify account is removed from payout group (stored in frozen data for potential restoration)
      expect(await this.token.payoutGroupIdOf(this.freezableAddress)).to.equal(0);
    });

    it("should freeze account with no payout group without claiming", async function() {
      // Account not registered to payout group
      const unregisteredAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(unregisteredAddress, 10e6);
      
      await expect(this.token.connect(this.assetProtectionRole).freeze(unregisteredAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(unregisteredAddress)
        .and.to.not.emit(this.token, "RewardsClaimed");
      
      expect(await this.token.isFrozen(unregisteredAddress)).to.be.true;
    });

    it("should freeze successfully even when payout group destination is frozen", async function() {
      // Freeze the destination first
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Freezing account should succeed (rewards are frozen, not claimed to destination)
      await expect(this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(this.freezableAddress);

      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
    });

    it("should handle orphaned payout group (deleted group)", async function() {
      // Delete the payout group
      await this.token.connect(this.owner).deletePayoutGroup(this.payoutGroupId);

      // Freeze should succeed (no rewards to claim for orphaned account)
      await expect(this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(this.freezableAddress)
        .and.to.not.emit(this.token, "RewardsClaimed");

      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
    });

    it("should freeze account with active payout group but zero rewards (just registered)", async function() {
      // Register a new account without time passing (no rewards accrued)
      const newAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(newAddress, 10e6);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, newAddress);

      // Verify no rewards yet
      expect(await this.token.availableRewardsOf(newAddress)).to.equal(0);

      // Freeze should succeed but not emit RewardsClaimed (no rewards to claim)
      await expect(this.token.connect(this.assetProtectionRole).freeze(newAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(newAddress)
        .and.to.not.emit(this.token, "RewardsClaimed");

      expect(await this.token.isFrozen(newAddress)).to.be.true;
      // Account is removed from payout group when frozen (stored in frozen data for potential restoration)
      expect(await this.token.payoutGroupIdOf(newAddress)).to.equal(0);
    });

    it("should handle freezeBatch with mixed payout group accounts", async function() {
      // Setup: freezableAddress is already in payout group with rewards
      // acc3 is not in any payout group
      const unregisteredAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(unregisteredAddress, 10e6);

      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Batch freeze both accounts
      await this.token.connect(this.assetProtectionRole).freezeBatch([this.freezableAddress, unregisteredAddress]);

      // Both should be frozen
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
      expect(await this.token.isFrozen(unregisteredAddress)).to.be.true;

      // Rewards should NOT have been claimed (frozen instead)
      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);
      expect(destinationBalanceAfter).to.equal(destinationBalanceBefore);

      // No rewards remaining for payout group account (frozen)
      expect(await this.token.availableRewardsOf(this.freezableAddress)).to.equal(0);
    });

    it("should restore frozen rewards when unfreezing", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      // Freeze (rewards frozen and stored)
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);
      expect(await this.token.availableRewardsOf(this.freezableAddress)).to.equal(0);

      // Unfreeze (rewards should be restored)
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // Verify rewards were restored (allow 1 unit tolerance for rounding)
      const rewardsAfter = await this.token.availableRewardsOf(this.freezableAddress);
      const diff = rewardsBefore > rewardsAfter ? rewardsBefore - rewardsAfter : rewardsAfter - rewardsBefore;
      expect(diff).to.be.lte(1);
    });

    it("should not accrue rewards during frozen period", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      // Freeze
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Advance time (would normally accrue more rewards)
      await time.increase(86400);

      // Unfreeze
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // Rewards should be same as before freeze (allow 1 unit tolerance for rounding)
      const rewardsAfter = await this.token.availableRewardsOf(this.freezableAddress);
      const diff = rewardsBefore > rewardsAfter ? rewardsBefore - rewardsAfter : rewardsAfter - rewardsBefore;
      expect(diff).to.be.lte(1);
    });

    it("should not restore rewards if wiped instead of unfrozen", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Freeze (rewards frozen and stored)
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Wipe (frozen rewards should be cleared, not restored)
      await this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.freezableAddress);

      // Destination should not have received any rewards
      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);
      expect(destinationBalanceAfter).to.equal(destinationBalanceBefore);

      // Account is wiped
      expect(await this.token.balanceOf(this.freezableAddress)).to.equal(0);
    });

    it("should handle freeze/unfreeze with no rewards (no reward freeze needed)", async function() {
      // Register a new account without time passing (no rewards accrued)
      const newAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(newAddress, 10e6);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, newAddress);

      // Verify no rewards yet
      expect(await this.token.availableRewardsOf(newAddress)).to.equal(0);

      // Freeze (no rewards to freeze)
      await this.token.connect(this.assetProtectionRole).freeze(newAddress);
      expect(await this.token.isFrozen(newAddress)).to.be.true;

      // Unfreeze (no rewards to restore)
      await this.token.connect(this.assetProtectionRole).unfreeze(newAddress);
      expect(await this.token.isFrozen(newAddress)).to.be.false;

      // Still no rewards
      expect(await this.token.availableRewardsOf(newAddress)).to.equal(0);
    });

    it("should exclude frozen account rewards from claimAll", async function() {
      // Register acc3 as well
      const otherAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(otherAddress, 100e6);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, otherAddress);

      // Advance time for both to accrue rewards
      await time.increase(86400);

      const frozenRewards = await this.token.availableRewardsOf(this.freezableAddress);
      const otherRewards = await this.token.availableRewardsOf(otherAddress);
      expect(frozenRewards).to.be.gt(0);
      expect(otherRewards).to.be.gt(0);

      // Freeze one account
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // ClaimAll should only include non-frozen account's rewards
      // Note: owner is the claimer (set in createPayoutGroup)
      await this.token.connect(this.owner).claimAll(this.payoutGroupId);

      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);
      const claimedAmount = destinationBalanceAfter - destinationBalanceBefore;

      // Claimed amount should be approximately equal to other account's rewards (allow 1 unit tolerance)
      const diff = claimedAmount > otherRewards ? claimedAmount - otherRewards : otherRewards - claimedAmount;
      expect(diff).to.be.lte(1);

      // Verify frozen account's rewards were excluded (much less than if included)
      expect(claimedAmount).to.be.lt(frozenRewards + otherRewards);
    });

    it("should not restore rewards when unfreezing if payout group was deleted", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      // Freeze (rewards frozen and stored with payout group ID)
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Verify frozen data is stored
      const [frozenRewards, frozenPayoutGroupId] = await this.token.getFrozenData(this.freezableAddress);
      expect(frozenRewards).to.be.gt(0);
      expect(frozenPayoutGroupId).to.equal(this.payoutGroupId);

      // Delete the payout group while address is frozen
      await this.token.connect(this.owner).deletePayoutGroup(this.payoutGroupId);

      // Unfreeze - payout group no longer exists, so rewards cannot be restored
      // Should emit FrozenRewardsLost event
      await expect(this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress))
        .to.emit(this.token, "FrozenRewardsLost")
        .withArgs(this.freezableAddress, this.payoutGroupId, frozenRewards);

      // Verify address is unfrozen but has no payout group (since original was deleted)
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.false;
      expect(await this.token.payoutGroupIdOf(this.freezableAddress)).to.equal(0);

      // Verify frozen data was cleared
      const [clearedRewards, clearedPayoutGroupId] = await this.token.getFrozenData(this.freezableAddress);
      expect(clearedRewards).to.equal(0);
      expect(clearedPayoutGroupId).to.equal(0);

      // No rewards since not in any payout group
      expect(await this.token.availableRewardsOf(this.freezableAddress)).to.equal(0);
    });

    it("should handle multiple freeze/unfreeze cycles correctly", async function() {
      // First cycle: freeze with initial rewards
      const rewards1 = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewards1).to.be.gt(0);

      // Freeze (rewards frozen)
      const tx1 = await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);
      await expect(tx1).to.emit(this.token, "RewardsFrozen").withArgs(this.freezableAddress, this.payoutGroupId, rewards1);

      // Unfreeze (rewards restored)
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // Verify rewards were restored
      const rewardsAfterUnfreeze1 = await this.token.availableRewardsOf(this.freezableAddress);
      const diff1 = rewards1 > rewardsAfterUnfreeze1 ? rewards1 - rewardsAfterUnfreeze1 : rewardsAfterUnfreeze1 - rewards1;
      expect(diff1).to.be.lte(1);

      // Advance time to accrue more rewards
      await time.increase(86400);

      // Second cycle: freeze with new (higher) rewards
      const rewards2 = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewards2).to.be.gt(rewards1); // Should have accrued more

      // Freeze again (new rewards frozen)
      const tx2 = await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);
      await expect(tx2).to.emit(this.token, "RewardsFrozen").withArgs(this.freezableAddress, this.payoutGroupId, rewards2);

      // Verify frozen data reflects the new rewards amount
      const [frozenRewards, frozenPayoutGroupId] = await this.token.getFrozenData(this.freezableAddress);
      const diffFrozen = rewards2 > frozenRewards ? rewards2 - frozenRewards : frozenRewards - rewards2;
      expect(diffFrozen).to.be.lte(1);
      expect(frozenPayoutGroupId).to.equal(this.payoutGroupId);

      // Unfreeze again
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // Verify second round of rewards were restored
      const rewardsAfterUnfreeze2 = await this.token.availableRewardsOf(this.freezableAddress);
      const diff2 = rewards2 > rewardsAfterUnfreeze2 ? rewards2 - rewardsAfterUnfreeze2 : rewardsAfterUnfreeze2 - rewards2;
      expect(diff2).to.be.lte(1);
    });

    it("should emit RewardsFrozen event when freezing with rewards", async function() {
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      // Freeze should emit RewardsFrozen event
      await expect(this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress))
        .to.emit(this.token, "RewardsFrozen")
        .withArgs(this.freezableAddress, this.payoutGroupId, rewardsBefore);
    });

    it("should emit RewardsFrozen event with zero rewards when freezing just-registered account", async function() {
      // Register a new account without time passing (no rewards accrued)
      const newAddress = this.acc3.address;
      await this.token.connect(this.owner).transfer(newAddress, 10e6);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, newAddress);

      // Verify no rewards yet
      expect(await this.token.availableRewardsOf(newAddress)).to.equal(0);

      // Freeze SHOULD emit RewardsFrozen event (even with 0 rewards) for audit trail
      // This records which payout group the address was removed from
      await expect(this.token.connect(this.assetProtectionRole).freeze(newAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(newAddress)
        .and.to.emit(this.token, "RewardsFrozen")
        .withArgs(newAddress, this.payoutGroupId, 0);
    });

    it("should not emit RewardsFrozen event when freezing address with zero balance", async function() {
      // Register a new account with zero balance
      const newAddress = this.acc3.address;
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, newAddress);

      // Verify zero balance
      expect(await this.token.balanceOf(newAddress)).to.equal(0);

      // Freeze should NOT emit RewardsFrozen event (nothing to store)
      await expect(this.token.connect(this.assetProtectionRole).freeze(newAddress))
        .to.emit(this.token, "FreezeAddress")
        .withArgs(newAddress)
        .and.to.not.emit(this.token, "RewardsFrozen");
    });

    it("should return frozen data via getFrozenData getter", async function() {
      // Before freeze: no frozen data
      const [rewardsBefore, payoutGroupIdBefore] = await this.token.getFrozenData(this.freezableAddress);
      expect(rewardsBefore).to.equal(0);
      expect(payoutGroupIdBefore).to.equal(0);

      const rewards = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewards).to.be.gt(0);

      // Freeze
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // After freeze: frozen data should be stored
      const [rewardsAfter, payoutGroupIdAfter] = await this.token.getFrozenData(this.freezableAddress);
      const diff = rewards > rewardsAfter ? rewards - rewardsAfter : rewardsAfter - rewards;
      expect(diff).to.be.lte(1);
      expect(payoutGroupIdAfter).to.equal(this.payoutGroupId);

      // Unfreeze
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // After unfreeze: frozen data should be cleared
      const [rewardsCleared, payoutGroupIdCleared] = await this.token.getFrozenData(this.freezableAddress);
      expect(rewardsCleared).to.equal(0);
      expect(payoutGroupIdCleared).to.equal(0);
    });

    it("should preserve original token amount when multiplier changes during freeze", async function() {
      // Get rewards before freeze
      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      // Freeze (rewards stored as token amount, not shares)
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Verify frozen data stores the reward amount
      const [frozenRewards, frozenPayoutGroupId] = await this.token.getFrozenData(this.freezableAddress);
      const diffBefore = rewardsBefore > frozenRewards ? rewardsBefore - frozenRewards : frozenRewards - rewardsBefore;
      expect(diffBefore).to.be.lte(1);
      expect(frozenPayoutGroupId).to.equal(this.payoutGroupId);

      // Get the multiplier ID from the payout group
      const multiplierId = await this.token.getPayoutGroupMultId(this.payoutGroupId);

      // Change the multiplier rate significantly while address is frozen (double the APR)
      // This simulates APR going up during the freeze period
      // Original rate was 0.05 (5% APR at 10 decimals), now set to 0.10 (10% APR)
      const newAPR = ethers.parseUnits("0.10", 10); // 10% APR
      await this.token.connect(this.owner).setMultiplierRateByAPR(multiplierId, newAPR);

      // Advance time for the new rate to take effect
      await time.increase(86400);

      // Unfreeze
      await this.token.connect(this.assetProtectionRole).unfreeze(this.freezableAddress);

      // Verify the original token amount of rewards is preserved (not affected by multiplier change)
      // The rewards should be approximately the same as before freeze (allow 1 unit tolerance for rounding)
      const rewardsAfter = await this.token.availableRewardsOf(this.freezableAddress);
      const diffAfter = rewardsBefore > rewardsAfter ? rewardsBefore - rewardsAfter : rewardsAfter - rewardsBefore;
      expect(diffAfter).to.be.lte(1);
    });
  });

  describe("pause/unpause", function() {
    it("should pause the contract", async function() {
      await expect(this.token.connect(this.owner).pause())
            .to.emit(this.token, "Pause");

      expect(await this.token.paused()).to.be.true;
    });

    it("should unpause the contract", async function() {
      await this.token.connect(this.owner).pause();

      await expect(this.token.connect(this.owner).unpause())
            .to.emit(this.token, "Unpause");

      expect(await this.token.paused()).to.be.false;
    });

    it("should revert when pausing already paused contract", async function() {
      await this.token.connect(this.owner).pause();

      await expect(this.token.connect(this.owner).pause())
            .to.be.revertedWithCustomError(this.token, "AlreadyPaused");
    });

    it("should revert when unpausing already unpaused contract", async function() {
      await expect(this.token.connect(this.owner).unpause())
            .to.be.revertedWithCustomError(this.token, "AlreadyUnPaused");
    });
  });

  describe("setSupplyControl", function() {
    it("should set supply control address", async function() {
      // Use acc2 as the new supply control address
      const newSupplyControl = this.acc2.address;

      await expect(this.token.connect(this.owner).setSupplyControl(newSupplyControl))
            .to.emit(this.token, "SupplyControlSet")
            .withArgs(newSupplyControl);
    });

    it("should revert when setting zero address", async function() {
      const { ZeroAddress } = require("hardhat").ethers;

      await expect(this.token.connect(this.owner).setSupplyControl(ZeroAddress))
            .to.be.revertedWithCustomError(this.token, "ZeroAddress");
    });
  });

  describe("wipeFrozenAddress", function() {
    const wipeAmount = 50e6;

    beforeEach(async function() {
      // Give the freezable address some balance
      await this.token.connect(this.owner).transfer(this.freezableAddress, wipeAmount);
    });

    it("should wipe frozen address with deleted/invalid payout group", async function() {
      const { ethers } = require("hardhat");
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

      // Set rate bounds and create multiplier and payout group
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      const initialRate = ethers.parseUnits("0.05", 12); // 5% APR
      const multiplierId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);

      // createPayoutGroup returns the payoutGroupId and takes (multiplierId, claimer)
      const payoutGroupId = await createPayoutGroup(this, multiplierId, this.owner);

      // Register the address to the payout group
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.freezableAddress);

      // Verify registration worked
      expect(await this.token.payoutGroupIdOf(this.freezableAddress)).to.equal(payoutGroupId);

      // Delete the payout group (making it inactive)
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Freeze the address
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      // Wipe should succeed even though payout group is invalid/deleted
      // This tests the hasInvalidPayout branch in wipeFrozenAddress
      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.freezableAddress))
        .to.emit(this.token, "FrozenAddressWiped")
        .withArgs(this.freezableAddress);

      // Verify balance was wiped
      expect(await this.token.balanceOf(this.freezableAddress)).to.equal(0);
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
    });

    it("should correctly update payout group shares when wiping frozen address (rewards frozen at freeze)", async function() {
      const { ethers } = require("hardhat");

      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10));

      const initialRate = ethers.parseUnits("0.05", 10);
      const multiplierId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);

      const payoutGroupId = await createPayoutGroup(this, multiplierId, this.owner);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.freezableAddress);

      const futureTime = (await time.latest()) + 86400;
      await setNextMultiplier(this.token, this.owner, multiplierId, ethers.parseUnits("1.001", 12), futureTime);
      await time.increase(86401);

      const rewardsBefore = await this.token.availableRewardsOf(this.freezableAddress);
      expect(rewardsBefore).to.be.gt(0);

      const groupBalanceBefore = await this.token.getPayoutGroupBalance(payoutGroupId);
      const accountBalance = await this.token.balanceOf(this.freezableAddress);
      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Freeze should freeze rewards (not claim them)
      await expect(this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress))
        .to.emit(this.token, "FreezeAddress")
        .and.to.not.emit(this.token, "RewardsClaimed");

      // Verify rewards were NOT claimed to destination
      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);
      expect(destinationBalanceAfter).to.equal(destinationBalanceBefore);

      // Verify no rewards remaining after freeze (frozen)
      expect(await this.token.availableRewardsOf(this.freezableAddress)).to.equal(0);

      // Now wipe (rewards already frozen at freeze, so wipe just removes balance)
      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.freezableAddress))
        .to.emit(this.token, "FrozenAddressWiped")
        .withArgs(this.freezableAddress);

      const groupBalanceAfter = await this.token.getPayoutGroupBalance(payoutGroupId);
      expect(groupBalanceAfter).to.equal(groupBalanceBefore - accountBalance);

      expect(await this.token.balanceOf(this.freezableAddress)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(this.freezableAddress)).to.equal(0);
    });

    it("should wipe frozen address with no payout group", async function() {
      await this.token.connect(this.assetProtectionRole).freeze(this.freezableAddress);

      expect(await this.token.payoutGroupIdOf(this.freezableAddress)).to.equal(0);

      const balanceBefore = await this.token.balanceOf(this.freezableAddress);
      const totalSupplyBefore = await this.token.totalSupply();

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.freezableAddress))
        .to.emit(this.token, "FrozenAddressWiped")
        .withArgs(this.freezableAddress)
        .and.to.emit(this.token, "SupplyDecreased")
        .withArgs(this.freezableAddress, balanceBefore)
        .and.to.emit(this.token, "Transfer")
        .withArgs(this.freezableAddress, ethers.ZeroAddress, balanceBefore);

      expect(await this.token.balanceOf(this.freezableAddress)).to.equal(0);
      expect(await this.token.totalSupply()).to.equal(totalSupplyBefore - balanceBefore);
      expect(await this.token.isFrozen(this.freezableAddress)).to.be.true;
    });

    it("should wipe frozen address with zero balance", async function() {
      // Use an address with no balance
      const zeroBalanceAddress = this.acc3.address;
      expect(await this.token.balanceOf(zeroBalanceAddress)).to.equal(0);

      // Freeze it
      await this.token.connect(this.assetProtectionRole).freeze(zeroBalanceAddress);

      const totalSupplyBefore = await this.token.totalSupply();

      // Wipe should succeed with zero balance
      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(zeroBalanceAddress))
        .to.emit(this.token, "FrozenAddressWiped")
        .withArgs(zeroBalanceAddress)
        .and.to.emit(this.token, "SupplyDecreased")
        .withArgs(zeroBalanceAddress, 0)
        .and.to.emit(this.token, "Transfer")
        .withArgs(zeroBalanceAddress, ethers.ZeroAddress, 0);

      expect(await this.token.balanceOf(zeroBalanceAddress)).to.equal(0);
      expect(await this.token.totalSupply()).to.equal(totalSupplyBefore);
      expect(await this.token.isFrozen(zeroBalanceAddress)).to.be.true;
    });

    it("should wipe frozen address with active payout group and zero balance", async function() {
      const { ethers } = require("hardhat");

      // Setup payout group
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10));

      const initialRate = ethers.parseUnits("0.05", 10);
      const multiplierId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);

      const payoutGroupId = await createPayoutGroup(this, multiplierId, this.owner);
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc.address);

      // Register an address with zero balance to payout group
      const zeroBalanceAddress = this.acc3.address;
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, zeroBalanceAddress);

      expect(await this.token.balanceOf(zeroBalanceAddress)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(zeroBalanceAddress)).to.equal(payoutGroupId);

      // Freeze (should not claim any rewards since balance is 0)
      await this.token.connect(this.assetProtectionRole).freeze(zeroBalanceAddress);

      const groupBalanceBefore = await this.token.getPayoutGroupBalance(payoutGroupId);

      // Wipe should succeed
      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(zeroBalanceAddress))
        .to.emit(this.token, "FrozenAddressWiped")
        .withArgs(zeroBalanceAddress);

      // Payout group balance should be unchanged (was 0 contribution)
      const groupBalanceAfter = await this.token.getPayoutGroupBalance(payoutGroupId);
      expect(groupBalanceAfter).to.equal(groupBalanceBefore);

      // Account should be fully cleared
      expect(await this.token.balanceOf(zeroBalanceAddress)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(zeroBalanceAddress)).to.equal(0);
    });
  });

  describe("Role-based access control", function() {
    it("reverts pause() when caller lacks PAUSE_ROLE", async function() {
      await expect(this.token.connect(this.acc2).pause())
        .to.be.revertedWith(/AccessControl.*missing role/);
    });

    it("reverts unpause() when caller lacks PAUSE_ROLE", async function() {
      await this.token.connect(this.owner).pause();

      await expect(this.token.connect(this.acc2).unpause())
        .to.be.revertedWith(/AccessControl.*missing role/);
    });

    it("reverts freeze() when caller lacks ASSET_PROTECTION_ROLE", async function() {
      await expect(this.token.connect(this.acc2).freeze(this.acc3.address))
        .to.be.revertedWith(/AccessControl.*missing role/);
    });

    it("reverts freezeBatch() when caller lacks ASSET_PROTECTION_ROLE", async function() {
      await expect(this.token.connect(this.acc2).freezeBatch([this.acc3.address]))
        .to.be.revertedWith(/AccessControl.*missing role/);
    });

    it("reverts unfreeze() when caller lacks ASSET_PROTECTION_ROLE", async function() {
      // First freeze an address with proper role
      await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);

      await expect(this.token.connect(this.acc2).unfreeze(this.acc3.address))
        .to.be.revertedWith(/AccessControl.*missing role/);
    });

    it("reverts unfreezeBatch() when caller lacks ASSET_PROTECTION_ROLE", async function() {
      // First freeze an address with proper role
      await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);

      await expect(this.token.connect(this.acc2).unfreezeBatch([this.acc3.address]))
        .to.be.revertedWith(/AccessControl.*missing role/);
    });
  });
});
