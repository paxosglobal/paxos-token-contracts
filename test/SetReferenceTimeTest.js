const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { UINT40_MAX } = require('./helpers/testSetup');

describe("setReferenceTime Tests", function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);
        // Set reference time to current time (default is 0 for UTC midnight alignment)
        // This makes period calculations relative to test start time
        const currentTime = await time.latest();
        await this.token.connect(this.owner).setReferenceTime(currentTime);
        // Set rate bounds to allow APR-based multiplier operations
        await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
        // Create default multiplier 1 for tests that use it
        await this.token.connect(this.owner).createMultiplier(0);
    });

    describe("setReferenceTime - Period Preservation", function () {
        it("should recalculate period number when setting new reference time", async function () {
            // Get initial values
            const initialReferenceTime = await this.token.getReferenceTime();
            const initialCurrentPeriod = await this.token.getCurrentPeriodNum();

            // Fast forward 5 days
            await time.increase(5 * 86400);

            const currentPeriodBefore = await this.token.getCurrentPeriodNum();
            expect(currentPeriodBefore).to.equal(5n); // 5 periods have passed

            // Set new reference time to 2 days ago
            // This will recalculate period: (now - (now - 2 days)) / 1 day = 2 periods
            const newReferenceTime = (await time.latest()) - (2 * 86400);

            await expect(this.token.connect(this.owner).setReferenceTime(newReferenceTime))
                .to.emit(this.token, "ReferenceTimeUpdated");

            // Period number is recalculated from new reference time
            const currentPeriodAfter = await this.token.getCurrentPeriodNum();
            // After setting reference to 2 days ago, period = 2 days / 1 day = 2
            expect(currentPeriodAfter).to.equal(2n);

            // Verify reference time changed
            const newRefTime = await this.token.getReferenceTime();
            expect(newRefTime).to.equal(newReferenceTime);
        });

        it("should align periods to midnight UTC", async function () {
            // Fast forward to some random time
            await time.increase(123456);

            const currentPeriodBefore = await this.token.getCurrentPeriodNum();
            expect(currentPeriodBefore).to.be.greaterThan(0n);

            // Calculate last midnight (must be in the past, not future)
            const now = await time.latest();
            const lastMidnight = Math.floor(now / 86400) * 86400;

            await expect(this.token.connect(this.owner).setReferenceTime(lastMidnight))
                .to.emit(this.token, "ReferenceTimeUpdated");

            // Period is recalculated from new reference time
            const currentPeriodAfter = await this.token.getCurrentPeriodNum();
            const expectedPeriod = Math.floor((now - lastMidnight) / 86400);
            expect(currentPeriodAfter).to.equal(BigInt(expectedPeriod));

            // Verify reference time is at midnight boundary
            const newRefTime = await this.token.getReferenceTime();
            expect(Number(newRefTime) % 86400).to.equal(0); // Should be at midnight
        });

        it("should work with reference time = current time", async function () {
            await time.increase(3 * 86400);

            const currentPeriodBefore = await this.token.getCurrentPeriodNum();
            expect(currentPeriodBefore).to.equal(3n);
            
            const now = await time.latest();

            await this.token.connect(this.owner).setReferenceTime(now);

            // When reference time is set to current time, period recalculates to 0
            const currentPeriodAfter = await this.token.getCurrentPeriodNum();
            expect(currentPeriodAfter).to.equal(0n); // (now - now) / 1 day = 0

            // Verify reference time was set correctly
            const newRefTime = await this.token.getReferenceTime();
            expect(newRefTime).to.equal(now);
        });
    });

    describe("setReferenceTime - Error Cases", function () {
        it("should revert if newReferenceTime is in the future", async function () {
            const now = await time.latest();
            const futureTime = now + 86400;

            await expect(
                this.token.connect(this.owner).setReferenceTime(futureTime)
            ).to.be.revertedWithCustomError(this.token, "InvalidReferenceTime");
        });

        it("should allow setting reference time in the past", async function () {
            // Setting reference time in the past is now allowed
            // Period will just be recalculated from the new reference time
            const now = await time.latest();
            const wayInPast = now - (1000 * 86400); // 1000 days ago

            await expect(
                this.token.connect(this.owner).setReferenceTime(wayInPast)
            ).to.emit(this.token, "ReferenceTimeUpdated");
            
            // Period should be recalculated: 1000 days / 1 day = 1000
            const currentPeriod = await this.token.getCurrentPeriodNum();
            expect(currentPeriod).to.equal(1000n);
        });

        it("should revert if caller doesn't have MULT_ADMIN_ROLE", async function () {
            const now = await time.latest();

            await expect(
                this.token.connect(this.recipient).setReferenceTime(now)
            ).to.be.reverted; // Will revert with access control error
        });
    });

    describe("setReferenceTime - Event Emission", function () {
        it("should emit ReferenceTimeUpdated event with correct parameters", async function () {
            await time.increase(5 * 86400);

            const oldReferenceTime = await this.token.getReferenceTime();

            const newReferenceTime = (await time.latest()) - (2 * 86400);

            await expect(this.token.connect(this.owner).setReferenceTime(newReferenceTime))
                .to.emit(this.token, "ReferenceTimeUpdated")
                .withArgs(oldReferenceTime, newReferenceTime);
        });
    });

    describe("setReferenceTime - Multiplier Catchup", function () {
        it("should catch up multipliers before changing reference", async function () {
            // Create a multiplier with a rate
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10)); // 5% APR

            // Mint some tokens (note: claim source is already funded in fixture with 10M tokens)
            // For this test we just need to ensure we have some balance to test with
            // The owner already has tokens from the fixture setup

            // Fast forward 10 days
            await time.increase(10 * 86400);

            // Get multiplier before setReferenceTime
            const multBefore = await this.token.getActiveMultiplier(1);

            // Set new reference time
            const newReferenceTime = (await time.latest()) - (5 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Multiplier should have been caught up and checkpointed
            // The multiplier value shouldn't change from the perspective of getForwardProjectedMultiplier
            const multAfter = await this.token.getActiveMultiplier(1);

            // Should be very close (might have tiny difference due to block time)
            const diff = multAfter > multBefore ? multAfter - multBefore : multBefore - multAfter;
            expect(diff).to.be.lessThan(ethers.parseUnits("0.001", 12)); // Less than 0.1% difference
        });
    });

    describe("setReferenceTime - Getter Functions", function () {
        it("should return correct values from getter functions", async function () {
            await time.increase(3 * 86400);

            const newReferenceTime = (await time.latest()) - 86400;
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            const refTime = await this.token.getReferenceTime();
            const currentPeriodNum = await this.token.getCurrentPeriodNum();

            expect(refTime).to.equal(newReferenceTime);
            // After setting reference time to 1 day ago, current period should be 1 (not 3)
            // because period numbers are calculated from the new reference time
            expect(currentPeriodNum).to.equal(1n);
        });
    });

    describe("setReferenceTime - Edge Cases", function () {
        it("should handle multiple sequential reference time updates", async function () {
            await time.increase(10 * 86400);

            let currentPeriod = await this.token.getCurrentPeriodNum();
            expect(currentPeriod).to.equal(10n);

            // First update - set reference time to 5 days ago
            // Period recalculated: (now - (now - 5 days)) / 1 day = 5
            const newRef1 = (await time.latest()) - (5 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef1);

            currentPeriod = await this.token.getCurrentPeriodNum();
            expect(currentPeriod).to.equal(5n); // Recalculated: 5 days / 1 day = 5

            // Second update - set reference time to 7 days ago
            // Period recalculated: (now - (now - 7 days)) / 1 day = 7
            const newRef2 = (await time.latest()) - (7 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef2);

            currentPeriod = await this.token.getCurrentPeriodNum();
            expect(currentPeriod).to.equal(7n); // Recalculated: 7 days / 1 day = 7

            // Third update - to now
            // Period recalculated: (now - now) / 1 day = 0
            const newRef3 = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(newRef3);

            currentPeriod = await this.token.getCurrentPeriodNum();
            expect(currentPeriod).to.equal(0n); // Recalculated: 0 days / 1 day = 0
        });

        it("should work correctly after setMaturityPeriod", async function () {
            await time.increase(5 * 86400);

            // Change maturity period from 1 day to 2 days
            // Must set checkpointPeriod first (or to same value) before changing maturityPeriod
            await this.token.connect(this.owner).setMaturityPeriod(2 * 86400);

            // Fast forward another 10 days (5 periods at 2-day period)
            await time.increase(10 * 86400);

            const currentPeriodBefore = await this.token.getCurrentPeriodNum();
            // At 2-day periods: (5 days + 10 days) / 2 days = 7.5, rounded down = 7
            expect(currentPeriodBefore).to.equal(7n);

            // Set new reference time to 4 days ago
            // Period recalculated: 4 days / 2 days = 2
            const newReferenceTime = (await time.latest()) - (4 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            const currentPeriodAfter = await this.token.getCurrentPeriodNum();
            expect(currentPeriodAfter).to.equal(2n); // 4 days / 2 days = 2
        });

        it("should preserve scheduled rate period when changing reference time", async function () {
            // Create a multiplier with 10% APR (as fraction at 10 decimals)
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1", 10));

            // Fast forward 5 days to period 5
            await time.increase(5 * 86400);

            // Schedule rate change at period 10 (5 days from now)
            const scheduledTime = (await time.latest()) + (5 * 86400);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.2", 10), scheduledTime);

            // Verify scheduled time before reference change
            const switchTimeBefore = await this.token.getSwitchTime(1);

            // Fast forward 2 days and change reference time
            // After 2 days, we're at period 7, and we set reference to 3 days ago
            await time.increase(2 * 86400);
            const newReferenceTime = (await time.latest()) - (3 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Get the new scheduled time (should represent the same absolute time)
            const switchTimeAfter = await this.token.getSwitchTime(1);

            // Verify: the switch time should be the same absolute time (just reference changed)
            // The switch time should be preserved
            const maturityPeriod = await this.token.getMaturityPeriod();
            expect(Number(switchTimeAfter)).to.be.closeTo(Number(switchTimeBefore), Number(maturityPeriod));
        });
    });

    describe("setReferenceTime - Scheduled Rate Preservation", function () {
        it("should correctly recalculate switchTimeMultiplier with new reference time", async function () {
            // Create a multiplier with 5% APR
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10)); // 5% APR

            // Set the rate explicitly to ensure it's active
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.05", 10));

            // Fast forward 10 days so multiplier grows significantly
            await time.increase(10 * 86400);

            // Get initial multiplier value (should be > 1.0)
            const initialMult = await this.token.getActiveMultiplier(1);
            expect(initialMult).to.be.gt(ethers.parseUnits("1.0", 12));

            // Schedule rate change for 5 days in the future with 10% APR
            const scheduledTime = (await time.latest()) + (5 * 86400);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.1", 10), scheduledTime);

            // Verify scheduled rate exists
            const nextAPRBefore = await this.token.getNextAPR(1);
            const switchTimeBefore = await this.token.getSwitchTime(1);
            expect(nextAPRBefore).to.equal(ethers.parseUnits("0.1", 10));
            expect(switchTimeBefore).to.equal(scheduledTime);

            // Get multiplier just before reference time change
            const multBeforeRefChange = await this.token.getActiveMultiplier(1);

            // Change reference time (shift by 2 days)
            const newReferenceTime = (await time.latest()) - (2 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Verify multiplier value is stable (period boundaries shifted but value shouldn't change much)
            const multAfterRefChange = await this.token.getActiveMultiplier(1);
            const diff = multAfterRefChange > multBeforeRefChange ?
                multAfterRefChange - multBeforeRefChange :
                multBeforeRefChange - multAfterRefChange;
            // Allow small tolerance for block time changes
            expect(diff).to.be.lessThan(ethers.parseUnits("0.001", 12));

            // Verify scheduled rate is preserved
            const nextAPRAfter = await this.token.getNextAPR(1);
            const switchTimeAfter = await this.token.getSwitchTime(1);
            expect(nextAPRAfter).to.equal(ethers.parseUnits("0.1", 10));
            expect(switchTimeAfter).to.equal(scheduledTime); // EXACT equality

            // Advance to just before switch time
            await time.increaseTo(scheduledTime - 10);
            const multBeforeSwitch = await this.token.getActiveMultiplier(1);

            // Advance past switch time
            await time.increaseTo(scheduledTime + 100);
            const multAfterSwitch = await this.token.getActiveMultiplier(1);

            // Multiplier should have grown
            expect(multAfterSwitch).to.be.gt(multBeforeSwitch);

            // Verify the scheduled rate is now active
            const currentAPR = await this.token.getCurrentAPR(1);
            expect(currentAPR).to.equal(ethers.parseUnits("0.1", 10));

            // getSwitchTime should return 0 (rate has been activated)
            const switchTimeActivated = await this.token.getSwitchTime(1);
            expect(switchTimeActivated).to.equal(0);
        });

        it("should preserve scheduled rate when changing reference time (exact verification)", async function () {
            // Create a multiplier with 5% APR
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10));

            // Fast forward 2 days
            await time.increase(2 * 86400);

            // Schedule rate change for 7 days in the future with 15% APR
            const scheduledTime = (await time.latest()) + (7 * 86400);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.15", 10), scheduledTime);

            // Store expected values
            const expectedSwitchTime = scheduledTime;
            const expectedNextAPR = ethers.parseUnits("0.15", 10);

            // Verify scheduled rate exists
            let nextAPR = await this.token.getNextAPR(1);
            let switchTime = await this.token.getSwitchTime(1);
            expect(nextAPR).to.equal(expectedNextAPR);
            expect(switchTime).to.equal(expectedSwitchTime);

            // Change reference time (shift by 3 days)
            const newReferenceTime = (await time.latest()) - (3 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Verify switchTime is EXACTLY preserved (not "close")
            switchTime = await this.token.getSwitchTime(1);
            expect(switchTime).to.equal(expectedSwitchTime); // EXACT equality, no tolerance

            // Verify nextAPR is EXACTLY preserved
            nextAPR = await this.token.getNextAPR(1);
            expect(nextAPR).to.equal(expectedNextAPR); // EXACT equality

            // Advance past scheduled time and verify rate activates correctly
            await time.increaseTo(scheduledTime + 100);

            // Current APR should now be the scheduled rate
            const currentAPR = await this.token.getCurrentAPR(1);
            expect(currentAPR).to.equal(expectedNextAPR);

            // getSwitchTime should return 0 after activation
            switchTime = await this.token.getSwitchTime(1);
            expect(switchTime).to.equal(0);
        });

        it("should preserve exact switchTime timestamp across reference changes", async function () {
            // Create multiplier
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10));

            // Schedule rate for specific timestamp
            const scheduledTime = (await time.latest()) + (10 * 86400);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.12", 10), scheduledTime);

            // Store the exact expected timestamp
            const expectedSwitchTime = scheduledTime;

            // First reference time change
            await time.increase(2 * 86400);
            const newRef1 = (await time.latest()) - (1 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef1);

            // Verify EXACT switchTime preservation
            let switchTime = await this.token.getSwitchTime(1);
            expect(switchTime).to.equal(expectedSwitchTime);

            // Second reference time change
            await time.increase(1 * 86400);
            const newRef2 = (await time.latest()) - (4 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef2);

            // Verify EXACT switchTime preservation again
            switchTime = await this.token.getSwitchTime(1);
            expect(switchTime).to.equal(expectedSwitchTime);

            // Third reference time change
            await time.increase(1 * 86400);
            const newRef3 = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(newRef3);

            // Verify EXACT switchTime preservation again
            switchTime = await this.token.getSwitchTime(1);
            expect(switchTime).to.equal(expectedSwitchTime);

            // Verify nextAPR also preserved through all changes
            const nextAPR = await this.token.getNextAPR(1);
            expect(nextAPR).to.equal(ethers.parseUnits("0.12", 10));
        });

        it("should handle activated rates separately from scheduled rates", async function () {
            // Create two multipliers
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10)); // Mult 1
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10)); // Mult 2

            // Mult 1: Schedule rate for near future (will be activated)
            const nearFuture = (await time.latest()) + 100; // 100 seconds
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.08", 10), nearFuture);

            // Mult 2: Schedule rate for distant future (will remain scheduled)
            const distantFuture = (await time.latest()) + (10 * 86400); // 10 days
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(2, ethers.parseUnits("0.12", 10), distantFuture);

            // Verify both have scheduled rates
            expect(await this.token.getSwitchTime(1)).to.be.gt(0);
            expect(await this.token.getSwitchTime(2)).to.be.gt(0);

            // Advance past mult 1's scheduled time (activate it)
            await time.increase(200);

            // Mult 1 should have activated (getSwitchTime = 0)
            expect(await this.token.getSwitchTime(1)).to.equal(0);
            expect(await this.token.getNextAPR(1)).to.equal(0);
            expect(await this.token.getCurrentAPR(1)).to.equal(ethers.parseUnits("0.08", 10));

            // Mult 2 should still be scheduled
            expect(await this.token.getSwitchTime(2)).to.equal(distantFuture);
            expect(await this.token.getNextAPR(2)).to.equal(ethers.parseUnits("0.12", 10));

            // Change reference time
            const newReferenceTime = (await time.latest()) - (2 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Mult 1: Activated rate should remain activated (no future scheduled rate)
            expect(await this.token.getSwitchTime(1)).to.equal(0);
            expect(await this.token.getNextAPR(1)).to.equal(0);
            expect(await this.token.getCurrentAPR(1)).to.equal(ethers.parseUnits("0.08", 10));

            // Mult 2: Future scheduled rate should be preserved
            expect(await this.token.getSwitchTime(2)).to.equal(distantFuture);
            expect(await this.token.getNextAPR(2)).to.equal(ethers.parseUnits("0.12", 10));
        });

        it("should preserve scheduled rate across multiple reference time changes", async function () {
            // Create multiplier with scheduled rate 10 days in future
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 10));

            await time.increase(2 * 86400); // Fast forward 2 days

            const scheduledTime = (await time.latest()) + (10 * 86400);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.15", 10), scheduledTime);

            // First reference time change
            await time.increase(1 * 86400);
            let newRef = (await time.latest()) - (1 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef);

            expect(await this.token.getSwitchTime(1)).to.equal(scheduledTime);
            expect(await this.token.getNextAPR(1)).to.equal(ethers.parseUnits("0.15", 10));

            // Second reference time change
            await time.increase(2 * 86400);
            newRef = (await time.latest()) - (3 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef);

            expect(await this.token.getSwitchTime(1)).to.equal(scheduledTime);
            expect(await this.token.getNextAPR(1)).to.equal(ethers.parseUnits("0.15", 10));

            // Third reference time change
            await time.increase(1 * 86400);
            newRef = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(newRef);

            expect(await this.token.getSwitchTime(1)).to.equal(scheduledTime);
            expect(await this.token.getNextAPR(1)).to.equal(ethers.parseUnits("0.15", 10));

            // Advance to activation time and verify rate activates correctly
            await time.increaseTo(scheduledTime + 100);

            expect(await this.token.getCurrentAPR(1)).to.equal(ethers.parseUnits("0.15", 10));
            expect(await this.token.getSwitchTime(1)).to.equal(0);
        });
    });

    describe("setReferenceTime - Bug Fix: switchTime and afterRate must be updated", function () {
        /**
         * This test specifically catches the bug where setReferenceTime() was NOT updating
         * switchTime and afterRate in the else branch (no future scheduled rate).
         *
         * The bug: After setReferenceTime(), the multiplier data would have:
         *   - switchTimeMultiplier = current multiplier value (correct)
         *   - switchTime = OLD timestamp from when rate was last scheduled (WRONG!)
         *   - afterRate = stale value (WRONG!)
         *
         * This violated the invariant that "switchTimeMultiplier is the multiplier AT switchTime".
         *
         * The fix: In the else branch, also update:
         *   - multData.switchTime = block.timestamp
         *   - multData.afterRate = 0
         */
        it("should correctly calculate multiplier growth after setReferenceTime (no scheduled rate)", async function () {
            // Setup: Create multiplier with 5% APR
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            const APR_5_PERCENT = ethers.parseUnits("0.05", 10);

            // Use multiplier 1 (created in fixture) and set its rate
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_5_PERCENT);

            // Let time pass - 10 days so multiplier grows
            await time.increase(10 * 86400);

            // Record multiplier value before setReferenceTime
            const multBeforeRefChange = await this.token.getActiveMultiplier(1);
            expect(multBeforeRefChange).to.be.gt(ethers.parseUnits("1.0", 12)); // Should have grown

            // Call setReferenceTime with a new reference (no scheduled rate exists)
            const newReferenceTime = (await time.latest()) - (5 * 86400); // 5 days ago
            await this.token.connect(this.owner).setReferenceTime(newReferenceTime);

            // Verify multiplier is stable immediately after setReferenceTime
            const multAfterRefChange = await this.token.getActiveMultiplier(1);
            let diff = multAfterRefChange > multBeforeRefChange ?
                multAfterRefChange - multBeforeRefChange :
                multBeforeRefChange - multAfterRefChange;
            expect(diff).to.be.lessThan(ethers.parseUnits("0.0001", 12)); // Very small tolerance

            // KEY TEST: Let more time pass (5 more days = 5 more periods)
            await time.increase(5 * 86400);

            // Get multiplier after additional growth
            const multAfterMoreTime = await this.token.getActiveMultiplier(1);

            // The multiplier MUST have grown from multAfterRefChange
            // With 5% APR and 5 periods (days), growth should be approximately:
            // (1 + 0.05/365)^5 ≈ 1.000685 times the previous value
            expect(multAfterMoreTime).to.be.gt(multAfterRefChange);

            // Calculate expected growth: multAfterRefChange * (1 + 0.05/365)^5
            // At 5% APR with daily periods, per-period rate = 0.05/365 ≈ 0.000137
            // 5 periods of growth = (1.000137)^5 ≈ 1.000685
            const expectedGrowthFactor = 1.000685;
            const expectedMult = (Number(multAfterRefChange) * expectedGrowthFactor);
            const actualMult = Number(multAfterMoreTime);

            // Allow 1% tolerance for rounding
            expect(actualMult).to.be.closeTo(expectedMult, expectedMult * 0.01);
        });

        it("should have consistent multiplier projection after multiple setReferenceTime calls", async function () {
            // This test verifies the multiplier grows consistently regardless of how many
            // times setReferenceTime is called (each call should properly reset the baseline)

            const APR_10_PERCENT = ethers.parseUnits("0.1", 10);
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_10_PERCENT);

            // Let 5 days pass
            await time.increase(5 * 86400);
            const mult1 = await this.token.getActiveMultiplier(1);

            // Call setReferenceTime
            let newRef = (await time.latest()) - (2 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef);

            // Let 3 more days pass
            await time.increase(3 * 86400);
            const mult2 = await this.token.getActiveMultiplier(1);
            expect(mult2).to.be.gt(mult1); // Must grow

            // Call setReferenceTime again
            newRef = (await time.latest()) - (1 * 86400);
            await this.token.connect(this.owner).setReferenceTime(newRef);

            // Let 2 more days pass
            await time.increase(2 * 86400);
            const mult3 = await this.token.getActiveMultiplier(1);
            expect(mult3).to.be.gt(mult2); // Must grow

            // Call setReferenceTime a third time
            newRef = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(newRef);

            // Let 4 more days pass
            await time.increase(4 * 86400);
            const mult4 = await this.token.getActiveMultiplier(1);
            expect(mult4).to.be.gt(mult3); // Must grow

            // Total time: 5 + 3 + 2 + 4 = 14 days
            // At 10% APR with daily periods, growth = (1 + 0.1/365)^14 ≈ 1.00385
            // From initial mult (≈1.0) to final mult4, expect ~1.4% growth
            const growthRatio = Number(mult4) / Number(ethers.parseUnits("1.0", 12));
            expect(growthRatio).to.be.closeTo(1.00385, 0.001);
        });

        it("should not double-count or lose growth when setReferenceTime resets baseline", async function () {
            // This test ensures that calling setReferenceTime doesn't cause growth to be
            // double-counted or lost - the multiplier should grow at a consistent rate

            const APR_5_PERCENT = ethers.parseUnits("0.05", 10);
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_5_PERCENT);

            // Scenario A: 10 days continuous (no setReferenceTime)
            const startTime = await time.latest();
            await time.increase(10 * 86400);
            const multContinuous = await this.token.getActiveMultiplier(1);

            // Reset to start for Scenario B
            // (We can't actually reset time, so we use a different multiplier)
            await this.token.connect(this.owner).createMultiplier(APR_5_PERCENT);
            // New multiplier (ID 2) starts fresh (no pre-initialized multipliers)

            // Scenario B: 5 days, then setReferenceTime, then 5 more days
            await time.increase(5 * 86400);
            const newRef = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(newRef);
            await time.increase(5 * 86400);
            const multWithRefChange = await this.token.getActiveMultiplier(2);

            // Both scenarios should have ~10 days of growth from their respective start points
            // Mult 1 started 10 days before mult 3, so we need to account for that
            // Mult 3 had 10 days of growth (5 before setReferenceTime + 5 after)
            // This verifies setReferenceTime doesn't break growth continuity

            // The key assertion: mult3 should have grown over its 10 days
            // At 5% APR, 10 days = (1 + 0.05/365)^10 ≈ 1.00137
            const expectedGrowth = 1.00137;
            const actualGrowth = Number(multWithRefChange) / 1e12;
            expect(actualGrowth).to.be.closeTo(expectedGrowth, 0.001);
        });
    });
});
