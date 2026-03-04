const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Out-of-Bounds Multiplier Tests', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

        // Configure maturity period and rate bounds
        await this.token.connect(this.owner).setMaturityPeriod(86400);
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("0.02", 10));

        // Setup multiplier before tests (creates multiplier 1)
        await setupMultiplierWithBounds(this);
    });

    describe('adminCreatePayoutGroup with invalid multiplier', function () {
        it('should revert with EVM error for out-of-bounds multiplier index', async function () {
            // Try to create payout address with multiplier index 999 (doesn't exist)
            await expect(
                this.token.connect(this.owner).createPayoutGroup(999, this.acc.address)
            ).to.be.reverted; // Natural EVM revert for array access out of bounds
        });

        it('should work with valid multiplier index 1', async function () {
            // Should work fine with existing multiplier
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

            // Verify it was created with multiplier ID 1
            expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(1);
        });
    });

    describe('getActiveMultiplier with invalid index', function () {
        it('should revert for out-of-bounds index', async function () {
            // getActiveMultiplier now reverts for non-existent multiplier IDs
            await expect(this.token['getActiveMultiplier'](999))
              .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
              .withArgs(999);
        });

        it('should work with valid index 1', async function () {
            const multiplier = await this.token['getActiveMultiplier'](1);
            expect(multiplier).to.equal(ethers.parseUnits("1.0", 12)); // Multiplier 1 initialized at 1.0
        });
    });

    describe('setPayoutGroupMultiplier with invalid indices', function () {
        let payoutGroupId;

        beforeEach(async function () {
            // Create a valid payout address first
            payoutGroupId = await createPayoutGroup(this, 1, this.acc);
        });

        it('should revert when trying to set invalid new multiplier index', async function () {
            await expect(
                this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 999)
            ).to.be.reverted;
        });

        it('should work when setting valid multiplier index', async function () {
            // Add another multiplier first (with bounds already set)
            await setupMultiplierWithBounds(this);

            // Should work fine
            await expect(
                this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, 1)
            ).to.not.be.reverted;

            // Verify it was changed
            expect(await this.token.getPayoutGroupMultId(payoutGroupId)).to.equal(1);
        });
    });

    describe('Edge case: accessing index at exact boundary', function () {
        it('should revert for out-of-bounds index', async function () {
            // We have multiplier index 1 from setupMultiplierWithBounds in beforeEach
            expect(await this.token['getActiveMultiplier'](1)).to.equal(ethers.parseUnits("1.0", 12));

            // Index 0 doesn't exist (invalid), should revert
            await expect(this.token['getActiveMultiplier'](0))
              .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
              .withArgs(0);
            // Index 2 doesn't exist yet, should revert
            await expect(this.token['getActiveMultiplier'](2))
              .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
              .withArgs(2);
        });

        it('should work after adding more multipliers', async function () {
            // Add another multiplier (with bounds already set)
            await setupMultiplierWithBounds(this);

            // Now indices 1 and 2 should work, all at 1.0
            expect(await this.token['getActiveMultiplier'](1)).to.equal(ethers.parseUnits("1.0", 12));
            expect(await this.token['getActiveMultiplier'](2)).to.equal(ethers.parseUnits("1.0", 12));

            // Index 0 doesn't exist (invalid), should revert
            await expect(this.token['getActiveMultiplier'](0))
              .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
              .withArgs(0);
            // Index 3 doesn't exist, should revert
            await expect(this.token['getActiveMultiplier'](3))
              .to.be.revertedWithCustomError(this.token, 'MultiplierIndexNotFound')
              .withArgs(3);
        });
    });
});