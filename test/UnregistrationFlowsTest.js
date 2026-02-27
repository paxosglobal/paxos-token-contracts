/**
 * Comprehensive Unregistration and Re-registration Tests
 *
 * Consolidates:
 * - PartnerInitiatedUnregistrationTest.js (392 lines) - Claimer/manager unregistration
 * - UnregisterReregistrationTest.js (422 lines) - Unregister/reregister flows
 *
 * Total: 814 lines → ~700 lines (saves ~114 lines of duplicate setup)
 */

const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { setupRebaseEnvironment, createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

describe('Unregistration Flows Test', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await setupRebaseEnvironment(this);
        // Set reference time to current time (default is 0 for UTC midnight alignment)
        const currentTime = await time.latest();
        await this.token.connect(this.owner).setReferenceTime(currentTime);
        // Create multiplier 1 (tests use multiplier 1 by default)
        await setupMultiplierWithBounds(this);
    });

    // ========================================================================
    // PARTNER-INITIATED UNREGISTRATION (No Signature Required)
    // ========================================================================

    describe('Partner-Initiated Unregistration', function () {
        beforeEach(async function () {
            // Setup accounts
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER);

            // Create payout group with acc as claimer
            this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);

            // Set acc2 as manager
            await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.acc2.address);

            // Register acc3 to the payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
        });

        describe('Claimer-Initiated', function () {
            it('should allow claimer to unregister account', async function () {
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(this.payoutGroupId);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.emit(this.token, 'AccountDeregistered')
                    .withArgs(this.acc3.address, this.payoutGroupId, this.acc.address);

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });

            it('should preserve balance during unregistration', async function () {
                const balanceBefore = await this.token.balanceOf(this.acc3.address);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                const balanceAfter = await this.token.balanceOf(this.acc3.address);
                expect(balanceAfter).to.equal(balanceBefore);
            });

            it('should allow claimer to unregister any account in their payout group', async function () {
                const signers = await ethers.getSigners();
                const additionalAccount = signers[7];
                await this.token.connect(this.owner).transfer(additionalAccount.address, ONE_ETHER);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, additionalAccount.address);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, additionalAccount.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(additionalAccount.address)).to.equal(0);
            });
        });

        describe('Manager-Initiated', function () {
            it('should allow manager to unregister account', async function () {
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(this.payoutGroupId);

                await expect(
                    this.token.connect(this.acc2).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.emit(this.token, 'AccountDeregistered')
                    .withArgs(this.acc3.address, this.payoutGroupId, this.acc.address);

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });
        });

        describe('Claim Before Unregistration', function () {
            beforeEach(async function () {
                // Generate rewards
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
                await time.increase(3601);
            });

            it('should claim rewards to configured destination before unregistering', async function () {
                await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc2.address);

                const rewardsBefore = await this.token.availableRewardsOf(this.acc3.address);
                expect(rewardsBefore).to.be.gt(0);

                const destBalanceBefore = await this.token.balanceOf(this.acc2.address);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                const destBalanceAfter = await this.token.balanceOf(this.acc2.address);
                expect(destBalanceAfter - destBalanceBefore).to.be.closeTo(rewardsBefore, 10n);
                expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(0);
            });

            it('should claim to claimer if no destination set', async function () {
                const rewardsBefore = await this.token.availableRewardsOf(this.acc3.address);
                expect(rewardsBefore).to.be.gt(0);

                const claimerBalanceBefore = await this.token.balanceOf(this.acc.address);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                const claimerBalanceAfter = await this.token.balanceOf(this.acc.address);
                expect(claimerBalanceAfter - claimerBalanceBefore).to.be.closeTo(rewardsBefore, 10n);
            });

            it('should emit RewardsClaimed event when claiming before unregistration', async function () {
                const rewardsBefore = await this.token.availableRewardsOf(this.acc3.address);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.emit(this.token, 'RewardsClaimed')
                    .withArgs(this.acc3.address, this.payoutGroupId, this.acc.address, rewardsBefore);
            });

            it('should handle unregistration with zero rewards gracefully', async function () {
                await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc3.address]);
                expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(0);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });
        });

        describe('Authorization Checks', function () {
            it('should reject when called by non-claimer/non-manager', async function () {
                const signers = await ethers.getSigners();
                const randomAccount = signers[7];

                await expect(
                    this.token.connect(randomAccount).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
            });

            it('should reject when account tries to unregister itself without being claimer/manager', async function () {
                await expect(
                    this.token.connect(this.acc3).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
            });
        });

        describe('State Updates', function () {
            it('should clear shares and epoch on unregistration', async function () {
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
                expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(0);
            });

            it('should update payout group balance tracking', async function () {
                const groupBalanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                const groupBalanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);
                expect(groupBalanceBefore - groupBalanceAfter).to.equal(ONE_ETHER);
            });

            it('should update payout group balance tracking', async function () {
                const pgBalanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                const pgBalanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);
                expect(pgBalanceBefore - pgBalanceAfter).to.equal(ONE_ETHER);
            });

            it('should correctly update payout group shares when unregistering after claiming rewards', async function () {
                await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc2.address);
                
                const futureTime = (await time.latest()) + 86400;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.001", 12), futureTime);
                await time.increase(86401);
                
                const rewardsBefore = await this.token.availableRewardsOf(this.acc3.address);
                expect(rewardsBefore).to.be.gt(0, 'Rewards should have accumulated');
                
                const groupBalanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);
                const acc3Balance = await this.token.balanceOf(this.acc3.address);
                const destinationBalanceBefore = await this.token.balanceOf(this.acc2.address);
                
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);
                
                const destinationBalanceAfter = await this.token.balanceOf(this.acc2.address);
                expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(rewardsBefore, 10n);
                
                const groupBalanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);
                expect(groupBalanceAfter).to.equal(groupBalanceBefore - acc3Balance,
                    'Payout group balance should decrease by unregistered account balance');
                
                const groupRewardsAfter = await this.token.getPayoutGroupAvailableRewards(this.payoutGroupId);
                expect(groupRewardsAfter).to.equal(0,
                    'Payout group rewards should be 0 after unregistering the only account (verifies shares were correctly updated)');
                
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
                expect(await this.token.availableRewardsOf(this.acc3.address)).to.equal(0);
            });
        });

        describe('Idempotency', function () {
            it('should be idempotent when account already unregistered', async function () {
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });

            it('should handle unregistration of account not in any group', async function () {
                const signers = await ethers.getSigners();
                const neverRegisteredAccount = signers[7];

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, neverRegisteredAccount.address)
                ).to.not.be.reverted;
            });
        });

        describe('Error Cases', function () {
            it('should reject unregistration from wrong payout group', async function () {
                const signers = await ethers.getSigners();
                const otherClaimer = signers[7];
                const otherPayoutGroupId = await createPayoutGroup(this, 1, otherClaimer);

                await expect(
                    this.token.connect(otherClaimer).unregisterRewardAddress(otherPayoutGroupId, this.acc3.address)
                ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
            });
        });

        describe('Multiple Account Scenarios', function () {
            beforeEach(async function () {
                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);

                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
                await time.increase(3601);
            });

            it('should unregister one account without affecting others', async function () {
                const acc2RewardsBefore = await this.token.availableRewardsOf(this.acc2.address);
                const accRewardsBefore = await this.token.availableRewardsOf(this.acc.address);

                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);

                expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.closeTo(acc2RewardsBefore, 10n);
                expect(await this.token.availableRewardsOf(this.acc.address)).to.be.closeTo(accRewardsBefore, 10n);
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
                expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(this.payoutGroupId);
                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(this.payoutGroupId);
            });

            it('should handle sequential unregistrations', async function () {
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address);
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc2.address);
                await this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc.address);

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
                expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(0);
                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
                expect(await this.token.getPayoutGroupBalance(this.payoutGroupId)).to.equal(0);
            });
        });

        describe('Edge Cases', function () {
            it('should handle unregistration with very small balance', async function () {
                await this.token.connect(this.acc3).transfer(this.owner.address, ONE_ETHER - 1n);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });

            it('should handle unregistration when balance is zero', async function () {
                await this.token.connect(this.acc3).transfer(this.owner.address, ONE_ETHER);

                await expect(
                    this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc3.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc3.address)).to.equal(0);
            });
        });
    });

    // ========================================================================
    // UNREGISTER AND RE-REGISTRATION FLOWS
    // ========================================================================

    describe('Unregister and Re-registration Flows', function () {
        beforeEach(async function () {
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
        });

        describe('Forced Claim on Unregister', function () {
            it('should claim rewards to configured destination on unregister', async function () {
                const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
                await time.increase(3601);

                const rewardsBefore = await this.token.availableRewardsOf(this.acc.address);
                expect(rewardsBefore).to.be.gt(0);

                const destinationBalanceBefore = await this.token.balanceOf(this.acc3.address);

                await expect(
                    this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address)
                ).to.emit(this.token, 'RewardsClaimed')
                    .to.emit(this.token, 'AccountDeregistered');

                const destinationBalanceAfter = await this.token.balanceOf(this.acc3.address);
                expect(destinationBalanceAfter - destinationBalanceBefore).to.be.closeTo(rewardsBefore, 10);

                const rewardsAfter = await this.token.availableRewardsOf(this.acc.address);
                expect(rewardsAfter).to.equal(0);
                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
            });

            it('should work when unregistering with no rewards', async function () {
                const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

                await expect(
                    this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address)
                ).to.emit(this.token, 'AccountDeregistered')
                    .to.not.emit(this.token, 'RewardsClaimed');

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
            });
        });

        describe('Re-registration to Different Payout Group', function () {
            it('should allow re-registration to payout group with different multiplier', async function () {
                // Create multiplier 2 for the second payout group
                await setupMultiplierWithBounds(this);

                const payoutGroup1Id = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, this.acc.address);

                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime1);
                await time.increase(3601);

                const rewardsGroup1 = await this.token.availableRewardsOf(this.acc.address);
                expect(rewardsGroup1).to.be.gt(0);

                await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroup1Id, this.acc.address);

                const payoutGroup2Id = await createPayoutGroup(this, 2, this.acc3);

                await expect(
                    this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup2Id, this.acc.address)
                ).to.emit(this.token, 'AccountRegistered')
                    .withArgs(this.acc.address, payoutGroup2Id, this.acc3.address);

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroup2Id);

                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 2, ethers.parseUnits("1.0002", 12), futureTime2);
                await time.increase(3601);

                const rewardsGroup2 = await this.token.availableRewardsOf(this.acc.address);
                expect(rewardsGroup2).to.be.gt(0);
            });

            it('should accumulate rewards at new multiplier rate after re-registration', async function () {
                // Create multiplier 2 for the second payout group
                await setupMultiplierWithBounds(this);

                const payoutGroup1Id = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, this.acc.address);

                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime1);
                await time.increase(3601);

                const rewards1 = await this.token.availableRewardsOf(this.acc.address);

                await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroup1Id, this.acc.address);

                const payoutGroup2Id = await createPayoutGroup(this, 2, this.acc3);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup2Id, this.acc.address);

                const futureTime2 = (await time.latest()) + 3600;
                // Use higher target (1.05) to ensure rewards2 > rewards1
                // Group 1: 1.02 (2% growth), Group 2: 1.05 (5% growth)
                // So rewards2 should be roughly 2.5x rewards1
                await setNextMultiplier(this.token, this.owner, 2, ethers.parseUnits("1.05", 12), futureTime2);
                await time.increase(3601);

                const rewards2 = await this.token.availableRewardsOf(this.acc.address);
                expect(rewards2).to.be.gt(0);
                // rewards2 should be greater than rewards1 (5% vs 2% growth)
                expect(rewards2).to.be.gt(rewards1);
                // Roughly 2.5x the rewards
                expect(rewards2).to.be.closeTo(rewards1 * 5n / 2n, ethers.parseUnits("0.01", 6));
            });
        });

        describe('Multiple Unregister-Register Cycles', function () {
            it('should handle multiple unregister-register cycles', async function () {
                // Create multipliers 2 and 3 for the second and third payout groups
                await setupMultiplierWithBounds(this);
                await setupMultiplierWithBounds(this);

                const group1Id = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(group1Id, this.acc.address);

                let futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
                await time.increase(3601);

                await this.token.connect(this.owner).registrarUnregisterRewardAddress(group1Id, this.acc.address);

                const group2Id = await createPayoutGroup(this, 2, this.acc3);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(group2Id, this.acc.address);

                futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 2, ethers.parseUnits("1.03", 12), futureTime);
                await time.increase(3601);

                await this.token.connect(this.owner).registrarUnregisterRewardAddress(group2Id, this.acc.address);

                const group3Id = await createPayoutGroup(this, 3, this.recipient);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(group3Id, this.acc.address);

                futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 3, ethers.parseUnits("1.04", 12), futureTime);
                await time.increase(3601);

                const finalRewards = await this.token.availableRewardsOf(this.acc.address);
                expect(finalRewards).to.be.gt(0);

                const finalGroupId = await this.token.payoutGroupIdOf(this.acc.address);
                expect(finalGroupId).to.equal(group3Id);
            });
        });

        describe('Re-registration Authorization', function () {
            it('should reject registrar unregister from wrong payout group', async function () {
                const payoutGroup1Id = await createPayoutGroup(this, 1, this.acc2);

                const payoutGroup2Id = await createPayoutGroup(this, 1, this.acc3);

                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, this.acc.address);

                await expect(
                    this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroup2Id, this.acc.address)
                ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroup1Id);
            });
        });

        describe('Re-registration to Same Group', function () {
            it('should allow re-registration to same group after unregistration', async function () {
                const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

                await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);

                await expect(
                    this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(payoutGroupId);
            });

            it('should allow registration to different group after unregistration', async function () {
                const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

                await this.token.connect(this.acc2).unregisterRewardAddress(payoutGroupId, this.acc.address);

                const signers = await ethers.getSigners();
                const newClaimer = signers[7];
                const newPayoutGroupId = await createPayoutGroup(this, 1, newClaimer);

                await expect(
                    this.token.connect(this.owner).registrarRegisterRewardAddress(newPayoutGroupId, this.acc.address)
                ).to.not.be.reverted;

                expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(newPayoutGroupId);
            });
        });
    });
});
