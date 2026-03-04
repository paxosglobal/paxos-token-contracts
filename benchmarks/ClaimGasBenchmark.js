const { deployPaxosTokenClaimableRewardsFixture } = require('../test/helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('../test/helpers/testHelpers');

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * Consolidated Claim Gas Benchmark
 *
 * This file consolidates benchmarks from:
 * - ClaimAllGasBenchmark.js
 * - ClaimAllControlledGasBenchmark.js
 * - ClaimNonceGasBenchmark.js (LastMultiplier tracking)
 *
 * Organized into sections:
 * 1. ClaimAll Gas Measurements
 * 2. Controlled ClaimAll Comparisons
 * 3. Individual Claim (claimOne) Gas Measurements
 * 4. LastMultiplier Tracking Efficiency
 */
describe('Claim Gas Benchmark (Consolidated)', function () {

    // =========================================================================
    // SECTION 1: BASIC CLAIMALL GAS MEASUREMENTS
    // =========================================================================
    describe('ClaimAll Gas Measurements', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

            // Grant necessary roles for testing
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Initialize multiplier and setup accounts
            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            // Create payout address and fund accounts
            this.payoutGroupId = await this.token.connect(this.owner).createPayoutGroup.staticCall(1, this.acc.address);
            await this.token.connect(this.owner).createPayoutGroup(1, this.acc.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

            // Register accounts to the same payout address
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
        });

        it('should measure claimAll gas usage (second claim)', async function () {
            // Setup multiplier scenario with rewards to claim
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);

            // First claimAll to establish baseline and warm storage
            await this.token.connect(this.acc).claimAll(this.payoutGroupId);

            // Advance to next period with more rewards
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for claimAll with rewards accumulated
            const tx = await this.token.connect(this.acc).claimAll(this.payoutGroupId);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimAll Gas Usage (2 addresses, second claim): ${receipt.gasUsed} gas`);
            console.log(`   (With _executeClaimAll memory optimization)\n`);

            // Should be efficient with memory optimization
            expect(receipt.gasUsed).to.be.lt(150000);
        });

        it('should measure claimAll gas with multiple registered addresses', async function () {
            // Setup multiplier with rewards
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.05", 12), futureTime1);
            await time.increase(3601);

            // Measure gas for claimAll with multiple addresses
            const tx = await this.token.connect(this.acc).claimAll(this.payoutGroupId);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimAll Gas (2 addresses, first claim): ${receipt.gasUsed} gas`);
            console.log(`   (With _executeClaimAll memory optimization)\n`);

            expect(receipt.gasUsed).to.be.lt(200000);
        });
    });

    // =========================================================================
    // SECTION 2: CONTROLLED CLAIMALL COMPARISONS
    // =========================================================================
    describe('ClaimAll Controlled Gas Comparison', function () {
        it('should measure claimAll gas - test 1 (3 addresses, second claim)', async function () {
            const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
            const { token, owner, acc, acc2, acc3 } = fixture;

            // Grant necessary roles
            await grantAllTestRoles(token, owner, owner.address);

            // Initialize
            await token.connect(owner).setMaturityPeriod(86400);
            await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
            await token.connect(owner).increaseSupply(ONE_ETHER * 20n);

            // Create payout group with acc as claimer
            const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, acc.address);
            await token.connect(owner).createPayoutGroup(1, acc.address);

            // Register 2 additional addresses (acc2, acc3) for total of 3
            await token.connect(owner).transfer(acc2.address, ONE_ETHER * 2n);
            await token.connect(owner).transfer(acc3.address, ONE_ETHER * 2n);
            await token.connect(owner).registrarRegisterRewardAddress(
                payoutGroupId,
                acc2.address
            );
            await token.connect(owner).registrarRegisterRewardAddress(
                payoutGroupId,
                acc3.address
            );

            // Setup FIRST multiplier with rewards
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);

            // Do FIRST claimAll to warm up storage
            await token.connect(acc).claimAll(payoutGroupId);

            // Setup SECOND multiplier with more rewards
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for SECOND claimAll
            const tx = await token.connect(acc).claimAll(payoutGroupId);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimAll Gas (Test 1 - 3 addresses, second claim): ${receipt.gasUsed} gas\n`);
            expect(receipt.gasUsed).to.be.lt(150000);
        });

        it('should measure claimAll gas - test 2 (3 addresses, second claim)', async function () {
            const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
            const { token, owner, acc, acc2, acc3 } = fixture;

            // Grant necessary roles
            await grantAllTestRoles(token, owner, owner.address);

            // Initialize
            await token.connect(owner).setMaturityPeriod(86400);
            await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
            await token.connect(owner).increaseSupply(ONE_ETHER * 20n);

            // Create payout group with acc as claimer
            const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, acc.address);
            await token.connect(owner).createPayoutGroup(1, acc.address);

            // Register 2 additional addresses (acc2, acc3) for total of 3
            await token.connect(owner).transfer(acc2.address, ONE_ETHER * 2n);
            await token.connect(owner).transfer(acc3.address, ONE_ETHER * 2n);
            await token.connect(owner).registrarRegisterRewardAddress(
                payoutGroupId,
                acc2.address
            );
            await token.connect(owner).registrarRegisterRewardAddress(
                payoutGroupId,
                acc3.address
            );

            // Setup FIRST multiplier with rewards
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);

            // Do FIRST claimAll to warm up storage
            await token.connect(acc).claimAll(payoutGroupId);

            // Setup SECOND multiplier with more rewards
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for SECOND claimAll
            const tx = await token.connect(acc).claimAll(payoutGroupId);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimAll Gas (Test 2 - 3 addresses, second claim): ${receipt.gasUsed} gas\n`);
            expect(receipt.gasUsed).to.be.lt(150000);
        });

        it('should measure claimAll gas variability across identical scenarios', async function () {
            const results = [];

            for (let run = 1; run <= 3; run++) {
                const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
                const { token, owner, acc, acc2, acc3 } = fixture;

                // Grant necessary roles
                await grantAllTestRoles(token, owner, owner.address);

                // Initialize
                await token.connect(owner).setMaturityPeriod(86400);
                await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
                await token.connect(owner).increaseSupply(ONE_ETHER * 20n);

                // Create payout group
                const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, acc.address);
                await token.connect(owner).createPayoutGroup(1, acc.address);
                await token.connect(owner).transfer(acc2.address, ONE_ETHER * 2n);
                await token.connect(owner).transfer(acc3.address, ONE_ETHER * 2n);
                await token.connect(owner).registrarRegisterRewardAddress(
                    payoutGroupId,
                    acc2.address
                );
                await token.connect(owner).registrarRegisterRewardAddress(
                    payoutGroupId,
                    acc3.address
                );

                // First claim
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await token.connect(acc).claimAll(payoutGroupId);

                // Second claim (measured)
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);
                const tx = await token.connect(acc).claimAll(payoutGroupId);
                const receipt = await tx.wait();

                results.push(Number(receipt.gasUsed));
            }

            console.log('\n' + '='.repeat(80));
            console.log('CLAIMALL GAS VARIABILITY ANALYSIS');
            console.log('='.repeat(80));
            console.log(`\nRun 1: ${results[0].toLocaleString()} gas`);
            console.log(`Run 2: ${results[1].toLocaleString()} gas`);
            console.log(`Run 3: ${results[2].toLocaleString()} gas`);
            console.log(`\nAverage: ${Math.round(results.reduce((a, b) => a + b) / results.length).toLocaleString()} gas`);
            console.log(`Min: ${Math.min(...results).toLocaleString()} gas`);
            console.log(`Max: ${Math.max(...results).toLocaleString()} gas`);
            console.log(`Range: ${(Math.max(...results) - Math.min(...results)).toLocaleString()} gas`);
            console.log(`\nVariability: ${((Math.max(...results) - Math.min(...results)) / Math.min(...results) * 100).toFixed(2)}%`);
        });
    });

    // =========================================================================
    // SECTION 3: INDIVIDUAL CLAIM (CLAIMONE) GAS MEASUREMENTS
    // =========================================================================
    describe('Individual Claim (claimOne) Gas Measurements', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

            // Grant necessary roles for testing
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Initialize multiplier and setup accounts
            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            // Create payout address and fund accounts
            this.payoutGroupId = await this.token.connect(this.owner).createPayoutGroup.staticCall(1, this.acc.address);
            await this.token.connect(this.owner).createPayoutGroup(1, this.acc.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

            // Register accounts to the same payout address
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
        });

        it('should measure claimOne gas usage (first claim)', async function () {
            // Setup multiplier with rewards
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.05", 12), futureTime1);
            await time.increase(3601);

            // Measure gas for individual claim
            const tx = await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimOne Gas (first claim): ${receipt.gasUsed} gas`);
            console.log(`   (Includes lastMultiplier update)\n`);

            expect(receipt.gasUsed).to.be.lt(120000);
        });

        it('should measure claimOne gas usage (subsequent claim)', async function () {
            // Setup first multiplier
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);

            // First claim to warm storage
            await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);

            // Setup second multiplier
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for subsequent claim
            const tx = await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimOne Gas (subsequent claim, warm storage): ${receipt.gasUsed} gas`);
            console.log(`   (Includes lastMultiplier update)\n`);

            expect(receipt.gasUsed).to.be.lt(100000);
        });
    });

    // =========================================================================
    // SECTION 4: LASTMULTIPLIER TRACKING EFFICIENCY
    // =========================================================================
    describe('LastMultiplier Tracking Efficiency', function () {
        beforeEach(async function () {
            Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

            // Grant necessary roles for testing
            await grantAllTestRoles(this.token, this.owner, this.owner.address);

            // Initialize multiplier and setup accounts
            await this.token.connect(this.owner).setMaturityPeriod(86400);
            await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

            // Create payout address and fund accounts
            this.payoutGroupId = await this.token.connect(this.owner).createPayoutGroup.staticCall(1, this.acc.address);
            await this.token.connect(this.owner).createPayoutGroup(1, this.acc.address);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

            // Register accounts to the same payout address
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);
        });

        it('should demonstrate gas efficiency with lastMultiplier tracking', async function () {
            // Setup multiplier scenario
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);
            await this.token.connect(this.acc).claimAll(this.payoutGroupId);

            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for individual claim with lastMultiplier tracking
            const tx = await this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc2.address]);
            const receipt = await tx.wait();

            console.log(`\n📊 ClaimOne Gas (with lastMultiplier tracking): ${receipt.gasUsed} gas`);
            console.log(`   (Avoids recalculating from epoch 0)\n`);

            // Should be efficient with new lastMultiplier model
            expect(receipt.gasUsed).to.be.lt(100000);
        });

        it('should compare gas cost of claims with vs without prior claimAll', async function () {
            const results = { withPriorClaim: 0, withoutPriorClaim: 0 };

            // Test 1: WITHOUT prior claimAll
            {
                const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
                const { token, owner, acc, acc2, acc3 } = fixture;

                await grantAllTestRoles(token, owner, owner.address);
                await token.connect(owner).setMaturityPeriod(86400);
                await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
                await token.connect(owner).increaseSupply(ONE_ETHER * 10n);

                const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, acc.address);
                await token.connect(owner).createPayoutGroup(1, acc.address);
                await token.connect(owner).transfer(acc2.address, ONE_ETHER * 2n);
                await token.connect(owner).registrarRegisterRewardAddress(
                    payoutGroupId,
                    acc2.address
                );

                // Setup multiplier
                const futureTime = (await time.latest()) + 3600;
                await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.05", 12), futureTime);
                await time.increase(3601);

                // First claimOne directly (no prior claimAll)
                const tx = await token.connect(acc).claimForAddresses(payoutGroupId, [acc2.address]);
                const receipt = await tx.wait();
                results.withoutPriorClaim = Number(receipt.gasUsed);
            }

            // Test 2: WITH prior claimAll
            {
                const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
                const { token, owner, acc, acc2, acc3 } = fixture;

                await grantAllTestRoles(token, owner, owner.address);
                await token.connect(owner).setMaturityPeriod(86400);
                await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
                await token.connect(owner).increaseSupply(ONE_ETHER * 10n);

                const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, acc.address);
                await token.connect(owner).createPayoutGroup(1, acc.address);
                await token.connect(owner).transfer(acc2.address, ONE_ETHER * 2n);
                await token.connect(owner).registrarRegisterRewardAddress(
                    payoutGroupId,
                    acc2.address
                );

                // Setup first multiplier and do claimAll
                const futureTime1 = (await time.latest()) + 3600;
                await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
                await time.increase(3601);
                await token.connect(acc).claimAll(payoutGroupId);

                // Setup second multiplier
                const futureTime2 = (await time.latest()) + 3600;
                await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
                await time.increase(3601);

                // ClaimOne after claimAll (with lastMultiplier set)
                const tx = await token.connect(acc).claimForAddresses(payoutGroupId, [acc2.address]);
                const receipt = await tx.wait();
                results.withPriorClaim = Number(receipt.gasUsed);
            }

            console.log('\n' + '='.repeat(80));
            console.log('LASTMULTIPLIER TRACKING EFFICIENCY COMPARISON');
            console.log('='.repeat(80));
            console.log(`\nWithout prior claimAll: ${results.withoutPriorClaim.toLocaleString()} gas`);
            console.log(`With prior claimAll:    ${results.withPriorClaim.toLocaleString()} gas`);
            console.log(`\nGas saved by lastMultiplier: ${(results.withoutPriorClaim - results.withPriorClaim).toLocaleString()} gas`);
            console.log(`Efficiency improvement: ${((results.withoutPriorClaim - results.withPriorClaim) / results.withoutPriorClaim * 100).toFixed(2)}%`);
            console.log('\nNote: LastMultiplier tracking avoids recalculating rewards from epoch 0');
        });
    });
});
