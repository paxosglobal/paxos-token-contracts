const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

describe('Zero Amount and Early Return Edge Cases', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
    await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
  });

  describe('Zero amount transfers', function() {
    it('should handle transfer of zero amount', async function() {
      // Transfer zero amount should succeed but do nothing
      await expect(
        this.token.connect(this.owner).transfer(this.acc.address, 0)
      ).to.not.be.reverted;

      expect(await this.token.balanceOf(this.acc.address)).to.equal(0);
    });

    it('should handle transferFrom of zero amount', async function() {
      // Setup approval
      await this.token.connect(this.owner).approve(this.acc.address, ethers.parseUnits("100", 6));

      // transferFrom zero amount
      await expect(
        this.token.connect(this.acc).transferFrom(this.owner.address, this.acc2.address, 0)
      ).to.not.be.reverted;

      expect(await this.token.balanceOf(this.acc2.address)).to.equal(0);
    });
  });

  describe('Zero balance operations', function() {
    it('should handle operations on address with zero balance', async function() {
      // Create payout group with rate bounds set first
      const rate = ethers.parseUnits("1", 12);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Register address with zero balance
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Should work even with zero balance
      expect(await this.token.balanceOf(this.acc.address)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
    });

    it('should return zero rewards for zero balance address', async function() {
      const rate = ethers.parseUnits("1", 12);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Register with zero balance
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Advance time
      await time.increase(86400);

      // Should have zero rewards since balance was zero
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.equal(0);
    });
  });

  describe('Early return paths', function() {
    it('should return zero for availableRewardsOf unregistered address', async function() {
      // Unregistered address should have zero rewards
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.equal(0);
    });
  });

  describe('availableRewardsOfBatch edge cases', function() {
    it('should return empty array for empty input', async function() {
      const batchRewards = await this.token.availableRewardsOfBatch([]);
      expect(batchRewards.length).to.equal(0);
    });

    it('should return zeros for unregistered addresses', async function() {
      const batchRewards = await this.token.availableRewardsOfBatch([
        this.acc.address,
        this.acc2.address
      ]);

      expect(batchRewards.length).to.equal(2);
      expect(batchRewards[0]).to.equal(0);
      expect(batchRewards[1]).to.equal(0);
    });
  });
});
