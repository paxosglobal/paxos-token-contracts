const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;

// Test that token operates correctly as an ERC20Basic token.
describe('ERC20Basic PaxosToken', function () {

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    await this.token.increaseSupplyToAddress(100, this.owner.address);
  });

  describe('basic data', function () {
    it('has getters for the name, symbol, and decimals', async function () {
      const name = await this.token.name();
      assert.equal(name, "PaxosToken USD");
      const symbol = await this.token.symbol();
      assert.equal(symbol, "PaxosToken");
      const decimals = await this.token.decimals();
      assert.equal(decimals, 18);
    });
  });

  describe('total supply', function () {
    it('returns the total amount of tokens', async function () {
      const totalSupply = await this.token.totalSupply();

      assert.equal(totalSupply, 100);
    });
  });

  describe('balanceOf', function () {
    describe('when the requested account has no tokens', function () {
      it('returns zero', async function () {
        const balance = await this.token.balanceOf(this.acc.address);

        assert.equal(balance, 0);
      });
    });

    describe('when the requested account has some tokens', function () {
      it('returns the total amount of tokens', async function () {
        const balance = await this.token.balanceOf(this.owner.address);

        assert.equal(balance, 100);
      });
    });
  });

  describe('transfer', function () {
    describe('when the recipient is not the zero address', function () {
      let to;
      beforeEach(async function () {
        to = this.recipient.address;
      });

      describe('when the sender does not have enough balance', function () {
        it('reverts', async function () {
          await expect(this.token.transfer(to, 101)).to.be.revertedWithCustomError(this.token, "InsufficientFunds");
        });
      });

      describe('when the sender has enough balance', function () {

        it('transfers the requested amount', async function () {
          await this.token.transfer(to, this.amount);

          const senderBalance = await this.token.balanceOf(this.owner.address);
          assert.equal(senderBalance, 0);

          const recipientBalance = await this.token.balanceOf(to);
          assert.equal(recipientBalance, this.amount);
        });

        it('emits a transfer event', async function () {
          await expect(this.token.transfer(to, this.amount))
          .to.emit(this.token, "Transfer")
          .withArgs(this.owner.address, to, 100);
        });
      });
    });

    describe('when the recipient is the zero address', function () {
      it('reverts', async function () {
        await expect(this.token.transfer(ZeroAddress, 100)).to.be.revertedWithCustomError(this.token, "ZeroAddress");
      });
    });
  });
});
