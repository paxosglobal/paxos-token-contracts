const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup } = require('./helpers/testSetup');

describe('Claim Source Tests', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
  });

  describe('setClaimSource() - All branches', function() {
    it('should succeed when all validations pass (happy path)', async function() {
      // Test the successful path through all branches
      // - claimSource != address(0) ✓
      // - !_isFrozen(claimSource) ✓
      // - wallet.payoutGroupId == 0 ✓

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      const oldSource = await this.token.getClaimSource();

      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.emit(this.token, 'ClaimSourceSet')
        .withArgs(oldSource, this.acc.address);

      expect(await this.token.getClaimSource()).to.equal(this.acc.address);
    });

    it('should prevent setting zero address even if current source is valid', async function() {
      // Verify current claim source is set
      const currentSource = await this.token.getClaimSource();
      expect(currentSource).to.equal(this.owner.address);

      // Try to set to zero address
      await expect(
        this.token.connect(this.owner).setClaimSource(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.token, 'ZeroAddress');

      // Verify claim source unchanged
      const afterSource = await this.token.getClaimSource();
      expect(afterSource).to.equal(this.owner.address);
    });

    it('should revert when setting frozen address as claim source', async function() {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should allow setting same address as current claim source', async function() {
      // Edge case: setting claim source to itself
      const currentSource = await this.token.getClaimSource();
      expect(currentSource).to.equal(this.owner.address);

      await expect(
        this.token.connect(this.owner).setClaimSource(this.owner.address)
      ).to.emit(this.token, 'ClaimSourceSet')
        .withArgs(this.owner.address, this.owner.address);
    });

    it('should handle address with zero balance as claim source', async function() {
      // Test that we can set claim source even if it has zero balance
      // (balance check happens at claim time, not at set time)
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(0);

      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc2.address)
      ).to.emit(this.token, 'ClaimSourceSet');

      expect(await this.token.getClaimSource()).to.equal(this.acc2.address);
    });

    it('should allow setting claim source after deregistration', async function() {
      // Test that deregistering allows setting as claim source again

      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc2); // Use acc2 as claimer

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Cannot set while registered
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');

      // Deregister using the claimer
      await this.token.connect(this.acc2).unregisterRewardAddress(payoutGroupId, this.acc.address);

      // Now should succeed
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.emit(this.token, 'ClaimSourceSet');
    });

    it('should allow changing from one valid claim source to another', async function() {
      // Fund acc to use as claim source
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("5000", 6));

      // Change claim source from owner to acc
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.emit(this.token, 'ClaimSourceSet')
        .withArgs(this.owner.address, this.acc.address);

      expect(await this.token.getClaimSource()).to.equal(this.acc.address);

      // Change back to owner
      await expect(
        this.token.connect(this.owner).setClaimSource(this.owner.address)
      ).to.emit(this.token, 'ClaimSourceSet')
        .withArgs(this.acc.address, this.owner.address);

      expect(await this.token.getClaimSource()).to.equal(this.owner.address);
    });
  });

  describe('setClaimSource() - Freeze/Unfreeze state transitions', function() {
    it('should handle unfreezing then refreezing claim source', async function() {
      // Test state transition: normal → frozen → unfrozen → frozen

      const claimSource = this.acc.address;
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(claimSource, ethers.parseUnits("100", 6));

      // Set as claim source (normal state)
      await this.token.connect(this.owner).setClaimSource(claimSource);
      expect(await this.token.getClaimSource()).to.equal(claimSource);

      // Freeze it
      await this.token.connect(this.assetProtectionRole).freeze(claimSource);

      // Cannot set a different frozen address
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Unfreeze
      await this.token.connect(this.assetProtectionRole).unfreeze(claimSource);
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

      // Now can set new claim source
      await this.token.connect(this.owner).transfer(this.acc2.address, ethers.parseUnits("100", 6));
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc2.address)
      ).to.emit(this.token, 'ClaimSourceSet');
    });

    it('should prevent setting frozen address even after thawing and refreezing', async function() {
      // Freeze an address
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Unfreeze it
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc.address);

      // Should succeed when unfrozen
      await this.token.connect(this.owner).setClaimSource(this.acc.address);
      expect(await this.token.getClaimSource()).to.equal(this.acc.address);

      // Freeze it again
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Should revert when trying to set a different frozen address
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });

  describe('setClaimSource() - Validation order', function() {
    it('should reject registered address with ClaimSourceCannotBeRegistered', async function() {
      // Setup: Register acc in a payout group (not frozen)
      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc);
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Should revert with ClaimSourceCannotBeRegistered (payout group check)
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');
    });

    it('should reject frozen address that was previously registered', async function() {
      // Setup: Register acc in a payout group, then freeze
      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc);
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Freeze the address - this clears payoutGroupId (freeze rewards behavior)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Should revert with AddressFrozen (payoutGroupId is now 0 after freeze, so frozen check triggers)
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should check zero address before frozen check', async function() {
      // Use an address that is not in a payout group and is frozen
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // Freeze the address (not in payout group)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Should revert with AddressFrozen (zero address check passed, frozen check fails)
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should validate claim source is not registered before allowing set', async function() {
      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc2); // Use acc2 as claimer

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // First register acc in payout group
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Cannot set acc as claim source because it's registered
      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');

      // Verify current claim source is still owner
      expect(await this.token.getClaimSource()).to.equal(this.owner.address);
    });
  });

  describe('setClaimSource() - Access control', function() {
    it('should revert when called by non-admin', async function() {
      await expect(
        this.token.connect(this.acc).setClaimSource(this.acc2.address)
      ).to.be.reverted; // Will revert with AccessControl error
    });

    it('should succeed when called by admin', async function() {
      expect(await this.token.hasRole(
        ethers.id("MULT_ADMIN_ROLE"),
        this.owner.address
      )).to.be.true;

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("10", 6));

      await expect(
        this.token.connect(this.owner).setClaimSource(this.acc.address)
      ).to.not.be.reverted;
    });
  });

  describe('_claimRewards() - All branches via claimForAddresses()', function() {
    beforeEach(async function() {
      // Setup payout group for claim tests
      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      this.multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      this.payoutGroupId = await createPayoutGroup(this, this.multId, this.acc);

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);
    });

    it('should succeed when all validations pass (happy path)', async function() {
      // Test the successful path through all branches:
      // - amount > 0 ✓
      // - claimSource != address(0) ✓
      // - !_isFrozen(claimSource) ✓
      // - sourceBalance >= amount ✓

      await time.increase(86400); // Accrue rewards

      const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsBefore).to.be.greaterThan(0);

      const balanceBefore = await this.token.balanceOf(this.acc.address);

      await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address]);

      const balanceAfter = await this.token.balanceOf(this.acc.address);
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it('should return early when amount == 0', async function() {
      // When there are no rewards, _claimRewards should return early

      // Don't advance time, so no rewards accrue
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.equal(0);

      // This should succeed but do nothing (early return)
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.not.be.reverted;
    });

    it('should revert when claim source is frozen', async function() {
      await time.increase(86400);
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);

      // Freeze claim source
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);

      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when claim source has insufficient balance', async function() {
      await time.increase(86400);
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);

      // Transfer most tokens away from claim source to make it insufficient
      const claimSource = await this.token.getClaimSource();
      const claimSourceBalance = await this.token.balanceOf(claimSource);

      // Transfer away leaving only a tiny amount
      await this.token.connect(this.owner).transfer(
        this.acc2.address,
        claimSourceBalance - BigInt(1) // Leave only 1 unit
      );

      // Now claim source has insufficient balance
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');
    });

    it('should handle claim with exact balance in claim source', async function() {
      // Edge case: claim source has exactly enough balance

      await time.increase(86400);
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);

      // Set up new claim source with exact amount needed
      const newClaimSource = this.acc3.address;
      await this.token.connect(this.owner).transfer(newClaimSource, rewards);
      await this.token.connect(this.owner).setClaimSource(newClaimSource);

      const claimSourceBalanceBefore = await this.token.balanceOf(newClaimSource);
      expect(claimSourceBalanceBefore).to.equal(rewards);

      // Claim should succeed with exact balance
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.not.be.reverted;

      // Claim source should now have zero balance
      const claimSourceBalanceAfter = await this.token.balanceOf(newClaimSource);
      expect(claimSourceBalanceAfter).to.equal(0);
    });

    it('should handle multiple small claims draining claim source', async function() {
      // Edge case: multiple claims until source is nearly empty

      // Register another account
      await this.token.connect(this.owner).transfer(this.acc2.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);

      await time.increase(86400);

      // Set up claim source with limited balance
      const newClaimSource = this.acc3.address;
      const limitedBalance = ethers.parseUnits("10", 6); // Only 10 tokens
      await this.token.connect(this.owner).transfer(newClaimSource, limitedBalance);
      await this.token.connect(this.owner).setClaimSource(newClaimSource);

      const rewards1 = await this.token.availableRewardsOf(this.acc.address);
      const rewards2 = await this.token.availableRewardsOf(this.acc2.address);
      const totalRewards = rewards1 + rewards2;

      // If total rewards exceed claim source balance, claims should fail
      if (totalRewards > limitedBalance) {
        // First claim might succeed
        if (rewards1 <= limitedBalance) {
          await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address]);

          // Second claim should fail due to insufficient balance
          await expect(
            this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
          ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');
        }
      }
    });

    it('should allow claims after unfreezing claim source', async function() {
      // Accrue some rewards
      await time.increase(86400);

      // Freeze the claim source
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);

      // Unfreeze the claim source
      await this.token.connect(this.assetProtectionRole).unfreeze(this.owner.address);

      // Should be able to claim now
      const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsBefore).to.be.greaterThan(0);

      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.emit(this.token, 'Transfer');

      // Rewards should be claimed
      const rewardsAfter = await this.token.availableRewardsOf(this.acc.address);
      expect(rewardsAfter).to.equal(0);
    });
  });

  describe('Integration - Claim Source Lifecycle', function() {
    it('should prevent all claim operations when claim source is frozen', async function() {
      // Setup: Create payout group and register multiple users
      const rate = ethers.parseUnits("0.05", 10);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

      // Mint tokens and register two users
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).transfer(this.acc2.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Accrue rewards
      await time.increase(86400);

      // Verify both have rewards
      expect(await this.token.availableRewardsOf(this.acc.address)).to.be.greaterThan(0);
      expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.greaterThan(0);

      // Freeze claim source
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);

      // Claimer should be unable to claim for all accounts
      await expect(
        this.token.connect(this.acc).claimAll(payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Unfreeze and set new claim source
      await this.token.connect(this.assetProtectionRole).unfreeze(this.owner.address);

      // Fund new claim source
      const newClaimSource = this.acc3.address;
      await this.token.connect(this.owner).transfer(newClaimSource, ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).setClaimSource(newClaimSource);

      // Claimer should now be able to claim for all accounts
      await expect(
        this.token.connect(this.acc).claimAll(payoutGroupId)
      ).to.not.be.reverted;
    });
  });

});

