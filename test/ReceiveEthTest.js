const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');

describe('Receive ETH Test', function () {

  describe('receive() function - Proxy', function () {
    beforeEach(async function () {
      Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    });

    it('should revert when sending ETH directly to contract', async function () {
      const contractAddress = await this.token.getAddress();

      await expect(
        this.owner.sendTransaction({
          to: contractAddress,
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWith("Not expecting ether");
    });

    it('should revert with correct message for small ETH amounts', async function () {
      const contractAddress = await this.token.getAddress();

      await expect(
        this.acc.sendTransaction({
          to: contractAddress,
          value: ethers.parseEther("0.1")
        })
      ).to.be.revertedWith("Not expecting ether");
    });

    it('should revert even when sending 0 ETH', async function () {
      const contractAddress = await this.token.getAddress();

      await expect(
        this.acc.sendTransaction({
          to: contractAddress,
          value: 0
        })
      ).to.be.revertedWith("Not expecting ether");
    });

    it('should revert from any sender address', async function () {
      const contractAddress = await this.token.getAddress();

      // Test from owner
      await expect(
        this.owner.sendTransaction({
          to: contractAddress,
          value: ethers.parseEther("0.5")
        })
      ).to.be.revertedWith("Not expecting ether");

      // Test from acc2
      await expect(
        this.acc2.sendTransaction({
          to: contractAddress,
          value: ethers.parseEther("0.5")
        })
      ).to.be.revertedWith("Not expecting ether");

      // Test from acc3
      await expect(
        this.acc3.sendTransaction({
          to: contractAddress,
          value: ethers.parseEther("0.5")
        })
      ).to.be.revertedWith("Not expecting ether");
    });
  });

  describe('receive() function - Implementation (Direct)', function () {
    beforeEach(async function () {
      Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    });

    it('should revert with implementation error when sending ETH to impl contract directly', async function () {
      // Get the implementation address from the proxy storage
      // AdminUpgradeabilityProxy uses: keccak256("org.zeppelinos.proxy.implementation")
      const IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
      const proxyAddress = await this.token.getAddress();

      // Read the implementation address from the proxy's storage
      const implAddressRaw = await ethers.provider.getStorage(proxyAddress, IMPLEMENTATION_SLOT);
      const implAddress = ethers.getAddress('0x' + implAddressRaw.slice(-40));

      // Send ETH directly to the implementation contract (not through proxy)
      // The implementation contract's receive() should revert
      await expect(
        this.owner.sendTransaction({
          to: implAddress,
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWith("Direct ETH transfers not supported");
    });
  });
});
