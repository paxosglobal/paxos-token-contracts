/**
 * Tests for double-claim prevention mechanisms.
 *
 * Double-claiming can occur when the claimAll detection logic incorrectly
 * determines that a wallet was updated after a claimAll event. This file
 * tests prevention of double-claims across different scenarios:
 *
 * 1. Multiplier ID changes (adminSetPayoutGroupMultiplier)
 * 2. Period parameter changes (setMaturityPeriod, setReferenceTime)
 *
 * The fix uses timestamps instead of period numbers for claimAll detection,
 * since timestamps are monotonically non-decreasing (guaranteed by EVM).
 */

const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_TOKEN = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);
const ONE_DAY = 86400;

describe('Double Claim Prevention', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);
    });

    // =========================================================================
    // SECTION 1: Multiplier Change Scenarios
    // =========================================================================
    // When adminSetPayoutGroupMultiplier switches a payout group from mult1 to mult2:
    // 1. claimAll is executed, paying out all accrued rewards at mult1's current value
    // 2. lastClaimAllMultiplier is set to mult2's current value (the NEW multiplier)
    // 3. All wallets in the group should show 0 rewards immediately after
    // 4. Wallets begin accruing rewards from mult2's value going forward

    describe('Multiplier Change Scenarios', function () {
        /**
         * Switching to a lower-valued multiplier.
         *
         * When changing from mult1 (higher) to mult2 (lower):
         * - Rewards should be 0 immediately after the change
         * - Wallets should begin accruing rewards as mult2 grows
         */
        it('switching to lower multiplier: rewards zero immediately, then accrue from new multiplier', async function () {
            // Create mult2
            await setupMultiplierWithBounds(this);

            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));

            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 100n);

            // Create payout group
            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

            // Step 1: Register wallet when mult1 = 1.0
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN);

            // Step 2: Grow mult1 to ~1.10 (10% growth)
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_100_PERCENT);
            await time.increase(ONE_DAY * 40); // ~40 days for ~10% growth

            const mult1Value = await this.token.getActiveMultiplier(1);
            expect(mult1Value).to.be.gt(ethers.parseUnits("1.08", 12));

            // Transfer to update wallet's state
            await this.token.connect(this.acc2).transfer(this.owner.address, 1n);

            // Wallet should have rewards
            const rewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsBefore).to.be.gt(0n);

            // Step 3: Grow mult2 to ~1.05 (lower than mult1)
            await this.token.connect(this.owner).setMultiplierRateByAPR(2, APR_100_PERCENT);
            await time.increase(ONE_DAY * 20); // ~20 days for ~5% growth

            const mult2Value = await this.token.getActiveMultiplier(2);
            expect(mult2Value).to.be.gt(MULTIPLIER_BASE);

            // Get mult1's final value (it continued growing)
            const mult1Final = await this.token.getActiveMultiplier(1);
            expect(mult2Value).to.be.lt(mult1Final); // mult2 < mult1

            // Record rewards and destination before change
            const rewardsBeforeChange = await this.token.availableRewardsOf(this.acc2.address);
            const destBefore = await this.token.balanceOf(this.acc3.address);

            // Step 4: Change multiplier
            await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

            // Verify rewards were claimed
            const destAfter = await this.token.balanceOf(this.acc3.address);
            const claimedAmount = destAfter - destBefore;
            expect(claimedAmount).to.be.closeTo(rewardsBeforeChange, rewardsBeforeChange / 5n);

            // Immediately after, rewards should be 0
            const rewardsImmediate = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsImmediate).to.equal(0n);

            // Step 5: Grow mult2 a bit more (1.05 → 1.06)
            await time.increase(ONE_DAY * 4);

            // Wallet should have rewards from mult2's growth
            const rewardsAfterGrowth = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterGrowth).to.be.gt(0n);
        });

        /**
         * VULNERABILITY TEST: Phantom group rewards when switching to higher multiplier.
         *
         * This tests a GROUP-LEVEL bug where claimAll() returns phantom rewards after
         * switching to a higher-valued multiplier. The root cause is that
         * adminSetPayoutGroupMultiplier updates lastClaimAllMultiplier to the new value
         * but does NOT recalculate groupShares.
         *
         * The math:
         *   After _executeClaimAll(): groupShares = balance / oldMult
         *   After setting lastClaimAllMultiplier = newMult
         *   Next claimAll(): groupRewards = groupShares * newMult - balance = phantom!
         */
        it('VULNERABILITY: no phantom rewards when calling claimAll after switching to higher multiplier', async function () {
            // Setup: mult1 at 1.0, mult2 at higher value
            await setupMultiplierWithBounds(this);
            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));
            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 100n);

            // Create payout group with mult1
            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);
            await this.token.connect(this.owner).setClaimSource(this.owner.address);

            // Register wallet and fund it
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN);

            // Grow mult2 to ~1.15 (higher than mult1)
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMultiplierRateByAPR(2, APR_100_PERCENT);
            await time.increase(ONE_DAY * 60);

            // Grow mult1 a little (~1.05)
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_100_PERCENT);
            await time.increase(ONE_DAY * 20);

            const mult1Final = await this.token.getActiveMultiplier(1);
            const mult2Final = await this.token.getActiveMultiplier(2);
            expect(mult2Final).to.be.gt(mult1Final, "mult2 should be higher");

            // Change to higher multiplier - this calls _executeClaimAll internally
            await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

            // Call claimAll AGAIN - should get 0 phantom rewards
            const destBefore = await this.token.balanceOf(this.acc3.address);
            await this.token.connect(this.acc).claimAll(payoutGroupId);
            const destAfter = await this.token.balanceOf(this.acc3.address);

            const phantomRewards = destAfter - destBefore;
            expect(phantomRewards).to.equal(0n,
                "VULNERABILITY: Phantom rewards claimed after switching to higher multiplier. " +
                "Group shares were not recalculated with new multiplier."
            );
        });

        /**
         * Switching to a higher-valued multiplier.
         *
         * When changing from mult1 (lower) to mult2 (higher):
         * - Rewards should be 0 immediately after the change
         * - No phantom rewards from the higher multiplier value
         */
        it('switching to higher multiplier: rewards zero immediately, no phantom rewards', async function () {
            // Create mult2
            await setupMultiplierWithBounds(this);

            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));
            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 100n);

            // Create payout group with mult1
            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

            // Register wallet and fund it
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN);

            // Grow mult2 first to ~1.15 (before touching mult1)
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMultiplierRateByAPR(2, APR_100_PERCENT);
            await time.increase(ONE_DAY * 60); // ~60 days for ~15% growth

            // Now grow mult1 a little bit (~1.05)
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, APR_100_PERCENT);
            await time.increase(ONE_DAY * 20); // ~20 days for ~5% growth

            const mult1Final = await this.token.getActiveMultiplier(1);
            const mult2Final = await this.token.getActiveMultiplier(2);

            // Verify mult2 > mult1
            expect(mult2Final).to.be.gt(mult1Final, "mult2 should be higher than mult1");

            // Change to higher multiplier (mult2)
            await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 2);

            // Rewards should be 0 immediately after claimAll
            const rewardsImmediate = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsImmediate).to.equal(0n, "Phantom rewards detected after switching to higher multiplier");
        });
    });

    // =========================================================================
    // SECTION 2: Period Parameter Change Scenarios
    // =========================================================================
    // These tests verify that changing maturityPeriod or referenceTime does not
    // enable double-claiming. The fix uses timestamps instead of period numbers
    // for claimAll detection.

    describe('Period Parameter Change Scenarios', function () {
        /**
         * Increasing maturityPeriod should not enable double-claim.
         *
         * Scenario:
         * 1. Wallet transfers at time T1
         * 2. ClaimAll at time T1
         * 3. Admin doubles maturityPeriod (period numbers decrease)
         * 4. ClaimAll at time T2
         * 5. Wallet should show 0 rewards (not double-claim)
         */
        it('increasing maturityPeriod does not enable double-claim', async function () {
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));

            const multiplierId = await setupMultiplierWithBounds(this, APR_100_PERCENT);
            const payoutGroupId = await createPayoutGroup(this, multiplierId, this.acc);

            // Fund claim source and wallet
            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 1000n);
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN * 100n);

            // Fast forward to period 3 and let rewards accrue
            await time.increase(ONE_DAY * 3);

            const periodBefore = await this.token.getCurrentPeriodNum();
            expect(periodBefore).to.be.gte(3);

            // Transfer to update wallet state
            await this.token.connect(this.acc2).transfer(this.owner.address, 1n);
            await this.token.connect(this.owner).transfer(this.acc2.address, 1n);

            // Verify rewards accrued
            const rewardsBeforeClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsBeforeClaimAll).to.be.gt(0, "Should have accrued rewards");

            // First claimAll
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Verify rewards are 0 after claimAll
            const rewardsAfterFirstClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterFirstClaimAll).to.equal(0, "Rewards should be 0 after claimAll");

            // Double the maturity period - period numbers will decrease
            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY * 2);

            const periodAfterChange = await this.token.getCurrentPeriodNum();
            expect(periodAfterChange).to.be.lt(periodBefore, "Period should have decreased");

            // Let time pass and do another claimAll
            await time.increase(ONE_DAY * 2);
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Rewards should still be 0 (no double-claim)
            const rewardsAfterSecondClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterSecondClaimAll).to.equal(0,
                "Double-claim detected: wallet shows rewards after claimAll despite period parameter change"
            );
        });

        /**
         * Moving referenceTime forward should not enable double-claim.
         *
         * Scenario:
         * 1. Wallet transfers at time T1
         * 2. ClaimAll at time T1
         * 3. Admin moves referenceTime forward (period numbers decrease)
         * 4. ClaimAll at time T2
         * 5. Wallet should show 0 rewards (not double-claim)
         */
        it('moving referenceTime forward does not enable double-claim', async function () {
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));

            const multiplierId = await setupMultiplierWithBounds(this, APR_100_PERCENT);
            const payoutGroupId = await createPayoutGroup(this, multiplierId, this.acc);

            // Fund claim source and wallet
            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 1000n);
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN * 100n);

            // Fast forward to period 5+
            await time.increase(ONE_DAY * 5);

            const periodBefore = await this.token.getCurrentPeriodNum();
            expect(periodBefore).to.be.gte(5);

            // Transfer to update wallet state
            await this.token.connect(this.acc2).transfer(this.owner.address, 1n);
            await this.token.connect(this.owner).transfer(this.acc2.address, 1n);

            // Verify rewards accrued
            const rewardsBeforeClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsBeforeClaimAll).to.be.gt(0, "Should have accrued rewards");

            // First claimAll
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Verify rewards are 0 after claimAll
            const rewardsAfterFirstClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterFirstClaimAll).to.equal(0, "Rewards should be 0 after claimAll");

            // Move referenceTime forward - period numbers will decrease
            const currentTime = await time.latest();
            const currentRefTime = await this.token.getReferenceTime();
            const newRefTime = Number(currentRefTime) + (ONE_DAY * 3);
            expect(newRefTime).to.be.lte(currentTime, "New reference time must be <= current time");

            await this.token.connect(this.owner).setReferenceTime(newRefTime);

            const periodAfterChange = await this.token.getCurrentPeriodNum();
            expect(periodAfterChange).to.be.lt(periodBefore, "Period should have decreased");

            // Let time pass and do another claimAll
            await time.increase(ONE_DAY);
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Rewards should still be 0 (no double-claim)
            const rewardsAfterSecondClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterSecondClaimAll).to.equal(0,
                "Double-claim detected: wallet shows rewards after claimAll despite referenceTime change"
            );
        });

        /**
         * Control test: claimAll detection works correctly without parameter changes.
         */
        it('claimAll detection works correctly without parameter changes', async function () {
            const APR_100_PERCENT = ethers.parseUnits("1", 10);
            await this.token.connect(this.owner).setMaturityPeriod(ONE_DAY);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("10", 10));

            const multiplierId = await setupMultiplierWithBounds(this, APR_100_PERCENT);
            const payoutGroupId = await createPayoutGroup(this, multiplierId, this.acc);

            // Fund claim source and wallet
            await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 1000n);
            await this.token.connect(this.owner).setClaimSource(this.owner.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN * 100n);

            // Fast forward and let rewards accrue
            await time.increase(ONE_DAY * 3);

            // Transfer to update wallet state
            await this.token.connect(this.acc2).transfer(this.owner.address, 1n);
            await this.token.connect(this.owner).transfer(this.acc2.address, 1n);

            // ClaimAll
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Rewards should be 0 after claimAll
            const rewardsAfterClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterClaimAll).to.equal(0, "Rewards should be 0 after claimAll");

            // Wait and do another claimAll (no parameter change)
            await time.increase(ONE_DAY * 2);
            await this.token.connect(this.acc).claimAll(payoutGroupId);

            // Rewards should still be 0
            const rewardsAfterSecondClaimAll = await this.token.availableRewardsOf(this.acc2.address);
            expect(rewardsAfterSecondClaimAll).to.equal(0, "Should not have phantom rewards after second claimAll");
        });
    });
});