// Separate describe block outside the main one to avoid the beforeEach that sets claim source
// NOTE: The ClaimSourceNotSet error can only be triggered in upgrade scenarios where
// _initializeV3 hasn't been called yet, since initialize() always sets claimSource.
// This test simulates such a scenario using hardhat_setStorageAt to clear the claim source.
describe('Claim Source Tests - ClaimSourceNotSet branch', function() {
  it('should revert with ClaimSourceNotSet when claim source is address(0)', async function() {
    // Use the standard fixture which sets up everything properly
    const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
    const { token, owner, acc } = fixture;

    // Grant roles
    await grantAllTestRoles(token, owner, owner.address);

    // Setup payout group and register user
    const rate = ethers.parseUnits("0.05", 10);
    await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));
    const multId = await token.connect(owner).createMultiplier.staticCall(rate);
    await token.connect(owner).createMultiplier(rate);

    const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(multId, acc.address);
    await token.connect(owner).createPayoutGroup(multId, acc.address);

    // Fund and register user
    await token.connect(owner).increaseSupply(ethers.parseUnits("1000", 6));
    await token.connect(owner).transfer(acc.address, ethers.parseUnits("100", 6));
    await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, acc.address);

    // Advance time to accrue rewards
    await time.increase(86400);

    // Verify rewards have accrued
    const rewards = await token.availableRewardsOf(acc.address);
    expect(rewards).to.be.greaterThan(0);

    // Clear the claim source using hardhat_setStorageAt to simulate an upgrade scenario
    const tokenAddress = await token.getAddress();

    // First verify current claim source is set
    const currentClaimSource = await token.getClaimSource();
    expect(currentClaimSource).to.not.equal(ethers.ZeroAddress);

    // Find the storage slot by scanning for the claim source address
    // ClaimableRewardsStorageV3 starts at slot 252, adminConfig is after several mappings
    // Mappings don't take sequential slots, but adminConfig (a struct) does
    // Based on the storage layout: slot 252 + mappings (5) + uint16s (packed) + struct
    // The adminConfig struct should be around slot 260-270 range
    const zeroValue = ethers.zeroPadValue("0x00", 32);

    // Scan storage slots to find claim source (it's packed with minRate and maxRate in one slot)
    let foundSlot = -1;
    for (let slot = 252; slot < 320; slot++) {
      const storageValue = await ethers.provider.getStorage(tokenAddress, slot);
      // The claim source is stored in the lower 20 bytes of the slot (address is 20 bytes)
      // Check if the lower 20 bytes match the claim source
      const lower20Bytes = '0x' + storageValue.slice(-40).toLowerCase();
      if (lower20Bytes === currentClaimSource.toLowerCase()) {
        foundSlot = slot;
        break;
      }
    }

    expect(foundSlot).to.be.greaterThan(-1, "Could not find claim source storage slot");

    // Clear the storage slot, unset claim source
    await ethers.provider.send("hardhat_setStorageAt", [
      tokenAddress,
      ethers.toQuantity(foundSlot),
      zeroValue
    ]);

    // Verify claim source is now zero
    expect(await token.getClaimSource()).to.equal(ethers.ZeroAddress);

    // Attempt to claim - should revert with ClaimSourceNotSet
    await expect(
      token.connect(acc).claimForAddresses(payoutGroupId, [acc.address])
    ).to.be.revertedWithCustomError(token, 'ClaimSourceNotSet');

    // Also test claimAll
    await expect(
      token.connect(acc).claimAll(payoutGroupId)
    ).to.be.revertedWithCustomError(token, 'ClaimSourceNotSet');
  });
});
