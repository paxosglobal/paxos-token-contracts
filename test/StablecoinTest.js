const { deployStableCoinFixturePYUSD, deployStableCoinFixtureUSDP, deployStableCoinFixtureUSDG } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { roles } = require('./helpers/constants');

// Test stable coin specific features.
describe('Stable coin testing', function () {

  describe('PYUSD testing', async function () {
    it('has correct name, symbol, and decimals', async function () {
      let { token } =  await loadFixture(deployStableCoinFixturePYUSD);
      const name = await token.name();
      assert.equal(name, "PayPal USD");
      const symbol = await token.symbol();
      assert.equal(symbol, "PYUSD");
      const decimals = await token.decimals();
      assert.equal(decimals, 6);
    });
  });

  describe('USDP testing', async function () {
    it('has correct name, symbol, and decimals', async function () {
      let { token } =  await loadFixture(deployStableCoinFixtureUSDP);
      const name = await token.name();
      assert.equal(name, "Pax Dollar");
      const symbol = await token.symbol();
      assert.equal(symbol, "USDP");
      const decimals = await token.decimals();
      assert.equal(decimals, 18);
    });
  });

  describe('USDG testing', async function () {
    it('has correct name, symbol, and decimals', async function () {
      let { token } =  await loadFixture(deployStableCoinFixtureUSDG);
      const name = await token.name();
      assert.equal(name, "Global Dollar");
      const symbol = await token.symbol();
      assert.equal(symbol, "USDG");
      const decimals = await token.decimals();
      assert.equal(decimals, 6);
    });

    describe("default admin role", function () {
      it("can upgrade with admin role", async () => {
        const { token } = await loadFixture(deployStableCoinFixtureUSDG);
        const newContract = await ethers.deployContract("USDG");
  
        await expect(token.upgradeTo(newContract)).to.not.be.reverted;
      });
  
      it("cannot upgrade without admin role", async () => {
        const { token, acc } = await loadFixture(deployStableCoinFixtureUSDG);
  
        await expect(
          token.connect(acc).upgradeTo(ZeroAddress)
        ).to.be.revertedWith(
          `AccessControl: account ${acc.address.toLowerCase()} is missing role ${
            roles.DEFAULT_ADMIN_ROLE
          }`
        );
      });
    });
  });
});