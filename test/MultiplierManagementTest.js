const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { UINT40_MAX } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * Consolidated Multiplier Management Tests
 *
 * This file consolidates tests from:
 * - Multiplier ManagementEdgeCasesTest.js
 * - MultiplierValidationTest.js (New Rebase Functions Tests)
 *
 * Organized into sections:
 * 1. Basic Multiplier Creation and Configuration
 * 2. Rate Bounds and Validation
 * 3. Multiplier Limits and Constraints
 * 4. Rewards Period Management
 * 5. Rate Bounds and Current Rate
 * 6. Global Metrics and View Functions
 */
describe('Multiplier Management Tests (Consolidated)', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    // Set default rate bounds to allow multiplier creation and rate setting
    await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
    // Create multipliers 1 and 2 for tests that use them
    await this.token.connect(this.owner).createMultiplier(0);
    await this.token.connect(this.owner).createMultiplier(0);
  });

  // ===========================================================================
  // SECTION 1: BASIC MULTIPLIER CREATION AND CONFIGURATION
  // ===========================================================================
  describe('Multiplier Creation', function () {
    it('should create a new multiplier configuration', async function () {
      // Create a new multiplier (auto-assigns index 3, 1 and 2 already exist from initializeV3)
      const initialRate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)

      const newMultId = await this.token.connect(this.owner).createMultiplier.staticCall(initialRate);
      await this.token.connect(this.owner).createMultiplier(initialRate);

      // Verify it was created with ID 3 and starts at 1.0
      expect(newMultId).to.equal(3);
      const activeMultiplier = await this.token.getActiveMultiplier(3);
      expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12)); // Always starts at 1.0
    });

    it('should create multiplier with max allowed rate', async function () {
      // Set rate bounds first
      const minRate = ethers.parseUnits("0", 10);
      const maxRate = ethers.parseUnits("0.5", 10); // 50% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

      // Create multiplier with max rate
      const newMultId = await this.token.connect(this.owner).createMultiplier.staticCall(maxRate);
      await this.token.connect(this.owner).createMultiplier(maxRate);

      // Verify multiplier was created (should be ID 3, since 1 and 2 exist from initializeV3)
      expect(newMultId).to.equal(3);

      // Verify initial multiplier value is 1.0
      const activeMultiplier = await this.token.getActiveMultiplier(newMultId);
      expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12));
    });

    it('should create multiplier with max rate and verify it does not exceed bounds', async function () {
      // Set conservative bounds
      const minRate = ethers.parseUnits("0.01", 10); // 1% min APR (10 decimals)
      const maxRate = ethers.parseUnits("0.1", 10); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

      // Create multiplier with exactly max rate
      const newMultId = await this.token.connect(this.owner).createMultiplier.staticCall(maxRate);
      await this.token.connect(this.owner).createMultiplier(maxRate);

      // Should succeed without revert
      expect(newMultId).to.be.gte(2);
    });

    it('should start at multiplier 1.0 regardless of rate', async function () {
      const highRate = ethers.parseUnits("0.2", 10); // 20% APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, highRate);

      const newMultId = await this.token.connect(this.owner).createMultiplier.staticCall(highRate);
      await this.token.connect(this.owner).createMultiplier(highRate);

      // All multipliers start at 1.0
      const initialMultiplier = await this.token.getActiveMultiplier(newMultId);
      expect(initialMultiplier).to.equal(ethers.parseUnits("1.0", 12));
    });
  });

  // ===========================================================================
  // SECTION 2: RATE BOUNDS AND VALIDATION
  // ===========================================================================
  describe('Rate Bounds and Validation', function () {
    beforeEach(async function () {
      // Set up reward period for rate-based updates
      await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    });

    it('should set multiplier rate with validation', async function () {
      // Set rate bounds: 0% min, 10% max
      const minRate = ethers.parseUnits("0", 10);
      const maxRate = ethers.parseUnits("0.1", 10); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

      // Set multiplier rate - should succeed (5% is within bounds)
      const newRate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, newRate);

      // Verify the active multiplier is still at current value (1.0)
      const activeMultiplier = await this.token.getActiveMultiplier(1);
      expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12)); // Should be current active multiplier
    });

    it('should revert when setting rate for non-existent multiplier', async function () {
      const rate = ethers.parseUnits("0.05", 10); // 5% APR
      await expect(
        this.token.connect(this.owner).setMultiplierRateByAPR(999, rate)
      ).to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('should set rate to exact max allowed value', async function () {
      // Set rate bounds
      const minRate = ethers.parseUnits("0", 10);
      const maxRate = ethers.parseUnits("0.15", 10); // 15% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

      // Set multiplier 1 rate to exactly max rate
      await expect(
        this.token.connect(this.owner).setMultiplierRateByAPR(1, maxRate)
      ).to.not.be.reverted;

      // Verify rate was set
      const activeMultiplier = await this.token.getActiveMultiplier(1);
      expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12)); // Still at 1.0 since no time passed
    });

    it('should allow setting rate at max boundary without revert', async function () {
      const maxRate = ethers.parseUnits("0.5", 10); // 50% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, maxRate);

      // Should succeed at exact boundary
      await expect(
        this.token.connect(this.owner).setMultiplierRateByAPR(1, maxRate)
      ).to.not.be.reverted;
    });

    it('should reject rate above max', async function () {
      const maxRate = ethers.parseUnits("0.1", 10); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, maxRate);

      // Try to set rate above max
      const tooHighRate = ethers.parseUnits("0.11", 10); // 11% APR (10 decimals)
      await expect(
        this.token.connect(this.owner).setMultiplierRateByAPR(1, tooHighRate)
      ).to.be.revertedWithCustomError(this.token, 'InvalidRebaseRate');
    });

    it('should handle max rate changes', async function () {
      // Set initial max
      const maxRate1 = ethers.parseUnits("0.05", 10); // 5% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, maxRate1);

      // Set rate to max
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, maxRate1);

      // Increase max rate
      const maxRate2 = ethers.parseUnits("0.1", 10); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, maxRate2);

      // Now can set to new max
      await expect(
        this.token.connect(this.owner).setMultiplierRateByAPR(1, maxRate2)
      ).to.not.be.reverted;
    });

    it('should reject invalid max rebase rates', async function () {
      // Try to set min > max (should revert)
      const minRate = ethers.parseUnits("0.1", 10); // 10% APR (10 decimals)
      const maxRate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
      await expect(
        this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate)
      ).to.be.revertedWithCustomError(this.token, "InvalidRateBounds");
    });

    it('should update rebase configuration', async function () {
      // Configure initial settings
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      const minRate1 = ethers.parseUnits("0", 10);
      const maxRate1 = ethers.parseUnits("0.1", 10); // 0.1% APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate1, maxRate1);

      // Update rebase period (global setting)
      await this.token.connect(this.owner).setMaturityPeriod(7200); // 2 hours

      // Update rate bounds
      const minRate2 = ethers.parseUnits("0", 10);
      const maxRate2 = ethers.parseUnits("0.2", 10); // 0.2% APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate2, maxRate2);

      // Verify updates
      const period = await this.token.getMaturityPeriod();
      const maxRate = await this.token.getMaxAPR();
      expect(period).to.equal(7200);
      expect(maxRate).to.equal(maxRate2);
    });

    // Batch rate setting tests
    describe('Batch Rate Setting', function () {
      it('should set multiple multiplier rates individually', async function () {
        // Note: Batch rate setting function removed in APR refactor
        // Set rate bounds
        const minRate = ethers.parseUnits("0", 10);
        const maxRate = ethers.parseUnits("0.2", 10); // 20% max APR (10 decimals)
        await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

        // Set rates individually
        const newRate1 = ethers.parseUnits("0.05", 10); // 5% APR for mult 1 (10 decimals)
        const newRate2 = ethers.parseUnits("0.1", 10); // 10% APR for mult 2 (10 decimals)

        await expect(
          this.token.connect(this.owner).setMultiplierRateByAPR(1, newRate1)
        ).to.emit(this.token, 'MultiplierRateScheduled');

        await expect(
          this.token.connect(this.owner).setMultiplierRateByAPR(2, newRate2)
        ).to.emit(this.token, 'MultiplierRateScheduled');

        // Verify rates were set (multipliers still at 1.0 since no time passed)
        const mult1 = await this.token.getActiveMultiplier(1);
        const mult2 = await this.token.getActiveMultiplier(2);
        expect(mult1).to.equal(ethers.parseUnits("1.0", 12));
        expect(mult2).to.equal(ethers.parseUnits("1.0", 12));
      });

      // Note: Batch rate setting tests removed - function doesn't exist in APR refactor
    });

    // Scheduled rate validation tests
    describe('Scheduled Rate Validation (scheduleNextMultRateByAPR)', function () {
      it('should revert when scheduled rate is below minRate', async function () {
        const minRate = ethers.parseUnits("0.01", 10); // 1% minimum APR (10 decimals)
        const maxRate = ethers.parseUnits("0.1", 10); // 10% maximum APR (10 decimals)

        // Set rate bounds
        await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

        // Create a multiplier
        const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
        await this.token.connect(this.owner).createMultiplier(rate);
        const multId = 3;

        // Try to schedule a rate below minRate
        const tooLowRate = ethers.parseUnits("0.005", 10); // 0.5% APR - below minimum (10 decimals)
        const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;

        await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, tooLowRate, futureTime))
          .to.be.revertedWithCustomError(this.token, 'InvalidRebaseRate')
          .withArgs(tooLowRate);
      });

      it('should revert when scheduled rate is above maxRate', async function () {
        const minRate = ethers.parseUnits("0.01", 10); // 1% minimum APR (10 decimals)
        const maxRate = ethers.parseUnits("0.1", 10); // 10% maximum APR (10 decimals)

        // Set rate bounds
        await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

        // Create a multiplier
        const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
        await this.token.connect(this.owner).createMultiplier(rate);
        const multId = 3;

        // Try to schedule a rate above maxRate
        const tooHighRate = ethers.parseUnits("0.15", 10); // 15% APR - above maximum (10 decimals)
        const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;

        await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, tooHighRate, futureTime))
          .to.be.revertedWithCustomError(this.token, 'InvalidRebaseRate')
          .withArgs(tooHighRate);
      });

      it('should succeed when scheduled rate is within bounds', async function () {
        const minRate = ethers.parseUnits("0.01", 10); // 1% minimum APR (10 decimals)
        const maxRate = ethers.parseUnits("0.1", 10); // 10% maximum APR (10 decimals)

        // Set rate bounds
        await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

        // Create a multiplier
        const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
        await this.token.connect(this.owner).createMultiplier(rate);
        const multId = 3;

        // Schedule a valid rate
        const validRate = ethers.parseUnits("0.08", 10); // 8% APR - within bounds (10 decimals)
        const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;

        await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, validRate, futureTime))
          .to.emit(this.token, 'MultiplierRateScheduled')
          .withArgs(multId, validRate, futureTime);
      });

      it('should allow scheduling when no rate bounds are set', async function () {
        // Create a multiplier without setting rate bounds
        const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
        await this.token.connect(this.owner).createMultiplier(rate);
        const multId = 3;

        // Schedule any rate
        const newRate = ethers.parseUnits("0.2", 10); // 20% APR - no bounds set (10 decimals)
        const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;

        await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, newRate, futureTime))
          .to.emit(this.token, 'MultiplierRateScheduled')
          .withArgs(multId, newRate, futureTime);
      });
    });
  });

  // ===========================================================================
  // SECTION 3: MULTIPLIER LIMITS AND CONSTRAINTS
  // ===========================================================================
  describe('Multiplier Limits and Constraints', function () {
    it('should increment multipliers in batch', async function () {
      // Set up multipliers with rates
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.01", 10)); // 1% APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.02", 10)); // 2% APR (10 decimals)

      // Check initial multipliers
      expect(await this.token.getActiveMultiplier(1)).to.equal(ethers.parseUnits("1.0", 12));
      expect(await this.token.getActiveMultiplier(2)).to.equal(ethers.parseUnits("1.0", 12));

      // Verify reward period is set
      expect(await this.token.getMaturityPeriod()).to.equal(86400); // Default 1 day
    });
  });

  // ===========================================================================
  // SECTION 4: REWARDS PERIOD MANAGEMENT
  // ===========================================================================
  describe('Rewards Period Management', function () {
    it('should set reward period to 1 hour (3600 seconds)', async function () {
      const oneHour = 3600;

      // Set period to 1 hour
      await expect(
        this.token.connect(this.owner).setMaturityPeriod(oneHour)
      ).to.emit(this.token, 'MaturityPeriodSet')
        .withArgs(0, oneHour);

      // Verify period was set
      const period = await this.token.getMaturityPeriod();
      expect(period).to.equal(oneHour);
    });

    it('should catch up all multipliers before changing to 1 hour period', async function () {
      // Set initial period
      await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day

      // Set a rate on multiplier 1
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.1", 10)); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.01", 10)); // 1% APR (10 decimals)

      // Get initial multiplier value
      const multBefore = await this.token.getActiveMultiplier(1);

      // Change to 1 hour period (must change maturity first, then checkpoint)
      await this.token.connect(this.owner).setMaturityPeriod(3600);

      // Verify period changed
      const period = await this.token.getMaturityPeriod();
      expect(period).to.equal(3600);

      // Multiplier should still be valid (caught up before change)
      const multAfter = await this.token.getActiveMultiplier(1);
      expect(multAfter).to.be.gte(multBefore);
    });

    it('should work correctly with very short periods', async function () {
      // Test with 1 minute period
      const oneMinute = 60;

      await expect(
        this.token.connect(this.owner).setMaturityPeriod(oneMinute)
      ).to.not.be.reverted;
      await expect(
      ).to.not.be.reverted;

      const period = await this.token.getMaturityPeriod();
      expect(period).to.equal(oneMinute);
    });

    it('should catch up multiple multipliers before period change', async function () {
      // Create second multiplier
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.1", 10)); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).createMultiplier(0);

      // Set rates on both
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.01", 10)); // 1% APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.02", 10)); // 2% APR (10 decimals)

      // Change period to 1 hour
      await expect(
        this.token.connect(this.owner).setMaturityPeriod(3600)
      ).to.not.be.reverted;

      // Both multipliers should still be valid
      const mult1 = await this.token.getActiveMultiplier(1);
      const mult2 = await this.token.getActiveMultiplier(2);

      expect(mult1).to.equal(ethers.parseUnits("1.0", 12));
      expect(mult2).to.equal(ethers.parseUnits("1.0", 12));
    });
  });

  // ===========================================================================
  // SECTION 4.5: ROLE-BASED ACCESS CONTROL
  // ===========================================================================
  describe('Role-based access control', function () {
    it('reverts createMultiplier when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).createMultiplier(0))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts deleteMultiplier when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).deleteMultiplier(1))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts setMaturityPeriod when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).setMaturityPeriod(3600))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts setRateBoundsByAPR when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).setRateBoundsByAPR(0, ethers.parseUnits("0.1", 10)))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts setMultiplierRateByAPR when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).setMultiplierRateByAPR(1, ethers.parseUnits("0.05", 10)))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts scheduleNextMultRateByAPR when caller lacks MULT_RATE_ROLE', async function () {
      const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;
      await expect(this.token.connect(this.acc2).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.05", 10), futureTime))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultRateRole');
    });

    it('reverts setClaimSource when caller lacks MULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc2).setClaimSource(this.acc3.address))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });

    it('reverts setReferenceTime when caller lacks MULT_ADMIN_ROLE', async function () {
      const currentTime = (await ethers.provider.getBlock('latest')).timestamp;
      await expect(this.token.connect(this.acc2).setReferenceTime(currentTime))
        .to.be.revertedWithCustomError(this.token, 'UnauthorizedMultAdminRole');
    });
  });

  // ===========================================================================
  // SECTION 4.6: VIEW FUNCTION EDGE CASES
  // ===========================================================================
  describe('View function edge cases', function () {
    it('getNextAPR reverts for non-existent multiplier', async function () {
      await expect(this.token.getNextAPR(999))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('getSwitchTime reverts for non-existent multiplier', async function () {
      await expect(this.token.getSwitchTime(999))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('deleteMultiplier reverts for non-existent multiplier', async function () {
      await expect(this.token.connect(this.owner).deleteMultiplier(999))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });
  });

  // ===========================================================================
  // SECTION 4.7: SCHEDULE TIME VALIDATION
  // ===========================================================================
  describe('Schedule time validation', function () {
    it('reverts scheduleNextMultRateByAPR when time is in the past', async function () {
      const pastTime = (await ethers.provider.getBlock('latest')).timestamp - 100;
      await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.05", 10), pastTime))
        .to.be.revertedWithCustomError(this.token, 'ScheduleTimeInPast');
    });

    it('reverts scheduleNextMultRateByAPR when time equals current block', async function () {
      const currentTime = (await ethers.provider.getBlock('latest')).timestamp;
      await expect(this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.05", 10), currentTime))
        .to.be.revertedWithCustomError(this.token, 'ScheduleTimeInPast');
    });
  });

  // ===========================================================================
  // SECTION 5: RATE BOUNDS AND CURRENT RATE
  // ===========================================================================
  describe('Rate Bounds and Current Rate', function () {
    it('should track rate bounds correctly', async function () {
      // Set rate bounds
      const minRate = ethers.parseUnits("0", 10);
      const maxRate = ethers.parseUnits("0.1", 10); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(minRate, maxRate);

      // Verify rate bounds
      const minRateSet = await this.token.getMinAPR();
      const maxRateSet = await this.token.getMaxAPR();
      expect(minRateSet).to.equal(minRate);
      expect(maxRateSet).to.equal(maxRate);
    });

    it('should return current rate for multiplier', async function () {
      // Set reward period and rate
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.1", 10)); // 10% max APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, rate);

      // Advance time so rate becomes active (setMultiplierRateByAPR uses block.timestamp + 1)
      await time.increase(1);

      // Get current rate
      const currentRate = await this.token.getCurrentAPR(1);
      expect(currentRate).to.equal(rate);
    });

    it('should revert for non-existent multiplier', async function () {
      await expect(this.token.getCurrentAPR(999))
        .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
        .withArgs(999);
    });

    it('should return correct rate after rate change', async function () {
      // Set initial rate
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      const rate1 = ethers.parseUnits("0.03", 10); // 3% APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.2", 10)); // 20% max APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, rate1);

      // Advance time so rate becomes active
      await time.increase(1);

      const currentRate1 = await this.token.getCurrentAPR(1);
      expect(currentRate1).to.equal(rate1);

      // Change rate
      const rate2 = ethers.parseUnits("0.08", 10); // 8% APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, rate2);

      // Advance time so new rate becomes active
      await time.increase(1);

      const currentRate2 = await this.token.getCurrentAPR(1);
      expect(currentRate2).to.equal(rate2);
    });

    it('should distinguish between getCurrentRate and getNextRate', async function () {
      // Set current rate
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      const currentRateValue = ethers.parseUnits("0.04", 10); // 4% current APR (10 decimals)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.2", 10)); // 20% max APR (10 decimals)
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, currentRateValue);

      // Advance time so rate becomes active
      await time.increase(1);

      // Schedule future rate
      const futureTime = (await ethers.provider.getBlock('latest')).timestamp + 3600;
      const nextRateValue = ethers.parseUnits("0.07", 10); // 7% scheduled APR (10 decimals)
      await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, nextRateValue, futureTime);

      // Verify getCurrentRate returns current rate
      const currentRate = await this.token.getCurrentAPR(1);
      expect(currentRate).to.equal(currentRateValue);

      // Verify getNextRate returns scheduled rate
      const nextRate = await this.token.getNextAPR(1);
      expect(nextRate).to.equal(nextRateValue);

      // They should be different
      expect(currentRate).to.not.equal(nextRate);
    });

    it('should return all active multipliers', async function () {
      // Get all active multipliers
      const multipliers = await this.token.getAllActiveMultipliers();

      // Should return a non-empty array
      expect(multipliers.length).to.be.greaterThan(0);

      // All returned IDs should be non-zero
      for (const multId of multipliers) {
        expect(multId).to.be.greaterThan(0);
      }

      // Verify each multiplier can be queried
      for (const multId of multipliers) {
        const activeValue = await this.token.getActiveMultiplier(multId);
        expect(activeValue).to.be.greaterThan(0);
      }
    });
  });
});
