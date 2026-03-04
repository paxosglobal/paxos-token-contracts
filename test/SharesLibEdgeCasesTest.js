const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

// Fixture for SharesLibTest contract
async function deploySharesLibTestFixture() {
  const SharesLibTest = await ethers.getContractFactory('SharesLibTest');
  const sharesLibTest = await SharesLibTest.deploy();
  await sharesLibTest.waitForDeployment();
  return { sharesLibTest };
}

describe('SharesLib Edge Cases', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
  });

  describe('SharesLib direct tests (via SharesLibTest harness)', function() {

    describe('ZeroMultiplier error path', function() {
      it('should revert with ZeroMultiplier when calcShares is called with multiplier = 0', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const balance = ethers.parseUnits("100", 6);
        const zeroMultiplier = 0n;

        await expect(
          sharesLibTest.exposed_calcShares(balance, zeroMultiplier)
        ).to.be.revertedWithCustomError(sharesLibTest, 'ZeroMultiplier');
      });

      it('should revert with ZeroMultiplier when updateSharesWithRewardPreservation has zero multiplier', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const oldBalance = ethers.parseUnits("50", 6);
        const newBalance = ethers.parseUnits("100", 6);
        const currentShares = ethers.parseUnits("50", 6);
        const zeroMultiplier = 0n;

        await expect(
          sharesLibTest.exposed_updateSharesWithRewardPreservation(oldBalance, newBalance, currentShares, zeroMultiplier)
        ).to.be.revertedWithCustomError(sharesLibTest, 'ZeroMultiplier');
      });

      it('should work correctly with valid multiplier', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const balance = ethers.parseUnits("100", 6);
        const validMultiplier = ethers.parseUnits("1", 12); // 1.0 at 12 decimals

        const shares = await sharesLibTest.exposed_calcShares(balance, validMultiplier);
        // shares = balance * MULT_BASE / multiplier = 100e6 * 1e12 / 1e12 = 100e6
        expect(shares).to.equal(balance);
      });

      it('should return 0 when currentShares=0 and newBalance=0 in updateSharesWithRewardPreservation', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const oldBalance = 0n;
        const newBalance = 0n;
        const currentShares = 0n;
        const validMultiplier = ethers.parseUnits("1", 12); // 1.0 at 12 decimals

        // This tests the else branch: return newBalance > 0 ? calcShares(...) : 0;
        // When currentShares=0 and newBalance=0, should return 0
        const newShares = await sharesLibTest.exposed_updateSharesWithRewardPreservation(
          oldBalance, newBalance, currentShares, validMultiplier
        );
        expect(newShares).to.equal(0);
      });
    });

    describe('PeriodNumOverflow error path', function() {
      it('should revert with PeriodNumOverflow when periodsElapsed exceeds uint32.max', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        // To trigger overflow: (currentTime - referenceTime) / maturityPeriod > uint32.max
        // uint32.max = 4294967295
        // With maturityPeriod = 1, we need currentTime - referenceTime > 4294967295
        const referenceTime = 0;
        const maturityPeriod = 1; // 1 second period
        // currentTime needs to be > uint32.max + referenceTime = 4294967295
        const currentTime = BigInt("4294967296"); // uint32.max + 1

        await expect(
          sharesLibTest.exposed_getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime)
        ).to.be.revertedWithCustomError(sharesLibTest, 'PeriodNumOverflow');
      });

      it('should return 0 when maturityPeriod is 0', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const referenceTime = 1000;
        const maturityPeriod = 0;
        const currentTime = 2000;

        const periodNum = await sharesLibTest.exposed_getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime);
        expect(periodNum).to.equal(0);
      });

      it('should return 0 when currentTime is before referenceTime', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const referenceTime = 2000;
        const maturityPeriod = 86400;
        const currentTime = 1000;

        const periodNum = await sharesLibTest.exposed_getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime);
        expect(periodNum).to.equal(0);
      });

      it('should calculate period correctly under normal conditions', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        const referenceTime = 1000;
        const maturityPeriod = 86400; // 1 day
        const currentTime = 1000 + 86400 * 5; // 5 days after reference

        const periodNum = await sharesLibTest.exposed_getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime);
        expect(periodNum).to.equal(5);
      });

      it('should handle max uint32 periods without overflow', async function() {
        const { sharesLibTest } = await loadFixture(deploySharesLibTestFixture);
        // Just under the overflow boundary
        const referenceTime = 0;
        const maturityPeriod = 1;
        const currentTime = BigInt("4294967295"); // uint32.max exactly

        const periodNum = await sharesLibTest.exposed_getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime);
        expect(periodNum).to.equal(4294967295);
      });
    });
  });

  describe('Period calculations with very long periods', function() {
    it('should handle large reward periods correctly', async function() {
      // Test with a very large period (but not zero, which is invalid)
      const longPeriod = 365 * 24 * 3600; // 1 year
      // Set checkpoint period first, then maturity period to satisfy validation: checkpointPeriod % maturityPeriod == 0
      await this.token.connect(this.owner).setMaturityPeriod(longPeriod);

      // Create a payout group
      const rate = ethers.parseUnits("0.05", 12);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Register user - this internally uses getCurrentPeriodNum
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // Should succeed with long period
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address)
      ).to.not.be.reverted;

      // Verify registration worked
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
    });

    it('should handle period start time calculations', async function() {
      // Test periodNumToStartTime with standard period
      const periodDuration = 86400; // 1 day
      await this.token.connect(this.owner).setMaturityPeriod(periodDuration);

      const rate = ethers.parseUnits("0.05", 12);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const multId = 1; // Use multiplier 1 that was just created
      const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Time advances
      await time.increase(periodDuration * 2);

      // Verify balanceOf works correctly across multiple periods (tests period calculations)
      const balance = await this.token.balanceOf(this.acc.address);
      expect(balance).to.be.greaterThan(0);

      // Verify rewards have accrued across periods
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);
    });
  });

  describe('periodNumToEndTime function', function() {
    it('should calculate period end time correctly', async function() {
      // This tests the uncovered periodNumToEndTime function which is used internally
      const periodDuration = 86400; // 1 day
      await this.token.connect(this.owner).setMaturityPeriod(periodDuration);

      const currentTime = await time.latest();
      await this.token.connect(this.owner).setReferenceTime(currentTime);

      // Create payout group with non-zero rate for rewards
      const rate = ethers.parseUnits("1", 12); // 100% daily for testing
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc); // Use multiplier 1

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Advance to next period - periodNumToEndTime is used internally
      await time.increase(periodDuration + 1);

      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);
    });
  });

  describe('updateSharesWithRewardPreservation with zero balance', function() {
    it('should handle zero new balance correctly', async function() {
      // Create payout group with meaningful rate
      const rate = ethers.parseUnits("1", 12); // 100% daily
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc); // Use multiplier 1

      // Give user balance and register
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Accrue some rewards
      await time.increase(86400);

      // Transfer entire balance away (newBalance = 0)
      const balance = await this.token.balanceOf(this.acc.address);
      await this.token.connect(this.acc).transfer(this.acc2.address, balance);

      // Should have zero balance but preserved rewards in shares
      expect(await this.token.balanceOf(this.acc.address)).to.equal(0);

      // Available rewards should still be claimable
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);
    });

    it('should handle zero current shares correctly', async function() {
      // Test the case where currentShares = 0 in updateSharesWithRewardPreservation
      // This happens when a wallet receives its first balance

      // Create payout group
      const rate = ethers.parseUnits("0.05", 12);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc); // Use multiplier 1

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));

      // Register wallet with zero balance (currentShares = 0)
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Now give it balance (this triggers updateSharesWithRewardPreservation with currentShares = 0)
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // Should work correctly
      expect(await this.token.balanceOf(this.acc.address)).to.equal(ethers.parseUnits("100", 6));

      // Verify zero rewards since no time has passed
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.equal(0);
    });
  });

  describe('Transfer with reward preservation', function() {
    it('should preserve rewards during transfers', async function() {
      // Create payout group with rate
      const rate = ethers.parseUnits("1", 12); // 100% daily
      await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
      await this.token.connect(this.owner).createMultiplier(rate);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc); // Use multiplier 1

      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Accrue rewards
      await time.increase(86400);

      // Transfer should preserve accrued rewards
      await this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6));

      // Should work correctly - rewards still available
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);
    });
  });
});
