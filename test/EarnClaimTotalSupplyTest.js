const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * Golden Flow Test: Earn+Claim Funding
 *
 * This test verifies that total supply remains constant throughout the earn and claim process:
 * 1. Set up balances → measure totalSupply=X
 * 2. Move time forward, earn happens → totalSupply=X (source balance decreased, availableRewards increased)
 * 3. Claim rewards → totalSupply=X (Transfer event, availableRewards decreased, destination balance increased)
 *
 * Tests from three perspectives: Admin, Claimer, and Manager
 */
describe('Golden Flow: Earn+Claim Total Supply Invariant', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Configure multiplier settings
        await this.token.connect(this.owner).setMaturityPeriod(86400);
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10)); // 0-10000% APR for testing
    });

    describe('From Admin Perspective', function () {
        it('should maintain totalSupply=X through setup → earn → claim cycle', async function () {
            // Step 1: Set up balances
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);

            // Create multiplier and payout group with acc2 as claimer, acc3 as destination
            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
            await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

            // Register acc to payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            // Measure initial state
            const totalSupplyInitial = await this.token.totalSupply();
            const sourceBalanceInitial = await this.token.balanceOf(await this.token.getClaimSource());
            const destinationBalanceInitial = await this.token.balanceOf(this.acc3.address);

            log(`\n📊 Step 1: Setup Complete`);
            log(`  totalSupply: ${ethers.formatUnits(totalSupplyInitial, 6)}`);
            log(`  Source balance: ${ethers.formatUnits(sourceBalanceInitial, 6)}`);
            log(`  Destination balance: ${ethers.formatUnits(destinationBalanceInitial, 6)}`);

            // Step 2: Move time forward past earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
            await time.increase(3601);

            // Measure after earn
            const totalSupplyAfterEarn = await this.token.totalSupply();
            const sourceBalanceAfterEarn = await this.token.balanceOf(await this.token.getClaimSource());
            const accAvailableRewards = await this.token.availableRewardsOf(this.acc.address);

            log(`\n📊 Step 2: After Earn (time passed)`);
            log(`  totalSupply: ${ethers.formatUnits(totalSupplyAfterEarn, 6)}`);
            log(`  Source balance: ${ethers.formatUnits(sourceBalanceAfterEarn, 6)}`);
            log(`  Account available rewards: ${ethers.formatUnits(accAvailableRewards, 6)}`);

            // Verify totalSupply hasn't changed
            expect(totalSupplyAfterEarn).to.equal(totalSupplyInitial,
                "Total supply should not change after earn");

            // Verify rewards are available
            expect(accAvailableRewards).to.be.gt(0, "Rewards should be available after earn");

            // Step 3: Claim rewards
            const destinationBalanceBeforeClaim = await this.token.balanceOf(this.acc3.address);

            await expect(this.token.connect(this.acc2).claimAll(payoutGroupId))
                .to.emit(this.token, 'Transfer')
                .to.emit(this.token, 'ClaimAllExecuted');

            // Measure after claim
            const totalSupplyAfterClaim = await this.token.totalSupply();
            const sourceBalanceAfterClaim = await this.token.balanceOf(await this.token.getClaimSource());
            const destinationBalanceAfterClaim = await this.token.balanceOf(this.acc3.address);
            const accAvailableRewardsAfterClaim = await this.token.availableRewardsOf(this.acc.address);

            log(`\n📊 Step 3: After Claim`);
            log(`  totalSupply: ${ethers.formatUnits(totalSupplyAfterClaim, 6)}`);
            log(`  Source balance: ${ethers.formatUnits(sourceBalanceAfterClaim, 6)}`);
            log(`  Destination balance: ${ethers.formatUnits(destinationBalanceAfterClaim, 6)}`);
            log(`  Account available rewards: ${ethers.formatUnits(accAvailableRewardsAfterClaim, 6)}`);

            // Verify the golden flow invariants
            expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial,
                "Total supply should not change after claim");
            expect(totalSupplyAfterClaim).to.equal(totalSupplyAfterEarn,
                "Total supply should remain constant");

            // Verify claim transferred funds
            expect(destinationBalanceAfterClaim).to.be.gt(destinationBalanceBeforeClaim,
                "Destination balance should increase after claim");

            // Verify source balance decreased (rewards paid out)
            expect(sourceBalanceAfterClaim).to.be.lt(sourceBalanceAfterEarn,
                "Source balance should decrease after paying rewards");

            // Verify available rewards decreased
            expect(accAvailableRewardsAfterClaim).to.equal(0,
                "Account available rewards should be 0 after claim");

            log(`\n✅ Golden Flow Complete: totalSupply remained constant throughout!`);
        });

        it('should maintain totalSupply with multiple accounts earning and claiming', async function () {
            // Setup multiple accounts
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 20n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 3n);
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 2n);

            // Create multiplier and payout group
            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.recipient);

            // Register all accounts
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc3.address);

            const totalSupplyInitial = await this.token.totalSupply();

            // Earn
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime);
            await time.increase(3601);

            const totalSupplyAfterEarn = await this.token.totalSupply();
            expect(totalSupplyAfterEarn).to.equal(totalSupplyInitial);

            // Claim for each account individually
            await this.token.connect(this.recipient).claimForAddresses(payoutGroupId, [this.acc.address]);
            const totalSupplyAfterClaim1 = await this.token.totalSupply();
            expect(totalSupplyAfterClaim1).to.equal(totalSupplyInitial);

            await this.token.connect(this.recipient).claimForAddresses(payoutGroupId, [this.acc2.address]);
            const totalSupplyAfterClaim2 = await this.token.totalSupply();
            expect(totalSupplyAfterClaim2).to.equal(totalSupplyInitial);

            await this.token.connect(this.recipient).claimForAddresses(payoutGroupId, [this.acc3.address]);
            const totalSupplyAfterClaim3 = await this.token.totalSupply();
            expect(totalSupplyAfterClaim3).to.equal(totalSupplyInitial);

            log(`✅ Multiple accounts: totalSupply remained constant through all claims!`);
        });
    });

    describe('From Claimer Perspective', function () {
        it('should maintain totalSupply when claimer executes earn → claim cycle', async function () {
            // Setup
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);

            // Create multiplier and payout group where acc2 is the claimer
            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            const totalSupplyInitial = await this.token.totalSupply();

            // Earn
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0003", 12), futureTime);
            await time.increase(3601);

            const totalSupplyAfterEarn = await this.token.totalSupply();
            expect(totalSupplyAfterEarn).to.equal(totalSupplyInitial);

            // Claimer claims
            const destinationBalanceBefore = await this.token.balanceOf(this.acc2.address);
            await this.token.connect(this.acc2).claimAll(payoutGroupId);
            const destinationBalanceAfter = await this.token.balanceOf(this.acc2.address);

            const totalSupplyAfterClaim = await this.token.totalSupply();

            expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial);
            expect(destinationBalanceAfter).to.be.gt(destinationBalanceBefore);

            log(`✅ Claimer perspective: totalSupply remained constant!`);
        });
    });

    describe('From Manager Perspective', function () {
        it('should maintain totalSupply when manager executes earn → claim cycle', async function () {
            // Setup
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);

            // Create multiplier and payout group with claimer and manager
            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
            await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId, this.acc3.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            const totalSupplyInitial = await this.token.totalSupply();

            // Earn
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.25", 12), futureTime);
            await time.increase(3601);

            const totalSupplyAfterEarn = await this.token.totalSupply();
            expect(totalSupplyAfterEarn).to.equal(totalSupplyInitial);

            // Manager claims to custom destination
            const customDestination = this.recipient.address;
            const destinationBalanceBefore = await this.token.balanceOf(customDestination);

            // Verify return value matches balance change
            const returnedAmount = await this.token.connect(this.acc3).claimAllTo.staticCall(payoutGroupId, customDestination);
            await this.token.connect(this.acc3).claimAllTo(payoutGroupId, customDestination);
            const destinationBalanceAfter = await this.token.balanceOf(customDestination);

            const totalSupplyAfterClaim = await this.token.totalSupply();

            expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial);
            expect(destinationBalanceAfter).to.be.gt(destinationBalanceBefore);
            expect(returnedAmount).to.equal(destinationBalanceAfter - destinationBalanceBefore);

            log(`✅ Manager perspective: totalSupply remained constant!`);
        });
    });

    describe('Edge Cases', function () {
        it('should maintain totalSupply through multiple earn cycles before claiming', async function () {
            // Setup
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);

            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            const totalSupplyInitial = await this.token.totalSupply();

            // Multiple earn cycles
            let futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
            await time.increase(3601);

            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime);
            await time.increase(3601);

            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.3", 12), futureTime);
            await time.increase(3601);

            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            // Finally claim
            await this.token.connect(this.acc2).claimAll(payoutGroupId);

            const totalSupplyAfterClaim = await this.token.totalSupply();
            expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial);

            log(`✅ Multiple earn cycles: totalSupply remained constant!`);
        });

        it('should maintain totalSupply with partial claims', async function () {
            // Setup with multiple accounts
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 3n);
            await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 2n);

            await setupMultiplierWithBounds(this); // creates mult 1
            const payoutGroupId = await createPayoutGroup(this, 1, this.acc3);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

            const totalSupplyInitial = await this.token.totalSupply();

            // Earn
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
            await time.increase(3601);

            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            // Partial claim - just acc
            await this.token.connect(this.acc3).claimForAddresses(payoutGroupId, [this.acc.address]);
            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            // Claim remaining - acc2
            await this.token.connect(this.acc3).claimForAddresses(payoutGroupId, [this.acc2.address]);
            expect(await this.token.totalSupply()).to.equal(totalSupplyInitial);

            log(`✅ Partial claims: totalSupply remained constant!`);
        });
    });
});
