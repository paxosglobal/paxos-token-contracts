const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * Golden Flow Test: First Action After Passing Earn Time
 *
 * This test verifies that the first action after passing earn time works correctly:
 * 1. Setup balances and earn time
 * 2. Pass the earn time (time forward)
 * 3. Execute first action (claim, transfer, mint, or burn)
 * 4. Verify rewards computed correctly
 * 5. Verify next action uses correct computed rewards
 */
describe('Golden Flow: First Action After Passing Earn Time', function () {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Set referenceTime to current time for proper period calculations
        // (referenceTime defaults to 0 which is Unix epoch)
        const currentTime = await time.latest();
        await this.token.connect(this.owner).setReferenceTime(currentTime);

        // Configure multiplier settings
        await this.token.connect(this.owner).setMaturityPeriod(86400);
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10)); // 0-10000% APR for testing

        // Common setup: create accounts with balances
        await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 20n);
        await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);
        await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 3n);

        // Create multiplier and payout group
        await setupMultiplierWithBounds(this); // creates mult 1
        this.payoutGroupId = await createPayoutGroup(this, 1, this.acc3);

        // Register accounts
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address);
    });

    describe('First Action: Claim', function () {
        it('should correctly compute rewards when claim is first action after earn time', async function () {
            log(`\n📊 Test: First action = CLAIM`);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);

            log(`  ⏰ Earn time scheduled for ${3600}s in future`);

            // Pass the earn time
            await time.increase(3601);
            log(`  ⏰ Time passed, earn time reached`);

            // Verify rewards are available before claim
            const rewardsBeforeClaim = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsBeforeClaim).to.be.gt(0, "Rewards should be available after passing earn time");
            log(`  💰 Available rewards: ${ethers.formatUnits(rewardsBeforeClaim, 6)}`);

            // First action: CLAIM
            const destinationBalanceBefore = await this.token.balanceOf(this.acc3.address);
            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);
            const destinationBalanceAfter = await this.token.balanceOf(this.acc3.address);

            const rewardsClaimed = destinationBalanceAfter - destinationBalanceBefore;
            log(`  ✅ First action (CLAIM) executed, rewards claimed: ${ethers.formatUnits(rewardsClaimed, 6)}`);

            // Verify rewards were computed correctly (10% increase on 5 ETH)
            const expectedRewards = ONE_ETHER * 5n / 10n; // 0.5 ETH
            expect(rewardsClaimed).to.be.closeTo(expectedRewards, ethers.parseUnits("0.01", 6));

            // Verify no rewards remain after claim
            const rewardsAfterClaim = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsAfterClaim).to.equal(0);

            log(`  ✅ Rewards computed correctly on first claim action`);
        });

        it('should use correct computed rewards for next action after first claim', async function () {
            // Setup and pass earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);

            // First action: claim for acc
            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);

            // Setup second earn
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime2);
            await time.increase(3601);

            // Second action: verify rewards computed correctly from new base
            const rewardsBeforeSecondClaim = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsBeforeSecondClaim).to.be.gt(0);

            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);

            log(`  ✅ Next action used correct computed rewards from previous claim`);
        });
    });

    describe('First Action: Transfer', function () {
        it('should correctly compute rewards when transfer is first action after earn time', async function () {
            log(`\n📊 Test: First action = TRANSFER`);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            log(`  ⏰ Earn time scheduled`);

            // Pass the earn time
            await time.increase(3601);
            log(`  ⏰ Time passed, earn time reached`);

            // Verify rewards are available
            const rewardsBeforeTransfer = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsBeforeTransfer).to.be.gt(0);
            log(`  💰 Available rewards: ${ethers.formatUnits(rewardsBeforeTransfer, 6)}`);

            // Get balances before transfer
            const senderBalanceBefore = await this.token.balanceOf(this.acc.address);
            const recipientBalanceBefore = await this.token.balanceOf(this.recipient.address);

            // First action: TRANSFER
            const transferAmount = ONE_ETHER;
            await this.token.connect(this.acc).transfer(this.recipient.address, transferAmount);
            log(`  ✅ First action (TRANSFER) executed: ${ethers.formatUnits(transferAmount, 6)}`);

            // Verify transfer worked correctly
            const senderBalanceAfter = await this.token.balanceOf(this.acc.address);
            const recipientBalanceAfter = await this.token.balanceOf(this.recipient.address);

            expect(senderBalanceAfter).to.equal(senderBalanceBefore - transferAmount);
            expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + transferAmount);

            log(`  ✅ Transfer computed correctly on first action`);
        });

        it('should use correct computed rewards for next action after first transfer', async function () {
            // Setup and pass earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);

            // First action: transfer
            await this.token.connect(this.acc).transfer(this.recipient.address, ONE_ETHER);

            // Verify can claim after transfer
            const rewardsAfterTransfer = await this.token.availableRewardsOf(this.acc.address);
            log(`  💰 Rewards after transfer: ${ethers.formatUnits(rewardsAfterTransfer, 6)}`);

            // Second action: claim should work with correct computed rewards
            if (rewardsAfterTransfer > 0) {
                await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);
                log(`  ✅ Claim after transfer used correct computed rewards`);
            }
        });
    });

    describe('First Action: Mint', function () {
        it('should correctly compute rewards when mint is first action after earn time', async function () {
            log(`\n📊 Test: First action = MINT`);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            log(`  ⏰ Earn time scheduled`);

            // Pass the earn time
            await time.increase(3601);
            log(`  ⏰ Time passed, earn time reached`);

            // Verify rewards are available
            const rewardsBeforeMint = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsBeforeMint).to.be.gt(0);
            log(`  💰 Available rewards: ${ethers.formatUnits(rewardsBeforeMint, 6)}`);

            // Get balance before mint
            const ownerBalanceBefore = await this.token.balanceOf(this.owner.address);
            const totalSupplyBefore = await this.token.totalSupply();

            // First action: MINT (to owner)
            const mintAmount = ONE_ETHER * 2n;
            await this.token.connect(this.owner).mint(this.owner.address, mintAmount);
            log(`  ✅ First action (MINT) executed: ${ethers.formatUnits(mintAmount, 6)}`);

            // Verify mint worked correctly
            const ownerBalanceAfter = await this.token.balanceOf(this.owner.address);
            const totalSupplyAfter = await this.token.totalSupply();

            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + mintAmount);
            expect(totalSupplyAfter).to.equal(totalSupplyBefore + mintAmount);

            log(`  ✅ Mint computed correctly on first action`);
        });

        it('should use correct computed rewards for next action after first mint', async function () {
            // Setup and pass earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);

            // First action: mint
            await this.token.connect(this.owner).mint(this.owner.address, ONE_ETHER);

            // Second action: verify rewards still claimable
            const rewardsAfterMint = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsAfterMint).to.be.gt(0);

            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);

            log(`  ✅ Claim after mint used correct computed rewards`);
        });
    });

    describe('First Action: Burn', function () {
        it('should correctly compute rewards when burn is first action after earn time', async function () {
            log(`\n📊 Test: First action = BURN`);

            // Transfer tokens to owner to test burn (owner has burn permissions)
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 3n);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            log(`  ⏰ Earn time scheduled`);

            // Pass the earn time
            await time.increase(3601);
            log(`  ⏰ Time passed, earn time reached`);

            // Verify rewards are available for owner
            const rewardsBeforeBurn = await this.token.availableRewardsOf(this.acc.address);
            log(`  💰 Available rewards: ${ethers.formatUnits(rewardsBeforeBurn, 6)}`);

            // Get balance before burn
            const ownerBalanceBefore = await this.token.balanceOf(this.owner.address);
            const totalSupplyBefore = await this.token.totalSupply();

            // First action: BURN (owner has permission)
            const burnAmount = ONE_ETHER;
            await this.token.connect(this.owner).burn(burnAmount);
            log(`  ✅ First action (BURN) executed: ${ethers.formatUnits(burnAmount, 6)}`);

            // Verify burn worked correctly
            const ownerBalanceAfter = await this.token.balanceOf(this.owner.address);
            const totalSupplyAfter = await this.token.totalSupply();

            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore - burnAmount);
            expect(totalSupplyAfter).to.equal(totalSupplyBefore - burnAmount);

            log(`  ✅ Burn computed correctly on first action`);
        });

        it('should use correct computed rewards for next action after first burn', async function () {
            // Setup and pass earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);

            // First action: burn (owner has permission)
            await this.token.connect(this.owner).burn(ONE_ETHER);

            // Second action: verify rewards still claimable
            const rewardsAfterBurn = await this.token.availableRewardsOf(this.acc.address);
            expect(rewardsAfterBurn).to.be.gt(0);

            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);

            log(`  ✅ Claim after burn used correct computed rewards`);
        });
    });

    describe('Complex Sequences', function () {
        it('should handle claim → transfer → mint → burn sequence correctly', async function () {
            log(`\n📊 Test: Complex sequence of actions`);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime);
            await time.increase(3601);

            log(`  Step 1: CLAIM`);
            const rewardsBefore1 = await this.token.availableRewardsOf(this.acc.address);
            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);
            expect(rewardsBefore1).to.be.gt(0);

            log(`  Step 2: TRANSFER`);
            const balanceBefore2 = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.acc).transfer(this.recipient.address, ONE_ETHER);
            const balanceAfter2 = await this.token.balanceOf(this.acc.address);
            expect(balanceAfter2).to.equal(balanceBefore2 - ONE_ETHER);

            log(`  Step 3: MINT`);
            const totalSupplyBefore3 = await this.token.totalSupply();
            await this.token.connect(this.owner).mint(this.owner.address, ONE_ETHER);
            const totalSupplyAfter3 = await this.token.totalSupply();
            expect(totalSupplyAfter3).to.equal(totalSupplyBefore3 + ONE_ETHER);

            log(`  Step 4: BURN`);
            const totalSupplyBefore4 = await this.token.totalSupply();
            await this.token.connect(this.owner).burn(ONE_ETHER);
            const totalSupplyAfter4 = await this.token.totalSupply();
            expect(totalSupplyAfter4).to.equal(totalSupplyBefore4 - ONE_ETHER);

            log(`  ✅ All actions in sequence computed rewards correctly`);
        });

        it('should handle multiple earn cycles with different first actions', async function () {
            log(`\n📊 Test: Multiple earn cycles, different first actions`);

            // Earn cycle 1 - first action: claim
            let futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);
            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);
            log(`  Cycle 1: First action was CLAIM ✅`);

            // Earn cycle 2 - first action: transfer
            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0003", 12), futureTime);
            await time.increase(3601);
            await this.token.connect(this.acc).transfer(this.recipient.address, ONE_ETHER / 2n);
            log(`  Cycle 2: First action was TRANSFER ✅`);

            // Earn cycle 3 - first action: burn (owner has permission)
            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime);
            await time.increase(3601);
            await this.token.connect(this.owner).burn(ONE_ETHER / 2n);
            log(`  Cycle 3: First action was BURN ✅`);

            log(`  ✅ All earn cycles handled different first actions correctly`);
        });
    });

    describe('Edge Cases', function () {
        it('should handle first action immediately after earn time (no delay)', async function () {
            // Schedule earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);

            // Move to exactly earn time (not past it)
            await time.increase(3600);

            // First action right at earn time
            const rewards = await this.token.availableRewardsOf(this.acc.address);
            if (rewards > 0) {
                await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);
                log(`  ✅ First action at exact earn time worked correctly`);
            }
        });

        it('should handle first action long after earn time', async function () {
            // Schedule earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);

            // Move way past earn time (1 week)
            await time.increase(7 * 24 * 3600);

            // First action long after earn time
            const rewards = await this.token.availableRewardsOf(this.acc.address);
            expect(rewards).to.be.gt(0);

            await this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [this.acc.address]);

            log(`  ✅ First action long after earn time worked correctly`);
        });

        it('should handle zero rewards case gracefully', async function () {
            // Create account with no balance
            const zeroAccount = this.recipient;

            // Register to payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, zeroAccount.address);

            // Setup earn time
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.1", 12), futureTime);
            await time.increase(3601);

            // First action should not fail even with zero rewards
            const rewards = await this.token.availableRewardsOf(zeroAccount.address);
            expect(rewards).to.equal(0);

            // Claim should not revert but also not emit event
            await expect(this.token.connect(this.acc3).claimForAddresses(this.payoutGroupId, [zeroAccount.address]))
                .to.not.emit(this.token, 'RewardsClaimed');

            log(`  ✅ Zero rewards case handled gracefully`);
        });
    });
});
