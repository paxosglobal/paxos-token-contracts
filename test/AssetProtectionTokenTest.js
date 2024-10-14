const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { roles } = require('./helpers/constants');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;

const amount = 100;

describe('PaxosToken', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    freezableAddress = this.acc2.address;
    this.token = this.token.connect(this.assetProtectionRole);

    // give freezable address some tokens.
    await this.token.connect(this.owner).increaseSupply(amount);
    await this.token.connect(this.owner).transfer(freezableAddress, amount);

  })

  describe('asset protection role test', function () {
    it('reverts asset protection actions when using incorrect address', async function () {
      await expect(this.token.connect(this.acc).wipeFrozenAddress(this.acc2.address)).to.be.reverted;
      await expect(this.token.connect(this.acc).freeze(this.acc2.address)).to.be.reverted;
      await expect(this.token.connect(this.acc).freezeBatch([this.acc2.address])).to.be.reverted;
      await expect(this.token.connect(this.acc).unfreeze(this.acc2.address)).to.be.reverted;
      await expect(this.token.connect(this.acc).unfreezeBatch([this.acc2.address])).to.be.reverted;
    });

    it('the current asset protection role is set', async function () {
      expect(await this.token.hasRole(roles.ASSET_PROTECTION_ROLE, this.assetProtectionRole.address)).to.be.true;
    });
  });

  describe('freeze', function () {
    it('freeze the address', async function () {
      await expect(this.token.connect(this.assetProtectionRole).freeze(freezableAddress))
            .to.emit(this.token, "FreezeAddress")
            .withArgs(freezableAddress);

      expect(await this.token.isFrozen(freezableAddress)).to.be.true;
    });

    it('freezeBatch set of address', async function () {
      await expect(this.token.connect(this.assetProtectionRole).freezeBatch([freezableAddress, this.acc3.address]))
            .to.emit(this.token, "FreezeAddress")
            .withArgs(freezableAddress)
            .to.emit(this.token, "FreezeAddress")
            .withArgs(this.acc3.address);

      expect(await this.token.isFrozen(freezableAddress)).to.be.true;
      expect(await this.token.isFrozen(this.acc3.address)).to.be.true;
    });

    it('freezeBatch empty set', async function () {
      await expect(this.token.connect(this.assetProtectionRole).freezeBatch([])).to.not.emit(this.token, "FreezeAddress");
    });

    it('reverts when address is already frozen', async function () {
      await this.token.freeze(freezableAddress);
      await expect(this.token.freeze(freezableAddress)).not.to.be.reverted;
    });
  });

  describe('unfreeze', function () {
    it('unfreeze the address', async function () {
      await this.token.freeze(freezableAddress);
      await expect(this.token.unfreeze(freezableAddress))
            .to.emit(this.token, "UnfreezeAddress")
            .withArgs(freezableAddress);

      expect(await this.token.isFrozen(freezableAddress)).to.be.false;
    });

    it('unfreezeBatch', async function () {
      await this.token.freeze(freezableAddress);
      await this.token.freeze(this.acc3.address);

      await expect(this.token.unfreezeBatch([freezableAddress, this.acc3.address]))
            .to.emit(this.token, "UnfreezeAddress")
            .withArgs(freezableAddress)
            .to.emit(this.token, "UnfreezeAddress")
            .withArgs(this.acc3.address);

      expect(await this.token.isFrozen(freezableAddress)).to.be.false;
      expect(await this.token.isFrozen(this.acc3.address)).to.be.false;
    });

    it('when address is already unfrozen', async function () {
      await expect(this.token.unfreeze(freezableAddress)).not.to.be.reverted;
    });

    it('unfreezeBatch empty set', async function () {
      await expect(this.token.connect(this.assetProtectionRole).unfreezeBatch([])).to.not.emit(this.token, "UnfreezeAddress");
    });
  });


  describe('wipeFrozenAddress', function () {
    it('wipes a frozen address balance', async function () {
      await this.token.freeze(this.acc2.address);

      await expect(this.token.connect(this.assetProtectionRole).wipeFrozenAddress(this.acc2.address))
      .to.emit(this.token, "FrozenAddressWiped")
      .withArgs(this.acc2.address) 
      .and.to.emit(this.token, "SupplyDecreased")
      .withArgs(this.acc2.address, amount) 
      .and.to.emit(this.token, "Transfer")
      .withArgs(this.acc2.address, ZeroAddress, amount) 
      expect(await this.token.isFrozen(this.acc2.address)).to.be.true;

      expect(await this.token.balanceOf(this.acc2.address)).to.equal(0);
    });

    it('reverts when address is not frozen', async function () {
      await expect(this.token.wipeFrozenAddress(this.acc2.address)).to.be.revertedWithCustomError(this.token, "AddressNotFrozen");
    });

  });

});
