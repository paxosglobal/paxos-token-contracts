const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Admin Functions Test', function () {

  describe('reclaimToken', function () {
    beforeEach(async function () {
      Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
      await grantAllTestRoles(this.token, this.owner, this.owner.address);

      // Setup: Create tokens and transfer some to the contract itself
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      const contractAddress = await this.token.getAddress();
      await this.token.connect(this.owner).transfer(contractAddress, ONE_ETHER);
    });

    it('should allow owner to reclaim tokens held by contract', async function () {
      const contractAddress = await this.token.getAddress();
      const ownerBalanceBefore = await this.token.balanceOf(this.owner.address);
      const contractBalanceBefore = await this.token.balanceOf(contractAddress);

      expect(contractBalanceBefore).to.equal(ONE_ETHER);

      await this.token.connect(this.owner).reclaimToken();

      const ownerBalanceAfter = await this.token.balanceOf(this.owner.address);
      const contractBalanceAfter = await this.token.balanceOf(contractAddress);

      expect(contractBalanceAfter).to.equal(0);
      expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + contractBalanceBefore);
    });

    it('should emit Transfer event when reclaiming tokens', async function () {
      const contractAddress = await this.token.getAddress();
      const contractBalance = await this.token.balanceOf(contractAddress);

      await expect(this.token.connect(this.owner).reclaimToken())
        .to.emit(this.token, 'Transfer')
        .withArgs(contractAddress, this.owner.address, contractBalance);
    });

    it('should revert when non-admin tries to reclaim tokens', async function () {
      await expect(
        this.token.connect(this.acc).reclaimToken()
      ).to.be.reverted;
    });

    it('should work even when contract holds zero tokens', async function () {
      // First reclaim
      await this.token.connect(this.owner).reclaimToken();

      // Second reclaim should work but transfer 0
      await expect(this.token.connect(this.owner).reclaimToken())
        .to.emit(this.token, 'Transfer')
        .withArgs(await this.token.getAddress(), this.owner.address, 0);
    });
  });

  describe('setSupplyControl', function () {
    beforeEach(async function () {
      Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
      await grantAllTestRoles(this.token, this.owner, this.owner.address);
    });

    it('should allow admin to set supply control', async function () {
      // Deploy a new supply control contract
      const SupplyControl = await ethers.getContractFactory('SupplyControl');
      const newSupplyControl = await SupplyControl.deploy();
      await newSupplyControl.waitForDeployment();
      const newSupplyControlAddress = await newSupplyControl.getAddress();

      await expect(this.token.connect(this.owner).setSupplyControl(newSupplyControlAddress))
        .to.emit(this.token, 'SupplyControlSet')
        .withArgs(newSupplyControlAddress);
    });

    it('should revert when non-admin tries to set supply control', async function () {
      const someAddress = this.acc.address;

      await expect(
        this.token.connect(this.acc).setSupplyControl(someAddress)
      ).to.be.reverted;
    });

    it('should revert when setting supply control to zero address', async function () {
      await expect(
        this.token.connect(this.owner).setSupplyControl(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.token, 'ZeroAddress');
    });
  });

  describe('isFrozen', function () {
    beforeEach(async function () {
      Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
      await grantAllTestRoles(this.token, this.owner, this.owner.address);
    });

    it('should return false for unfrozen address', async function () {
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.false;
    });

    it('should return true for frozen address', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.true;
    });

    it('should return false after unfreezing', async function () {
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc.address);
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.false;
    });
  });
});
