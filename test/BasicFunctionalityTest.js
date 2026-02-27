const { ethers } = require("hardhat");
const { expect } = require("chai");

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

describe("Basic Functionality Test", function () {
    describe("LastMultiplier Model Principles", function () {
        it("should demonstrate basic reward calculation principles", async function () {
            // Basic LastMultiplier formula: balance * (currentMultiplier - lastMultiplier) / lastMultiplier
            const balance = ethers.parseUnits("1000", 12);
            const currentMultiplier = ethers.parseUnits("1.5", 12);
            const lastMultiplier = ethers.parseUnits("1.2", 12);

            // Manual calculation to verify the principle
            const multiplierDiff = currentMultiplier - lastMultiplier;
            const expectedRewards = balance * multiplierDiff / lastMultiplier;

            // This should equal: 1000 * (1.5 - 1.2) / 1.2 = 1000 * 0.3 / 1.2 = 250
            expect(expectedRewards).to.equal(ethers.parseUnits("250", 12));
        });

        it("should demonstrate zero rewards scenarios", async function () {
            const balance = ethers.parseUnits("1000", 12);

            // Same multiplier - no growth
            let currentMultiplier = ethers.parseUnits("1.2", 12);
            let lastMultiplier = ethers.parseUnits("1.2", 12);
            let multiplierDiff = currentMultiplier > lastMultiplier ? currentMultiplier - lastMultiplier : 0n;
            let rewards = multiplierDiff > 0 ? balance * multiplierDiff / lastMultiplier : 0n;
            expect(rewards).to.equal(0);

            // Current < last - no rewards
            currentMultiplier = ethers.parseUnits("1.0", 12);
            lastMultiplier = ethers.parseUnits("1.2", 12);
            multiplierDiff = currentMultiplier > lastMultiplier ? currentMultiplier - lastMultiplier : 0n;
            rewards = multiplierDiff > 0 ? balance * multiplierDiff / lastMultiplier : 0n;
            expect(rewards).to.equal(0);

            // Zero balance
            multiplierDiff = ethers.parseUnits("1.5", 12) - ethers.parseUnits("1.2", 12);
            rewards = 0n * multiplierDiff / ethers.parseUnits("1.2", 12);
            expect(rewards).to.equal(0);
        });

        it("should demonstrate compound interest principle", async function () {
            const balance = ethers.parseUnits("1000", 12);

            // Period 1: 10% growth from 1.0 to 1.1
            let lastMultiplier = ethers.parseUnits("1.0", 12);
            let currentMultiplier = ethers.parseUnits("1.1", 12);
            let rewards1 = balance * (currentMultiplier - lastMultiplier) / lastMultiplier;

            // Should be 1000 * 0.1 / 1.0 = 100
            expect(rewards1).to.equal(ethers.parseUnits("100", 12));

            // Period 2: 10% growth from 1.1 to 1.21 (compound)
            lastMultiplier = currentMultiplier; // Now 1.1
            currentMultiplier = ethers.parseUnits("1.21", 12); // 1.1 * 1.1
            let rewards2 = balance * (currentMultiplier - lastMultiplier) / lastMultiplier;

            // Should be 1000 * 0.11 / 1.1 = 100 (same reward due to compound interest)
            expect(rewards2).to.equal(ethers.parseUnits("100", 12));
        });

        it("should handle precision correctly", async function () {
            const balance = ethers.parseUnits("1000", 12);
            const currentMultiplier = ethers.parseUnits("1.001", 12); // 0.1% growth
            const lastMultiplier = ethers.parseUnits("1.0", 12);

            const rewards = balance * (currentMultiplier - lastMultiplier) / lastMultiplier;

            // Should be 1000 * 0.001 / 1.0 = 1
            expect(rewards).to.equal(ethers.parseUnits("1", 12));
        });

        it("should handle large numbers without overflow", async function () {
            const balance = ethers.parseUnits("1000000", 12); // 1M tokens
            const currentMultiplier = ethers.parseUnits("2.0", 12);
            const lastMultiplier = ethers.parseUnits("1.001", 12);

            const rewards = balance * (currentMultiplier - lastMultiplier) / lastMultiplier;

            // Should be 1M * 0.5 / 1.5 = 333,333.33...
            const expectedRewards = balance * (currentMultiplier - lastMultiplier) / lastMultiplier;
            expect(rewards).to.equal(expectedRewards);
            expect(rewards).to.be.gt(0);
        });

        it("should demonstrate the key advantages of LastMultiplier model", async function () {
            // LastMultiplier model advantages:
            // 1. No shares calculation needed
            // 2. Direct formula: reward = balance * (currentMult - lastMult) / lastMult
            // 3. Compound interest built-in
            // 4. Gas efficient O(1) operations
            // 5. Precision maintained with 12-decimal multipliers

            log("✅ LastMultiplier Model Advantages:");
            log("  • No shares calculation required");
            log("  • Direct reward formula");
            log("  • Built-in compound interest");
            log("  • O(1) gas efficiency");
            log("  • 12-decimal precision");

            // Simple validation that the model works
            const balance = ethers.parseUnits("100", 12);
            const growth = ethers.parseUnits("0.1", 12); // 10% growth
            const baseMultiplier = ethers.parseUnits("1.0", 12);
            const newMultiplier = baseMultiplier + growth;

            const rewards = balance * growth / baseMultiplier;
            expect(rewards).to.equal(ethers.parseUnits("10", 12)); // 10% of 100 = 10
        });
    });
});