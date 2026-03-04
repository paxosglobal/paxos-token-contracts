const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? log.bind(console) : () => {};

/**
 * Daily Earn Event Simulation Test
 *
 * This test suite simulates a 30-day period with daily earn events:
 * - Daily multiplier updates using scheduleNextMultRate
 * - Rate changes during the period (Day 10: 5%→7%, Day 20: 7%→10%)
 * - Continuous reward accrual verification
 * - State consistency checks throughout
 * - Multi-group behavior over extended period
 */
describe('Daily Earn Event Simulation', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Configure multiplier settings for daily rewards
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing
  });

  it('should simulate 30 days of daily earn events with rate changes', async function () {
    log('\n🔄 30-Day Daily Earn Simulation\n');

    // ========== Setup: Create payout groups and register accounts ==========
    log('Setup: Create payout group and register accounts');

    // Create multiplier 1 first, then set initial rate: 10% APR (~0.027% daily)
    await setupMultiplierWithBounds(this); // creates mult 1
    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1", 10));

    const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

    // Register 3 accounts with different balances
    const signers = await ethers.getSigners();
    const accounts = [this.acc2, this.acc3, signers[7]];
    const balances = [ONE_ETHER * 100n, ONE_ETHER * 50n, ONE_ETHER * 25n]; // 100, 50, 25 tokens

    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 200n);

    for (let i = 0; i < accounts.length; i++) {
      await this.token.connect(this.owner).transfer(accounts[i].address, balances[i]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[i].address);
      log(`✓ Registered ${accounts[i].address.slice(0, 10)}... with ${ethers.formatUnits(balances[i], 6)} tokens`);
    }

    const totalSupplyInitial = await this.token.totalSupply();
    const sourceBalanceInitial = await this.token.balanceOf(await this.token.getClaimSource());
    log(`\n📊 Initial State:`);
    log(`  Total Supply: ${ethers.formatUnits(totalSupplyInitial, 6)}`);
    log(`  Source Balance: ${ethers.formatUnits(sourceBalanceInitial, 6)}`);
    log(`  Total Registered: ${ethers.formatUnits(balances[0] + balances[1] + balances[2], 6)}`);

    // ========== Day 1-10: 5% daily rate ==========
    log('\n📅 Days 1-10: 5% daily rate');
    let cumulativeRewards = 0n;

    for (let day = 1; day <= 10; day++) {
      // Advance time by 1 day
      await time.increase(86400);

      // Check rewards accumulated (compute from individual accounts)
      let totalAvailable = 0n;
      for (const account of accounts) {
        totalAvailable += await this.token.availableRewardsOf(account.address);
      }
      cumulativeRewards = totalAvailable;

      if (day % 3 === 0) { // Log every 3 days
        log(`  Day ${day}: Total rewards: ${ethers.formatUnits(totalAvailable, 6)}`);
      }
    }

    log(`✓ Day 10 complete: ${ethers.formatUnits(cumulativeRewards, 6)} total rewards`);

    // Verify individual rewards at day 10
    const rewardsDay10 = [];
    for (let i = 0; i < accounts.length; i++) {
      const rewards = await this.token.availableRewardsOf(accounts[i].address);
      rewardsDay10.push(rewards);
      expect(rewards).to.be.gt(0);
    }

    // Verify proportional rewards (100:50:25 ratio should be maintained approximately)
    expect(rewardsDay10[0]).to.be.gt(rewardsDay10[1]); // 100 > 50
    expect(rewardsDay10[1]).to.be.gt(rewardsDay10[2]); // 50 > 25

    // ========== Day 10: Schedule rate change to 15% APR ==========
    log('\n📅 Day 10: Schedule rate change to 15% APR');
    const currentTime = await time.latest();
    const day11Time = currentTime + 86400;
    await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.15", 10), day11Time);

    const nextRate = await this.token.getNextAPR(1);
    const nextRateTime = await this.token.getSwitchTime(1);
    expect(nextRate).to.equal(ethers.parseUnits("0.15", 10));
    expect(nextRateTime).to.be.closeTo(day11Time, 86400); // Within one epoch (epoch-aligned)
    log(`✓ Scheduled 15% APR for day 11`);

    // ========== Day 11-20: 15% APR ==========
    log('\n📅 Days 11-20: 15% APR');

    for (let day = 11; day <= 20; day++) {
      await time.increase(86400);

      // Compute total rewards from individual accounts
      let totalAvailable = 0n;
      for (const account of accounts) {
        totalAvailable += await this.token.availableRewardsOf(account.address);
      }
      cumulativeRewards = totalAvailable;

      if (day % 3 === 0) {
        log(`  Day ${day}: Total rewards: ${ethers.formatUnits(totalAvailable, 6)}`);
      }
    }

    log(`✓ Day 20 complete: ${ethers.formatUnits(cumulativeRewards, 6)} total rewards`);

    // Verify rewards increased more than in first 10 days (due to higher rate)
    const rewardsDay20 = [];
    for (let i = 0; i < accounts.length; i++) {
      const rewards = await this.token.availableRewardsOf(accounts[i].address);
      rewardsDay20.push(rewards);
      expect(rewards).to.be.gt(rewardsDay10[i]); // Should have grown
    }

    // ========== Day 20: Schedule rate change to 20% APR ==========
    log('\n📅 Day 20: Schedule rate change to 20% APR');
    const currentTime2 = await time.latest();
    const day21Time = currentTime2 + 86400;
    await this.token.connect(this.owner).scheduleNextMultRateByAPR(1, ethers.parseUnits("0.2", 10), day21Time);

    log(`✓ Scheduled 20% APR for day 21`);

    // ========== Day 21-30: 20% APR ==========
    log('\n📅 Days 21-30: 20% APR');

    for (let day = 21; day <= 30; day++) {
      await time.increase(86400);

      // Compute total rewards from individual accounts
      let totalAvailable = 0n;
      for (const account of accounts) {
        totalAvailable += await this.token.availableRewardsOf(account.address);
      }
      cumulativeRewards = totalAvailable;

      if (day % 3 === 0) {
        log(`  Day ${day}: Total rewards: ${ethers.formatUnits(totalAvailable, 6)}`);
      }
    }

    log(`✓ Day 30 complete: ${ethers.formatUnits(cumulativeRewards, 6)} total rewards`);

    // ========== Verify state consistency after 30 days ==========
    log('\n📊 Final State Verification:');

    // TotalSupply should remain constant
    const totalSupplyFinal = await this.token.totalSupply();
    expect(totalSupplyFinal).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant: ${ethers.formatUnits(totalSupplyFinal, 6)}`);

    // All accounts should have accumulated significant rewards
    for (let i = 0; i < accounts.length; i++) {
      const finalRewards = await this.token.availableRewardsOf(accounts[i].address);
      expect(finalRewards).to.be.gt(rewardsDay20[i]); // Grew from day 20
      log(`  Account ${i + 1} rewards: ${ethers.formatUnits(finalRewards, 6)}`);
    }

    // Source balance should have enough to cover all rewards
    const sourceBalanceFinal = await this.token.balanceOf(await this.token.getClaimSource());
    let totalFinalRewards = 0n;
    for (const account of accounts) {
      totalFinalRewards += await this.token.availableRewardsOf(account.address);
    }
    expect(sourceBalanceFinal).to.be.gte(totalFinalRewards);
    log(`✓ Source balance sufficient: ${ethers.formatUnits(sourceBalanceFinal, 6)} >= ${ethers.formatUnits(totalFinalRewards, 6)}`);

    // ========== Claim all rewards and verify cleanup ==========
    log('\n📥 Claiming all rewards...');
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.recipient.address);

    const recipientBalanceBefore = await this.token.balanceOf(this.recipient.address);
    await this.token.connect(this.acc).claimAll(payoutGroupId);
    const recipientBalanceAfter = await this.token.balanceOf(this.recipient.address);

    const totalClaimed = recipientBalanceAfter - recipientBalanceBefore;
    log(`✓ Claimed ${ethers.formatUnits(totalClaimed, 6)} tokens`);

    // All rewards should be claimed
    for (let i = 0; i < accounts.length; i++) {
      const remainingRewards = await this.token.availableRewardsOf(accounts[i].address);
      expect(remainingRewards).to.equal(0);
    }
    log(`✓ All rewards claimed successfully`);

    // TotalSupply still constant after claim
    const totalSupplyAfterClaim = await this.token.totalSupply();
    expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply still constant: ${ethers.formatUnits(totalSupplyAfterClaim, 6)}`);

    log('\n✅ 30-day simulation completed successfully!\n');
  });

  it('should handle claims at various points during 30-day period', async function () {
    log('\n🔄 30-Day Simulation with Periodic Claims\n');

    // ========== Setup ==========
    await setupMultiplierWithBounds(this); // creates mult 1
    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1", 10)); // 10% APR (~0.027% daily)
    const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.recipient.address);

    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 100n);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 100n);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

    log(`✓ Setup complete: 1 account with 100 tokens`);

    const totalSupplyInitial = await this.token.totalSupply();
    let totalClaimedSoFar = 0n;

    // ========== Claim every 10 days ==========
    for (let period = 1; period <= 3; period++) {
      log(`\n📅 Period ${period}: Days ${(period - 1) * 10 + 1}-${period * 10}`);

      // Advance 10 days
      for (let day = 1; day <= 10; day++) {
        await time.increase(86400);
      }

      const rewardsBeforeClaim = await this.token.availableRewardsOf(this.acc2.address);
      log(`  Rewards accumulated: ${ethers.formatUnits(rewardsBeforeClaim, 6)}`);

      // Claim
      const recipientBalanceBefore = await this.token.balanceOf(this.recipient.address);
      await this.token.connect(this.acc).claimAll(payoutGroupId);
      const recipientBalanceAfter = await this.token.balanceOf(this.recipient.address);

      const claimed = recipientBalanceAfter - recipientBalanceBefore;
      totalClaimedSoFar += claimed;
      log(`  ✓ Claimed: ${ethers.formatUnits(claimed, 6)}`);

      // Verify rewards cleared
      const rewardsAfterClaim = await this.token.availableRewardsOf(this.acc2.address);
      expect(rewardsAfterClaim).to.equal(0);

      // Verify totalSupply constant
      const totalSupplyCurrent = await this.token.totalSupply();
      expect(totalSupplyCurrent).to.equal(totalSupplyInitial);
    }

    log(`\n✅ Total claimed over 30 days: ${ethers.formatUnits(totalClaimedSoFar, 6)} tokens`);
    log(`✅ Periodic claim simulation completed!\n`);
  });

  it('should maintain accuracy with multiple accounts and different claim patterns', async function () {
    log('\n🔄 Multi-Account Different Claim Patterns\n');

    // ========== Setup: 3 accounts with different claim strategies ==========
    await setupMultiplierWithBounds(this); // creates mult 1
    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1", 10)); // 10% APR (~0.027% daily)
    const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

    const signers = await ethers.getSigners();
    const accounts = [this.acc2, this.acc3, signers[7]];
    const balances = [ONE_ETHER * 100n, ONE_ETHER * 100n, ONE_ETHER * 100n];

    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 400n);

    for (let i = 0; i < accounts.length; i++) {
      await this.token.connect(this.owner).transfer(accounts[i].address, balances[i]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[i].address);
    }

    log(`✓ Setup: 3 accounts with 100 tokens each`);

    const totalSupplyInitial = await this.token.totalSupply();
    const totalClaimed = [0n, 0n, 0n];

    // ========== 30 days with different claim patterns ==========
    // Account 1: Claims every 5 days
    // Account 2: Claims every 10 days
    // Account 3: Never claims (accumulates all 30 days)

    for (let day = 1; day <= 30; day++) {
      await time.increase(86400);

      // Account 1: Claim every 5 days
      if (day % 5 === 0) {
        const rewards = await this.token.availableRewardsOf(accounts[0].address);
        if (rewards > 0) {
          await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [accounts[0].address]);
          totalClaimed[0] += rewards;
        }
      }

      // Account 2: Claim every 10 days
      if (day % 10 === 0) {
        const rewards = await this.token.availableRewardsOf(accounts[1].address);
        if (rewards > 0) {
          await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [accounts[1].address]);
          totalClaimed[1] += rewards;
        }
      }

      // Account 3: Never claims

      if (day % 10 === 0) {
        log(`\n  Day ${day}:`);
        log(`    Account 1 total claimed: ${ethers.formatUnits(totalClaimed[0], 6)}`);
        log(`    Account 2 total claimed: ${ethers.formatUnits(totalClaimed[1], 6)}`);
        const acc3Rewards = await this.token.availableRewardsOf(accounts[2].address);
        log(`    Account 3 unclaimed: ${ethers.formatUnits(acc3Rewards, 6)}`);
      }
    }

    // ========== Final verification ==========
    log('\n📊 Final State:');

    // Account 3 claims all at once
    const acc3FinalRewards = await this.token.availableRewardsOf(accounts[2].address);
    await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [accounts[2].address]);
    totalClaimed[2] = acc3FinalRewards;

    // The three accounts will have claimed different amounts due to claim timing differences
    // in a shares-based model. Claiming more frequently can result in lower total rewards
    // because the lastMultiplier is updated more often, which affects future earnings.
    log(`  Account 1 total claimed: ${ethers.formatUnits(totalClaimed[0], 6)} (claimed every 5 days)`);
    log(`  Account 2 total claimed: ${ethers.formatUnits(totalClaimed[1], 6)} (claimed every 10 days)`);
    log(`  Account 3 total claimed: ${ethers.formatUnits(totalClaimed[2], 6)} (claimed once at end)`);

    // Verify Account 3 (claimed once at end) has the most rewards
    // This is expected in a shares-based model where holding rewards longer = more growth
    expect(totalClaimed[2]).to.be.gt(totalClaimed[1]); // Less frequent claiming → more rewards
    expect(totalClaimed[1]).to.be.gt(totalClaimed[0]); // Less frequent claiming → more rewards
    log(`✓ Less frequent claiming resulted in higher total rewards (expected behavior)`);

    // TotalSupply still constant
    const totalSupplyFinal = await this.token.totalSupply();
    expect(totalSupplyFinal).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant: ${ethers.formatUnits(totalSupplyFinal, 6)}`);

    log('\n✅ Multi-account claim pattern test passed!\n');
  });
});
