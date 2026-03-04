const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { UINT40_MAX } = require('./helpers/testSetup');

describe('Rate Validation Edge Cases', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
    // Set rate bounds to allow creating multipliers
    await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
  });

  describe('Multiplier rate bounds', function() {
    it('should accept rate at minimum bound when creating multiplier', async function() {
      const minRate = await this.token.getMinAPR();

      // Should succeed with minRate
      await expect(
        this.token.connect(this.owner).createMultiplier(minRate)
      ).to.not.be.reverted;
    });

    it('should accept rate at maximum bound when creating multiplier', async function() {
      const maxRate = await this.token.getMaxAPR();

      // Should succeed with maxRate
      await expect(
        this.token.connect(this.owner).createMultiplier(maxRate)
      ).to.not.be.reverted;
    });

    it('should accept rate in valid range when creating multiplier', async function() {
      const validRate = ethers.parseUnits("0.5", 10); // 50% APR (10 decimals)

      await expect(
        this.token.connect(this.owner).createMultiplier(validRate)
      ).to.not.be.reverted;
    });
  });

  describe('Rewards period validation', function() {
    it('should revert when setting rewards period to zero', async function() {
      await expect(
        this.token.connect(this.owner).setMaturityPeriod(0)
      ).to.be.revertedWithCustomError(this.token, 'InvalidRebaseRate');
    });

    it('should accept minimum valid period', async function() {
      const minPeriod = 1; // 1 second

      await expect(
        this.token.connect(this.owner).setMaturityPeriod(minPeriod)
      ).to.not.be.reverted;
      await expect(
      ).to.not.be.reverted;

      expect(await this.token.getMaturityPeriod()).to.equal(minPeriod);
    });

    it('should accept large period values', async function() {
      const largePeriod = 365 * 24 * 3600; // 1 year

      // Set checkpointPeriod first to ensure it's compatible with new maturityPeriod
      await expect(
      ).to.not.be.reverted;
      await expect(
        this.token.connect(this.owner).setMaturityPeriod(largePeriod)
      ).to.not.be.reverted;

      expect(await this.token.getMaturityPeriod()).to.equal(largePeriod);
    });
  });

  describe('Rate change validation', function() {
    it('should handle scheduled rate within bounds', async function() {
      const initialRate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);

      const newRate = ethers.parseUnits("0.005", 10); // 0.5% APR (10 decimals)
      const currentTime = await ethers.provider.getBlock('latest').then(b => b.timestamp);
      const scheduleTime = currentTime + 86400;

      await expect(
        this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, newRate, scheduleTime)
      ).to.not.be.reverted;

      expect(await this.token.getNextAPR(multId)).to.equal(newRate);
    });

    it('should handle rate change to same value', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      const currentTime = await ethers.provider.getBlock('latest').then(b => b.timestamp);
      const scheduleTime = currentTime + 86400;

      // Schedule rate change to same value
      await expect(
        this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, rate, scheduleTime)
      ).to.not.be.reverted;
    });
  });
});
