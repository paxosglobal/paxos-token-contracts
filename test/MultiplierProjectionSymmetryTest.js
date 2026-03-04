const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

/**
 * @title MultiplierProjectionSymmetryTest
 * @notice Tests for projectMultiplier() bidirectional functionality and monotonicity invariants
 */
describe('MultiplierProjectionSymmetryTest', function () {
    const PERIOD_LENGTH = 86400; // 1 day
    const MULT_BASE = ethers.parseUnits("1", 12); // 1.0 at 12 decimals
    const RATE_5_PERCENT = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)

    let testContract;

    before(async function () {
        const MultiplierGrowthLibTest = await ethers.getContractFactory("MultiplierGrowthLibTest");
        testContract = await MultiplierGrowthLibTest.deploy();
        await testContract.waitForDeployment();
    });

    describe("projectMultiplier() Bidirectional Tests", function () {
        const periodLength = 86400n; // 1 day
        const referenceTime = 1700000000n;

        it("Should handle backward projection correctly (targetTime < knownTime)", async function () {
            const knownMultiplier = ethers.parseUnits("1.05", 12); // Future multiplier
            const apr = ethers.parseUnits("0.05", 10); // 5% APR
            const knownTime = referenceTime + (30n * periodLength); // 30 days in
            const targetTime = referenceTime; // Query the past

            const result = await testContract.projectMultiplier(
                knownMultiplier, apr, knownTime, targetTime, periodLength, referenceTime
            );

            // The past multiplier should be LESS than the known (future) multiplier
            expect(result).to.be.lessThan(knownMultiplier);
            expect(result).to.be.greaterThan(MULT_BASE); // Still greater than 1.0
        });

        it("Should handle forward projection correctly (targetTime > knownTime)", async function () {
            const knownMultiplier = ethers.parseUnits("1.0", 12);
            const apr = ethers.parseUnits("0.05", 10);
            const knownTime = referenceTime;
            const targetTime = referenceTime + (30n * periodLength);

            const result = await testContract.projectMultiplier(
                knownMultiplier, apr, knownTime, targetTime, periodLength, referenceTime
            );

            // The future multiplier should be GREATER than the known (past) multiplier
            expect(result).to.be.greaterThan(knownMultiplier);
        });

        it("Should be bidirectionally symmetric", async function () {
            const originalMultiplier = ethers.parseUnits("1.5", 12);
            const apr = ethers.parseUnits("0.05", 10);
            const time1 = referenceTime;
            const time2 = referenceTime + (30n * periodLength);

            // Forward then backward
            const forward = await testContract.projectMultiplier(
                originalMultiplier, apr, time1, time2, periodLength, referenceTime
            );
            const backToOriginal = await testContract.projectMultiplier(
                forward, apr, time2, time1, periodLength, referenceTime
            );

            // Should get back to original within precision tolerance
            expect(backToOriginal).to.be.closeTo(originalMultiplier, ethers.parseUnits("0.000001", 12));
        });

        it("Should maintain monotonicity across time", async function () {
            // For non-negative rates, multiplier at later time >= multiplier at earlier time
            const knownMultiplier = ethers.parseUnits("1.0", 12);
            const apr = ethers.parseUnits("0.05", 10);
            const knownTime = referenceTime + (50n * periodLength);

            // Query at increasing times
            const times = [
                referenceTime,
                referenceTime + (10n * periodLength),
                referenceTime + (20n * periodLength),
                referenceTime + (30n * periodLength),
                referenceTime + (40n * periodLength),
                referenceTime + (50n * periodLength),
                referenceTime + (60n * periodLength),
                referenceTime + (70n * periodLength)
            ];

            const multipliers = [];
            for (const t of times) {
                const mult = await testContract.projectMultiplier(
                    knownMultiplier, apr, knownTime, t, periodLength, referenceTime
                );
                multipliers.push(mult);
            }

            // Verify monotonicity
            for (let i = 1; i < multipliers.length; i++) {
                expect(multipliers[i]).to.be.greaterThanOrEqual(
                    multipliers[i-1],
                    `Monotonicity violated: M(t${i}) < M(t${i-1})`
                );
            }
        });
    });

    describe("Integration Tests", function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

            // Grant necessary roles
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Set maturity period and checkpoint period
            await this.token.connect(this.owner).setMaturityPeriod(PERIOD_LENGTH);

            // Set rate bounds
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10));

            // Create multiplier
            await this.token.connect(this.owner).createMultiplier(0);
            await time.increase(1);

            // Set rate
            await this.token.connect(this.owner).setMultiplierRateByAPR(1, RATE_5_PERCENT);
            await time.increase(1);
        });

        it("Should have increasing multiplier over time", async function () {
            const multId = 1;

            // Get multiplier now
            const mult1 = await this.token.getActiveMultiplier(multId);

            // Advance 30 days
            await time.increase(30 * PERIOD_LENGTH);

            // Get multiplier after 30 days
            const mult2 = await this.token.getActiveMultiplier(multId);

            // Multiplier should have grown
            expect(mult2).to.be.greaterThan(mult1);

            // Growth should be approximately (1 + 0.05/365)^30 ≈ 1.00411
            const ratio = (mult2 * 1000000n) / mult1;
            expect(ratio).to.be.greaterThan(1004000n); // > 1.004
            expect(ratio).to.be.lessThan(1005000n); // < 1.005
        });

        it("Should work with scheduled rate changes", async function () {
            const multId = 1;
            const currentTime = await time.latest();
            const rateChangeTime = currentTime + (15 * PERIOD_LENGTH);

            // Schedule a rate change
            const RATE_10_PERCENT = ethers.parseUnits("0.10", 10);
            await this.token.connect(this.owner).scheduleNextMultRateByAPR(multId, RATE_10_PERCENT, rateChangeTime);

            // Get multiplier before rate change
            await time.increase(10 * PERIOD_LENGTH);
            const multBefore = await this.token.getActiveMultiplier(multId);

            // Get multiplier after rate change
            await time.increase(20 * PERIOD_LENGTH);
            const multAfter = await this.token.getActiveMultiplier(multId);

            // Both multipliers should be valid and increasing
            expect(multAfter).to.be.greaterThan(multBefore);
            expect(multBefore).to.be.greaterThan(MULT_BASE);
        });
    });
});
