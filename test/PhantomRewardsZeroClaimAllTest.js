/**
 * Reproduction test for: Zero-reward early return in _executeClaimAll creates phantom wallet rewards
 *
 * When adminSetPayoutGroupMultiplier() calls _executeClaimAll() and group rewards are zero,
 * the function exits early without advancing lastClaimAllTime. The multiplier switch then
 * recalculates group-level shares under the new multiplier, but wallets updated after the
 * previous checkpoint keep stale shares from the old multiplier. This causes
 * availableRewardsOf(account) > 0 while getPayoutGroupAvailableRewards(group) == 0.
 * A claimer can extract those phantom rewards from the claim source.
 */
const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_TOKEN = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

describe('Phantom rewards via zero-reward _executeClaimAll early return', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10));
  });

  it('wallet reports positive rewards while group reports zero after multiplier switch through zero-reward path', async function () {
    // Step 1: Create two multipliers — mult1 will grow, mult2 starts higher
    const multiplier1Id = await setupMultiplierWithBounds(this);
    const multiplier2Id = await setupMultiplierWithBounds(this);

    // Step 2: Create payout group on mult1 with acc as claimer, acc3 as destination
    const payoutGroupId = await createPayoutGroup(this, multiplier1Id, this.acc);
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

    // Step 3: Fund and register acc2 in the payout group
    const startingBalance = ONE_TOKEN * 1000n;
    await this.token.connect(this.owner).increaseSupply(startingBalance * 2n);
    await this.token.connect(this.owner).transfer(this.acc2.address, startingBalance);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

    // Step 4: Grow mult1 so rewards accrue, then grow mult2 to a higher value
    // Grow mult2 to 1.10 (higher value for the switch)
    const mult2Future = (await time.latest()) + 86400 * 40;
    await setNextMultiplier(this.token, this.owner, Number(multiplier2Id), ethers.parseUnits("1.10", 12), mult2Future);
    const mult2Value = await this.token.getActiveMultiplier(multiplier2Id);
    expect(mult2Value).to.be.gt(ethers.parseUnits("1.09", 12));

    // Grow mult1 slightly so acc2 has rewards
    const mult1Future = (await time.latest()) + 86400 * 5;
    await setNextMultiplier(this.token, this.owner, Number(multiplier1Id), ethers.parseUnits("1.01", 12), mult1Future);
    expect(await this.token.availableRewardsOf(this.acc2.address)).to.be.gt(0n);

    // Step 5: ClaimAll to establish the checkpoint (lastClaimAllTime = now)
    await this.token.connect(this.acc).claimAll(payoutGroupId);
    expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0n);
    expect(await this.token.getPayoutGroupAvailableRewards(payoutGroupId)).to.equal(0n);

    // Step 6: Stop mult1 growth and trigger a wallet update (transfer) so walletLastUpdate > lastClaimAllTime
    await this.token.connect(this.owner).setMultiplierRateByAPR(multiplier1Id, 0);
    await time.increase(1);
    // Small transfer updates acc2's wallet timestamp
    await this.token.connect(this.acc2).transfer(this.owner.address, 1n);

    // Verify: still zero rewards for both wallet and group
    expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0n);
    expect(await this.token.getPayoutGroupAvailableRewards(payoutGroupId)).to.equal(0n);

    // Step 7: Switch to higher-valued mult2.
    // _executeClaimAll will see groupRewards == 0 and return early WITHOUT updating lastClaimAllTime.
    // adminSetPayoutGroupMultiplier then recalculates group shares with the new multiplier,
    // but wallet shares remain stale (computed under old mult1).
    await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, multiplier2Id);

    // THE BUG: wallet reports positive rewards, group reports zero
    const walletRewards = await this.token.availableRewardsOf(this.acc2.address);
    const groupRewards = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);

    expect(walletRewards).to.be.gt(0n, "wallet should see phantom rewards from stale shares");
    expect(groupRewards).to.equal(0n, "group should report zero (shares rebased to new multiplier)");

    // Step 8: The phantom rewards are actually claimable — funds extracted from claim source
    const destinationBefore = await this.token.balanceOf(this.acc3.address);
    await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
    const destinationAfter = await this.token.balanceOf(this.acc3.address);

    expect(destinationAfter - destinationBefore).to.equal(walletRewards, "phantom rewards paid out from claim source");
    expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0n, "wallet rewards zeroed after claim");
  });

  it('reproduces on a fresh payout group that never had a claimAll', async function () {
    // This is the simplest case: no prior claimAll needed at all.
    // Fresh groups have lastClaimAllTime = 0, so ANY wallet registration
    // sets walletLastUpdate > lastClaimAllTime, triggering the stale-shares path.

    // Create mult1 (base 1.0) and mult2 (grown to 1.10)
    const multiplier1Id = await setupMultiplierWithBounds(this);
    const multiplier2Id = await setupMultiplierWithBounds(this);

    // Grow mult2 to a higher value
    const mult2Future = (await time.latest()) + 86400 * 40;
    await setNextMultiplier(this.token, this.owner, Number(multiplier2Id), ethers.parseUnits("1.10", 12), mult2Future);

    // Create a fresh payout group on mult1 — lastClaimAllTime = 0
    const payoutGroupId = await createPayoutGroup(this, multiplier1Id, this.acc);
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc3.address);

    // Fund and register a wallet — walletLastUpdate = block.timestamp >> 0
    await this.token.connect(this.owner).increaseSupply(ONE_TOKEN * 2000n);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_TOKEN * 1000n);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

    // Confirm: zero rewards before the switch (no multiplier growth on mult1)
    expect(await this.token.availableRewardsOf(this.acc2.address)).to.equal(0n);
    expect(await this.token.getPayoutGroupAvailableRewards(payoutGroupId)).to.equal(0n);

    // Switch to higher-valued mult2 — _executeClaimAll returns early, lastClaimAllTime stays 0
    await this.token.connect(this.owner).adminSetPayoutGroupMultiplier(payoutGroupId, multiplier2Id);

    // THE BUG: wallet sees phantom rewards, group sees zero
    const walletRewards = await this.token.availableRewardsOf(this.acc2.address);
    const groupRewards = await this.token.getPayoutGroupAvailableRewards(payoutGroupId);

    expect(walletRewards).to.be.gt(0n, "wallet sees phantom rewards from stale shares");
    expect(groupRewards).to.equal(0n, "group reports zero (shares rebased to new multiplier)");

    // Phantom rewards are claimable
    const destinationBefore = await this.token.balanceOf(this.acc3.address);
    await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);
    const destinationAfter = await this.token.balanceOf(this.acc3.address);

    expect(destinationAfter - destinationBefore).to.equal(walletRewards, "phantom rewards paid out from claim source");
  });
});
