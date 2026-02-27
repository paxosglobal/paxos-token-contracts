const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? log.bind(console) : () => {};

/**
 * Complete Lifecycle Test: Single Payout Group
 *
 * This test suite covers the complete end-to-end lifecycle of a single payout group:
 * 1. Create multiplier (verify initial state)
 * 2. Create payout group with claimer
 * 3. Register multiple accounts to the group
 * 4. Mint tokens to the accounts
 * 5. Set reward rate and advance time (earn)
 * 6. Verify rewards accrued using shares model
 * 7. Execute claimAll
 * 8. Verify balances and state after claim
 * 9. Unregister all accounts
 * 10. Delete payout group
 * 11. Verify complete cleanup
 */
describe('Complete Lifecycle: Single Payout Group', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Configure multiplier settings
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing range
  });

  it('should complete full lifecycle: create → register → mint → earn → claim → unregister → delete', async function () {
    log('\n🔄 Complete Lifecycle Test: Single Payout Group\n');

    // ========== Step 1: Create multiplier and verify it exists ==========
    log('Step 1: Create and verify multiplier');
    await setupMultiplierWithBounds(this);
    const mult1 = await this.token['getActiveMultiplier'](1);
    expect(mult1).to.equal(ethers.parseUnits("1", 12)); // Should be 1.0
    log(`✓ Multiplier 1: ${ethers.formatUnits(mult1, 12)}`);

    // ========== Step 2: Create payout group with claimer ==========
    log('\nStep 2: Create payout group');
    const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

    expect(payoutGroupId).to.equal(1);
    log(`✓ Created payout group ${payoutGroupId} with claimer ${this.acc.address.slice(0, 10)}...`);

    // Set destination for claims
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.recipient.address);
    log(`✓ Set destination to ${this.recipient.address.slice(0, 10)}...`);

    // ========== Step 3: Register 3 accounts to the group ==========
    log('\nStep 3: Register accounts');
    const signers = await ethers.getSigners();
    const accounts = [this.acc2, this.acc3, signers[7]]; // Use additional signer

    for (let i = 0; i < accounts.length; i++) {
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[i].address);
      log(`✓ Registered ${accounts[i].address.slice(0, 10)}... to group ${payoutGroupId}`);
    }

    // ========== Step 4: Mint tokens to the accounts ==========
    log('\nStep 4: Mint tokens');
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 100n);

    const mintAmounts = [ONE_ETHER * 10n, ONE_ETHER * 20n, ONE_ETHER * 30n];
    for (let i = 0; i < accounts.length; i++) {
      await this.token.connect(this.owner).transfer(accounts[i].address, mintAmounts[i]);
      log(`✓ Minted ${ethers.formatUnits(mintAmounts[i], 6)} tokens to ${accounts[i].address.slice(0, 10)}...`);
    }

    // Record initial state
    const totalSupplyInitial = await this.token.totalSupply();
    const sourceBalanceInitial = await this.token.balanceOf(await this.token.getClaimSource());
    log(`\n📊 Initial State:`);
    log(`  Total Supply: ${ethers.formatUnits(totalSupplyInitial, 6)}`);
    log(`  Source Balance: ${ethers.formatUnits(sourceBalanceInitial, 6)}`);

    // ========== Step 5: Set reward rate and advance time (earn) ==========
    log('\nStep 5: Set reward rate and earn');
    const futureTime = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
    await time.increase(3601);

    log(`✓ Advanced time past earn event`);
    const newMult = await this.token['getActiveMultiplier'](1);
    log(`✓ New multiplier: ${ethers.formatUnits(newMult, 12)}`);

    // ========== Step 6: Verify rewards accrued using shares model ==========
    log('\nStep 6: Verify rewards accrued');

    // Compute total rewards by summing individual account rewards
    let totalAvailableRewards = 0n;
    for (let i = 0; i < accounts.length; i++) {
      const accountRewards = await this.token.availableRewardsOf(accounts[i].address);
      totalAvailableRewards += accountRewards;
      expect(accountRewards).to.be.gt(0);
      log(`  Account ${accounts[i].address.slice(0, 10)}... rewards: ${ethers.formatUnits(accountRewards, 6)}`);
    }

    expect(totalAvailableRewards).to.be.gt(0);
    log(`✓ Total available rewards (computed): ${ethers.formatUnits(totalAvailableRewards, 6)}`);

    // Verify totalSupply hasn't changed (earn doesn't mint)
    const totalSupplyAfterEarn = await this.token.totalSupply();
    expect(totalSupplyAfterEarn).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply unchanged: ${ethers.formatUnits(totalSupplyAfterEarn, 6)}`);

    // ========== Step 7: Execute claimAll ==========
    log('\nStep 7: Execute claimAll');
    const destinationBalanceBefore = await this.token.balanceOf(this.recipient.address);

    await expect(
      this.token.connect(this.acc).claimAll(payoutGroupId)
    ).to.emit(this.token, 'ClaimAllExecuted');

    const destinationBalanceAfter = await this.token.balanceOf(this.recipient.address);
    const rewardsClaimed = destinationBalanceAfter - destinationBalanceBefore;
    log(`✓ Claimed ${ethers.formatUnits(rewardsClaimed, 6)} tokens to destination`);

    // ========== Step 8: Verify balances and state after claim ==========
    log('\nStep 8: Verify state after claim');
    const totalSupplyAfterClaim = await this.token.totalSupply();
    expect(totalSupplyAfterClaim).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply still unchanged: ${ethers.formatUnits(totalSupplyAfterClaim, 6)}`);

    // Verify all rewards claimed
    for (let i = 0; i < accounts.length; i++) {
      const accountRewards = await this.token.availableRewardsOf(accounts[i].address);
      expect(accountRewards).to.equal(0);
    }
    log(`✓ All account rewards claimed (now 0)`);

    // Verify source balance decreased
    const sourceBalanceAfterClaim = await this.token.balanceOf(await this.token.getClaimSource());
    expect(sourceBalanceAfterClaim).to.be.lt(sourceBalanceInitial);
    log(`✓ Source balance decreased: ${ethers.formatUnits(sourceBalanceAfterClaim, 6)}`);

    // ========== Step 9: Unregister all accounts ==========
    log('\nStep 9: Unregister all accounts');
    for (let i = 0; i < accounts.length; i++) {
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, accounts[i].address);
      const payoutId = await this.token.payoutGroupIdOf(accounts[i].address);
      expect(payoutId).to.equal(0);
      log(`✓ Unregistered ${accounts[i].address.slice(0, 10)}... (payoutGroupId now 0)`);
    }

    // Verify payout group balance is now zero
    const groupBalance = await this.token.getPayoutGroupBalance(payoutGroupId);
    expect(groupBalance).to.equal(0);
    log(`✓ Payout group balance: ${ethers.formatUnits(groupBalance, 6)}`);

    // ========== Step 10: Delete payout group ==========
    log('\nStep 10: Delete payout group');
    await expect(
      this.token.connect(this.owner).deletePayoutGroup(payoutGroupId)
    ).to.emit(this.token, 'PayoutGroupDeleted')
      .withArgs(payoutGroupId, this.acc.address);
    log(`✓ Deleted payout group ${payoutGroupId}`);

    // ========== Step 11: Verify complete cleanup ==========
    log('\nStep 11: Verify complete cleanup');

    // Payout group data cleared
    const claimer = await this.token.getPayoutGroupClaimer(payoutGroupId);
    expect(claimer).to.equal(ethers.ZeroAddress);
    log(`✓ Payout group data cleared`);

    // TotalSupply still constant
    const totalSupplyFinal = await this.token.totalSupply();
    expect(totalSupplyFinal).to.equal(totalSupplyInitial);
    log(`✓ TotalSupply constant throughout: ${ethers.formatUnits(totalSupplyFinal, 6)}`);

    // Payout group ID not reused
    await setupMultiplierWithBounds(this);
    const newPayoutGroupId = await createPayoutGroup(this, 1, this.acc2);
    expect(newPayoutGroupId).to.equal(2); // Should be 2, not reusing 1
    log(`✓ New payout group ID: ${newPayoutGroupId} (not reusing ${payoutGroupId})`);

    log('\n✅ Complete lifecycle test passed!\n');
  });

  it('should verify invariants at each lifecycle stage', async function () {
    // Helper to take snapshot
    const takeSnapshot = async (accounts = []) => {
      // Compute total rewards from registered accounts
      let totalAvailableRewards = 0n;
      for (const account of accounts) {
        totalAvailableRewards += await this.token.availableRewardsOf(account);
      }
      return {
        totalSupply: await this.token.totalSupply(),
        totalAvailableRewards,
        sourceBalance: await this.token.balanceOf(await this.token.getClaimSource())
      };
    };

    const snapshots = [];

    // Initial state
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 50n);
    snapshots.push({ stage: 'initial', data: await takeSnapshot([]) });

    // Create payout group
    await setupMultiplierWithBounds(this);
    const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
    snapshots.push({ stage: 'created group', data: await takeSnapshot([]) });

    // Register account
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 10n);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);
    snapshots.push({ stage: 'registered', data: await takeSnapshot([this.acc2.address]) });

    // Earn
    const futureTime = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
    await time.increase(3601);
    snapshots.push({ stage: 'earned', data: await takeSnapshot([this.acc2.address]) });

    // Claim
    await this.token.connect(this.acc).claimAll(payoutGroupId);
    snapshots.push({ stage: 'claimed', data: await takeSnapshot([this.acc2.address]) });

    // Unregister
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc2.address);
    snapshots.push({ stage: 'unregistered', data: await takeSnapshot([]) });

    // Delete
    await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);
    snapshots.push({ stage: 'deleted', data: await takeSnapshot([]) });

    // Verify totalSupply constant at all stages
    const initialSupply = snapshots[0].data.totalSupply;
    for (let i = 0; i < snapshots.length; i++) {
      expect(snapshots[i].data.totalSupply).to.equal(initialSupply,
        `TotalSupply changed at stage: ${snapshots[i].stage}`);
    }

    log('\n📊 Lifecycle Snapshots:');
    for (const snapshot of snapshots) {
      log(`${snapshot.stage.padEnd(20)} - Supply: ${ethers.formatUnits(snapshot.data.totalSupply, 6)}, Available: ${ethers.formatUnits(snapshot.data.totalAvailableRewards, 6)}`);
    }

    log('\n✅ All invariants maintained throughout lifecycle!\n');
  });
});
