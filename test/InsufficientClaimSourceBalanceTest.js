const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

/**
 * Comprehensive tests for InsufficientClaimSourceBalance error
 *
 * These tests verify that insufficient claim source balance
 * is handled safely and correctly across all claim operations.
 *
 * The tests prove:
 * 1. Balance check happens BEFORE any state changes (safe revert)
 * 2. Error provides correct parameters (required, available)
 * 3. All claim operations (claimOne, claimAll, claimBatch) handle this correctly
 * 4. Edge cases (exactly zero, near-zero) work as expected
 */
describe('InsufficientClaimSourceBalance Tests', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Set up rewards period
        await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing

        // Setup multiplier before creating payout group
        await setupMultiplierWithBounds(this);

        // Create payout group and register test accounts
        this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);

        // Fund test accounts
        const testAmount = ethers.parseUnits("1000", 6); // 1000 tokens at 6 decimals
        await this.token.connect(this.owner).increaseSupply(testAmount);
        await this.token.connect(this.owner).transfer(this.acc2.address, ethers.parseUnits("100", 6));
        await this.token.connect(this.owner).transfer(this.acc3.address, ethers.parseUnits("100", 6));

        // Register accounts to payout group
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);

        // Set multiplier to 1.05 to generate 5% rewards (using helper function)
        const futureTime = (await time.latest()) + 86400; // 1 day from now
        await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);

        // Verify rewards have been generated
        const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
        const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

        if (acc2Rewards === 0n || acc3Rewards === 0n) {
            throw new Error(`Setup failed: Insufficient rewards generated (acc2: ${ethers.formatUnits(acc2Rewards, 6)}, acc3: ${ethers.formatUnits(acc3Rewards, 6)})`);
        }
    });

    describe('ClaimOne - Insufficient Balance', function () {
        it('should revert with InsufficientClaimSourceBalance when claim source has insufficient balance', async function () {
            // Get the claim source (owner in our fixture)
            const claimSource = await this.token.getClaimSource();
            const claimSourceBalance = await this.token.balanceOf(claimSource);

            // Calculate how much rewards are available for acc2
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            expect(acc2Rewards).to.be.gt(0, "acc2 should have rewards");

            // Drain claim source so it has less than needed for rewards
            // Leave a small amount (less than acc2Rewards)
            const amountToTransferOut = claimSourceBalance - (acc2Rewards / 2n);
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            const remainingBalance = await this.token.balanceOf(claimSource);
            expect(remainingBalance).to.be.lt(acc2Rewards, "Claim source should have insufficient funds");

            // Attempt to claim should revert with correct error
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance')
                .withArgs(acc2Rewards, remainingBalance);
        });

        it('should revert when claim source has exactly zero balance', async function () {
            // Get rewards amount first
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            expect(acc2Rewards).to.be.gt(0);

            // Drain claim source completely
            const claimSource = await this.token.getClaimSource();
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance);

            // Verify claim source is empty
            expect(await this.token.balanceOf(claimSource)).to.equal(0);

            // Should revert with zero available
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance')
                .withArgs(acc2Rewards, 0);
        });

        it('should succeed when claim source has exactly enough balance', async function () {
            const claimSource = await this.token.getClaimSource();
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);

            // Drain to exactly the rewards amount
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            const amountToTransferOut = claimSourceBalance - acc2Rewards;
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            // Verify we have exactly enough
            expect(await this.token.balanceOf(claimSource)).to.equal(acc2Rewards);

            // Should succeed
            const balanceBefore = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            const balanceAfter = await this.token.balanceOf(this.acc.address);

            expect(balanceAfter - balanceBefore).to.equal(acc2Rewards);
        });

        it('should verify no state changes occur when claim fails due to insufficient balance', async function () {
            // Record initial state
            const claimSource = await this.token.getClaimSource();
            const initialSourceBalance = await this.token.balanceOf(claimSource);
            const initialAcc2Balance = await this.token.balanceOf(this.acc2.address);
            const initialTotalSupply = await this.token.totalSupply();
            const initialRewards = await this.token.availableRewardsOf(this.acc2.address);

            // Drain claim source
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const amountToTransferOut = initialSourceBalance - (acc2Rewards / 2n);
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            // Attempt claim (should fail)
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');

            // Verify NO state changes occurred
            const claimSourceAfter = await this.token.balanceOf(claimSource);
            const acc2BalanceAfter = await this.token.balanceOf(this.acc2.address);
            const totalSupplyAfter = await this.token.totalSupply();
            const rewardsAfter = await this.token.availableRewardsOf(this.acc2.address);

            // Source balance changed due to transfer, but not due to claim
            expect(claimSourceAfter).to.equal(initialSourceBalance - amountToTransferOut);
            expect(acc2BalanceAfter).to.equal(initialAcc2Balance);
            expect(totalSupplyAfter).to.equal(initialTotalSupply);
            expect(rewardsAfter).to.equal(initialRewards);
        });
    });

    describe('ClaimAll - Insufficient Balance', function () {
        it('should revert with InsufficientClaimSourceBalance when claim source has insufficient balance', async function () {
            const claimSource = await this.token.getClaimSource();
            const claimSourceBalance = await this.token.balanceOf(claimSource);

            // Get total group rewards
            const groupRewards = await this.token.getPayoutGroupAvailableRewards(this.payoutGroupId);
            expect(groupRewards).to.be.gt(0, "Group should have rewards");

            // Drain claim source to be insufficient for total group rewards
            const amountToTransferOut = claimSourceBalance - (groupRewards / 2n);
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            const remainingBalance = await this.token.balanceOf(claimSource);
            expect(remainingBalance).to.be.lt(groupRewards);

            // ClaimAll should revert
            await expect(
                this.token.connect(this.acc).claimAll(this.payoutGroupId)
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance')
                .withArgs(groupRewards, remainingBalance);
        });

        it('should succeed when claim source has exactly enough for claimAll', async function () {
            const claimSource = await this.token.getClaimSource();
            const groupRewards = await this.token.getPayoutGroupAvailableRewards(this.payoutGroupId);

            // Drain to exactly the group rewards amount
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            const amountToTransferOut = claimSourceBalance - groupRewards;
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            // Verify exactly enough
            expect(await this.token.balanceOf(claimSource)).to.equal(groupRewards);

            // Should succeed
            const balanceBefore = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).claimAll(this.payoutGroupId);
            const balanceAfter = await this.token.balanceOf(this.acc.address);

            expect(balanceAfter - balanceBefore).to.be.closeTo(groupRewards, ethers.parseUnits("0.01", 6));
        });

        it('should handle partial success scenario correctly (atomic failure)', async function () {
            // This test verifies that if claimAll fails, it doesn't partially claim some accounts
            const claimSource = await this.token.getClaimSource();
            const groupRewards = await this.token.getPayoutGroupAvailableRewards(this.payoutGroupId);

            // Drain to insufficient amount
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance - (groupRewards / 2n));

            // Record state before attempt
            const acc2RewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
            const acc3RewardsBefore = await this.token.availableRewardsOf(this.acc3.address);

            // Attempt claimAll (should fail atomically)
            await expect(
                this.token.connect(this.acc).claimAll(this.payoutGroupId)
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');

            // Verify both accounts still have their rewards (nothing was claimed)
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(acc2RewardsBefore);
            expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(acc3RewardsBefore);
        });
    });

    describe('ClaimBatch - Insufficient Balance', function () {
        it('should revert with InsufficientClaimSourceBalance when claim source has insufficient balance for batch', async function () {
            const claimSource = await this.token.getClaimSource();
            const claimSourceBalance = await this.token.balanceOf(claimSource);

            // Get rewards for both accounts
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);
            const totalRewards = acc2Rewards + acc3Rewards;

            expect(totalRewards).to.be.gt(0, "Should have total rewards");

            // Drain to insufficient amount for batch
            const amountToTransferOut = claimSourceBalance - (totalRewards / 2n);
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransferOut);

            // ClaimBatch should fail when hitting the limit
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address, this.acc3.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');
        });

        it('should revert when claim source runs out mid-batch', async function () {
            const claimSource = await this.token.getClaimSource();

            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

            // Drain to just enough for first claim but not second
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            const amountToLeave = acc2Rewards + (acc3Rewards / 2n);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance - amountToLeave);

            // Batch claim should fail (atomic - no partial claims)
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address, this.acc3.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');

            // Verify first account wasn't claimed either (atomic failure)
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(acc2Rewards);
            expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(acc3Rewards);
        });

        it('should succeed when claim source has exactly enough for entire batch', async function () {
            const claimSource = await this.token.getClaimSource();
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);
            const totalRewards = acc2Rewards + acc3Rewards;

            // Drain to exactly the total needed
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance - totalRewards);

            // Verify exactly enough
            expect(await this.token.balanceOf(claimSource)).to.equal(totalRewards);

            // Should succeed for entire batch
            const balanceBefore = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address, this.acc3.address]);
            const balanceAfter = await this.token.balanceOf(this.acc.address);

            expect(balanceAfter - balanceBefore).to.be.closeTo(totalRewards, ethers.parseUnits("0.01", 6));
        });
    });

    describe('Edge Cases', function () {
        it('should handle claim source with 1 wei insufficient correctly', async function () {
            const claimSource = await this.token.getClaimSource();
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const claimSourceBalance = await this.token.balanceOf(claimSource);

            // Make sure we have enough to leave acc2Rewards - 1
            expect(claimSourceBalance).to.be.gt(acc2Rewards, "Claim source should have more than rewards amount");

            // Drain to exactly 1 less than needed
            const amountToTransfer = claimSourceBalance - acc2Rewards + 1n;
            await this.token.connect(this.owner).transfer(this.recipient.address, amountToTransfer);

            const remainingBalance = await this.token.balanceOf(claimSource);
            expect(remainingBalance).to.equal(acc2Rewards - 1n);

            // Should still revert
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance')
                .withArgs(acc2Rewards, acc2Rewards - 1n);
        });

        it('should handle zero rewards claim gracefully (no revert)', async function () {
            // Claim all rewards first
            await this.token.connect(this.acc).claimAll(this.payoutGroupId);

            // Verify rewards are now zero
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0);

            // Drain claim source completely
            const claimSource = await this.token.getClaimSource();
            const balance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, balance);

            // Attempting to claim zero rewards should not revert (even with empty source)
            // because amount check happens before balance check
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            // Should succeed (no-op)
        });

        it('should verify error parameters are correct (required vs available)', async function () {
            const claimSource = await this.token.getClaimSource();
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);

            // Leave exactly half of what's needed (should be less than acc2Rewards since we have 5% rewards on 100 tokens = 5 tokens)
            const availableAmount = acc2Rewards / 2n;
            expect(availableAmount).to.be.lt(acc2Rewards, "Available should be less than required");

            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance - availableAmount);

            // Verify exactly the available amount remains
            expect(await this.token.balanceOf(claimSource)).to.equal(availableAmount);

            // Verify the error has correct parameters
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance')
                .withArgs(acc2Rewards, availableAmount); // (required, available)
        });

        it('should handle sequential claims exhausting claim source', async function () {
            const claimSource = await this.token.getClaimSource();
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

            // Drain to exactly enough for first claim only
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance - acc2Rewards - 1n);

            // First claim should succeed (or very close)
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);

            // Second claim should fail due to insufficient balance
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc3.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');
        });
    });

    describe('Integration: Multiple Scenarios', function () {
        it('should handle replenishing claim source and retrying claim', async function () {
            const claimSource = await this.token.getClaimSource();
            const acc2Rewards = await this.token.availableRewardsOf(this.acc2.address);

            // Drain claim source
            const claimSourceBalance = await this.token.balanceOf(claimSource);
            await this.token.connect(this.owner).transfer(this.recipient.address, claimSourceBalance);

            // Verify claim fails
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');

            // Replenish claim source
            await this.token.connect(this.recipient).transfer(claimSource, acc2Rewards);

            // Now claim should succeed
            const balanceBefore = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            const balanceAfter = await this.token.balanceOf(this.acc.address);

            expect(balanceAfter - balanceBefore).to.equal(acc2Rewards);
        });

        it('should verify safe revert with no partial state changes', async function () {
            const claimSource = await this.token.getClaimSource();
            const initialSourceBalance = await this.token.balanceOf(claimSource);
            const initialAcc2Rewards = await this.token.availableRewardsOf(this.acc2.address);
            const initialAcc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

            // Drain to insufficient
            await this.token.connect(this.owner).transfer(this.recipient.address, initialSourceBalance);

            // Attempt claim (will revert)
            await expect(
                this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address])
            ).to.be.revertedWithCustomError(this.token, 'InsufficientClaimSourceBalance');

            // Verify all state remains consistent
            expect(await this.token.balanceOf(claimSource)).to.equal(0); // Changed by transfer only
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(initialAcc2Rewards);
            expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(initialAcc3Rewards);
        });
    });
});
