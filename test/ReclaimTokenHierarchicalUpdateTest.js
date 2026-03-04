const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { UINT40_MAX } = require('./helpers/testSetup');

/**
 * Test that reclaimToken properly updates payout group balances
 *
 * This test would FAIL with the old broken code that used _setBalance()
 * but PASSES with the fixed code that uses _transfer()
 *
 * Background: reclaimToken transfers tokens from the contract address back to the owner.
 * With the old implementation using _setBalance(), payout group balances would NOT be updated.
 * With the new implementation using _transfer(), payout group balances ARE properly updated.
 */
describe('ReclaimToken Hierarchical Updates', function () {

  it('Should update payout group balance when reclaiming tokens from contract', async function () {
    const { token, owner, acc } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

    // Set up rate bounds and create multiplier 1
    await token.connect(owner).setRateBoundsByAPR(0, UINT40_MAX);
    await token.connect(owner).createMultiplier(0);

    const multiplierId = 1;

    // Create payout group with acc as claimer
    await token.connect(owner).createPayoutGroup(multiplierId, acc.address);
    const payoutGroupId = 1;

    // Give acc some tokens and register acc to payout group
    const additionalTokens = ethers.parseUnits("10000", 6); // 10K tokens
    await token.connect(owner).increaseSupply(additionalTokens);
    await token.connect(owner).transfer(acc.address, additionalTokens);
    await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, acc.address);

    // Transfer tokens from acc to contract (this updates payout group properly)
    const contractAddress = await token.getAddress();
    const amountToContract = ethers.parseUnits("3000", 6); // 3K tokens
    await token.connect(acc).transfer(contractAddress, amountToContract);

    const accBalanceAfterTransfer = await token.balanceOf(acc.address);
    const contractBalanceAfterTransfer = await token.balanceOf(contractAddress);
    const payoutBalanceAfterTransfer = await token.getPayoutGroupBalance(payoutGroupId);

    // Verify state before reclaim
    // Note: Acc has 10K from increaseSupplyToAddress
    const initialAccBalance = ethers.parseUnits("10000", 6);
    expect(accBalanceAfterTransfer).to.equal(initialAccBalance - amountToContract, 'Acc should have sent 3000 tokens to contract');
    expect(contractBalanceAfterTransfer).to.equal(amountToContract, 'Contract should have 3000 tokens');
    expect(payoutBalanceAfterTransfer).to.equal(initialAccBalance - amountToContract, 'Payout group should track acc balance');

    // Reclaim tokens
    await token.reclaimToken();

    const accBalanceFinal = await token.balanceOf(acc.address);
    const ownerBalanceFinal = await token.balanceOf(owner.address);
    const contractBalanceFinal = await token.balanceOf(contractAddress);
    const payoutBalanceFinal = await token.getPayoutGroupBalance(payoutGroupId);

    // Verify balances moved correctly
    // Contract tokens should go back to owner (default admin), not to acc
    expect(contractBalanceFinal).to.equal(0n, 'Contract should have 0 balance after reclaim');
    expect(accBalanceFinal).to.equal(initialAccBalance - amountToContract, 'Acc balance should remain unchanged');
    expect(payoutBalanceFinal).to.equal(initialAccBalance - amountToContract, 'Payout group should still track acc balance');
  });
});
