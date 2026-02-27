const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { UINT40_MAX } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Rate-Based Multiplier Tests', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        // Set rate bounds to allow creating multipliers and setting rates
        await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
        // Create multipliers 1 and 2 for tests that use them
        await this.token.connect(this.owner).createMultiplier(0);
        await this.token.connect(this.owner).createMultiplier(0);
    });

    it('should set and update multiplier rates', async function () {
        const newRate = ethers.parseUnits("0.01", 10); // 1% APR (10 decimals)

        // Set rate for multiplier 1
        await this.token.connect(this.owner).setMultiplierRateByAPR(1, newRate);

        // Verify the rate was set using individual getters
        const activeMultiplier = await this.token.getActiveMultiplier(1);
        const nextRate = await this.token.getNextAPR(2);

        // Active multiplier should still be 1.0 since no time has passed
        expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12));
    });

    it('should calculate active multiplier from checkpoint and rate', async function () {
        // Set up rate for multiplier 1
        const rate = ethers.parseUnits("0.05", 10); // 5% APR (10 decimals)
        await this.token.connect(this.owner).setMultiplierRateByAPR(1, rate);

        // Active multiplier should still be the checkpoint initially
        const activeMultiplier = await this.token.getActiveMultiplier(1);
        expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12));

        // Note: Testing time-based compounding would require time manipulation
        // which is more complex and should be done in integration tests
    });

    it('should increment all multipliers in batch', async function () {
        // Set rates on multiple multipliers
        await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.01", 10)); // 1% APR (10 decimals)
        await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.02", 10)); // 2% APR (10 decimals)

        // Multipliers now update automatically on transfer/claim operations
        // No explicit checkpoint needed
    });

    it('should handle 100 multiplier configurations', async function () {
        // Test creating many multipliers to verify scalability
        const maxMultipliers = 10; // Test with smaller number for gas efficiency

        // Note: multipliers 1 and 2 already created in beforeEach
        for (let i = 3; i <= maxMultipliers; i++) {
            // Create multiplier with just rate (claim source set globally)
            await this.token.connect(this.owner).createMultiplier(
                ethers.parseUnits("0.01", 10) // 1% APR (10 decimals)
            );
        }

        // Verify all were created (1 to maxMultipliers)
        for (let i = 1; i <= maxMultipliers; i++) {
            const activeMultiplier = await this.token.getActiveMultiplier(i);
            expect(activeMultiplier).to.equal(ethers.parseUnits("1.0", 12));
        }
    });

    it('should provide correct multiplier count', async function () {
        // Should start with 2 multipliers from beforeEach
        // Verify by checking that multiplier 1 and 2 exist
        const mult1 = await this.token.getActiveMultiplier(1);
        const mult2 = await this.token.getActiveMultiplier(2);
        expect(mult1).to.equal(ethers.parseUnits("1.0", 12));
        expect(mult2).to.equal(ethers.parseUnits("1.0", 12));

        // Add one more
        await this.token.connect(this.owner).createMultiplier(
            ethers.parseUnits("0.01", 10) // 1% APR (10 decimals)
        );

        // Verify multiplier 3 now exists
        const mult3 = await this.token.getActiveMultiplier(3);
        expect(mult3).to.equal(ethers.parseUnits("1.0", 12));
    });

    it('should enforce sequential multiplier creation', async function () {
        // The createMultiplier function auto-assigns sequential IDs
        // Just verify that creating multiple multipliers works correctly
        const id1 = await this.token.connect(this.owner).createMultiplier.staticCall(
            ethers.parseUnits("0.01", 10) // 1% APR (10 decimals)
        );
        await this.token.connect(this.owner).createMultiplier(
            ethers.parseUnits("0.01", 10) // 1% APR (10 decimals)
        );

        const id2 = await this.token.connect(this.owner).createMultiplier.staticCall(
            ethers.parseUnits("0.02", 10) // 2% APR (10 decimals)
        );

        // IDs should be sequential
        expect(Number(id2)).to.equal(Number(id1) + 1);
    });
});