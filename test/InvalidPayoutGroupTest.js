const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

describe('Invalid/Orphaned Payout Group Handling', function () {
  const testAmount = ethers.parseUnits("100", 6);

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
  });

  describe('Transfer with deleted payout group', function() {
    it('should handle transfer from address with deleted payout group', async function() {
      // Setup multiplier with bounds before creating (setupMultiplierWithBounds sets bounds and creates)
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      // Give address balance and register
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Accrue rewards
      await time.increase(86400);

      // Delete the payout group (leaving account orphaned)
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Transfer should trigger cleanup of invalid payout group
      await expect(
        this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6))
      ).to.not.be.reverted;

      // Verify transfer succeeded
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ethers.parseUnits("10", 6));
    });

    it('should handle transferFrom with deleted payout group', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Approve
      await this.token.connect(this.acc).approve(this.acc2.address, testAmount);

      // Delete payout group
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // transferFrom should work
      await expect(
        this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc3.address, ethers.parseUnits("10", 6))
      ).to.not.be.reverted;

      expect(await this.token.balanceOf(this.acc3.address)).to.equal(ethers.parseUnits("10", 6));
    });
  });

  describe('Burn with deleted payout group', function() {
    it('should handle decrease supply from address with deleted payout group', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(testAmount * 2n);
      // Transfer some to acc so we can test burn from acc's balance
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("50", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Delete payout group
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Enable burning from any address for owner
      await this.supplyControl.updateAllowAnyMintAndBurnAddress(this.owner.address, true);

      // Decrease supply (which triggers cleanup) should work from acc
      await expect(
        this.token.connect(this.owner).decreaseSupplyFromAddress(ethers.parseUnits("10", 6), this.acc.address)
      ).to.not.be.reverted;
    });
  });

  describe('Invalid payout group detection', function() {
    it('should detect when payout group multiplierId is zero', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(testAmount);
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Unregister and delete
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Wallet still has reference to deleted group - transfer should clean up
      // This tests the _processWalletChangeWithCleanup path
      await this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6));

      // Should work without error
      expect(await this.token.balanceOf(this.acc2.address)).to.be.greaterThan(0);
    });

    it('should handle multiple transfers with invalid payout group', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(testAmount);
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Delete payout group
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Multiple transfers should all work
      await this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6));
      await this.token.connect(this.acc).transfer(this.acc3.address, ethers.parseUnits("10", 6));

      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ethers.parseUnits("10", 6));
      expect(await this.token.balanceOf(this.acc3.address)).to.equal(ethers.parseUnits("10", 6));
    });
  });

  describe('Wallet cleanup on invalid payout', function() {
    it('should clear wallet payout group reference when processing change with cleanup', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(testAmount);
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Verify wallet has payout group
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);

      // Delete payout group
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Transfer triggers cleanup
      await this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6));

      // Wallet should no longer have payout group reference
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
    });
  });

  describe('Edge cases with inactive payout groups', function() {
    it('should handle balance updates when payout group becomes inactive', async function() {
      // Setup multiplier with bounds before creating
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).increaseSupply(testAmount * 3n);
      await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Make payout group inactive by deleting
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
      await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

      // Receiving transfer should also work
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("50", 6));

      expect(await this.token.balanceOf(this.acc.address)).to.be.greaterThan(testAmount);
    });
  });
});
