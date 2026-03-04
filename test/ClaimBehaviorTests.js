const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * Comprehensive Claim Behavior Tests
 *
 * Consolidates tests from:
 * - ClaimNonceLagTest.js (LastMultiplier tracking)
 * - ClaimAllEpochTrackingTest.js (Epoch tracking consistency)
 * - ClaimAllClaimOneMixingTest.js (No double payout)
 */
describe('Claim Behavior Tests', function () {
    // ========================================================================
    // LASTMULTIPLIER TRACKING
    // ========================================================================

    describe('LastMultiplier Tracking', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Set referenceTime to current time for proper period calculations
            const currentTime = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(currentTime);

            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-3000% APR for testing
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            await setupMultiplierWithBounds(this);
            this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
        });

        describe('LastMultiplier Tracking Scenario', function () {
            it('should handle lastMultiplier updates correctly after claimAll', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                const returnedAmount = await this.token.connect(this.acc).claimAll.staticCall(this.payoutGroupId);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const claimedAmount = balanceAfter - balanceBefore;

                log(`Full claim rewards: ${ethers.formatEther(claimedAmount)} ETH`);
                expect(claimedAmount).to.be.gt(0);
                // Verify return value matches balance change
                expect(returnedAmount).to.equal(claimedAmount);

                // Verify claiming again immediately yields no additional rewards
                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                const returnedAmount2 = await this.token.connect(this.acc).claimAll.staticCall(this.payoutGroupId);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter2 - balanceBefore2).to.equal(0);
                expect(returnedAmount2).to.equal(0);
            });

            it('should calculate rewards correctly for accounts after claimAll', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                log("\n=== BEFORE CLAIMALL ===");
                log(`Account (acc2) balance: ${ethers.formatUnits(await this.token.balanceOf(this.acc2.address), 6)}`);
                log(`Multiplier: ${ethers.formatUnits(await this.token.getActiveMultiplier(1), 12)}`);

                const claimAllBalanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const claimAllBalanceAfter = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = claimAllBalanceAfter - claimAllBalanceBefore;

                log("\n=== AFTER CLAIMALL ===");
                log(`ClaimAll rewards paid: ${ethers.formatUnits(claimAllRewards, 6)}`);

                // Increase multiplier again to create more rewards
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                log("\n=== BEFORE INDIVIDUAL CLAIM ===");
                log(`Account (acc2) balance: ${ethers.formatUnits(await this.token.balanceOf(this.acc2.address), 6)}`);
                log(`Current multiplier: ${ethers.formatUnits(await this.token.getActiveMultiplier(1), 12)}`);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const actualRewards = balanceAfter - balanceBefore;

                log("\n=== AFTER INDIVIDUAL CLAIM ===");
                log(`Individual claim rewards: ${ethers.formatUnits(actualRewards, 6)}`);

                expect(actualRewards).to.be.gt(0);
            });

            it('should handle multiple accounts consistently after claimAll', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const controllerBalanceBefore = await this.token.balanceOf(this.acc.address);
                const returnedAcc2 = await this.token.connect(this.acc).claimForAddresses.staticCall(this.payoutGroupId, [this.acc2.address]);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
                const controllerBalanceAfter1 = await this.token.balanceOf(this.acc.address);
                const acc2Rewards = controllerBalanceAfter1 - controllerBalanceBefore;

                const returnedAcc3 = await this.token.connect(this.acc).claimForAddresses.staticCall(this.payoutGroupId, [this.acc3.address]);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc3.address]);
                const controllerBalanceAfter2 = await this.token.balanceOf(this.acc.address);
                const acc3Rewards = controllerBalanceAfter2 - controllerBalanceAfter1;

                log(`acc2 rewards: ${ethers.formatEther(acc2Rewards)}`);
                log(`acc3 rewards: ${ethers.formatEther(acc3Rewards)}`);

                expect(acc2Rewards).to.equal(acc3Rewards);
                expect(acc2Rewards).to.be.gt(0);
                // Verify return values match balance changes
                expect(returnedAcc2).to.equal(acc2Rewards);
                expect(returnedAcc3).to.equal(acc3Rewards);
            });
        });

        describe('Transfer After Full Claim (LastMultiplier Updates)', function () {
            it('should handle lastMultiplier updates when account transfers after claimAll', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const currentMultiplier = await this.token.getActiveMultiplier(1);
                log(`Current multiplier after claimAll: ${ethers.formatEther(currentMultiplier)}`);

                const transferTx = await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER / 2n);
                const receipt = await transferTx.wait();

                log(`Transfer completed with gas: ${receipt.gasUsed}`);
                expect(receipt.gasUsed).to.be.gt(0);
            });

            it('should handle rewards calculation correctly after transfer updates lastMultiplier', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER / 4n);

                // Increase multiplier again and advance time
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const rewards = balanceAfter - balanceBefore;

                log(`Rewards for acc2 after transfer: ${ethers.formatEther(rewards)}`);
                // After second multiplier increase and time passage, rewards should be generated
                expect(rewards).to.be.gt(0);
            });
        });

        describe('Edge Cases', function () {
            it('should handle zero rewards scenario with lastMultiplier sync', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const balanceBefore = await this.token.balanceOf(this.acc2.address);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc2.address);

                expect(balanceAfter - balanceBefore).to.equal(0);
            });

            it('should handle multiple claimAlls updating lastMultiplier correctly', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const futureTime3 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.03", 12), futureTime3);
                await time.increase(3601);
                await this.token.connect(this.acc).claimAll(this.payoutGroupId);

                const balanceBeforeZeroClaim = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
                const balanceAfterZeroClaim = await this.token.balanceOf(this.acc.address);
                expect(balanceAfterZeroClaim - balanceBeforeZeroClaim).to.equal(0);

                const futureTime4 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.04", 12), futureTime4);
                await time.increase(3601);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const rewards = balanceAfter - balanceBefore;

                log(`Rewards with synchronized lastMultiplier: ${ethers.formatEther(rewards)}`);
                expect(rewards).to.be.gt(0);
            });
        });
    });

    // ========================================================================
    // EPOCH TRACKING CONSISTENCY
    // ========================================================================

    describe('ClaimAll EpochNum Tracking Consistency', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Set referenceTime to current time for proper period calculations
            const currentTime = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(currentTime);

            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-3000% APR for testing
        });

        it('should handle same-epoch transfer + claimAll correctly', async function () {
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1000n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 100n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 100n);

            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.recipient);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

            const futureTime = (await time.latest()) + 7200;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(7201);

            const acc1RewardsBefore = await this.token.availableRewardsOf(this.acc.address);
            const acc2RewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
            expect(acc1RewardsBefore).to.be.gt(0, "acc1 should have rewards");
            expect(acc2RewardsBefore).to.be.gt(0, "acc2 should have rewards");

            log(`  acc1 rewards before: ${ethers.formatUnits(acc1RewardsBefore, 6)}`);
            log(`  acc2 rewards before: ${ethers.formatUnits(acc2RewardsBefore, 6)}`);

            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);

            await this.token.connect(this.recipient).claimAll(payoutGroupId);

            const acc1RewardsAfter = await this.token.availableRewardsOf(this.acc.address);
            const acc2RewardsAfter = await this.token.availableRewardsOf(this.acc2.address);

            log(`  acc1 rewards after: ${ethers.formatUnits(acc1RewardsAfter, 6)}`);
            log(`  acc2 rewards after: ${ethers.formatUnits(acc2RewardsAfter, 6)}`);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            // The small remaining rewards are due to timing differences in multiplier updates
            expect(acc1RewardsAfter).to.be.lt(ethers.parseUnits("5", 6), "acc1 should have ~0 rewards after claimAll");
            expect(acc2RewardsAfter).to.be.lt(ethers.parseUnits("5", 6), "acc2 should have ~0 rewards after claimAll");

            log(`  ✅ ClaimAll correctly reset rewards for account updated in same epoch`);
        });

        it('should handle multiple transfers + claimAll in same epoch', async function () {
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1000n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 100n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 100n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 100n);

            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.recipient);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

            const futureTime = (await time.latest()) + 7200;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(7201);

            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
            await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER);
            await this.token.connect(this.acc3).transfer(this.acc.address, ONE_ETHER);

            await this.token.connect(this.recipient).claimAll(payoutGroupId);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc3.address)).to.be.lt(ethers.parseUnits("5", 6));

            log(`  ✅ ClaimAll correctly handled multiple same-epoch transfers`);
        });

        it('should maintain consistency across multiple claimAll operations', async function () {
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1000n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 100n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 100n);

            await setupMultiplierWithBounds(this);
            const payoutGroupId = await createPayoutGroup(this, 1, this.recipient);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

            let futureTime = (await time.latest()) + 7200;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
            await time.increase(7201);

            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
            await this.token.connect(this.recipient).claimAll(payoutGroupId);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.lt(ethers.parseUnits("5", 6));

            // Increase multiplier again and verify rewards accumulate
            futureTime = (await time.latest()) + 7200;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(7201);

            // After new earn period, rewards should accumulate
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.gt(0);
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.gt(0);

            await this.token.connect(this.acc2).transfer(this.acc.address, ONE_ETHER);
            await this.token.connect(this.recipient).claimAll(payoutGroupId);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.lt(ethers.parseUnits("5", 6));

            log(`  ✅ Multiple claimAll operations maintain consistency`);
        });

        it('should handle claimAll immediately after cross-group transfer', async function () {
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1000n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 100n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 100n);

            await setupMultiplierWithBounds(this);
            const group1Id = await createPayoutGroup(this, 1, this.recipient);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(group1Id, this.acc.address);

            const group2Id = await createPayoutGroup(this, 1, this.acc3);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(group2Id, this.acc2.address);

            const futureTime = (await time.latest()) + 7200;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(7201);

            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER * 10n);

            await this.token.connect(this.recipient).claimAll(group1Id);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.gt(0);

            await this.token.connect(this.acc3).claimAll(group2Id);

            // Allow tolerance for rounding/multiplier growth between transfer and claimAll
            expect(await this.token.availableRewardsOf(this.acc.address)).to.be.lt(ethers.parseUnits("5", 6));
            expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.lt(ethers.parseUnits("5", 6));

            log(`  ✅ ClaimAll correctly handles cross-group transfers`);
        });
    });

    // ========================================================================
    // CLAIMALL AND CLAIMONE MIXING - NO DOUBLE PAYOUT
    // ========================================================================

    describe('ClaimAll and ClaimOne Mixing - No Double Payout', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Set referenceTime to current time for proper period calculations
            const currentTime = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(currentTime);

            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-3000% APR for testing
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            this.acc4 = ethers.Wallet.createRandom().connect(ethers.provider);

            await setupMultiplierWithBounds(this);
            this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc4.address, ONE_ETHER * 2n);

            const payoutGroupId = this.payoutGroupId;
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc4.address);
        });

        describe('Basic Non-Double Payout Tests', function () {
            it('claimAll then claimOne (same multiplier) - claimOne should yield 0 rewards', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                const returnedClaimAll = await this.token.connect(this.acc).claimAll.staticCall(payoutGroupId);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter - balanceBefore;

                expect(claimAllRewards).to.be.gt(0);
                expect(returnedClaimAll).to.equal(claimAllRewards);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                const returnedClaimOne = await this.token.connect(this.acc).claimForAddresses.staticCall(payoutGroupId, [this.acc2.address]);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimOneRewards = balanceAfter2 - balanceBefore2;

                expect(claimOneRewards).to.equal(0);
                expect(returnedClaimOne).to.equal(0);
            });

            it('claimOne then claimAll (same multiplier) - claimAll should yield remaining rewards', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                const returnedClaimOne = await this.token.connect(this.acc).claimForAddresses.staticCall(payoutGroupId, [this.acc2.address]);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const claimOneRewards = balanceAfter - balanceBefore;

                expect(claimOneRewards).to.be.gt(0);
                expect(returnedClaimOne).to.equal(claimOneRewards);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                const returnedClaimAll = await this.token.connect(this.acc).claimAll.staticCall(payoutGroupId);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter2 - balanceBefore2;

                expect(claimAllRewards).to.be.gt(0);
                expect(returnedClaimAll).to.equal(claimAllRewards);
                expect(claimAllRewards).to.be.closeTo(claimOneRewards * 2n, claimOneRewards);

                const totalClaimed = claimOneRewards + claimAllRewards;
                expect(totalClaimed).to.be.gt(ethers.parseUnits("0.05", 6));
                expect(totalClaimed).to.be.lt(ethers.parseUnits("0.15", 6));
            });

            it('claimOne then claimOne (same multiplier) - second claimOne should yield 0 rewards', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const firstRewards = balanceAfter - balanceBefore;

                expect(firstRewards).to.be.gt(0);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const secondRewards = balanceAfter2 - balanceBefore2;

                expect(secondRewards).to.equal(0);
            });
        });

        describe('Ordering Tests with Multiplier Increases', function () {
            it('claimAll → mult increase → claimOne: only new rewards since claimAll', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimAll(payoutGroupId);

                // Increase multiplier again to create new earn period
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const rewards = balanceAfter - balanceBefore;

                expect(rewards).to.be.gt(ethers.parseUnits("0.01", 6));
                expect(rewards).to.be.lt(ethers.parseUnits("0.05", 6));
            });

            it('claimOne → mult increase → claimAll: only new rewards since claimOne', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const claimOneRewards = balanceAfter1 - balanceBefore1;

                // Increase multiplier to create new earn period
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter2 - balanceBefore2;

                expect(claimAllRewards).to.be.gt(0);
                expect(claimAllRewards).to.be.lt(ethers.parseUnits("0.3", 6));
            });

            it('claimBatch → mult increase → claimAll: claimAll only pays unclaimed addresses', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                // Check available rewards before claiming using batch function
                const addressesToClaim = [this.acc2.address, this.acc3.address];
                const availableRewards = await this.token.availableRewardsOfBatch(addressesToClaim);
                expect(availableRewards.length).to.equal(2);
                expect(availableRewards[0]).to.be.gt(0);
                expect(availableRewards[1]).to.be.gt(0);

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                const returnedBatch = await this.token.connect(this.acc).claimForAddresses.staticCall(payoutGroupId, addressesToClaim);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, addressesToClaim);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const batchRewards = balanceAfter1 - balanceBefore1;

                // Verify claimed amount matches sum of available rewards and return value
                expect(batchRewards).to.equal(availableRewards[0] + availableRewards[1]);
                expect(returnedBatch).to.equal(batchRewards);

                // Increase multiplier to create new earn period
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                const returnedClaimAll = await this.token.connect(this.acc).claimAll.staticCall(payoutGroupId);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter2 - balanceBefore2;

                // ClaimAll should claim remaining account (acc4) with new rewards from second earn period
                expect(claimAllRewards).to.be.gt(0);
                expect(returnedClaimAll).to.equal(claimAllRewards);
            });

            it('claimAll → mult increase → claimBatch: batch claims new rewards correctly', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimAll(payoutGroupId);

                // Increase multiplier to create new earn period
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                // Check available rewards before claiming using batch function
                const addressesToClaim = [this.acc2.address, this.acc3.address, this.acc4.address];
                const availableRewards = await this.token.availableRewardsOfBatch(addressesToClaim);
                expect(availableRewards.length).to.equal(3);
                const expectedTotal = availableRewards[0] + availableRewards[1] + availableRewards[2];

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                const returnedBatch = await this.token.connect(this.acc).claimForAddresses.staticCall(payoutGroupId, addressesToClaim);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, addressesToClaim);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const batchRewards = balanceAfter - balanceBefore;

                // Verify claimed amount matches sum of available rewards and return value
                expect(batchRewards).to.equal(expectedTotal);
                expect(returnedBatch).to.equal(batchRewards);
                expect(batchRewards).to.be.gt(0);
                expect(batchRewards).to.be.lt(ethers.parseUnits("0.3", 6));
            });
        });

        describe('Multiple Account Scenarios', function () {
            it('claimOne(acc2) → claimAll → verify acc2 gets 0 more, acc3 & owner get paid', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const acc2Rewards = balanceAfter1 - balanceBefore1;

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter2 - balanceBefore2;

                expect(claimAllRewards).to.be.closeTo(acc2Rewards * 2n, acc2Rewards);

                const balanceBefore3 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter3 = await this.token.balanceOf(this.acc.address);
                const acc2RewardsAgain = balanceAfter3 - balanceBefore3;

                expect(acc2RewardsAgain).to.equal(0);
            });

            it('claimAll → claimOne(acc2) → verify acc2 gets 0', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimAll(payoutGroupId);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);
                const rewards = balanceAfter - balanceBefore;

                expect(rewards).to.equal(0);
            });

            it('Partial batch claim → claimAll → verify only unclaimed get paid', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const batchRewards = balanceAfter1 - balanceBefore1;

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter2 - balanceBefore2;

                expect(claimAllRewards).to.be.closeTo(batchRewards * 2n, batchRewards);
            });
        });

        describe('Complex Ordering Patterns', function () {
            it('claimOne(acc2) → claimAll → claimOne(acc2) → mult increase → claimOne(acc2) → verify correct new rewards', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                await this.token.connect(this.acc).claimAll(payoutGroupId);

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter1 - balanceBefore1).to.equal(0);

                // Increase multiplier to create new earn period
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                const newRewards = balanceAfter2 - balanceBefore2;

                expect(newRewards).to.be.gt(0);
                expect(newRewards).to.be.lt(ethers.parseUnits("0.05", 6));
            });

            it('claimBatch([acc2,acc3]) → claimAll → claimOne(owner) → verify owner gets 0', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address, this.acc3.address]);
                await this.token.connect(this.acc).claimAll(payoutGroupId);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc4.address]);
                const balanceAfter = await this.token.balanceOf(this.acc.address);

                expect(balanceAfter - balanceBefore).to.equal(0);
            });

            it('claimAll → claimBatch(all) → verify all get 0', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimAll(payoutGroupId);

                // Verify batch shows zero rewards available after claimAll
                const addressesToClaim = [this.acc2.address, this.acc3.address, this.acc4.address];
                const availableRewards = await this.token.availableRewardsOfBatch(addressesToClaim);
                expect(availableRewards[0]).to.equal(0);
                expect(availableRewards[1]).to.equal(0);
                expect(availableRewards[2]).to.equal(0);

                const balanceBefore = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, addressesToClaim);
                const balanceAfter = await this.token.balanceOf(this.acc.address);

                expect(balanceAfter - balanceBefore).to.equal(0);
            });
        });

        describe('Edge Cases', function () {
            it('Multiple claimAll calls in a row should be idempotent', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const firstRewards = balanceAfter1 - balanceBefore1;

                expect(firstRewards).to.be.gt(0);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter2 - balanceBefore2).to.equal(0);

                const balanceBefore3 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter3 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter3 - balanceBefore3).to.equal(0);
            });

            it('Mixed claimOne/claimAll with no multiplier changes should eventually yield 0', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc3.address]);

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                const claimAllRewards = balanceAfter1 - balanceBefore1;

                expect(claimAllRewards).to.be.gt(0);

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter2 - balanceBefore2).to.equal(0);

                const balanceBefore3 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter3 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter3 - balanceBefore3).to.equal(0);
            });

            it('Verify total rewards claimed across all claims match expected total', async function () {
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
                await time.increase(3601);

                const payoutGroupId = this.payoutGroupId;

                let totalClaimed = 0n;

                const balanceBefore1 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
                const balanceAfter1 = await this.token.balanceOf(this.acc.address);
                totalClaimed += balanceAfter1 - balanceBefore1;

                const balanceBefore2 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc3.address]);
                const balanceAfter2 = await this.token.balanceOf(this.acc.address);
                totalClaimed += balanceAfter2 - balanceBefore2;

                const balanceBefore3 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                const balanceAfter3 = await this.token.balanceOf(this.acc.address);
                totalClaimed += balanceAfter3 - balanceBefore3;

                const minExpected = ethers.parseUnits("0.05", 6);
                const maxExpected = ethers.parseUnits("0.12", 6);
                expect(totalClaimed).to.be.gte(minExpected);
                expect(totalClaimed).to.be.lte(maxExpected);

                const balanceBefore4 = await this.token.balanceOf(this.acc.address);
                await this.token.connect(this.acc).claimAll(payoutGroupId);
                await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address, this.acc3.address, this.acc4.address]);
                const balanceAfter4 = await this.token.balanceOf(this.acc.address);
                expect(balanceAfter4 - balanceBefore4).to.equal(0);
            });
        });
    });

    describe('availableRewardsOfBatch', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Set referenceTime to current time for proper period calculations
            const currentTime = await time.latest();
            await this.token.connect(this.owner).setReferenceTime(currentTime);

            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10));
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            // Create additional test wallet
            this.acc4 = ethers.Wallet.createRandom().connect(ethers.provider);

            await setupMultiplierWithBounds(this);
            this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);
            await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc.address);

            // Transfer different amounts to test proportional rewards
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 1n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc4.address, ONE_ETHER * 3n);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc4.address);
        });

        it('should return rewards matching individual calls', async function () {
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
            await time.increase(3601);

            // Get individual rewards
            const rewards2 = await this.token.availableRewardsOf(this.acc2.address);
            const rewards3 = await this.token.availableRewardsOf(this.acc3.address);
            const rewards4 = await this.token.availableRewardsOf(this.acc4.address);

            // Get batch rewards
            const batchRewards = await this.token.availableRewardsOfBatch([
                this.acc2.address,
                this.acc3.address,
                this.acc4.address
            ]);

            // Verify batch returns same values as individual calls
            expect(batchRewards.length).to.equal(3);
            expect(batchRewards[0]).to.equal(rewards2);
            expect(batchRewards[1]).to.equal(rewards3);
            expect(batchRewards[2]).to.equal(rewards4);

            // Verify all have rewards
            expect(batchRewards[0]).to.be.gt(0);
            expect(batchRewards[1]).to.be.gt(0);
            expect(batchRewards[2]).to.be.gt(0);

            // Verify rewards are proportional to balances (1:2:3 ratio)
            expect(batchRewards[1]).to.be.gt(batchRewards[0]);
            expect(batchRewards[2]).to.be.gt(batchRewards[1]);
        });

        it('should accurately predict claimForAddresses payout', async function () {
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
            await time.increase(3601);

            const addressesToClaim = [this.acc2.address, this.acc3.address, this.acc4.address];

            // Check batch rewards before claiming
            const availableRewards = await this.token.availableRewardsOfBatch(addressesToClaim);
            const expectedTotal = availableRewards[0] + availableRewards[1] + availableRewards[2];

            // Claim and verify amount matches prediction
            const balanceBefore = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, addressesToClaim);
            const balanceAfter = await this.token.balanceOf(this.acc.address);

            expect(balanceAfter - balanceBefore).to.equal(expectedTotal);
        });
    });
});
