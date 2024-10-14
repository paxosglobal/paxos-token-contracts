const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');

// Test that the PaxosToken contract can reclaim token it has received.
// Note that the contract is not payable in Eth.
const amount = 100;
describe('CanReclaimFunds', function () {

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    await this.token.increaseSupplyToAddress(amount, this.owner.address);
    await this.token.transfer(await this.token.getAddress(), amount);
    const balance = await this.token.balanceOf(this.owner.address);
    assert.equal(0, BigInt(balance));
    const contractBalance = await this.token.balanceOf(await this.token.getAddress());
    assert.equal(amount, contractBalance);
  });

  it('should not accept Eth', async function () {
    await expect(
      this.owner.sendTransaction({to: await this.token.getAddress(), value: amount})
    ).to.be.revertedWith('Not expecting ether');
  });

  it('should allow owner to reclaim tokens', async function () {
    await this.token.reclaimToken();

    const balance = await this.token.balanceOf(this.owner.address);
    assert.equal(amount, balance);
    const contractBalance = await this.token.balanceOf(await this.token.getAddress());
    assert.equal(0, contractBalance);
  });

  it('should allow only owner to reclaim tokens', async function () {
    await expect(
      this.token.connect(this.acc).reclaimToken()
    ).to.be.revertedWith(
      `AccessControl: account ${this.acc.address.toLowerCase()} is missing role 0x0000000000000000000000000000000000000000000000000000000000000000`  
    );
  });
});
