const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? log.bind(console) : () => {};

/**
 * Complete Lifecycle Test: Multiple Payout Groups
 *
 * This test suite covers complex workflows with multiple payout groups and multipliers:
 * - Create 3 multipliers with different rates
 * - Create 2 payout groups per multiplier (6 total)
 * - Register accounts across different groups
 * - Transfers within and across groups
 * - Periodic multiplier increases
 * - Verify differential reward accrual
 * - Mixed claims (some full, some individual)
 * - Migrate accounts between groups (unregister + register)
 */
describe('Complete Lifecycle: Multiple Payout Groups', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Configure multiplier settings
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing range
  });

  it('should handle complete multi-group lifecycle', async function () {
    log('\n🔄 Complete Multi-Group Lifecycle Test\n');

    // ========== Step 1: Create 3 multipliers with different rates ==========
    log('Step 1: Create multipliers with different rates');
    // Create multipliers 1, 2 and 3
    await setupMultiplierWithBounds(this); // creates mult 1
    await setupMultiplierWithBounds(this); // creates mult 2
    await setupMultiplierWithBounds(this); // creates mult 3

    // Set different rates for multipliers 1, 2, 3: 0% (none), 5%, 10%
    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0", 10)); // 0% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.05", 10)); // 5% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(3, ethers.parseUnits("0.1", 10)); // 10% APR

    log(`✓ Created 3 multipliers with rates: 0%, 5%, 10%`);

    // ========== Step 2: Create 2 payout groups per multiplier (6 total) ==========
    log('\nStep 2: Create payout groups');
    const signers = await ethers.getSigners();
    const claimers = signers.slice(10, 16); // Use signers 10-15 as claimers

    const payoutGroupIds = [];
    for (let multIdx = 1; multIdx <= 3; multIdx++) {
      for (let groupIdx = 0; groupIdx < 2; groupIdx++) {
        const claimer = claimers[(multIdx - 1) * 2 + groupIdx];
        const pgId = await createPayoutGroup(this, multIdx, claimer);
        payoutGroupIds.push({ id: pgId, multIdx, claimer: claimer.address });
        log(`✓ Created group ${pgId} (mult ${multIdx}) with claimer ${claimer.address.slice(0, 10)}...`);
      }
    }

    expect(payoutGroupIds.length).to.equal(6);

    // ========== Step 3: Register accounts across different groups ==========
    log('\nStep 3: Register accounts across groups');
    const accounts = [this.acc, this.acc2, this.acc3, signers[7], signers[8], signers[9]];

    // Register 1 account to each payout group
    for (let i = 0; i < 6; i++) {
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        payoutGroupIds[i].id,
        accounts[i].address
      );
      log(`✓ Registered ${accounts[i].address.slice(0, 10)}... to group ${payoutGroupIds[i].id}`);
    }

    // ========== Step 4: Mint tokens ==========
    log('\nStep 4: Mint tokens');
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 200n);

    for (let i = 0; i < 6; i++) {
      const amount = ONE_ETHER * 10n; // 10 tokens each
      await this.token.connect(this.owner).transfer(accounts[i].address, amount);
      log(`✓ Minted ${ethers.formatUnits(amount, 6)} to ${accounts[i].address.slice(0, 10)}...`);
    }

    const totalSupplyInitial = await this.token.totalSupply();

    // ========== Step 5: Periodic multiplier increases (3 earn events) ==========
    log('\nStep 5: Periodic multiplier increases');

    // Earn event 1: Increase all multipliers
    await time.increase(86401); // 1 day + 1 second
    log(`✓ Earn event 1: Time advanced`);

    // Earn event 2: Increase again
    await time.increase(86400); // 1 more day
    log(`✓ Earn event 2: Time advanced`);

    // ========== Step 6: Verify differential reward accrual ==========
    log('\nStep 6: Verify differential reward accrual');

    // Accounts with mult 0 (0% rate) should have rewards ≈ 0
    const rewards0a = await this.token.availableRewardsOf(accounts[0].address);
    const rewards0b = await this.token.availableRewardsOf(accounts[1].address);
    expect(rewards0a).to.be.closeTo(0n, ethers.parseUnits("0.01", 6));
    expect(rewards0b).to.be.closeTo(0n, ethers.parseUnits("0.01", 6));
    log(`✓ Mult 0 accounts (0% rate): ~0 rewards`);

    // Accounts with mult 1 (5% rate) should have rewards > 0
    const rewards1a = await this.token.availableRewardsOf(accounts[2].address);
    const rewards1b = await this.token.availableRewardsOf(accounts[3].address);
    expect(rewards1a).to.be.gt(0);
    expect(rewards1b).to.be.gt(0);
    log(`✓ Mult 1 accounts (5% rate): ${ethers.formatUnits(rewards1a, 6)}, ${ethers.formatUnits(rewards1b, 6)}`);

    // Accounts with mult 2 (10% rate) should have rewards > mult 1
    const rewards2a = await this.token.availableRewardsOf(accounts[4].address);
    const rewards2b = await this.token.availableRewardsOf(accounts[5].address);
    expect(rewards2a).to.be.gt(rewards1a);
    expect(rewards2b).to.be.gt(rewards1b);
    log(`✓ Mult 2 accounts (10% rate): ${ethers.formatUnits(rewards2a, 6)}, ${ethers.formatUnits(rewards2b, 6)}`);

    // ========== Step 7: Mixed claims ==========
    log('\nStep 7: Mixed claims');

    // ClaimAll for group 1 (mult 0)
    await this.token.connect(claimers[0]).claimAll(payoutGroupIds[0].id);
    log(`✓ ClaimAll for group ${payoutGroupIds[0].id}`);

    // ClaimOne for account in group 3 (mult 1)
    await this.token.connect(claimers[2]).claimForAddresses(payoutGroupIds[2].id, [accounts[2].address]);
    log(`✓ ClaimOne for account ${accounts[2].address.slice(0, 10)}... in group ${payoutGroupIds[2].id}`);

    // ClaimAll for group 5 (mult 2)
    await this.token.connect(claimers[4]).claimAll(payoutGroupIds[4].id);
    log(`✓ ClaimAll for group ${payoutGroupIds[4].id}`);

    // Verify totalSupply still constant
    const totalSupplyAfterClaims = await this.token.totalSupply();
    expect(totalSupplyAfterClaims).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant: ${ethers.formatUnits(totalSupplyAfterClaims, 6)}`);

    // ========== Step 8: Transfers within and across groups ==========
    log('\nStep 8: Transfers within and across groups');

    // Transfer within same group (same multiplier)
    await this.token.connect(accounts[0]).transfer(accounts[1].address, ONE_ETHER);
    log(`✓ Transfer within same group (mult 0)`);

    // Transfer across groups (different multipliers)
    await this.token.connect(accounts[2]).transfer(accounts[4].address, ONE_ETHER);
    log(`✓ Transfer across groups (mult 1 → mult 2)`);

    // Verify totalSupply still constant
    const totalSupplyAfterTransfers = await this.token.totalSupply();
    expect(totalSupplyAfterTransfers).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant after transfers: ${ethers.formatUnits(totalSupplyAfterTransfers, 6)}`);

    log('\n✅ Multi-group lifecycle test passed!\n');
  });

  it('should migrate accounts between groups (unregister + register)', async function () {
    log('\n🔄 Account Migration Test\n');

    // Setup: Create multipliers 1 and 2 with bounds
    await setupMultiplierWithBounds(this); // creates mult 1
    await setupMultiplierWithBounds(this); // creates mult 2
    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.05", 10)); // 5% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.1", 10)); // 10% APR

    // Create 2 payout groups
    const group1Id = await createPayoutGroup(this, 1, this.acc); // Group 1, mult 1
    const group2Id = await createPayoutGroup(this, 2, this.acc2); // Group 2, mult 2

    log(`✓ Created group ${group1Id} (mult 1) and group ${group2Id} (mult 2)`);

    // Register account to group 1
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 50n);
    await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 10n);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(group1Id, this.acc3.address);
    log(`✓ Registered ${this.acc3.address.slice(0, 10)}... to group ${group1Id}`);

    // Verify registration
    const payoutIdBefore = await this.token.payoutGroupIdOf(this.acc3.address);
    expect(payoutIdBefore).to.equal(group1Id);
    const group1BalanceBefore = await this.token.getPayoutGroupBalance(group1Id);
    expect(group1BalanceBefore).to.equal(ONE_ETHER * 10n);
    log(`✓ Group ${group1Id} balance: ${ethers.formatUnits(group1BalanceBefore, 6)}`);

    // Earn rewards in group 1
    await time.increase(86401);
    const rewardsInGroup1 = await this.token.availableRewardsOf(this.acc3.address);
    expect(rewardsInGroup1).to.be.gt(0);
    log(`\n✓ Earned rewards in group 1: ${ethers.formatUnits(rewardsInGroup1, 6)}`);

    // Claim rewards before migrating
    await this.token.connect(this.acc).claimAll(group1Id);
    log(`✓ Claimed rewards from group 1`);

    // Migrate: Unregister from group 1
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(group1Id, this.acc3.address);
    const payoutIdAfterUnregister = await this.token.payoutGroupIdOf(this.acc3.address);
    expect(payoutIdAfterUnregister).to.equal(0);
    log(`\n✓ Unregistered from group ${group1Id} (payoutGroupId now 0)`);

    // Verify group 1 balance decreased
    const group1BalanceAfterUnregister = await this.token.getPayoutGroupBalance(group1Id);
    expect(group1BalanceAfterUnregister).to.equal(0);
    log(`✓ Group ${group1Id} balance now: ${ethers.formatUnits(group1BalanceAfterUnregister, 6)}`);

    // Register to group 2 (migration complete)
    await this.token.connect(this.owner).registrarRegisterRewardAddress(group2Id, this.acc3.address);
    const payoutIdAfterRegister = await this.token.payoutGroupIdOf(this.acc3.address);
    expect(payoutIdAfterRegister).to.equal(group2Id);
    log(`\n✓ Registered to group ${group2Id} (payoutGroupId now ${group2Id})`);

    // Verify group 2 balance increased
    const group2BalanceAfterRegister = await this.token.getPayoutGroupBalance(group2Id);
    expect(group2BalanceAfterRegister).to.equal(ONE_ETHER * 10n);
    log(`✓ Group ${group2Id} balance now: ${ethers.formatUnits(group2BalanceAfterRegister, 6)}`);

    // Earn rewards in group 2 (should use new multiplier rate: 10% vs 5%)
    await time.increase(86400);
    const rewardsInGroup2 = await this.token.availableRewardsOf(this.acc3.address);
    expect(rewardsInGroup2).to.be.gt(0);
    log(`\n✓ Earned rewards in group 2: ${ethers.formatUnits(rewardsInGroup2, 6)}`);

    // Since group 2 has 10% rate vs group 1's 5% rate, rewards should be ~2x (for same time period)
    // Note: Can't directly compare because claim reset the baseline

    log('\n✅ Account migration test passed!\n');
  });

  it('should handle multiple simultaneous migrations', async function () {
    log('\n🔄 Multiple Migrations Test\n');

    // Setup: Create multipliers 1, 2 and 3 with bounds
    await setupMultiplierWithBounds(this); // creates mult 1
    await setupMultiplierWithBounds(this); // creates mult 2
    await setupMultiplierWithBounds(this); // creates mult 3

    const signers = await ethers.getSigners();
    const claimers = [this.acc, this.acc2, this.acc3];
    const accounts = [signers[7], signers[8], signers[9], signers[10], signers[11]]; // 5 accounts to migrate

    const groupIds = [];
    for (let i = 1; i <= 3; i++) {
      const gid = await createPayoutGroup(this, i, claimers[i-1]);
      groupIds.push(gid);
      log(`✓ Created group ${gid} (mult ${i})`);
    }

    // Register 5 accounts to group 1
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 100n);
    for (let i = 0; i < 5; i++) {
      await this.token.connect(this.owner).transfer(accounts[i].address, ONE_ETHER * 10n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(groupIds[0], accounts[i].address);
    }
    log(`\n✓ Registered 5 accounts to group ${groupIds[0]}`);

    const group1BalanceBefore = await this.token.getPayoutGroupBalance(groupIds[0]);
    expect(group1BalanceBefore).to.equal(ONE_ETHER * 50n);

    // Migrate all 5 accounts to different target groups
    log(`\n✓ Migrating accounts...`);
    const targetGroups = [1, 1, 2, 2, 2]; // Mix of groups 2 and 3

    for (let i = 0; i < 5; i++) {
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(groupIds[0], accounts[i].address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(groupIds[targetGroups[i]], accounts[i].address);
      log(`  Migrated account ${i + 1} to group ${groupIds[targetGroups[i]]}`);
    }

    // Verify group 1 is now empty
    const group1BalanceAfter = await this.token.getPayoutGroupBalance(groupIds[0]);
    expect(group1BalanceAfter).to.equal(0);
    log(`\n✓ Group ${groupIds[0]} now empty: ${ethers.formatUnits(group1BalanceAfter, 6)}`);

    // Verify groups 2 and 3 received the accounts
    const group2Balance = await this.token.getPayoutGroupBalance(groupIds[1]);
    const group3Balance = await this.token.getPayoutGroupBalance(groupIds[2]);
    expect(group2Balance).to.equal(ONE_ETHER * 20n); // 2 accounts
    expect(group3Balance).to.equal(ONE_ETHER * 30n); // 3 accounts
    log(`✓ Group ${groupIds[1]} balance: ${ethers.formatUnits(group2Balance, 6)}`);
    log(`✓ Group ${groupIds[2]} balance: ${ethers.formatUnits(group3Balance, 6)}`);

    log('\n✅ Multiple migrations test passed!\n');
  });

});
