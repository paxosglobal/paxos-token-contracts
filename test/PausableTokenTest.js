const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');

const { roles } = require('./helpers/constants');

// Test that PaxosToken operates correctly as a Pausable token.
describe('Pausable PaxosToken', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    await this.token.increaseSupplyToAddress(100, this.owner.address);
  });

  const amount = 10;

  it('can transfer in non-pause', async function () {
    const paused = await this.token.paused();
    assert.equal(paused, false);
    await this.token.transfer(this.acc.address, amount);
    const balance = await this.token.balanceOf(this.owner.address);
    assert.equal(90, balance);
  });

  it('cannot transfer in pause', async function () {
    await expect(this.token.pause())
      .to.emit(this.token, "Pause")
    const paused = await this.token.paused();
    assert.equal(paused, true);
    await expect(this.token.transfer(this.acc.address, amount)).to.be.revertedWithCustomError(this.token, "ContractPaused");
    const balance = await this.token.balanceOf(this.owner.address);
    assert.equal(100, balance);
  });

  it('cannot approve/transferFrom in pause', async function () {
    await this.token.approve(this.acc.address, amount);
    await this.token.pause();
    const paused = await this.token.paused();
    assert.equal(paused, true);
    await expect(this.token.approve(this.acc.address, 2 * amount)).to.be.revertedWithCustomError(this.token, "ContractPaused");
    await expect(this.token.connect(this.acc).transferFrom(this.owner.address, this.acc.address, amount)).to.be.revertedWithCustomError(this.token, "ContractPaused");
  });

  it('cannot increase/decrease approval in pause', async function () {
    await this.token.pause();
    await expect(this.token.connect(this.acc2).increaseApproval(this.acc.address, amount)).to.be.revertedWithCustomError(this.token, "ContractPaused");
    await expect(this.token.connect(this.acc2).decreaseApproval(this.acc.address, amount)).to.be.revertedWithCustomError(this.token, "ContractPaused");
  });

  it('should resume allowing normal process after pause is over', async function () {
    await this.token.pause();
    await expect(this.token.unpause())
    .to.emit(this.token, "Unpause")
    await this.token.transfer(this.acc.address, amount);
    const balance = await this.token.balanceOf(this.owner.address);
    assert.equal(90, balance);
  });

  it('cannot unpause when unpaused or pause when paused', async function () {
    await expect(this.token.unpause()).to.be.revertedWithCustomError(this.token, "AlreadyUnPaused");
    await this.token.pause();
    await expect(this.token.pause()).to.be.revertedWithCustomError(this.token, "AlreadyPaused");
  });

  it('only pause-role can pause the contract', async function () {
    await this.token.grantRole(roles.PAUSE_ROLE, this.acc2.address);
    // Any other address should not have permission to pause the contract
    await expect(this.token.connect(this.acc).pause()).to.be.revertedWith(
      `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${roles.PAUSE_ROLE}`
    );
  });

  it('only pause-role can unpause the contract', async function () {
    await this.token.grantRole(roles.PAUSE_ROLE, this.acc2.address);
    // Any other address should not have permission to unpause the contract
    await expect(this.token.connect(this.acc).unpause()).to.be.revertedWith(
      `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${roles.PAUSE_ROLE}`
    );
  });

});
