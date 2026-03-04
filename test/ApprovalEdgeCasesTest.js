const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Approval Edge Cases Test', function () {

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
  });

  describe('increaseApproval with frozen addresses', function () {
    it('should revert when spender is frozen', async function () {
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.owner).increaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when owner is frozen', async function () {
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);

      await expect(
        this.token.connect(this.owner).increaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when both owner and spender are frozen', async function () {
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.owner).increaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when increasing by zero', async function () {
      await expect(
        this.token.connect(this.owner).increaseApproval(this.acc.address, 0)
      ).to.be.revertedWithCustomError(this.token, 'ZeroValue');
    });

    it('should work when neither is frozen', async function () {
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);

      await expect(this.token.connect(this.owner).increaseApproval(this.acc.address, ONE_ETHER))
        .to.emit(this.token, 'Approval')
        .withArgs(this.owner.address, this.acc.address, ONE_ETHER * 2n);
    });
  });

  describe('decreaseApproval with frozen addresses', function () {
    beforeEach(async function () {
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER * 3n);
    });

    it('should revert when spender is frozen', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when owner is frozen', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);

      await expect(
        this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when both owner and spender are frozen', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.owner.address);
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when decreasing by zero', async function () {
      await expect(
        this.token.connect(this.owner).decreaseApproval(this.acc.address, 0)
      ).to.be.revertedWithCustomError(this.token, 'ZeroValue');
    });

    it('should set allowance to zero when subtracting more than current allowance', async function () {
      await this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER * 10n);

      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(0);
    });

    it('should work when neither is frozen', async function () {
      await expect(this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER))
        .to.emit(this.token, 'Approval')
        .withArgs(this.owner.address, this.acc.address, ONE_ETHER * 2n);
    });
  });

  describe('wipeFrozenAddress', function () {
    beforeEach(async function () {
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 2n);
    });

    it('should revert when address is not frozen', async function () {
      await expect(
        this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressNotFrozen');
    });

    it('should wipe frozen address balance', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      const balanceBefore = await this.token.balanceOf(this.acc.address);
      expect(balanceBefore).to.equal(ONE_ETHER * 2n);

      await this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address);

      const balanceAfter = await this.token.balanceOf(this.acc.address);
      expect(balanceAfter).to.equal(0);
    });

    it('should decrease total supply when wiping', async function () {
      const totalSupplyBefore = await this.token.totalSupply();
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address);

      const totalSupplyAfter = await this.token.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore - (ONE_ETHER * 2n));
    });

    it('should emit FrozenAddressWiped event', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address))
        .to.emit(this.token, 'FrozenAddressWiped')
        .withArgs(this.acc.address);
    });

    it('should emit SupplyDecreased event', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      const balance = await this.token.balanceOf(this.acc.address);

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address))
        .to.emit(this.token, 'SupplyDecreased')
        .withArgs(this.acc.address, balance);
    });

    it('should emit Transfer event to zero address', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      const balance = await this.token.balanceOf(this.acc.address);

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address))
        .to.emit(this.token, 'Transfer')
        .withArgs(this.acc.address, ethers.ZeroAddress, balance);
    });

    it('should only be callable by asset protection role', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(
        this.token.connect(this.acc2).wipeFrozenAddress(this.acc.address)
      ).to.be.reverted;
    });

    it('should work with payout group registered address', async function () {
      // Create multiplier with bounds, then payout group, and register acc
      await setupMultiplierWithBounds(this);  // Creates multiplier ID 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Freeze and wipe
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      await this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address);

      const balance = await this.token.balanceOf(this.acc.address);
      expect(balance).to.equal(0);
    });

    it('should handle wiping address with zero balance', async function () {
      // Transfer tokens away first
      await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER * 2n);
      const balance = await this.token.balanceOf(this.acc.address);
      expect(balance).to.equal(0);

      // Freeze and wipe
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc.address))
        .to.emit(this.token, 'FrozenAddressWiped')
        .withArgs(this.acc.address);
    });
  });
});
