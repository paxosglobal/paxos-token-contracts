const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

describe('Frozen Address Edge Cases', function () {
  const testAmount = 100e6;

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Setup: Give addresses some balance
    await this.token.connect(this.owner).increaseSupply(testAmount * 3);
    await this.token.connect(this.owner).transfer(this.acc.address, testAmount);
    await this.token.connect(this.owner).transfer(this.acc2.address, testAmount);
  });

  describe('approve() with frozen addresses', function() {
    it('should revert when spender is frozen', async function() {
      // Freeze the spender
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);

      // Try to approve frozen spender - should revert
      await expect(
        this.token.connect(this.acc).approve(this.acc2.address, testAmount)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when msg.sender is frozen', async function() {
      // Freeze the caller
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Try to approve while frozen - should revert
      await expect(
        this.token.connect(this.acc).approve(this.acc2.address, testAmount)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should succeed when neither sender nor spender is frozen', async function() {
      // Both unfrozen - should work
      await expect(
        this.token.connect(this.acc).approve(this.acc2.address, testAmount)
      ).to.emit(this.token, 'Approval');
    });
  });

  describe('transferFrom() with frozen addresses', function() {
    beforeEach(async function() {
      // Setup approval from acc to acc2
      await this.token.connect(this.acc).approve(this.acc2.address, testAmount);
    });

    it('should revert when msg.sender is frozen', async function() {
      // Freeze the caller (who is trying to spend the allowance)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);

      // Try to transferFrom while frozen - should revert
      await expect(
        this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc3.address, testAmount / 2)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when from address is frozen', async function() {
      // Freeze the from address
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Try to transferFrom frozen address - should revert
      await expect(
        this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc3.address, testAmount / 2)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when to address is frozen', async function() {
      // Freeze the destination
      await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);

      // Try to transferFrom to frozen address - should revert
      await expect(
        this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc3.address, testAmount / 2)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });

  describe('permit() with frozen addresses', function() {
    it('should revert when owner is frozen', async function() {
      const { ethers } = require("hardhat");

      // Freeze the owner
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Setup permit parameters
      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const value = testAmount;

      // Get domain separator and nonce
      const nonce = await this.token.nonces(this.acc.address);
      const domain = {
        name: await this.token.name(),
        version: "2",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await this.token.getAddress()
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const message = {
        owner: this.acc.address,
        spender: this.acc2.address,
        value: value,
        nonce: nonce,
        deadline: deadline
      };

      // Sign the permit
      const signature = await this.acc.signTypedData(domain, types, message);
      const sig = ethers.Signature.from(signature);

      // Try to execute permit with frozen owner - should revert
      await expect(
        this.token.permit(
          this.acc.address,
          this.acc2.address,
          value,
          deadline,
          sig.v,
          sig.r,
          sig.s
        )
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('should revert when spender is frozen', async function() {
      const { ethers } = require("hardhat");

      // Freeze the spender
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);

      // Setup permit parameters
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const value = testAmount;

      const nonce = await this.token.nonces(this.acc.address);
      const domain = {
        name: await this.token.name(),
        version: "2",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await this.token.getAddress()
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const message = {
        owner: this.acc.address,
        spender: this.acc2.address,
        value: value,
        nonce: nonce,
        deadline: deadline
      };

      const signature = await this.acc.signTypedData(domain, types, message);
      const sig = ethers.Signature.from(signature);

      // Try to execute permit with frozen spender - should revert
      await expect(
        this.token.permit(
          this.acc.address,
          this.acc2.address,
          value,
          deadline,
          sig.v,
          sig.r,
          sig.s
        )
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });

  describe('cancelAuthorization() with frozen addresses', function() {
    it('should revert when authorizer is frozen', async function() {
      const { ethers } = require("hardhat");

      // First create a valid authorization
      const authorizationNonce = ethers.hexlify(ethers.randomBytes(32));

      // Freeze the authorizer
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

      // Setup cancel authorization parameters
      const domain = {
        name: await this.token.name(),
        version: "2",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await this.token.getAddress()
      };

      const types = {
        CancelAuthorization: [
          { name: "authorizer", type: "address" },
          { name: "nonce", type: "bytes32" }
        ]
      };

      const message = {
        authorizer: this.acc.address,
        nonce: authorizationNonce
      };

      // Sign the cancellation
      const signature = await this.acc.signTypedData(domain, types, message);
      const sig = ethers.Signature.from(signature);

      // Try to cancel with frozen authorizer - should revert
      await expect(
        this.token.cancelAuthorization(
          this.acc.address,
          authorizationNonce,
          sig.v,
          sig.r,
          sig.s
        )
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });
});
