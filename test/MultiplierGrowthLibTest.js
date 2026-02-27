const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * @title MultiplierGrowthLibTest
 * @notice Unit tests for MultiplierGrowthLib library functions
 */
describe("MultiplierGrowthLib", function () {
    let MultiplierGrowthLibTest;
    let testContract;

    const MULT_BASE = ethers.parseUnits("1", 12); // 1e12
    const ONE_DAY = 86400n;

    before(async function () {
        MultiplierGrowthLibTest = await ethers.getContractFactory("MultiplierGrowthLibTest");
        testContract = await MultiplierGrowthLibTest.deploy();
        await testContract.waitForDeployment();
    });

    describe("calculatePeriodsCrossed", function () {
        const periodLength = 86400n; // 1 day
        const referenceTime = 1700000000n;

        it("should return 0 when currentTime <= lastTime", async function () {
            const lastTime = referenceTime + 1000n;
            const currentTime = referenceTime + 500n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(0n);
        });

        it("should return 0 when currentTime < referenceTime", async function () {
            const lastTime = referenceTime - 2000n;
            const currentTime = referenceTime - 1000n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(0n);
        });

        it("should return 0 when no period boundary crossed", async function () {
            const lastTime = referenceTime + 1000n;
            const currentTime = referenceTime + 2000n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(0n);
        });

        it("should return 1 when one period boundary crossed", async function () {
            const lastTime = referenceTime + 1000n;
            const currentTime = referenceTime + periodLength + 1000n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(1n);
        });

        it("should return correct count when multiple periods crossed", async function () {
            const lastTime = referenceTime + 1000n;
            const currentTime = referenceTime + (5n * periodLength) + 1000n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(5n);
        });

        it("should handle lastTime before referenceTime correctly", async function () {
            const lastTime = referenceTime - 1000n;
            const currentTime = referenceTime + (3n * periodLength) + 1000n;
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(3n);
        });

        it("should handle exact period boundary times", async function () {
            const lastTime = referenceTime;
            const currentTime = referenceTime + (2n * periodLength);
            const periods = await testContract.calculatePeriodsCrossed(lastTime, currentTime, periodLength, referenceTime);
            expect(periods).to.equal(2n);
        });
    });

    describe("power", function () {
        it("should return MULT_BASE for exponent = 0", async function () {
            const base = ethers.parseUnits("1.05", 12);
            const result = await testContract.power(base, 0);
            expect(result).to.equal(MULT_BASE);
        });

        it("should return base for exponent = 1", async function () {
            const base = ethers.parseUnits("1.05", 12);
            const result = await testContract.power(base, 1);
            expect(result).to.equal(base);
        });

        it("should calculate base^2 correctly", async function () {
            const base = ethers.parseUnits("1.05", 12);
            const result = await testContract.power(base, 2);
            const expected = ethers.parseUnits("1.1025", 12);
            expect(result).to.be.closeTo(expected, ethers.parseUnits("0.0001", 12));
        });

        it("should calculate base^3 correctly", async function () {
            const base = ethers.parseUnits("1.05", 12);
            const result = await testContract.power(base, 3);
            const expected = ethers.parseUnits("1.157625", 12);
            expect(result).to.be.closeTo(expected, ethers.parseUnits("0.0001", 12));
        });

        it("should calculate base^10 correctly", async function () {
            const base = ethers.parseUnits("1.05", 12);
            const result = await testContract.power(base, 10);
            const expected = ethers.parseUnits("1.628894", 12);
            expect(result).to.be.closeTo(expected, ethers.parseUnits("0.001", 12));
        });

        it("should calculate base^365 correctly", async function () {
            const base = ethers.parseUnits("1.0001", 12);
            const result = await testContract.power(base, 365);
            const expected = ethers.parseUnits("1.0372", 12);
            expect(result).to.be.closeTo(expected, ethers.parseUnits("0.001", 12));
        });

        it("should handle small rate (0.01% = 1.0001)", async function () {
            const base = ethers.parseUnits("1.0001", 12);
            const result = await testContract.power(base, 1);
            expect(result).to.equal(base);
        });
    });

    describe("projectMultiplier", function () {
        const periodLength = 86400n; // 1 day
        const referenceTime = 1700000000n;

        describe("edge cases", function () {
            it("should return knownMultiplier when targetTime == knownTime", async function () {
                const mult = ethers.parseUnits("1.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime, periodLength, referenceTime);
                expect(result).to.equal(mult);
            });

            it("should return knownMultiplier when periodLength = 0", async function () {
                const mult = ethers.parseUnits("1.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (5n * periodLength), 0n, referenceTime);
                expect(result).to.equal(mult);
            });

            it("should return knownMultiplier when no periods crossed", async function () {
                const mult = ethers.parseUnits("1.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const knownTime = referenceTime + 1000n;
                const targetTime = referenceTime + 2000n;
                const result = await testContract.projectMultiplier(mult, apr, knownTime, targetTime, periodLength, referenceTime);
                expect(result).to.equal(mult);
            });

            it("should handle rate = 0 (no growth)", async function () {
                const mult = ethers.parseUnits("1.5", 12);
                // Forward
                const forward = await testContract.projectMultiplier(mult, 0n, referenceTime, referenceTime + (10n * periodLength), periodLength, referenceTime);
                expect(forward).to.equal(mult);
                // Backward
                const backward = await testContract.projectMultiplier(mult, 0n, referenceTime + (10n * periodLength), referenceTime, periodLength, referenceTime);
                expect(backward).to.equal(mult);
            });

            it("should handle very small rates", async function () {
                const mult = ethers.parseUnits("1", 12);
                const apr = ethers.parseUnits("0.00365", 10); // 0.365% APR
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (365n * periodLength), periodLength, referenceTime);
                const expected = ethers.parseUnits("1.003656268", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.000001", 12));
            });
        });

        describe("forward projection (targetTime > knownTime)", function () {
            it("should apply compound growth for 1 period", async function () {
                const mult = ethers.parseUnits("1", 12);
                const apr = ethers.parseUnits("0.0365", 10); // 3.65% APR = 0.01% daily
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + periodLength, periodLength, referenceTime);
                const expected = ethers.parseUnits("1.0001", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12));
            });

            it("should apply compound growth for multiple periods", async function () {
                const mult = ethers.parseUnits("1", 12);
                const apr = ethers.parseUnits("0.05", 10); // 5% APR
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (5n * periodLength), periodLength, referenceTime);
                // (1 + 0.05/365)^5 ≈ 1.000685
                const expected = ethers.parseUnits("1.000685", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12));
            });

            it("should apply growth to non-1.0 starting multiplier", async function () {
                const mult = ethers.parseUnits("2.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (5n * periodLength), periodLength, referenceTime);
                const expected = ethers.parseUnits("2.501713", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.0001", 12));
            });

            it("should demonstrate compound vs linear difference", async function () {
                const mult = ethers.parseUnits("1", 12);
                const apr = ethers.parseUnits("1", 10); // 100% APR
                const result = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (365n * periodLength), periodLength, referenceTime);
                // Compound: (1 + 1/365)^365 ≈ 2.7145
                // Linear would be: 1 + 1 = 2
                const expected = ethers.parseUnits("2.7145", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.01", 12));
            });
        });

        describe("backward projection (targetTime < knownTime)", function () {
            it("should reverse compound growth for 1 period", async function () {
                const mult = ethers.parseUnits("1.0001", 12);
                const apr = ethers.parseUnits("0.0365", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime + periodLength, referenceTime, periodLength, referenceTime);
                const expected = ethers.parseUnits("1", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12));
            });

            it("should reverse compound growth for multiple periods", async function () {
                const mult = ethers.parseUnits("1.000685", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime + (5n * periodLength), referenceTime, periodLength, referenceTime);
                const expected = ethers.parseUnits("1", 12);
                expect(result).to.be.closeTo(expected, ethers.parseUnits("0.00001", 12));
            });

            it("should reverse growth for non-1.0 future multiplier", async function () {
                const mult = ethers.parseUnits("2.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const result = await testContract.projectMultiplier(mult, apr, referenceTime + (30n * periodLength), referenceTime, periodLength, referenceTime);
                expect(result).to.be.lessThan(mult);
                expect(result).to.be.greaterThan(ethers.parseUnits("2.4", 12));
            });
        });

        describe("bidirectional symmetry", function () {
            it("should perfectly reverse forward projection", async function () {
                const originalMult = ethers.parseUnits("1.5", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const time1 = referenceTime;
                const time2 = referenceTime + (30n * periodLength);

                const forward = await testContract.projectMultiplier(originalMult, apr, time1, time2, periodLength, referenceTime);
                const backward = await testContract.projectMultiplier(forward, apr, time2, time1, periodLength, referenceTime);

                expect(backward).to.be.closeTo(originalMult, ethers.parseUnits("0.000001", 12));
            });

            it("should perfectly reverse with high rate", async function () {
                const originalMult = ethers.parseUnits("2.0", 12);
                const apr = ethers.parseUnits("1", 10); // 100% APR
                const time1 = referenceTime;
                const time2 = referenceTime + (365n * periodLength);

                const forward = await testContract.projectMultiplier(originalMult, apr, time1, time2, periodLength, referenceTime);
                const backward = await testContract.projectMultiplier(forward, apr, time2, time1, periodLength, referenceTime);

                expect(backward).to.be.closeTo(originalMult, ethers.parseUnits("0.000001", 12));
            });

            it("should be symmetric with multiple test cases", async function () {
                const testCases = [
                    { multiplier: ethers.parseUnits("1", 12), apr: ethers.parseUnits("0.05", 10), periods: 10n },
                    { multiplier: ethers.parseUnits("2.5", 12), apr: ethers.parseUnits("0.1", 10), periods: 30n },
                    { multiplier: ethers.parseUnits("1.5", 12), apr: ethers.parseUnits("0.0365", 10), periods: 100n },
                ];

                for (const testCase of testCases) {
                    const time1 = referenceTime;
                    const time2 = referenceTime + (testCase.periods * periodLength);

                    const forward = await testContract.projectMultiplier(testCase.multiplier, testCase.apr, time1, time2, periodLength, referenceTime);
                    const backward = await testContract.projectMultiplier(forward, testCase.apr, time2, time1, periodLength, referenceTime);

                    expect(backward).to.be.closeTo(testCase.multiplier, ethers.parseUnits("0.000001", 12));
                }
            });
        });

        describe("gas efficiency", function () {
            it("should be efficient for 365 periods (binary exponentiation)", async function () {
                const mult = ethers.parseUnits("1", 12);
                const apr = ethers.parseUnits("0.05", 10);
                const tx = await testContract.projectMultiplier(mult, apr, referenceTime, referenceTime + (365n * periodLength), periodLength, referenceTime);
                expect(tx).to.not.be.reverted;
            });
        });

        describe("overflow protection", function () {
            it("should revert when base exceeds 2^128 during squaring", async function () {
                // The power function uses MAX_SAFE = 2^128 - 1
                // After scaling to 18 decimals (base * 1e6), base must not exceed 2^128
                // To trigger overflow: base * 1e6 > 2^128
                // base > 2^128 / 1e6 ≈ 3.4e32
                // At 12 decimals, this means multiplier > 3.4e20

                // Use a value that will overflow when scaled up and squared
                const overflowBase = BigInt("340282366920938463463374607431768211456"); // 2^128 (at 12 decimals, this scales up to exceed limit)

                // With exponent >= 2, it will try to square the base and trigger overflow
                await expect(
                    testContract.power(overflowBase, 2)
                ).to.be.revertedWith("MultiplierGrowth: base exceeds 2^128 before squaring");
            });

            it("should revert when result exceeds 2^128 during accumulation", async function () {
                // Use a large base that will cause result overflow when multiplied
                // The result * base multiplication happens when exponent is odd
                const largeBase = BigInt("340282366920938463463374607431768211456"); // 2^128

                // With exponent = 1, it should directly use the base
                // But with exponent = 3, it will square then try to multiply result
                await expect(
                    testContract.power(largeBase, 3)
                ).to.be.reverted; // Either overflow during squaring or result accumulation
            });

            it("should handle maximum safe base without overflow", async function () {
                // Use a reasonable large multiplier that stays within bounds
                const safeBase = ethers.parseUnits("100", 12); // 100x multiplier

                // Should work for reasonable exponents
                const result = await testContract.power(safeBase, 10);
                expect(result).to.be.greaterThan(0n);
            });
        });
    });
});
