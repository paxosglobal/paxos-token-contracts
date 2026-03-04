const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * @title CompoundInterestMathTest
 * @notice Mathematical verification that compound interest is working correctly
 * @dev Compares results against known compound interest values
 */
describe("Compound Interest Mathematical Verification", function () {
    let MultiplierGrowthLibTest;
    let testContract;

    // Constants
    const MULT_BASE = ethers.parseUnits("1", 12); // 1e12
    const RATE_BASE = ethers.parseUnits("1", 10); // 1e10
    const ONE_DAY = 86400n;
    const SECONDS_PER_YEAR = 31536000n;

    before(async function () {
        MultiplierGrowthLibTest = await ethers.getContractFactory("MultiplierGrowthLibTest");
        testContract = await MultiplierGrowthLibTest.deploy();
        await testContract.waitForDeployment();
    });

    describe("Known compound interest values", function () {
        const referenceTime = 1700000000n;

        it("should match known value: 5% APR for 10 days", async function () {
            // Formula: (1 + 0.05/365)^10 ≈ 1.00137074...
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.05", 10); // 5% APR at 10 decimals
            const periods = 10n;

            const result = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            const expected = ethers.parseUnits("1.001370707", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(result).to.be.closeTo(expected, tolerance);
        });

        it("should match known value: 1% APR for 100 days", async function () {
            // Formula: (1 + 0.01/365)^100 ≈ 1.00274147...
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.01", 10); // 1% APR at 10 decimals
            const periods = 100n;

            const result = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            const expected = ethers.parseUnits("1.002743436", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(result).to.be.closeTo(expected, tolerance);
        });

        it("should match known value: 5% APR for 365 days (1 year)", async function () {
            // Formula: (1 + 0.05/365)^365 ≈ 1.05127... (this is the APY)
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.05", 10); // 5% APR at 10 decimals
            const periods = 365n;

            const result = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            const expected = ethers.parseUnits("1.051267496", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(result).to.be.closeTo(expected, tolerance);
        });

        it("should match known value: 3.65% APR for 365 days (realistic daily rate)", async function () {
            // Formula: (1 + 0.0365/365)^365 = (1 + 0.0001)^365 ≈ 1.03714...
            // This is roughly 3.71% APY from 3.65% APR with daily compounding
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR at 10 decimals
            const periods = 365n;

            const result = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            const expected = ethers.parseUnits("1.037172406", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(result).to.be.closeTo(expected, tolerance);
        });

        it("should match known value: 3.65% APR for 730 days (2 years)", async function () {
            // Formula: (1 + 0.0365/365)^730 = (1.03714...)^2 ≈ 1.0757...
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR at 10 decimals
            const periods = 730n;

            const result = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            const expected = ethers.parseUnits("1.075726600", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(result).to.be.closeTo(expected, tolerance);
        });
    });

    describe("Compound vs Linear comparison", function () {
        const referenceTime = 1700000000n;

        it("should show difference: 50% APR for 365 days", async function () {
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.5", 10); // 50% APR at 10 decimals
            const periods = 365n;

            const compoundResult = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Compound: (1 + 0.5/365)^365 ≈ 1.6487...
            const expectedCompound = ethers.parseUnits("1.648157219", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(compoundResult).to.be.closeTo(expectedCompound, tolerance);

            // Linear: 1 + 0.5 = 1.5
            const linearWouldBe = ethers.parseUnits("1.5", 12);

            // Compound is larger than linear
            expect(compoundResult).to.be.gt(linearWouldBe);
        });

        it("should show difference: 10% APR for 100 days", async function () {
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.1", 10); // 10% APR at 10 decimals
            const periods = 100n;

            const compoundResult = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Compound: (1 + 0.1/365)^100 ≈ 1.027777...
            const expectedCompound = ethers.parseUnits("1.027772154", 12);
            expect(compoundResult).to.be.closeTo(expectedCompound, ethers.parseUnits("0.000001", 12));

            // Linear: 1 + (0.1 * 100/365) ≈ 1.027397
            const linearWouldBe = ethers.parseUnits("1.027397260", 12);

            // Compound is slightly higher than linear
            expect(compoundResult).to.be.gt(linearWouldBe);
        });

        it("should show realistic difference: 3.65% APR for 365 days", async function () {
            // This is a realistic reward rate (3.65% APR ≈ 3.71% APY)
            const lastMultiplier = ethers.parseUnits("1", 12);
            const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR at 10 decimals
            const periods = 365n;

            const compoundResult = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Compound: (1 + 0.0365/365)^365 ≈ 1.037172406
            const expectedCompound = ethers.parseUnits("1.037172406", 12);
            expect(compoundResult).to.be.closeTo(expectedCompound, ethers.parseUnits("0.000001", 12));

            // Linear: 1 + 0.0365 = 1.0365
            const linearWouldBe = ethers.parseUnits("1.0365", 12);

            // Even at low rates, compound is noticeably higher
            expect(compoundResult).to.be.gt(linearWouldBe);
            const bps = ((compoundResult - linearWouldBe) * 10000n) / linearWouldBe;
        });
    });

    describe("Compound interest properties", function () {
        const referenceTime = 1700000000n;

        it("should satisfy: (1+r)^(a+b) = (1+r)^a * (1+r)^b", async function () {
            // Compound interest property: growth over combined periods equals product of individual growths
            // Using 3.65% APR which gives daily rate of ~0.01% (0.0365/365 ≈ 0.0001)
            const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR at 10 decimals
            const periods_a = 50n;
            const periods_b = 30n;

            // Calculate growth over 80 days
            const combined = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                referenceTime + ((periods_a + periods_b) * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Calculate growth over 50 days
            const first = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                referenceTime + (periods_a * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Calculate growth over 30 days
            const second = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                referenceTime + (periods_b * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Product: first * second / MULT_BASE (to maintain scale)
            const product = (first * second) / MULT_BASE;

            // Should be equal (within rounding tolerance)
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(combined).to.be.closeTo(product, tolerance);
        });

        it("should satisfy: applying multiplier M then growth = applying growth * M", async function () {
            // Order independence property
            const lastMultiplier = ethers.parseUnits("2.5", 12);
            // Using 7.3% APR which gives daily rate of ~0.02% (0.073/365 ≈ 0.0002)
            const apr = ethers.parseUnits("0.073", 10); // 7.3% APR at 10 decimals
            const periods = 20n;

            // Method 1: Start with 2.5, apply 20 days of growth at 7.3% APR
            const result1 = await testContract.projectMultiplier(
                lastMultiplier,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );

            // Method 2: Calculate growth factor, then multiply by 2.5
            const growth = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                referenceTime + (periods * ONE_DAY),
                ONE_DAY,
                referenceTime
            );
            const result2 = (growth * lastMultiplier) / MULT_BASE;

            // Should be equal (within rounding tolerance from 38-decimal intermediate precision)
            // With 38-decimal precision, we expect sub-nanoscale accuracy
            expect(result1).to.be.closeTo(result2, 10); // Within 10 units at 12 decimals
        });
    });

    describe("Period alignment verification", function () {
        const referenceTime = 1700000000n;

        it("should only compound at period boundaries, not mid-period", async function () {
            // Using 18.25% APR which gives daily rate of ~0.05% (0.1825/365 ≈ 0.0005)
            const apr = ethers.parseUnits("0.1825", 10); // 18.25% APR at 10 decimals

            // Time at period start (exactly at boundary)
            const atPeriodStart = referenceTime;

            // Time just before next period (still in period 0)
            const beforeNextPeriod = referenceTime + ONE_DAY - 1n;

            // Time at next period start (crossed boundary)
            const atNextPeriod = referenceTime + ONE_DAY;

            // Should be same (no periods crossed)
            const resultBefore = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                atPeriodStart,
                beforeNextPeriod,
                ONE_DAY,
                referenceTime
            );
            expect(resultBefore).to.equal(MULT_BASE); // No growth yet

            // Should have grown (1 period crossed)
            const resultAfter = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                atPeriodStart,
                atNextPeriod,
                ONE_DAY,
                referenceTime
            );
            // With 18.25% APR: (1 + 0.1825/365)^1 ≈ 1.0005
            const expectedAfter = ethers.parseUnits("1.0005", 12);
            const tolerance = ethers.parseUnits("0.000001", 12);
            expect(resultAfter).to.be.closeTo(expectedAfter, tolerance);
        });

        it("should align to reference time correctly", async function () {
            // Using 3.65% APR which gives daily rate of ~0.01% (0.0365/365 ≈ 0.0001)
            const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR at 10 decimals
            const referenceTime = 1000000n; // Some arbitrary reference

            // 5 complete periods after reference
            const time1 = referenceTime + (5n * ONE_DAY);

            // 5.9 periods after reference (still in period 5)
            const time2 = referenceTime + (5n * ONE_DAY) + (ONE_DAY * 9n / 10n);

            const result1 = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                time1,
                ONE_DAY,
                referenceTime
            );

            const result2 = await testContract.projectMultiplier(
                MULT_BASE,
                apr,
                referenceTime,
                time2,
                ONE_DAY,
                referenceTime
            );

            // Should be the same - both have crossed exactly 5 period boundaries
            expect(result1).to.equal(result2);
        });
    });
});
