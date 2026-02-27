const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');

describe('Self-Transfer Fix Verification', function () {

  describe('Self-transfer protection', function () {

    it('Should handle self-transfer as a no-op (no balance change)', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      const balanceBefore = await token.balanceOf(owner.address);
      const supplyBefore = await token.totalSupply();

      // Self-transfer
      await token.transfer(owner.address, 500);

      const balanceAfter = await token.balanceOf(owner.address);
      const supplyAfter = await token.totalSupply();

      // Verify no tokens were created
      expect(balanceAfter).to.equal(balanceBefore, 'Balance should remain unchanged');
      expect(supplyAfter).to.equal(supplyBefore, 'Total supply should remain unchanged');
    });

    it('Should emit Transfer event for self-transfer', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      // Verify Transfer event is emitted
      await expect(token.transfer(owner.address, 500))
        .to.emit(token, 'Transfer')
        .withArgs(owner.address, owner.address, 500);
    });

    it('Should handle repeated self-transfers without creating tokens', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      const initialBalance = await token.balanceOf(owner.address);

      // Multiple self-transfers
      for (let i = 0; i < 10; i++) {
        await token.transfer(owner.address, 100);
      }

      const finalBalance = await token.balanceOf(owner.address);

      expect(finalBalance).to.equal(initialBalance, 'Balance should remain unchanged after multiple self-transfers');
    });

    it('Should handle self-transferFrom as a no-op', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      // Approve self
      await token.approve(owner.address, 5000);

      const balanceBefore = await token.balanceOf(owner.address);

      // Self-transferFrom
      await token.transferFrom(owner.address, owner.address, 500);

      const balanceAfter = await token.balanceOf(owner.address);

      expect(balanceAfter).to.equal(balanceBefore, 'Balance should remain unchanged for self-transferFrom');
    });

    it('Should handle zero-value self-transfer', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      const balanceBefore = await token.balanceOf(owner.address);

      // Zero-value self-transfer
      await token.transfer(owner.address, 0);

      const balanceAfter = await token.balanceOf(owner.address);

      expect(balanceAfter).to.equal(balanceBefore);
    });

    it('Should not affect normal transfers between different addresses', async function () {
      const { token, owner, recipient } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      const ownerBefore = await token.balanceOf(owner.address);
      const recipientBefore = await token.balanceOf(recipient.address);

      // Normal transfer
      await token.transfer(recipient.address, 500);

      const ownerAfter = await token.balanceOf(owner.address);
      const recipientAfter = await token.balanceOf(recipient.address);

      expect(ownerAfter).to.equal(ownerBefore - 500n);
      expect(recipientAfter).to.equal(recipientBefore + 500n);
    });

    it('Should revert self-transfer with insufficient balance', async function () {
      const { token, owner } = await loadFixture(deployPaxosTokenClaimableRewardsFixture);

      await token.increaseSupplyToAddress(1000, owner.address);

      const balance = await token.balanceOf(owner.address);

      // Attempt self-transfer with amount exceeding balance
      await expect(token.transfer(owner.address, balance + 1n))
        .to.be.revertedWithCustomError(token, 'InsufficientFunds');

      // Verify balance unchanged
      expect(await token.balanceOf(owner.address)).to.equal(balance);
    });
  });
});
