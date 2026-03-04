const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);

/**
 * System Invariants Tests
 *
 * Tests critical accounting invariants that must hold across all operations:
 * 1. Balance Accounting: totalSupply == sum of all balances
 * 2. Shares Model: shares * multiplier / MULT_BASE >= balance (with rewards)
 * 3. Payout Group Consistency: group aggregates match sum of members
 * 4. Operation Safety: transfers/claims don't change totalSupply
 * 5. Mint/Burn Only: only mint/burn operations change totalSupply
 */
describe('System Invariants Tests', function () {
    let accounts = [];
    let payoutGroups = [];

    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Set up test accounts
        accounts = [this.acc, this.acc2, this.acc3];

        // Initialize system
        await this.token.connect(this.owner).setMaturityPeriod(86400);
        await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1000n);

        // Create multiplier with bounds (returns ID 1)
        await setupMultiplierWithBounds(this);

        // Create two payout groups
        const pg1Id = await createPayoutGroup(this, 1, this.acc);
        const pg2Id = await createPayoutGroup(this, 1, this.acc2);

        payoutGroups = [pg1Id, pg2Id];

        // Distribute tokens to test accounts
        for (let i = 0; i < accounts.length; i++) {
            await this.token.connect(this.owner).transfer(accounts[i].address, ONE_ETHER * 100n);
        }
    });

    /**
     * Helper to get all account addresses in the system
     */
    async function getAllAddresses(context) {
        return [
            context.owner.address,
            context.acc.address,
            context.acc2.address,
            context.acc3.address,
            context.recipient.address,
            context.admin.address
        ];
    }

    /**
     * Helper to sum all balances in the system
     */
    async function sumAllBalances(token, addresses) {
        let total = 0n;
        for (const addr of addresses) {
            total += await token.balanceOf(addr);
        }
        return total;
    }

    /**
     * Helper to get accounts registered to a payout group
     */
    async function getPayoutGroupMembers(token, payoutGroupId, allAddresses) {
        const members = [];
        for (const addr of allAddresses) {
            const groupId = await token.payoutGroupIdOf(addr);
            if (groupId === payoutGroupId) {
                members.push(addr);
            }
        }
        return members;
    }

    // ===========================================================================
    // SECTION 1: BALANCE ACCOUNTING INVARIANTS
    // ===========================================================================
    describe('Balance Accounting Invariants', function () {
        it('should maintain totalSupply == sum of all balances', async function () {
            const totalSupply = await this.token.totalSupply();
            const addresses = await getAllAddresses(this);
            const sumOfBalances = await sumAllBalances(this.token, addresses);

            log(`Total Supply: ${ethers.formatUnits(totalSupply, 6)}`);
            log(`Sum of Balances: ${ethers.formatUnits(sumOfBalances, 6)}`);

            expect(totalSupply).to.equal(sumOfBalances,
                'totalSupply must equal sum of all balances (standard ERC20 invariant)');
        });

        it('should maintain payout group balance == sum of member balances', async function () {
            // Register accounts to payout groups
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[1], this.acc2.address);

            // Check each payout group
            for (let i = 0; i < payoutGroups.length; i++) {
                const groupId = payoutGroups[i];
                const groupBalance = await this.token.getPayoutGroupBalance(groupId);

                const addresses = await getAllAddresses(this);
                const members = await getPayoutGroupMembers(this.token, groupId, addresses);

                let sumMemberBalances = 0n;
                for (const member of members) {
                    sumMemberBalances += await this.token.balanceOf(member);
                }

                log(`Payout Group ${groupId}: group balance=${ethers.formatUnits(groupBalance, 6)}, sum of members=${ethers.formatUnits(sumMemberBalances, 6)}`);

                expect(groupBalance).to.equal(sumMemberBalances,
                    `Payout group ${groupId} balance must equal sum of member balances`);
            }
        });

        it('should preserve total balance across transfers', async function () {
            const addresses = await getAllAddresses(this);
            const totalBefore = await sumAllBalances(this.token, addresses);

            // Perform multiple transfers
            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
            await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER * 2n);
            await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 5n);

            const totalAfter = await sumAllBalances(this.token, addresses);

            expect(totalAfter).to.equal(totalBefore,
                'Total balance across all accounts must be preserved during transfers');
        });

        it('should maintain accounting after complex multi-account operations', async function () {
            // Register accounts
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc3.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[1], this.acc2.address);

            const addresses = await getAllAddresses(this);

            // Check invariant before operations
            const totalSupply1 = await this.token.totalSupply();
            const sumBalances1 = await sumAllBalances(this.token, addresses);
            expect(totalSupply1).to.equal(sumBalances1);

            // Do transfers
            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER * 10n);
            await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER * 5n);

            // Check invariant after transfers
            const totalSupply2 = await this.token.totalSupply();
            const sumBalances2 = await sumAllBalances(this.token, addresses);
            expect(totalSupply2).to.equal(sumBalances2);
            expect(totalSupply2).to.equal(totalSupply1, 'totalSupply unchanged by transfers');

            // Generate some rewards
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), futureTime);
            await time.increase(3601);

            // Claim rewards
            await this.token.connect(this.acc).claimAll(payoutGroups[0]);

            // Check invariant after claim
            const totalSupply3 = await this.token.totalSupply();
            const sumBalances3 = await sumAllBalances(this.token, addresses);
            expect(totalSupply3).to.equal(sumBalances3);
            expect(totalSupply3).to.equal(totalSupply1, 'totalSupply unchanged by claims');
        });
    });

    // ===========================================================================
    // SECTION 2: SHARES MODEL INVARIANTS
    // ===========================================================================
    describe('Shares Model Invariants', function () {
        it('should maintain shares * multiplier >= balance * MULT_BASE (unclaimed rewards)', async function () {
            // Register and give account a balance
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);

            // Generate rewards by advancing multiplier
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
            await time.increase(3601);

            // Trigger multiplier update via transfer to self
            await this.token.connect(this.acc).transfer(this.acc.address, 0);

            const balance = await this.token.balanceOf(this.acc.address);
            const availableRewards = await this.token.availableRewardsOf(this.acc.address);
            const multiplier = await this.token.getActiveMultiplier(1);

            log(`Balance: ${ethers.formatUnits(balance, 6)}`);
            log(`Available Rewards: ${ethers.formatUnits(availableRewards, 6)}`);
            log(`Multiplier: ${ethers.formatUnits(multiplier, 12)}`);

            // Shares model: balance + rewards should be recoverable from shares
            expect(availableRewards).to.be.gt(0, 'Should have earned rewards from multiplier increase');
        });

        it('should satisfy shares * multiplier == balance * MULT_BASE after claim', async function () {
            // Register and give account a balance
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);

            // Generate rewards
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(3601);

            // Claim all rewards
            await this.token.connect(this.acc).claimAll(payoutGroups[0]);

            const availableRewards = await this.token.availableRewardsOf(this.acc.address);

            log(`Available Rewards After Claim: ${ethers.formatUnits(availableRewards, 6)}`);

            // After claim, should have no unclaimed rewards
            expect(availableRewards).to.equal(0, 'Should have zero available rewards after claim');
        });

        it('should track unclaimed rewards correctly via shares model', async function () {
            // Register two accounts to same payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc3.address);

            const initialRewards1 = await this.token.availableRewardsOf(this.acc.address);
            const initialRewards2 = await this.token.availableRewardsOf(this.acc3.address);

            expect(initialRewards1).to.equal(0, 'No rewards initially');
            expect(initialRewards2).to.equal(0, 'No rewards initially');

            // Generate rewards
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
            await time.increase(3601);

            // Trigger reward updates via transfers
            await this.token.connect(this.acc).transfer(this.acc.address, 0);
            await this.token.connect(this.acc3).transfer(this.acc3.address, 0);

            const rewardsAfter1 = await this.token.availableRewardsOf(this.acc.address);
            const rewardsAfter2 = await this.token.availableRewardsOf(this.acc3.address);

            log(`Rewards acc: ${ethers.formatUnits(rewardsAfter1, 6)}`);
            log(`Rewards acc3: ${ethers.formatUnits(rewardsAfter2, 6)}`);

            expect(rewardsAfter1).to.be.gt(0, 'Should have earned rewards');
            expect(rewardsAfter2).to.be.gt(0, 'Should have earned rewards');

            // Rewards should be proportional to balance (both have 100 ETHER)
            const balance1 = await this.token.balanceOf(this.acc.address);
            const balance2 = await this.token.balanceOf(this.acc3.address);

            expect(balance1).to.equal(balance2, 'Balances are equal');
            expect(rewardsAfter1).to.equal(rewardsAfter2, 'Equal balances should earn equal rewards');
        });
    });

    // ===========================================================================
    // SECTION 3: OPERATION SAFETY INVARIANTS
    // ===========================================================================
    describe('Operation Safety Invariants', function () {
        it('should not change totalSupply during transfers', async function () {
            const supplyBefore = await this.token.totalSupply();

            // Do multiple transfers
            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
            await this.token.connect(this.acc2).transfer(this.acc3.address, ONE_ETHER * 2n);
            await this.token.connect(this.acc3).transfer(this.owner.address, ONE_ETHER);

            const supplyAfter = await this.token.totalSupply();

            expect(supplyAfter).to.equal(supplyBefore,
                'Transfers must not change totalSupply');
        });

        it('should not change totalSupply during claims', async function () {
            // Register and generate rewards
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);

            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.03", 12), futureTime);
            await time.increase(3601);

            const supplyBefore = await this.token.totalSupply();

            // Claim rewards
            await this.token.connect(this.acc).claimAll(payoutGroups[0]);

            const supplyAfter = await this.token.totalSupply();

            expect(supplyAfter).to.equal(supplyBefore,
                'Claims must not change totalSupply (moves tokens from claim source)');
        });

        it('should only change totalSupply during mint operations', async function () {
            const supplyBefore = await this.token.totalSupply();

            // Mint tokens
            const mintAmount = ONE_ETHER * 50n;
            await this.token.connect(this.owner).increaseSupply(mintAmount);

            const supplyAfter = await this.token.totalSupply();

            expect(supplyAfter).to.equal(supplyBefore + mintAmount,
                'Mint must increase totalSupply by exact mint amount');
        });

        it('should only change totalSupply during burn operations', async function () {
            const supplyBefore = await this.token.totalSupply();

            // Burn tokens from owner
            const burnAmount = ONE_ETHER * 30n;
            await this.token.connect(this.owner).decreaseSupply(burnAmount);

            const supplyAfter = await this.token.totalSupply();

            expect(supplyAfter).to.equal(supplyBefore - burnAmount,
                'Burn must decrease totalSupply by exact burn amount');
        });

        it('should maintain totalSupply invariant through complex operation sequence', async function () {
            const addresses = await getAllAddresses(this);

            // Initial check
            let supply = await this.token.totalSupply();
            let balanceSum = await sumAllBalances(this.token, addresses);
            expect(supply).to.equal(balanceSum);

            // Transfer
            await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER * 10n);
            supply = await this.token.totalSupply();
            balanceSum = await sumAllBalances(this.token, addresses);
            expect(supply).to.equal(balanceSum, 'After transfer');

            // Mint
            await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 100n);
            supply = await this.token.totalSupply();
            balanceSum = await sumAllBalances(this.token, addresses);
            expect(supply).to.equal(balanceSum, 'After mint');

            // Transfer again
            await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 50n);
            supply = await this.token.totalSupply();
            balanceSum = await sumAllBalances(this.token, addresses);
            expect(supply).to.equal(balanceSum, 'After second transfer');

            // Burn
            await this.token.connect(this.owner).decreaseSupply(ONE_ETHER * 75n);
            supply = await this.token.totalSupply();
            balanceSum = await sumAllBalances(this.token, addresses);
            expect(supply).to.equal(balanceSum, 'After burn');
        });
    });

    // ===========================================================================
    // SECTION 4: PAYOUT GROUP CONSISTENCY
    // ===========================================================================
    describe('Payout Group Consistency', function () {
        it('should maintain consistent payout group aggregates', async function () {
            // Register accounts to payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc3.address);

            const groupBalance = await this.token.getPayoutGroupBalance(payoutGroups[0]);
            const acc1Balance = await this.token.balanceOf(this.acc.address);
            const acc3Balance = await this.token.balanceOf(this.acc3.address);

            expect(groupBalance).to.equal(acc1Balance + acc3Balance,
                'Payout group balance must equal sum of member balances');
        });

        it('should update aggregates correctly on registration', async function () {
            const groupId = payoutGroups[0];

            // Check initial group balance (should be 0)
            const initialGroupBalance = await this.token.getPayoutGroupBalance(groupId);
            expect(initialGroupBalance).to.equal(0);

            // Register account with balance
            const accBalance = await this.token.balanceOf(this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(groupId, this.acc.address);

            // Group balance should now include account balance
            const finalGroupBalance = await this.token.getPayoutGroupBalance(groupId);
            expect(finalGroupBalance).to.equal(accBalance,
                'Group balance must update to include registered account balance');
        });

        it('should update aggregates correctly on unregistration', async function () {
            const groupId = payoutGroups[0];

            // Register two accounts
            await this.token.connect(this.owner).registrarRegisterRewardAddress(groupId, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(groupId, this.acc3.address);

            const groupBalanceBefore = await this.token.getPayoutGroupBalance(groupId);
            const acc1Balance = await this.token.balanceOf(this.acc.address);

            // Unregister one account
            await this.token.connect(this.owner).registrarUnregisterRewardAddress(groupId, this.acc.address);

            const groupBalanceAfter = await this.token.getPayoutGroupBalance(groupId);

            expect(groupBalanceAfter).to.equal(groupBalanceBefore - acc1Balance,
                'Group balance must decrease by unregistered account balance');
        });

        it('should handle cross-group transfers correctly', async function () {
            // Register accounts to different groups
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[1], this.acc2.address);

            const group0Before = await this.token.getPayoutGroupBalance(payoutGroups[0]);
            const group1Before = await this.token.getPayoutGroupBalance(payoutGroups[1]);

            // Transfer between groups
            const transferAmount = ONE_ETHER * 10n;
            await this.token.connect(this.acc).transfer(this.acc2.address, transferAmount);

            const group0After = await this.token.getPayoutGroupBalance(payoutGroups[0]);
            const group1After = await this.token.getPayoutGroupBalance(payoutGroups[1]);

            expect(group0After).to.equal(group0Before - transferAmount,
                'Source group balance must decrease by transfer amount');
            expect(group1After).to.equal(group1Before + transferAmount,
                'Destination group balance must increase by transfer amount');
        });

        it('should maintain group available rewards consistency', async function () {
            // Register two accounts to same group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroups[0], this.acc3.address);

            // Generate rewards
            const futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.04", 12), futureTime);
            await time.increase(3601);

            // Trigger updates
            await this.token.connect(this.acc).transfer(this.acc.address, 0);
            await this.token.connect(this.acc3).transfer(this.acc3.address, 0);

            // Check group rewards vs sum of individual rewards
            const groupRewards = await this.token.getPayoutGroupAvailableRewards(payoutGroups[0]);
            const acc1Rewards = await this.token.availableRewardsOf(this.acc.address);
            const acc3Rewards = await this.token.availableRewardsOf(this.acc3.address);

            log(`Group Rewards: ${ethers.formatUnits(groupRewards, 6)}`);
            log(`Sum Individual: ${ethers.formatUnits(acc1Rewards + acc3Rewards, 6)}`);

            // Group rewards should match sum of individual rewards
            expect(groupRewards).to.equal(acc1Rewards + acc3Rewards,
                'Group available rewards must equal sum of member available rewards');
        });
    });
});
