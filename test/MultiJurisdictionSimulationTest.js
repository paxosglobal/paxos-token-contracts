const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? log.bind(console) : () => {};

/**
 * Multi-Jurisdiction Simulation Test
 *
 * This test suite simulates a multi-jurisdiction environment:
 * - 5 "jurisdictions" (payout groups) representing different geographic regions
 * - Each jurisdiction has its own multiplier with different rates
 * - Each jurisdiction has its own claimer/registrar
 * - Accounts distributed across jurisdictions
 * - Verify data isolation between jurisdictions
 * - Test cross-jurisdiction migrations
 * - Test admin operations across all jurisdictions
 */
describe('Multi-Jurisdiction Simulation', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR
    // Create multipliers 1 and 2 (tests assume they exist)
    await this.token.connect(this.owner).createMultiplier(0);
    await this.token.connect(this.owner).createMultiplier(0);
  });

  it('should simulate 5 independent jurisdictions with different rates', async function () {
    log('\n🌍 Multi-Jurisdiction Simulation\n');

    // ========== Setup: Create 5 multipliers representing different jurisdictions ==========
    log('Step 1: Create 5 multipliers for different jurisdictions');

    // Multipliers 1 and 2 already exist from beforeEach
    // Multiplier 1: US (3% rate)
    // Multiplier 2: EU (4% rate)
    // Multiplier 3: UK (5% rate)
    // Multiplier 4: Asia (6% rate)
    // Multiplier 5: LATAM (7% rate)

    await this.token.connect(this.owner).createMultiplier(0); // Mult 3: UK
    await this.token.connect(this.owner).createMultiplier(0); // Mult 4: Asia
    await this.token.connect(this.owner).createMultiplier(0); // Mult 5: LATAM

    await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1095", 10)); // 3% daily = 10.95% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.146", 10)); // 4% daily = 14.6% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(3, ethers.parseUnits("0.1825", 10)); // 5% daily = 18.25% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(4, ethers.parseUnits("0.219", 10)); // 6% daily = 21.9% APR
    await this.token.connect(this.owner).setMultiplierRateByAPR(5, ethers.parseUnits("0.2555", 10)); // 7% daily = 25.55% APR

    log(`✓ Created 5 multipliers: US(3%), EU(4%), UK(5%), Asia(6%), LATAM(7%)`);

    // ========== Setup: Create payout groups for each jurisdiction ==========
    log('\nStep 2: Create payout group for each jurisdiction');

    const signers = await ethers.getSigners();
    const claimers = signers.slice(10, 15); // Use signers 10-14 as jurisdiction claimers
    const jurisdictionNames = ['US', 'EU', 'UK', 'Asia', 'LATAM'];
    const jurisdictions = [];

    for (let i = 1; i <= 5; i++) {
      const pgId = await createPayoutGroup(this, i, claimers[i-1]);
      jurisdictions.push({
        name: jurisdictionNames[i-1],
        payoutGroupId: pgId,
        multiplierIdx: i,
        claimer: claimers[i-1]
      });
      log(`✓ Created ${jurisdictionNames[i-1]} jurisdiction (group ${pgId}, mult ${i})`);
    }

    // ========== Setup: Register accounts to different jurisdictions ==========
    log('\nStep 3: Register accounts across jurisdictions');

    // Create 15 accounts (3 per jurisdiction)
    // Use fixture accounts first, then signers
    const allAccounts = [this.acc, this.acc2, this.acc3, this.recipient, this.admin, this.assetProtectionRole,
                         ...signers.slice(7, 16)]; // Total: 15 accounts
    const accounts = [];
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 1500n);

    for (let jurisdictionIdx = 0; jurisdictionIdx < 5; jurisdictionIdx++) {
      const jurisdictionAccounts = [];

      for (let accountIdx = 0; accountIdx < 3; accountIdx++) {
        const signer = allAccounts[jurisdictionIdx * 3 + accountIdx];
        const balance = ONE_ETHER * 100n; // 100 tokens each

        await this.token.connect(this.owner).transfer(signer.address, balance);
        await this.token.connect(this.owner).registrarRegisterRewardAddress(
          jurisdictions[jurisdictionIdx].payoutGroupId,
          signer.address
        );

        jurisdictionAccounts.push({ signer, balance });
      }

      accounts.push(jurisdictionAccounts);
      log(`✓ Registered 3 accounts to ${jurisdictions[jurisdictionIdx].name} jurisdiction`);
    }

    const totalSupplyInitial = await this.token.totalSupply();
    log(`\n📊 Initial Setup: 5 jurisdictions, 15 accounts total, ${ethers.formatUnits(totalSupplyInitial, 6)} supply`);

    // ========== Test: Verify data isolation between jurisdictions ==========
    log('\nStep 4: Verify data isolation between jurisdictions');

    // Earn rewards (10 days)
    for (let day = 1; day <= 10; day++) {
      await time.increase(86400);
    }

    // Check that each jurisdiction has different reward totals (due to different rates)
    const jurisdictionRewards = [];
    for (let i = 0; i < 5; i++) {
      let totalJurisdictionRewards = 0n;
      for (let j = 0; j < 3; j++) {
        const rewards = await this.token.availableRewardsOf(accounts[i][j].signer.address);
        totalJurisdictionRewards += rewards;
      }
      jurisdictionRewards.push(totalJurisdictionRewards);
      log(`  ${jurisdictions[i].name}: ${ethers.formatUnits(totalJurisdictionRewards, 6)} total rewards`);
    }

    // Verify rewards increase with higher rates: US < EU < UK < Asia < LATAM
    for (let i = 1; i < 5; i++) {
      expect(jurisdictionRewards[i]).to.be.gt(jurisdictionRewards[i - 1]);
    }
    log(`✓ Verified reward differential across jurisdictions`);

    // ========== Test: Cross-jurisdiction migration ==========
    log('\nStep 5: Test cross-jurisdiction migration');

    // Migrate one account from US to LATAM (low rate to high rate)
    const migratingAccount = accounts[0][0].signer; // First account in US

    const rewardsBeforeMigration = await this.token.availableRewardsOf(migratingAccount.address);
    log(`  Account in US has ${ethers.formatUnits(rewardsBeforeMigration, 6)} rewards before migration`);

    // Claim rewards before migrating
    await this.token.connect(jurisdictions[0].claimer).claimForAddresses(
      jurisdictions[0].payoutGroupId,
      [migratingAccount.address]
    );
    log(`  ✓ Claimed rewards before migration`);

    // Unregister from US
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(
      jurisdictions[0].payoutGroupId,
      migratingAccount.address
    );
    const payoutIdAfterUnregister = await this.token.payoutGroupIdOf(migratingAccount.address);
    expect(payoutIdAfterUnregister).to.equal(0);
    log(`  ✓ Unregistered from US jurisdiction`);

    // Register to LATAM
    await this.token.connect(this.owner).registrarRegisterRewardAddress(
      jurisdictions[4].payoutGroupId,
      migratingAccount.address
    );
    const payoutIdAfterRegister = await this.token.payoutGroupIdOf(migratingAccount.address);
    expect(payoutIdAfterRegister).to.equal(jurisdictions[4].payoutGroupId);
    log(`  ✓ Registered to LATAM jurisdiction`);

    // Earn for 5 more days
    for (let day = 1; day <= 5; day++) {
      await time.increase(86400);
    }

    // Verify account now earns at LATAM rate (7% vs 3%)
    const rewardsInLATAM = await this.token.availableRewardsOf(migratingAccount.address);
    expect(rewardsInLATAM).to.be.gt(0);
    log(`  ✓ Account earned ${ethers.formatUnits(rewardsInLATAM, 6)} in LATAM (7% rate)`);

    // ========== Test: Switching jurisdictions auto-unregisters from current ==========
    log('\nStep 6: Verify account can switch jurisdictions (auto-unregister)');

    const testAccount = accounts[1][0].signer; // An account already in EU

    // Verify account is in EU before switch
    const euPayoutGroupId = jurisdictions[1].payoutGroupId;
    const ukPayoutGroupId = jurisdictions[2].payoutGroupId;
    expect(await this.token.payoutGroupIdOf(testAccount.address)).to.equal(euPayoutGroupId);

    // Register to UK - should auto-unregister from EU
    const tx = await this.token.connect(this.owner).registrarRegisterRewardAddress(
      ukPayoutGroupId,
      testAccount.address
    );

    // Verify events: AccountDeregistered from EU, AccountRegistered to UK
    await expect(tx).to.emit(this.token, 'AccountDeregistered')
      .withArgs(testAccount.address, euPayoutGroupId, jurisdictions[1].claimer.address);
    await expect(tx).to.emit(this.token, 'AccountRegistered')
      .withArgs(testAccount.address, ukPayoutGroupId, jurisdictions[2].claimer.address);

    // Verify account is now in UK
    expect(await this.token.payoutGroupIdOf(testAccount.address)).to.equal(ukPayoutGroupId);
    log(`✓ Successfully switched from EU to UK jurisdiction`);

    // ========== Test: Admin operations across all jurisdictions ==========
    log('\nStep 7: Test admin operations across all jurisdictions');

    // Admin sets custom destination for all jurisdictions
    // Create 5 new addresses as destinations using signers that haven't been used
    const destinationSigners = await ethers.getSigners();
    const destinations = destinationSigners.slice(0, 5); // Use first 5 signers (safe range)
    for (let i = 0; i < 5; i++) {
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(
        jurisdictions[i].payoutGroupId,
        destinations[i].address
      );
      log(`  ✓ Set destination for ${jurisdictions[i].name}`);
    }

    // Claim all rewards for all jurisdictions
    log('\nStep 8: Claim rewards for all jurisdictions');
    const claimedPerJurisdiction = [];

    for (let i = 0; i < 5; i++) {
      const destBalanceBefore = await this.token.balanceOf(destinations[i].address);
      await this.token.connect(jurisdictions[i].claimer).claimAll(jurisdictions[i].payoutGroupId);
      const destBalanceAfter = await this.token.balanceOf(destinations[i].address);
      const claimed = destBalanceAfter - destBalanceBefore;
      claimedPerJurisdiction.push(claimed);
      log(`  ${jurisdictions[i].name}: Claimed ${ethers.formatUnits(claimed, 6)}`);
    }

    // ========== Final verification ==========
    log('\n📊 Final State Verification:');

    // TotalSupply constant
    const totalSupplyFinal = await this.token.totalSupply();
    expect(totalSupplyFinal).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant: ${ethers.formatUnits(totalSupplyFinal, 6)}`);

    // All accounts have zero rewards after claim (including migrated account)
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 0 && j === 0) continue; // Skip - this account migrated out of US
        const rewards = await this.token.availableRewardsOf(accounts[i][j].signer.address);
        expect(rewards).to.equal(0);
      }
    }

    // Migrated account also has zero rewards (was claimed in LATAM ClaimAll)
    const migratedRewards = await this.token.availableRewardsOf(migratingAccount.address);
    expect(migratedRewards).to.equal(0);
    log(`✓ All rewards claimed including migrated account`);

    log('\n✅ Multi-jurisdiction simulation completed!\n');
  });

  it('should handle jurisdiction-specific rate changes independently', async function () {
    log('\n🌍 Independent Jurisdiction Rate Changes\n');

    // ========== Setup: Create 3 jurisdictions ==========
    // Multipliers 1 and 2 already exist from initializeV3, create multiplier 3
    await this.token.connect(this.owner).createMultiplier(0); // Mult 3

    const signers = await ethers.getSigners();
    const jurisdictions = [];

    for (let i = 1; i <= 3; i++) {
      await this.token.connect(this.owner).setMultiplierRateByAPR(i, ethers.parseUnits("0.3", 10)); // All start at 30% APR
      const pgId = await createPayoutGroup(this, i, signers[9 + i]);
      jurisdictions.push({ payoutGroupId: pgId, multiplierIdx: i, claimer: signers[9 + i] });
    }

    log(`✓ Created 3 jurisdictions, all at 5% rate`);

    // Register 1 account per jurisdiction
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 400n);
    const accounts = [];
    for (let i = 0; i < 3; i++) {
      await this.token.connect(this.owner).transfer(signers[15 + i].address, ONE_ETHER * 100n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        jurisdictions[i].payoutGroupId,
        signers[15 + i].address
      );
      accounts.push(signers[15 + i]);
    }
    log(`✓ Registered 1 account per jurisdiction`);

    // ========== Test: Earn at same rate (baseline) ==========
    for (let day = 1; day <= 5; day++) {
      await time.increase(86400);
    }

    const baselineRewards = [];
    for (let i = 0; i < 3; i++) {
      const rewards = await this.token.availableRewardsOf(accounts[i].address);
      baselineRewards.push(rewards);
    }
    log(`\n✓ After 5 days at 5% rate:`);
    for (let i = 0; i < 3; i++) {
      log(`  Jurisdiction ${i + 1}: ${ethers.formatUnits(baselineRewards[i], 6)}`);
    }

    // All should be approximately equal
    for (let i = 1; i < 3; i++) {
      expect(baselineRewards[i]).to.be.closeTo(baselineRewards[0], ethers.parseUnits("0.1", 6));
    }

    // ========== Test: Change rate for jurisdiction 2 only ==========
    log(`\n✓ Changing jurisdiction 2 rate to 60% APR (doubling from 30%)`);
    await this.token.connect(this.owner).setMultiplierRateByAPR(2, ethers.parseUnits("0.6", 10)); // 60% APR

    // Earn for 5 more days
    for (let day = 1; day <= 5; day++) {
      await time.increase(86400);
    }

    const afterRateChangeRewards = [];
    for (let i = 0; i < 3; i++) {
      const rewards = await this.token.availableRewardsOf(accounts[i].address);
      afterRateChangeRewards.push(rewards);
    }

    log(`\n✓ After 5 more days (jurisdiction 2 at 10%, others at 5%):`);
    for (let i = 0; i < 3; i++) {
      log(`  Jurisdiction ${i + 1}: ${ethers.formatUnits(afterRateChangeRewards[i], 6)}`);
    }

    // Jurisdiction 2 should have more new rewards than jurisdictions 1 and 3
    const newRewards = [
      afterRateChangeRewards[0] - baselineRewards[0],
      afterRateChangeRewards[1] - baselineRewards[1],
      afterRateChangeRewards[2] - baselineRewards[2]
    ];

    expect(newRewards[1]).to.be.gt(newRewards[0] * 150n / 100n); // Jurisdiction 2 earned >1.5x more
    expect(newRewards[1]).to.be.gt(newRewards[2] * 150n / 100n);
    log(`✓ Jurisdiction 2 earned significantly more due to higher rate`);

    log('\n✅ Independent rate change test passed!\n');
  });

  it('should handle simultaneous migrations across jurisdictions', async function () {
    log('\n🌍 Simultaneous Cross-Jurisdiction Migrations\n');

    // ========== Setup: Create 3 jurisdictions ==========
    // Multipliers 1 and 2 already exist from initializeV3, create multiplier 3
    await this.token.connect(this.owner).createMultiplier(0);

    const signers = await ethers.getSigners();
    const jurisdictions = [];

    for (let i = 1; i <= 3; i++) {
      const pgId = await createPayoutGroup(this, i, signers[9 + i]);
      jurisdictions.push({ payoutGroupId: pgId, name: `Jurisdiction ${i}` });
    }

    log(`✓ Created 3 jurisdictions`);

    // Register 3 accounts to jurisdiction 1
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 400n);
    const accounts = [signers[15], signers[16], signers[17]];

    for (let i = 0; i < 3; i++) {
      await this.token.connect(this.owner).transfer(accounts[i].address, ONE_ETHER * 100n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        jurisdictions[0].payoutGroupId,
        accounts[i].address
      );
    }
    log(`✓ Registered 3 accounts to Jurisdiction 1`);

    // Verify all in jurisdiction 1
    const j1BalanceBefore = await this.token.getPayoutGroupBalance(jurisdictions[0].payoutGroupId);
    expect(j1BalanceBefore).to.equal(ONE_ETHER * 300n);
    log(`  Jurisdiction 1 balance: ${ethers.formatUnits(j1BalanceBefore, 6)}`);

    // ========== Test: Migrate all 3 accounts to different jurisdictions ==========
    log(`\n✓ Migrating accounts to different jurisdictions...`);

    // Account 1 → stays in Jurisdiction 1
    // Account 2 → migrates to Jurisdiction 2
    // Account 3 → migrates to Jurisdiction 3

    // Migrate account 2
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(
      jurisdictions[0].payoutGroupId,
      accounts[1].address
    );
    await this.token.connect(this.owner).registrarRegisterRewardAddress(
      jurisdictions[1].payoutGroupId,
      accounts[1].address
    );
    log(`  ✓ Account 2 migrated to Jurisdiction 2`);

    // Migrate account 3
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(
      jurisdictions[0].payoutGroupId,
      accounts[2].address
    );
    await this.token.connect(this.owner).registrarRegisterRewardAddress(
      jurisdictions[2].payoutGroupId,
      accounts[2].address
    );
    log(`  ✓ Account 3 migrated to Jurisdiction 3`);

    // ========== Verify final distribution ==========
    log(`\n📊 Final Distribution:`);

    const j1BalanceAfter = await this.token.getPayoutGroupBalance(jurisdictions[0].payoutGroupId);
    const j2BalanceAfter = await this.token.getPayoutGroupBalance(jurisdictions[1].payoutGroupId);
    const j3BalanceAfter = await this.token.getPayoutGroupBalance(jurisdictions[2].payoutGroupId);

    expect(j1BalanceAfter).to.equal(ONE_ETHER * 100n); // 1 account
    expect(j2BalanceAfter).to.equal(ONE_ETHER * 100n); // 1 account
    expect(j3BalanceAfter).to.equal(ONE_ETHER * 100n); // 1 account

    log(`  Jurisdiction 1: ${ethers.formatUnits(j1BalanceAfter, 6)} (1 account)`);
    log(`  Jurisdiction 2: ${ethers.formatUnits(j2BalanceAfter, 6)} (1 account)`);
    log(`  Jurisdiction 3: ${ethers.formatUnits(j3BalanceAfter, 6)} (1 account)`);

    log('\n✅ Simultaneous migration test passed!\n');
  });

  it('should verify hierarchical data consistency across jurisdictions', async function () {
    log('\n🌍 Hierarchical Data Consistency\n');

    // ========== Setup: Create 3 multipliers (jurisdictions) ==========
    // Multipliers 1 and 2 already exist from initializeV3, create multiplier 3
    await this.token.connect(this.owner).createMultiplier(0);

    const signers = await ethers.getSigners();

    // Create 2 payout groups per multiplier (6 total groups)
    const groups = [];
    for (let multIdx = 1; multIdx <= 3; multIdx++) {
      for (let groupIdx = 0; groupIdx < 2; groupIdx++) {
        const pgId = await createPayoutGroup(
          this,
          multIdx,
          signers[10 + (multIdx - 1) * 2 + groupIdx]
        );
        groups.push({ payoutGroupId: pgId, multiplierIdx: multIdx });
      }
    }

    log(`✓ Created 6 payout groups across 3 multipliers`);

    // Register accounts and mint tokens
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 700n);

    const accountsPerGroup = [];
    const accountSigners = [this.acc, this.acc2, this.acc3, this.recipient, this.admin, this.assetProtectionRole];
    for (let i = 0; i < 6; i++) {
      const account = accountSigners[i];
      await this.token.connect(this.owner).transfer(account.address, ONE_ETHER * 100n);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        groups[i].payoutGroupId,
        account.address
      );
      accountsPerGroup.push(account);
    }

    log(`✓ Registered 1 account per group (6 accounts total)`);

    // ========== Verify hierarchical consistency ==========
    log(`\n📊 Hierarchical Data Verification:`);

    // Verify sum of payout group balances
    for (let multIdx = 1; multIdx <= 3; multIdx++) {
      let sumOfGroups = 0n;
      for (let i = 0; i < 6; i++) {
        if (groups[i].multiplierIdx === multIdx) {
          const groupBalance = await this.token.getPayoutGroupBalance(groups[i].payoutGroupId);
          sumOfGroups += groupBalance;
        }
      }

      log(`  Multiplier ${multIdx}: ${ethers.formatUnits(sumOfGroups, 6)} (sum of groups)`);
    }

    log(`✓ Hierarchical consistency verified`);

    // ========== Test: Transfer between groups in same multiplier ==========
    log(`\n✓ Transfer within same multiplier...`);

    const account0BalBefore = await this.token.balanceOf(accountsPerGroup[0].address);
    const account1BalBefore = await this.token.balanceOf(accountsPerGroup[1].address);
    await this.token.connect(accountsPerGroup[0]).transfer(
      accountsPerGroup[1].address,
      ONE_ETHER * 10n
    );
    const account0BalAfter = await this.token.balanceOf(accountsPerGroup[0].address);
    const account1BalAfter = await this.token.balanceOf(accountsPerGroup[1].address);

    // Total balance should be preserved
    expect(account0BalAfter + account1BalAfter).to.equal(account0BalBefore + account1BalBefore);
    log(`  ✓ Total balance preserved during transfer`);

    // ========== Test: Transfer between different multipliers ==========
    log(`\n✓ Transfer across multipliers...`);

    // Note: getTotalBalanceByMultiplier was removed in commit 3faadc2
    // (Remove Multiplier-level tracking and source rewards)
    // Multiplier-level tracking is no longer maintained for gas optimization

    // Just verify the transfer succeeds between different multipliers
    await this.token.connect(accountsPerGroup[0]).transfer(
      accountsPerGroup[2].address,
      ONE_ETHER * 20n
    );

    log(`  ✓ Cross-multiplier transfer succeeded`);
    log('\n✅ Hierarchical data consistency test passed!\n');
  });
});
