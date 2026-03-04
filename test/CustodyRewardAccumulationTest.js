const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

// Helper for conditional logging based on TEST_VERBOSE environment variable
const log = process.env.TEST_VERBOSE ? console.log.bind(console) : () => {};

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Custody Reward Accumulation Tests', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    // Initialize multiplier 0 for all tests
    await this.token.connect(this.owner).setMaturityPeriod(86400);
        await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing
  });


  it('Should keep custody balance separate from reward aggregation', async function () {
    // Test that balance stays on custody address, only rewards aggregate at payout level
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 2n);
    
    log(`\n🏦 BALANCE vs REWARD SEPARATION TEST`);
    log(`===================================`);
    
    // Check initial balances before payout setup
    const initialCustodyBalance = await this.token.balanceOf(this.acc.address);
    log(`Initial custody balance: ${ethers.formatEther(initialCustodyBalance)} ETH`);
    expect(initialCustodyBalance).to.equal(ONE_ETHER * 2n);

    // Set up payoutGroup
    await setupMultiplierWithBounds(this);
    const payoutGroupId = await createPayoutGroup(this, 1, this.acc2);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);
    
    // Verify custody balance is preserved
    const afterSetupCustodyBalance = await this.token.balanceOf(this.acc.address);
    const afterSetupPayoutBalance = await this.token.balanceOf(this.acc2.address);
    
    log(`After payout group setup:`);
    log(`  Account balance: ${ethers.formatEther(afterSetupCustodyBalance)} ETH`);
    log(`  Claimer balance: ${ethers.formatEther(afterSetupPayoutBalance)} ETH`);
    
    expect(afterSetupCustodyBalance).to.equal(ONE_ETHER * 2n); // ✅ Balance stays on account
    expect(afterSetupPayoutBalance).to.equal(0); // ✅ Claimer has no individual balance
    
    // Test custody can still transfer its balance
    await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER);
    
    const finalCustodyBalance = await this.token.balanceOf(this.acc.address);
    const finalPayoutBalance = await this.token.balanceOf(this.acc2.address);
    
    log(`After transfer:`);
    log(`  Account balance: ${ethers.formatEther(finalCustodyBalance)} ETH`);
    log(`  Claimer balance: ${ethers.formatEther(finalPayoutBalance)} ETH`);
    
    expect(finalCustodyBalance).to.equal(ONE_ETHER); // Reduced by transfer
    expect(finalPayoutBalance).to.equal(ONE_ETHER); // Received the transfer
    
    log(`✅ Account retains control of its balance`);
  });

});