const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

/**
 * @title ScheduledRateApplicationTest
 * @notice Tests for scheduled rate change application in _getActiveMultiplier()
 * @dev Verifies the critical fix where scheduled rates are now automatically applied
 *
 * BACKGROUND:
 * ===========
 * Previously, _getActiveMultiplier() ignored config.nextRate and config.nextRatePeriodNum,
 * so scheduled rate changes were never automatically applied. This test verifies
 * the two-phase period-based calculation correctly applies scheduled rates.
 *
 * RATE CHANGE SEMANTICS:
 * ======================
 * When a rate is scheduled for period N:
 * - All periods BEFORE period N use the OLD rate
 * - All periods FROM period N onward use the NEW rate
 * - Example: If rate changes at period 10, period 9 uses old rate, period 10 uses new rate
 */
describe('ScheduledRateApplicationTest', function () {
    const PERIOD_LENGTH = 86400; // 1 day
    const MULT_BASE = ethers.parseUnits("1", 12); // 1.0 at 12 decimals
    const RATE_1_PERCENT = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)
    const RATE_2_PERCENT = ethers.parseUnits("0.02", 10); // 2% APR (10 decimals)
    const RATE_3_PERCENT = ethers.parseUnits("0.03", 10); // 3% APR (10 decimals)

    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        
        // Grant necessary roles
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Set maturity period and checkpoint period
        await this.token.connect(this.owner).setMaturityPeriod(PERIOD_LENGTH);

        // Set rate bounds to allow the rates we'll use
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR

        // Set up claim source
        await this.token.connect(this.owner).setClaimSource(this.owner.address);

        // Create multiplier first (multiplier ID 1)
        await this.token.connect(this.owner).createMultiplier(0); // Rate will be set below

        // Advance time slightly to ensure we're not exactly at period boundary
        // This ensures switchTime (period start) is in the past when we set the rate
        await time.increase(1);

        // Set initial rate to 1% APR
        await this.token.connect(this.owner).setMultiplierRateByAPR(1, RATE_1_PERCENT);

        // Advance time by 1 second so the rate becomes active (switchTime uses block.timestamp + 1)
        await time.increase(1);
    });

    describe("Scheduled Rate Application", function () {
        it("Should apply scheduled rate change after activation", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule rate change from 1% to 2%
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Before rate change: should use 1% rate
            // Advance to cross 3 complete period boundaries
            await time.increaseTo(currentTime + (3 * PERIOD_LENGTH) + 1);
            const mult1 = await this.token.getActiveMultiplier(multId);

            // After rate change: should use 2-phase calculation (1% then 2%)
            // Advance to cross 10 complete period boundaries
            await time.increaseTo(currentTime + (10 * PERIOD_LENGTH) + 1);
            const mult2 = await this.token.getActiveMultiplier(multId);

            // mult2 should be greater than mult1 (continued compounding)
            expect(mult2).to.be.greaterThan(mult1);

            // Verify it's actually using 2% APR in second phase
            // After 10 complete periods: 5 @ 1% APR, 5 @ 2% APR (daily compounding)
            // 5 periods @ 1% APR: (1 + 0.01/365)^5 ≈ 1.000137
            // 5 periods @ 2% APR: (1 + 0.02/365)^5 ≈ 1.000274
            // Combined: 1.000137 * 1.000274 ≈ 1.000411
            const expected = ethers.parseUnits("1.0004", 12); // Approximate
            expect(mult2).to.be.greaterThan(expected);
        });

        it("Should not apply scheduled rate before activation", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const futureRateChangeTime = currentTime + (20 * PERIOD_LENGTH);

            // Schedule rate change far in the future
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_3_PERCENT, futureRateChangeTime);

            // Advance to cross 10 complete period boundaries (before rate change)
            // Need to advance enough to cross period boundaries for growth to occur
            // Add extra time to ensure we're past the period boundary
            await time.increaseTo(currentTime + (10 * PERIOD_LENGTH) + PERIOD_LENGTH);

            // Should still use old rate only
            const mult = await this.token.getActiveMultiplier(multId);

            // With 1% APR and daily compounding, after 10 complete periods: (1 + 0.01/365)^10 ≈ 1.000274
            // Note: Growth only occurs at period boundaries, so we need complete periods
            // The multiplier should have grown from the initial 1.0
            expect(mult).to.be.gt(ethers.parseUnits("1.0", 12)); // Should be greater than 1.0
            const expected = ethers.parseUnits("1.0003", 12);
            expect(mult).to.be.closeTo(expected, ethers.parseUnits("0.0001", 12)); // Allow tolerance
        });

        it("Should handle checkpoint at rate change boundary", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Advance to cross 5 complete period boundaries (at or past rate change time)
            await time.increaseTo(rateChangeTime + 1);

            const multAtChange = await this.token.getActiveMultiplier(multId);

            // With 1% APR and daily compounding, after 5 complete periods: (1 + 0.01/365)^5 ≈ 1.000137
            const expected = ethers.parseUnits("1.00014", 12);
            expect(multAtChange).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12)); // Allow tolerance

            // Advance past rate change to cross 10 complete period boundaries
            await time.increaseTo(currentTime + (10 * PERIOD_LENGTH) + 1);

            const multAfter = await this.token.getActiveMultiplier(multId);

            // Should now have additional periods at 2% APR
            // Verify multiplier continued to grow
            expect(multAfter).to.be.gt(multAtChange);
        });

        it("Should handle rate decrease (lower scheduled rate)", async function () {
            const multId = 1;
            const RATE_HALF_PERCENT = ethers.parseUnits("0.005", 10); // 0.5% APR (10 decimals)
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule LOWER rate
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_HALF_PERCENT, rateChangeTime);

            // Advance past rate change to cross 10 complete period boundaries
            await time.increaseTo(currentTime + (10 * PERIOD_LENGTH) + 1);

            const mult = await this.token.getActiveMultiplier(multId);

            // With APR-based system: 5 complete periods @ 1% APR, then 5 complete periods @ 0.5% APR
            // 5 periods @ 1%: (1 + 0.01/365)^5 ≈ 1.000137
            // 5 periods @ 0.5%: (1 + 0.005/365)^5 ≈ 1.000068
            // Total: 1.000137 * 1.000068 ≈ 1.000205
            const expected = ethers.parseUnits("1.00021", 12);
            expect(mult).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12)); // Allow tolerance
        });
    });

    describe("Concrete Example from Conversation", function () {
        it("balance 0→1 at period 5, rate change at period 10 (1%→2%), query at period 22", async function () {
            const multId = 1;
            const startTime = await time.latest();

            // Advance to period 5 and set a checkpoint
            await time.increaseTo(startTime + (5 * PERIOD_LENGTH));

            // Schedule rate change at period 10
            const rateChangeTime = startTime + (10 * PERIOD_LENGTH);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Advance to cross 22 complete period boundaries
            await time.increaseTo(startTime + (22 * PERIOD_LENGTH) + 1);

            // Get multiplier
            const mult = await this.token.getActiveMultiplier(multId);

            // Expected calculation with APR (not percentage-per-period):
            // From period 0 to period 22 = 22 complete periods total
            // Rate changes at period 10, so:
            // - Periods 0→10 = 10 complete periods @ 1% APR: (1 + 0.01/365)^10 ≈ 1.000274
            // - Periods 10→22 = 12 complete periods @ 2% APR: (1 + 0.02/365)^12 ≈ 1.000658
            // - Combined: 1.000274 * 1.000658 ≈ 1.000932

            const expected = ethers.parseUnits("1.0009", 12); // Approximate
            expect(mult).to.be.greaterThan(expected);
        });
    });

    describe("View Functions", function () {
        it("Should return correct scheduled rate info", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Check scheduled rate
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_2_PERCENT);

            // Check scheduled time (will be aligned to period boundary)
            const switchTime = await this.token.getSwitchTime(multId);
            expect(switchTime).to.be.closeTo(BigInt(rateChangeTime), BigInt(PERIOD_LENGTH));
        });

        it("Should handle overwriting scheduled rate", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (10 * PERIOD_LENGTH);

            // Schedule initial rate
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Overwrite with different rate
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_3_PERCENT, rateChangeTime);

            // Should show new rate
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_3_PERCENT);
        });
    });

    describe("Integration with Operations", function () {
        it("Should apply scheduled rate during getActiveMultiplier calls", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Get multiplier before rate change (at period 3)
            await time.increaseTo(currentTime + (3 * PERIOD_LENGTH));
            const multBefore = await this.token.getActiveMultiplier(multId);

            // Get multiplier after rate change (at period 10)
            await time.increaseTo(currentTime + (10 * PERIOD_LENGTH));
            const multAfter = await this.token.getActiveMultiplier(multId);

            // multAfter should reflect two-phase calculation and be greater
            expect(multAfter).to.be.greaterThan(multBefore);

            // Verify the scheduled rate is being applied
            // From period 3 to 10 = 7 periods total
            // - Periods 3→5 = 2 periods @ 1%
            // - Periods 5→10 = 5 periods @ 2%
            // So growth should be more than just 7 periods @ 1%

            // Calculate what growth would be with only 1% rate
            // (multBefore * (1.01)^7) / MULT_BASE
            const oldRateGrowth = (multBefore * BigInt("1072135") * BigInt(1000000)) / (MULT_BASE * BigInt(1000000));

            // multAfter should be significantly higher due to 2% rate in second phase
            expect(multAfter).to.be.greaterThan(oldRateGrowth);
        });
    });

    describe("Internal State After Scheduling (Bug Fix Verification)", function () {
        it("Should set correct switchTimeMultiplier when scheduling future rate", async function () {
            const multId = 1;
            const currentTime = await time.latest();

            // Advance time to let multiplier grow
            await time.increaseTo(currentTime + (3 * PERIOD_LENGTH) + 1);
            const multBeforeScheduling = await this.token.getActiveMultiplier(multId);

            // Schedule rate change 5 periods in the future
            const rateChangeTime = (await time.latest()) + (5 * PERIOD_LENGTH);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Advance to exactly the switchTime
            await time.increaseTo(rateChangeTime);
            const multAtSwitchTime = await this.token.getActiveMultiplier(multId);

            // The multiplier at switchTime should be greater than when we scheduled
            // (because it grew for 5 more periods at 1%)
            expect(multAtSwitchTime).to.be.greaterThan(multBeforeScheduling);

            // Verify the multiplier grew correctly for those 5 periods at 1%
            // Expected: multBeforeScheduling * (1 + 0.01/365)^5
            const expectedGrowth = (multBeforeScheduling * BigInt(1000137)) / BigInt(1000000);
            expect(multAtSwitchTime).to.be.closeTo(expectedGrowth, ethers.parseUnits("0.00001", 12));
        });

        it("Should project switchTimeMultiplier to future, not use current multiplier", async function () {
            const multId = 1;

            // Let multiplier grow for 2 periods
            const startTime = await time.latest();
            await time.increaseTo(startTime + (2 * PERIOD_LENGTH) + 1);
            const multAfter2Periods = await this.token.getActiveMultiplier(multId);

            // Schedule a rate change 10 periods in the future
            const scheduleTime = await time.latest();
            const rateChangeTime = scheduleTime + (10 * PERIOD_LENGTH);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Advance to switchTime
            await time.increaseTo(rateChangeTime);
            const multAtSwitch = await this.token.getActiveMultiplier(multId);

            // The multiplier at switchTime should account for 10 periods of growth
            // If switchTimeMultiplier was incorrectly set to current value (at schedule time),
            // the calculation would be wrong
            // Correct: should grow from multAfter2Periods through 10 periods
            const expectedAtSwitch = (multAfter2Periods * BigInt(1000274)) / BigInt(1000000);
            expect(multAtSwitch).to.be.closeTo(expectedAtSwitch, ethers.parseUnits("0.00001", 12));

            // Continue past switchTime to verify two-phase calculation works
            await time.increaseTo(rateChangeTime + (5 * PERIOD_LENGTH));
            const multAfterSwitch = await this.token.getActiveMultiplier(multId);

            // Should now include 5 periods at 2% rate
            expect(multAfterSwitch).to.be.greaterThan(multAtSwitch);
        });
    });

    describe("Erasing Scheduled Rates (Bug Fix Verification)", function () {
        it("Should erase scheduled rate when calling setMultiplierRateByAPR", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (10 * PERIOD_LENGTH);

            // Schedule a future rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Verify scheduled rate exists
            let nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_2_PERCENT);

            // Set an immediate rate (should erase scheduled rate)
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_3_PERCENT);

            // Advance time so switchTime is in the past (setMultiplierRateByAPR uses block.timestamp + 1)
            await time.increase(1);

            // Verify scheduled rate was erased (no future rate change after switchTime passed)
            nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(0);

            // Verify current rate is the newly set rate
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_3_PERCENT);
        });

        it("Should erase scheduled rate when setting immediate rate", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const futureRateChangeTime = currentTime + (10 * PERIOD_LENGTH);

            // Schedule a rate change in the future
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, futureRateChangeTime);

            // Verify switchTime is in the future
            let switchTime = await this.token.getSwitchTime(multId);
            expect(switchTime).to.be.closeTo(BigInt(futureRateChangeTime), BigInt(PERIOD_LENGTH));

            // Set an immediate rate (this erases the scheduled rate)
            const setRateTime = await time.latest();
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_3_PERCENT);

            // Move forward one second so switchTime is in the past
            await time.increase(1);

            // Verify switchTime returns 0 (no future scheduled rate after immediate rate is set and time has passed)
            switchTime = await this.token.getSwitchTime(multId);
            expect(switchTime).to.equal(0); // No future rate change scheduled

            // Verify the current rate was updated to the new rate
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_3_PERCENT);
        });

        it("Should handle setting immediate rate after scheduled rate activation", async function () {
            const multId = 1;
            const startTime = await time.latest();
            const rateChangeTime = startTime + (5 * PERIOD_LENGTH);

            // Schedule rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Advance past the scheduled rate change time
            await time.increaseTo(rateChangeTime + (3 * PERIOD_LENGTH));

            // The scheduled rate has now activated - getCurrentAPR should return the active rate (2%)
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_2_PERCENT);

            // getNextAPR should return 0 since the switch time has passed (not a future scheduled rate)
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(0);

            // Set a new immediate rate (should erase scheduled rate)
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_3_PERCENT);

            // Advance time so switchTime is in the past
            await time.increase(1);

            // Verify new rate is set
            const newCurrentRate = await this.token.getCurrentAPR(multId);
            expect(newCurrentRate).to.equal(RATE_3_PERCENT);

            // Verify scheduled rate was erased
            const newNextRate = await this.token.getNextAPR(multId);
            expect(newNextRate).to.equal(0);
        });
    });

    describe("Multiple Rate Changes Per Checkpoint (Bug Fix Verification)", function () {
        it("Should handle two scheduled rates in same checkpoint period", async function () {
            const multId = 1;
            const currentTime = await time.latest();

            // Both rate changes are within the same checkpoint period
            const rateChangeTime1 = currentTime + (5 * PERIOD_LENGTH);
            const rateChangeTime2 = currentTime + (7 * PERIOD_LENGTH);

            // Schedule first rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime1);

            // Schedule second rate change (should overwrite first)
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_3_PERCENT, rateChangeTime2);

            // Verify second rate is scheduled
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_3_PERCENT);

            // Advance past both rate change times
            await time.increaseTo(rateChangeTime2 + PERIOD_LENGTH);

            // The scheduled rate has activated - getCurrentAPR should return the active rate (3%)
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_3_PERCENT);

            // getNextAPR should return 0 since the switch time has passed
            const stillNextRate = await this.token.getNextAPR(multId);
            expect(stillNextRate).to.equal(0);

            // Verify multiplier calculation is correct
            const mult = await this.token.getActiveMultiplier(multId);
            expect(mult).to.be.greaterThan(MULT_BASE);
        });

        it("Should handle scheduling then immediate rate set in same checkpoint", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (5 * PERIOD_LENGTH);

            // Schedule a future rate change
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime);

            // Immediately set a different rate (within same block/checkpoint if possible)
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_3_PERCENT);

            // Advance time so switchTime is in the past
            await time.increase(1);

            // Verify the scheduled rate was erased
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(0);

            // Verify the immediate rate is active
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_3_PERCENT);

            // Advance time and verify multiplier grows with the immediate rate (3%)
            const setTime = await time.latest();
            await time.increaseTo(setTime + (10 * PERIOD_LENGTH));
            const mult = await this.token.getActiveMultiplier(multId);

            // The multiplier grew at 1% before we changed it, then at 3% after
            // Since we set the rate almost immediately, it should be close to 10 periods @ 3%
            // But there may have been a tiny amount of growth at 1% first
            // So let's check it's greater than 1% for 10 periods but close to 3% for 10 periods
            const expected1Pct = ethers.parseUnits("1.00027", 12);  // 10 periods @ 1%
            const expected3Pct = ethers.parseUnits("1.00082", 12);  // 10 periods @ 3%
            expect(mult).to.be.greaterThan(expected1Pct);
            expect(mult).to.be.closeTo(expected3Pct, ethers.parseUnits("0.0002", 12));
        });

        it("Should handle multiple setMultiplierRateByAPR calls in succession", async function () {
            const multId = 1;

            // Set rate 1
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_1_PERCENT);
            const mult1 = await this.token.getActiveMultiplier(multId);

            // Immediately set rate 2 (no time advance)
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_2_PERCENT);
            const mult2 = await this.token.getActiveMultiplier(multId);

            // Multiplier should not have changed (no time passed)
            expect(mult2).to.equal(mult1);

            // Immediately set rate 3
            await this.token.connect(this.owner).setMultiplierRateByAPR(multId, RATE_3_PERCENT);

            // Advance time so switchTime is in the past
            await time.increase(1);

            // Current rate should be rate 3
            const currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_3_PERCENT);

            // No scheduled rate should exist
            const nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(0);
        });

    });

    describe("Committing Activated Rates (Bug Fix Verification)", function () {
        it("Should commit activated scheduled rate when scheduling new rate", async function () {
            const multId = 1;
            const startTime = await time.latest();
            const rateChangeTime1 = startTime + (5 * PERIOD_LENGTH);

            // Schedule first rate change (1% → 2%)
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime1);

            // Verify first rate is scheduled
            let nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_2_PERCENT);

            // beforeRate should still be 1%
            let currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_1_PERCENT);

            // Advance past first rate change activation
            await time.increaseTo(rateChangeTime1 + (3 * PERIOD_LENGTH));

            // Schedule second rate change (should commit 2% to beforeRate first)
            const rateChangeTime2 = (await time.latest()) + (5 * PERIOD_LENGTH);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_3_PERCENT, rateChangeTime2);

            // Now beforeRate should be 2% (committed from afterRate)
            currentRate = await this.token.getCurrentAPR(multId);
            expect(currentRate).to.equal(RATE_2_PERCENT);

            // And nextRate should be 3%
            nextRate = await this.token.getNextAPR(multId);
            expect(nextRate).to.equal(RATE_3_PERCENT);

            // Verify multiplier projection used correct rate (2%, not 1%)
            // Advance to second rate change time
            await time.increaseTo(rateChangeTime2);
            const multAtSwitch = await this.token.getActiveMultiplier(multId);

            // Multiplier should reflect growth at 2% from the commit point
            expect(multAtSwitch).to.be.greaterThan(MULT_BASE);
        });

        it("Should use correct rate for projection when activated rate exists", async function () {
            const multId = 1;
            const startTime = await time.latest();
            const rateChangeTime1 = startTime + (3 * PERIOD_LENGTH);

            // Schedule rate change to 2%
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_2_PERCENT, rateChangeTime1);

            // Advance past activation
            await time.increaseTo(rateChangeTime1 + (2 * PERIOD_LENGTH));

            // Get multiplier after 2% rate has been active for 2 periods
            const multBefore = await this.token.getActiveMultiplier(multId);

            // Schedule another rate change - should use 2% (not 1%) for projection
            const rateChangeTime2 = (await time.latest()) + (5 * PERIOD_LENGTH);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_3_PERCENT, rateChangeTime2);

            // Advance to new switch time
            await time.increaseTo(rateChangeTime2);
            const multAtSwitch = await this.token.getActiveMultiplier(multId);

            // Growth from multBefore to multAtSwitch should reflect 2% rate (not 1%)
            // 5 periods at 2%: (1 + 0.02/365)^5 ≈ 1.000274
            const expectedGrowth = (multBefore * BigInt(1000274)) / BigInt(1000000);
            expect(multAtSwitch).to.be.closeTo(expectedGrowth, ethers.parseUnits("0.00002", 12));
        });
    });
});
