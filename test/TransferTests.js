const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

/**
 * Comprehensive Transfer Tests
 *
 * Consolidates tests from:
 * - CrossMultiplierTransferTest.js (Cross-multiplier transfer behavior)
 * - TransferFromBatchEdgeCasesTest.js (TransferFromBatch validation and edge cases)
 */
describe('Transfer Tests', function () {
    // ========================================================================
    // CROSS-MULTIPLIER TRANSFER TESTS
    // ========================================================================

    describe('Cross-Multiplier Transfer Tests', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);
        });

        describe('Total Payout Data Adjustments', function () {
            beforeEach(async function () {
                await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
                await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 2n);
                await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
                await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

                await this.token.connect(this.owner).setMaturityPeriod(86400);
                // Create 3 multipliers (IDs 1, 2, 3) with rate bounds
                await setupMultiplierWithBounds(this); // multiplier 1
                await setupMultiplierWithBounds(this); // multiplier 2
                await setupMultiplierWithBounds(this); // multiplier 3

                this.pg1Id = await createPayoutGroup(this, 1, this.acc);
                this.pg2Id = await createPayoutGroup(this, 1, this.acc2);
                this.pg3Id = await createPayoutGroup(this, 1, this.acc3);

                await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(this.pg2Id, 2);
                await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(this.pg3Id, 3);

                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.pg1Id, this.acc.address);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.pg2Id, this.acc2.address);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(this.pg3Id, this.acc3.address);
            });

            it('should adjust payout group data correctly during cross-multiplier transfers', async function () {
                const transferAmount = ONE_ETHER / 2n;

                const initialBalance1 = await this.token.getPayoutGroupBalance(this.pg1Id);
                const initialBalance2 = await this.token.getPayoutGroupBalance(this.pg2Id);
                const initialBalance3 = await this.token.getPayoutGroupBalance(this.pg3Id);

                log('Initial Payout Group Balances:');
                log(`Group 1 - Balance: ${ethers.formatEther(initialBalance1)}`);
                log(`Group 2 - Balance: ${ethers.formatEther(initialBalance2)}`);
                log(`Group 3 - Balance: ${ethers.formatEther(initialBalance3)}`);

                await this.token.connect(this.acc).transfer(this.acc2.address, transferAmount);

                const afterTransferBalance1 = await this.token.getPayoutGroupBalance(this.pg1Id);
                const afterTransferBalance2 = await this.token.getPayoutGroupBalance(this.pg2Id);
                const afterTransferBalance3 = await this.token.getPayoutGroupBalance(this.pg3Id);

                log('After Transfer Payout Group Balances:');
                log(`Group 1 - Balance: ${ethers.formatEther(afterTransferBalance1)}`);
                log(`Group 2 - Balance: ${ethers.formatEther(afterTransferBalance2)}`);
                log(`Group 3 - Balance: ${ethers.formatEther(afterTransferBalance3)}`);

                expect(afterTransferBalance1).to.equal(initialBalance1 - transferAmount);
                expect(afterTransferBalance2).to.equal(initialBalance2 + transferAmount);
                expect(afterTransferBalance3).to.equal(initialBalance3);
            });

            it('should handle multiple cross-multiplier transfers correctly', async function () {
                const transferAmount = ONE_ETHER / 4n;

                const initialBalance0 = await this.token.balanceOf(this.acc.address);
                const initialBalance1 = await this.token.balanceOf(this.acc2.address);
                const initialBalance2 = await this.token.balanceOf(this.acc3.address);

                await this.token.connect(this.acc).transfer(this.acc2.address, transferAmount);
                await this.token.connect(this.acc2).transfer(this.acc3.address, transferAmount);
                await this.token.connect(this.acc3).transfer(this.acc.address, transferAmount);

                const finalBalance0 = await this.token.balanceOf(this.acc.address);
                const finalBalance1 = await this.token.balanceOf(this.acc2.address);
                const finalBalance2 = await this.token.balanceOf(this.acc3.address);

                log('After Multiple Transfers:');
                log(`acc - Balance: ${ethers.formatEther(finalBalance0)}`);
                log(`acc2 - Balance: ${ethers.formatEther(finalBalance1)}`);
                log(`acc3 - Balance: ${ethers.formatEther(finalBalance2)}`);

                const initialTotalBalance = initialBalance0 + initialBalance1 + initialBalance2;
                const finalTotalBalance = finalBalance0 + finalBalance1 + finalBalance2;

                expect(finalTotalBalance).to.equal(initialTotalBalance);
            });

            it('should handle transfers with different multiplier values correctly', async function () {
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(this.token, this.owner, 2, ethers.parseUnits("1.02", 12), futureTime2);

                const transferAmount = ONE_ETHER / 2n;

                const mult1 = await this.token['getActiveMultiplier'](1);
                const mult2 = await this.token['getActiveMultiplier'](2);
                const mult3 = await this.token['getActiveMultiplier'](3);

                log(`Multipliers: Index 1 = ${ethers.formatEther(mult1)}, Index 2 = ${ethers.formatEther(mult2)}, Index 3 = ${ethers.formatEther(mult3)}`);

                const initialBalance0 = await this.token.balanceOf(this.acc.address);
                const initialBalance1 = await this.token.balanceOf(this.acc2.address);

                log(`Initial balances: acc = ${ethers.formatEther(initialBalance0)}, acc2 = ${ethers.formatEther(initialBalance1)}`);

                const tx = await this.token.connect(this.acc).transfer(this.acc2.address, transferAmount);
                const receipt = await tx.wait();

                log(`Cross-multiplier transfer gas: ${receipt.gasUsed}`);

                const finalBalance0 = await this.token.balanceOf(this.acc.address);
                const finalBalance1 = await this.token.balanceOf(this.acc2.address);

                expect(finalBalance0).to.equal(initialBalance0 - transferAmount);
                expect(finalBalance1).to.equal(initialBalance1 + transferAmount);

                log(`Transfer completed successfully between different multipliers`);
            });
        });

        describe('Gas Benchmarking', function () {
            it('should measure gas costs for cross-multiplier transfers', async function () {
                await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
                await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
                await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

                await this.token.connect(this.owner).setMaturityPeriod(86400);
                // Create 2 multipliers (IDs 1, 2) with rate bounds
                await setupMultiplierWithBounds(this); // multiplier 1
                await setupMultiplierWithBounds(this); // multiplier 2

                const pg1Id = await createPayoutGroup(this, 1, this.acc);
                const pg2Id = await createPayoutGroup(this, 1, this.acc2);

                await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(pg2Id, 2);

                await this.token.connect(this.owner).registrarRegisterRewardAddress(pg1Id, this.acc.address);
                await this.token.connect(this.owner).registrarRegisterRewardAddress(pg2Id, this.acc2.address);

                const sameIndexTx = await this.token.connect(this.acc).transfer(this.acc.address, ONE_ETHER / 10n);
                const sameIndexReceipt = await sameIndexTx.wait();

                const diffIndexTx = await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER / 10n);
                const diffIndexReceipt = await diffIndexTx.wait();

                log(`\\n⚡ CROSS-MULTIPLIER TRANSFER GAS ANALYSIS:`);
                log(`Same multiplier index: ${sameIndexReceipt.gasUsed} gas`);
                log(`Different multiplier indices: ${diffIndexReceipt.gasUsed} gas`);
                log(`Cross-multiplier overhead: +${Number(diffIndexReceipt.gasUsed) - Number(sameIndexReceipt.gasUsed)} gas`);

                expect(Number(diffIndexReceipt.gasUsed)).to.be.greaterThan(Number(sameIndexReceipt.gasUsed));
            });
        });
    });

    // ========================================================================
    // TRANSFERFROMBATCH EDGE CASES
    // ========================================================================

    describe('TransferFromBatch Edge Cases', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
            await grantAllTestRoles(this.token, this.owner, this.owner.address);
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            // Setup: Give acc3 allowance from owner
            await this.token.connect(this.owner).approve(this.acc3.address, ONE_ETHER * 10n);
        });

        describe('Array Length Validation', function () {
            it('should revert when from and to arrays have different lengths', async function () {
                const from = [this.owner.address, this.owner.address];
                const to = [this.acc.address]; // Different length
                const value = [ONE_ETHER, ONE_ETHER];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'ArgumentLengthMismatch');
            });

            it('should revert when from and value arrays have different lengths', async function () {
                const from = [this.owner.address, this.owner.address];
                const to = [this.acc.address, this.acc2.address];
                const value = [ONE_ETHER]; // Different length

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'ArgumentLengthMismatch');
            });

            it('should revert when to and value arrays have different lengths', async function () {
                const from = [this.owner.address];
                const to = [this.acc.address, this.acc2.address]; // Different length
                const value = [ONE_ETHER];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'ArgumentLengthMismatch');
            });

            it('should succeed when all arrays have same length', async function () {
                const from = [this.owner.address, this.owner.address];
                const to = [this.acc.address, this.acc2.address];
                const value = [ONE_ETHER, ONE_ETHER * 2n];

                await expect(this.token.connect(this.acc3).transferFromBatch(from, to, value))
                    .to.emit(this.token, 'Transfer')
                    .withArgs(this.owner.address, this.acc.address, ONE_ETHER);
            });

            it('should work with single element arrays', async function () {
                const from = [this.owner.address];
                const to = [this.acc.address];
                const value = [ONE_ETHER];

                await expect(this.token.connect(this.acc3).transferFromBatch(from, to, value))
                    .to.emit(this.token, 'Transfer')
                    .withArgs(this.owner.address, this.acc.address, ONE_ETHER);
            });

            it('should work with empty arrays', async function () {
                const from = [];
                const to = [];
                const value = [];

                // Should succeed but transfer nothing
                await expect(this.token.connect(this.acc3).transferFromBatch(from, to, value))
                    .to.not.be.reverted;
            });
        });

        describe('Frozen Spender in Batch Transfer', function () {
            it('should revert when spender is frozen', async function () {
                await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);

                const from = [this.owner.address];
                const to = [this.acc.address];
                const value = [ONE_ETHER];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
            });
        });

        describe('Multiple Transfers in Batch', function () {
            it('should execute all transfers in batch successfully', async function () {
                const from = [this.owner.address, this.owner.address, this.owner.address];
                const to = [this.acc.address, this.acc2.address, this.acc3.address];
                const value = [ONE_ETHER, ONE_ETHER * 2n, ONE_ETHER * 3n];

                await this.token.connect(this.acc3).transferFromBatch(from, to, value);

                expect(await this.token.balanceOf(this.acc.address)).to.equal(ONE_ETHER);
                expect(await this.token.balanceOf(this.acc2.address)).to.equal(ONE_ETHER * 2n);
                expect(await this.token.balanceOf(this.acc3.address)).to.equal(ONE_ETHER * 3n);
            });

            it('should consume allowance for all transfers', async function () {
                const from = [this.owner.address, this.owner.address];
                const to = [this.acc.address, this.acc2.address];
                const value = [ONE_ETHER, ONE_ETHER * 2n];

                const allowanceBefore = await this.token.allowance(this.owner.address, this.acc3.address);

                await this.token.connect(this.acc3).transferFromBatch(from, to, value);

                const allowanceAfter = await this.token.allowance(this.owner.address, this.acc3.address);
                expect(allowanceAfter).to.equal(allowanceBefore - ONE_ETHER * 3n);
            });

            it('should revert if insufficient allowance for any transfer', async function () {
                await this.token.connect(this.owner).approve(this.acc3.address, ONE_ETHER);

                const from = [this.owner.address, this.owner.address];
                const to = [this.acc.address, this.acc2.address];
                const value = [ONE_ETHER, ONE_ETHER * 2n];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'InsufficientAllowance');
            });
        });

        describe('Transfer to Zero Address Validation', function () {
            it('should revert when transferring to zero address in batch', async function () {
                const from = [this.owner.address];
                const to = [ethers.ZeroAddress];
                const value = [ONE_ETHER];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'ZeroAddress');
            });
        });

        describe('Contract Paused', function () {
            it('should revert when contract is paused', async function () {
                await this.token.connect(this.owner).pause();

                const from = [this.owner.address];
                const to = [this.acc.address];
                const value = [ONE_ETHER];

                await expect(
                    this.token.connect(this.acc3).transferFromBatch(from, to, value)
                ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
            });
        });
    });
});
