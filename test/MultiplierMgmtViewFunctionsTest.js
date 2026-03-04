const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { UINT40_MAX } = require('./helpers/testSetup');

describe('MultiplierMgmtFacet View Functions', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
    // Set rate bounds to allow multiplier creation
    await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
  });

  describe('getAllActiveMultipliers()', function() {
    it('should return all active multipliers', async function() {
      // Create some multipliers
      const rate1 = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const rate2 = ethers.parseUnits("0.005", 10); // 0.5% APR (10 decimals)

      await this.token.connect(this.owner).createMultiplier(rate1);
      await this.token.connect(this.owner).createMultiplier(rate2);

      const activeMultipliers = await this.token.getAllActiveMultipliers();

      // Should include the new multipliers (1, 2) we just created
      expect(activeMultipliers.length).to.be.greaterThanOrEqual(2);
      expect(activeMultipliers).to.include(1n);
      expect(activeMultipliers).to.include(2n);
    });

    it('should not include deleted multipliers', async function() {
      // Create and immediately delete a multiplier (if no payout groups use it)
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Delete it (should work if no payout groups reference it)
      await this.token.connect(this.owner).deleteMultiplier(multId);

      const activeMultipliers = await this.token.getAllActiveMultipliers();
      expect(activeMultipliers).to.not.include(multId);
    });
  });

  describe('getActiveMultiplier()', function() {
    it('should return the current multiplier value (not rate)', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      const retrievedMultiplier = await this.token.getActiveMultiplier(multId);
      // New multipliers always start at 1.0 (12 decimals)
      expect(retrievedMultiplier).to.equal(ethers.parseUnits("1.0", 12));
    });

  });

  describe('getMaturityPeriod()', function() {
    it('should return the current maturity period', async function() {
      const currentPeriod = await this.token.getMaturityPeriod();
      expect(currentPeriod).to.equal(86400); // Default is 1 day
    });

    it('should return updated period after change', async function() {
      const newPeriod = 43200; // 12 hours
      await this.token.connect(this.owner).setMaturityPeriod(newPeriod);

      const currentPeriod = await this.token.getMaturityPeriod();
      expect(currentPeriod).to.equal(newPeriod);
    });
  });

  describe('getReferenceTime()', function() {
    it('should return the reference time', async function() {
      const refTime = await this.token.getReferenceTime();
      // Default referenceTime is 0 (Unix epoch, UTC midnight aligned)
      expect(refTime).to.equal(0);
    });

    it('should return updated reference time after change', async function() {
      const newRefTime = await time.latest();
      await this.token.connect(this.owner).setReferenceTime(newRefTime);

      const retrievedRefTime = await this.token.getReferenceTime();
      expect(retrievedRefTime).to.equal(newRefTime);
    });
  });

  // getReferencePeriodNum() removed - period numbers are now computed from referenceTime and maturityPeriod

  describe('getCurrentPeriodNum()', function() {
    it('should return the current period number', async function() {
      const currentPeriod = await this.token.getCurrentPeriodNum();
      expect(currentPeriod).to.be.greaterThanOrEqual(0);
    });

    it('should increase after time passes', async function() {
      const initialPeriod = await this.token.getCurrentPeriodNum();

      // Advance time by more than one period
      await time.increase(86400 * 2);

      const laterPeriod = await this.token.getCurrentPeriodNum();
      expect(laterPeriod).to.be.greaterThan(initialPeriod);
    });
  });

  describe('getClaimSource()', function() {
    it('should return the claim source address', async function() {
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);
    });

    it('should return updated claim source after change', async function() {
      await this.token.connect(this.owner).setClaimSource(this.acc.address);

      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.acc.address);
    });
  });

  describe('getMinRate() and getMaxRate()', function() {
    it('should return min and max rate bounds', async function() {
      const minRate = await this.token.getMinAPR();
      const maxRate = await this.token.getMaxAPR();

      // MinRate can be 0 (valid), maxRate should be defined
      expect(maxRate).to.be.greaterThanOrEqual(0);
      expect(maxRate).to.be.greaterThanOrEqual(minRate);
    });
  });

  describe('getNextRate()', function() {
    it('should return 0 when no rate change is scheduled', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Advance time so rate becomes active (no longer scheduled)
      await time.increase(1);

      const nextRate = await this.token.getNextAPR(multId);
      expect(nextRate).to.equal(0);
    });

    it('should return scheduled rate when rate change is pending', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Schedule a rate change for next period
      const newRate = ethers.parseUnits("0.005", 10); // 0.5% APR (10 decimals)
      const currentTime = await time.latest();
      const nextPeriodTime = currentTime + 86400;
      await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, newRate, nextPeriodTime);

      const nextRate = await this.token.getNextAPR(multId);
      expect(nextRate).to.equal(newRate);
    });
  });

  describe('getSwitchTime()', function() {
    it('should return 0 when no rate change is scheduled', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Advance time so rate becomes active (no longer scheduled)
      await time.increase(1);

      const switchTime = await this.token.getSwitchTime(multId);
      expect(switchTime).to.equal(0);
    });

    it('should return scheduled time when rate change is pending', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Schedule a rate change for next period
      const newRate = ethers.parseUnits("0.005", 10); // 0.5% APR (10 decimals)
      const currentTime = await time.latest();
      const nextPeriodTime = currentTime + 86400;
      await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, newRate, nextPeriodTime);

      const switchTime = await this.token.getSwitchTime(multId);
      expect(switchTime).to.be.greaterThan(0);
    });
  });

  describe('getCurrentRate()', function() {
    it('should return current APR for multiplier', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Advance time so rate becomes active
      await time.increase(1);

      const currentAPR = await this.token.getCurrentAPR(multId);
      expect(currentAPR).to.equal(rate);
    });

  });

  describe('getNextAPY()', function() {
    it('should return 0 when no rate change is scheduled', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Advance time so rate becomes active (no longer scheduled)
      await time.increase(1);

      const nextAPY = await this.token.getNextAPY(multId);
      expect(nextAPY).to.equal(0);
    });

    it('should revert for non-existent multiplier', async function() {
      await expect(this.token.getNextAPY(999))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('should return converted APY when rate change is pending', async function() {
      const rate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
      await this.token.connect(this.owner).createMultiplier(rate);

      // Schedule a rate change for next period
      const newAPR = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
      const currentTime = await time.latest();
      const nextPeriodTime = currentTime + 86400;
      await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, newAPR, nextPeriodTime);

      const nextAPY = await this.token.getNextAPY(multId);

      // APY should be slightly higher than APR due to daily compounding
      // For 5% APR with daily compounding: APY ≈ 5.127%
      expect(nextAPY).to.be.greaterThan(newAPR);
      expect(nextAPY).to.be.closeTo(newAPR, ethers.parseUnits("0.005", 10)); // Within 0.5%
    });
  });

  describe('getCurrentAPY()', function() {
    it('should return current APY for multiplier', async function() {
      const apr = ethers.parseUnits("0.04", 10); // 4% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(apr);
      await this.token.connect(this.owner).createMultiplier(apr);

      // Advance time so rate becomes active
      await time.increase(1);

      const currentAPY = await this.token.getCurrentAPY(multId);

      // APY should be slightly higher than APR due to daily compounding
      // For 4% APR with daily compounding: APY ≈ 4.081%
      expect(currentAPY).to.be.greaterThan(apr);
      expect(currentAPY).to.be.closeTo(apr, ethers.parseUnits("0.005", 10)); // Within 0.5%
    });

    it('should revert for non-existent multiplier', async function() {
      await expect(
        this.token.getCurrentAPY(999)
      ).to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('should convert APR to APY correctly with different compounding periods', async function() {
      const apr = ethers.parseUnits("0.1", 10); // 10% APR (10 decimals)
      const multId = await this.token.connect(this.owner).createMultiplier.staticCall(apr);
      await this.token.connect(this.owner).createMultiplier(apr);

      // Advance time so rate becomes active
      await time.increase(1);

      // Test with daily compounding (default period = 86400)
      const apyDaily = await this.token.getCurrentAPY(multId);

      // Change to hourly compounding
      await this.token.connect(this.owner).setMaturityPeriod(3600); // 1 hour
      const apyHourly = await this.token.getCurrentAPY(multId);

      // More frequent compounding should yield higher APY
      expect(apyHourly).to.be.greaterThan(apyDaily);
    });
  });
});
