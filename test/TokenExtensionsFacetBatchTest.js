const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ethers } = require("hardhat");
const { signTransferAuthorization, signCancelAuthorization, computeFacetDomainSeparator, MAX_UINT256 } = require('./helpers/signature');
const { ACCOUNTS } = require('./helpers/constants');
const { grantAllTestRoles } = require('./helpers/testHelpers');

describe("TokenExtensionsFacet - Batch Operations", function () {
  let domainSeparator;

  let sender1 = ACCOUNTS[0];
  let sender2 = ACCOUNTS[1];
  let recipient1 = ACCOUNTS[2];
  let recipient2 = ACCOUNTS[3];
  let senderBalance = 10e6;
  let transactionValue = 1e6;
  const initialBalance = 100e6;

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.increaseSupplyToAddress(initialBalance, this.owner.address);
    domainSeparator = await computeFacetDomainSeparator(this.token);
    this.spender = this.acc2;
  });

  describe("transferWithAuthorizationBatch", function() {
    it("reverts when contract is paused (v,r,s version)", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));

      await this.token.transfer(sender1.address, senderBalance);

      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      // Pause the contract
      await this.token.pause();

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });

    it("should execute batch transfer with multiple authorizations", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const nonce2 = ethers.hexlify(ethers.randomBytes(32));

      // Fund senders
      await this.token.transfer(sender1.address, senderBalance);
      await this.token.transfer(sender2.address, senderBalance);

      // Sender1 signs authorization
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      // Sender2 signs authorization
      const auth2 = signTransferAuthorization(
        sender2.address,
        recipient2.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce2,
        domainSeparator,
        sender2.key
      );

      // Check initial balances
      expect(await this.token.balanceOf(sender1.address)).to.equal(senderBalance);
      expect(await this.token.balanceOf(sender2.address)).to.equal(senderBalance);
      expect(await this.token.balanceOf(recipient1.address)).to.equal(0);
      expect(await this.token.balanceOf(recipient2.address)).to.equal(0);

      // Execute batch transfer
      const result = await this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address, sender2.address],
        [recipient1.address, recipient2.address],
        [transactionValue, transactionValue],
        [0, 0],
        [MAX_UINT256, MAX_UINT256],
        [nonce1, nonce2],
        [auth1.v, auth2.v],
        [auth1.r, auth2.r],
        [auth1.s, auth2.s]
      );

      // Check final balances
      expect(await this.token.balanceOf(sender1.address)).to.equal(senderBalance - transactionValue);
      expect(await this.token.balanceOf(sender2.address)).to.equal(senderBalance - transactionValue);
      expect(await this.token.balanceOf(recipient1.address)).to.equal(transactionValue);
      expect(await this.token.balanceOf(recipient2.address)).to.equal(transactionValue);

      // Check that authorizations were used
      expect(await this.token.authorizationState(sender1.address, nonce1)).to.be.true;
      expect(await this.token.authorizationState(sender2.address, nonce2)).to.be.true;
    });

    it("should succeed with empty arrays (no-op)", async function() {
      // Empty arrays should be a no-op (no error, just nothing happens)
      await this.token.connect(this.spender).transferWithAuthorizationBatch(
        [], [], [], [], [], [], [], [], []
      );
    });

    it("should revert with mismatched array lengths", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [auth1.r],
        // Missing s parameter
        []
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'to' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [], // Mismatched 'to' array
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'value' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [], // Mismatched 'value' array
        [0],
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'validAfter' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [], // Mismatched 'validAfter' array
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'validBefore' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [], // Mismatched 'validBefore' array
        [nonce1],
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'nonce' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [], // Mismatched 'nonce' array
        [auth1.v],
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'v' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [], // Mismatched 'v' array
        [auth1.r],
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'r' array length mismatches", async function() {
      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [auth1.v],
        [], // Mismatched 'r' array
        [auth1.s]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });
  });

  describe("transferWithAuthorizationBatch with bytes signature", function() {
    it("reverts when contract is paused (bytes signature version)", async function() {
      const nonce1 = ethers.randomBytes(32);

      await this.token.transfer(sender1.address, senderBalance);

      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      // Pause the contract
      await this.token.pause();

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });

    it("should execute batch transfer with bytes signatures", async function() {
      const nonce1 = ethers.randomBytes(32);
      const nonce2 = ethers.randomBytes(32);

      // Fund senders
      await this.token.transfer(sender1.address, senderBalance);
      await this.token.transfer(sender2.address, senderBalance);

      // Create signatures
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      const auth2 = signTransferAuthorization(
        sender2.address,
        recipient2.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce2,
        domainSeparator,
        sender2.key
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);
      const signature2 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth2.r, auth2.s, auth2.v]);

      // Check initial balances
      expect(await this.token.balanceOf(sender1.address)).to.equal(senderBalance);
      expect(await this.token.balanceOf(sender2.address)).to.equal(senderBalance);
      expect(await this.token.balanceOf(recipient1.address)).to.equal(0);
      expect(await this.token.balanceOf(recipient2.address)).to.equal(0);

      // Execute bytes signature batch transfer
      const result = await this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])']( 
        [sender1.address, sender2.address],
        [recipient1.address, recipient2.address],
        [transactionValue, transactionValue],
        [0, 0],
        [MAX_UINT256, MAX_UINT256],
        [nonce1, nonce2],
        [signature1, signature2]
      );

      await result.wait();

      // Check final balances
      expect(await this.token.balanceOf(sender1.address)).to.equal(senderBalance - transactionValue);
      expect(await this.token.balanceOf(sender2.address)).to.equal(senderBalance - transactionValue);
      expect(await this.token.balanceOf(recipient1.address)).to.equal(transactionValue);
      expect(await this.token.balanceOf(recipient2.address)).to.equal(transactionValue);

      // Check that authorizations were used
      expect(await this.token.authorizationState(sender1.address, nonce1)).to.be.true;
      expect(await this.token.authorizationState(sender2.address, nonce2)).to.be.true;
    });

    it("should revert when signature arrays have different lengths", async function() {
      const nonce1 = ethers.randomBytes(32);
      const nonce2 = ethers.randomBytes(32);

      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])']( 
        [sender1.address, sender2.address],
        [recipient1.address, recipient2.address],
        [transactionValue, transactionValue],
        [0, 0],
        [MAX_UINT256, MAX_UINT256],
        [nonce1, nonce2],
        [signature1] // Only one signature for two transfers
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'to' array length mismatches (bytes signature)", async function() {
      const nonce1 = ethers.randomBytes(32);
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );
      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [], // Mismatched 'to' array
        [transactionValue],
        [0],
        [MAX_UINT256],
        [nonce1],
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'value' array length mismatches (bytes signature)", async function() {
      const nonce1 = ethers.randomBytes(32);
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );
      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [recipient1.address],
        [], // Mismatched 'value' array
        [0],
        [MAX_UINT256],
        [nonce1],
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'validAfter' array length mismatches (bytes signature)", async function() {
      const nonce1 = ethers.randomBytes(32);
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );
      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [], // Mismatched 'validAfter' array
        [MAX_UINT256],
        [nonce1],
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'validBefore' array length mismatches (bytes signature)", async function() {
      const nonce1 = ethers.randomBytes(32);
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );
      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [], // Mismatched 'validBefore' array
        [nonce1],
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("reverts when 'nonce' array length mismatches (bytes signature)", async function() {
      const nonce1 = ethers.randomBytes(32);
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );
      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])'](
        [sender1.address],
        [recipient1.address],
        [transactionValue],
        [0],
        [MAX_UINT256],
        [], // Mismatched 'nonce' array
        [signature1]
      )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
    });

    it("should revert when one signature is invalid", async function() {
      const nonce1 = ethers.randomBytes(32);
      const nonce2 = ethers.randomBytes(32);

      await this.token.transfer(sender1.address, senderBalance);
      await this.token.transfer(sender2.address, senderBalance);

      // Valid signature for sender1
      const auth1 = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce1,
        domainSeparator,
        sender1.key
      );

      // Invalid signature for sender2 (wrong signer)
      const auth2 = signTransferAuthorization(
        sender2.address,
        recipient2.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce2,
        domainSeparator,
        ACCOUNTS[5].key // Wrong signer
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth1.r, auth1.s, auth1.v]);
      const signature2 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [auth2.r, auth2.s, auth2.v]);

      await expect(this.token.connect(this.spender)['transferWithAuthorizationBatch(address[],address[],uint256[],uint256[],uint256[],bytes32[],bytes[])']( 
        [sender1.address, sender2.address],
        [recipient1.address, recipient2.address],
        [transactionValue, transactionValue],
        [0, 0],
        [MAX_UINT256, MAX_UINT256],
        [nonce1, nonce2],
        [signature1, signature2]
      )).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });
  });

  describe("cancelAuthorization - already used", function() {
    it("should emit AuthorizationAlreadyUsed when canceling already canceled authorization", async function() {
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      // Cancel the authorization first time
      const cancellation = signCancelAuthorization(
        sender1.address,
        nonce,
        domainSeparator,
        sender1.key
      );

      await this.token.connect(this.spender).cancelAuthorization(
        sender1.address,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s
      );

      // Check that the authorization is now used
      expect(await this.token.authorizationState(sender1.address, nonce)).to.be.true;

      // Try to cancel again - should emit AuthorizationAlreadyUsed
      const cancellation2 = signCancelAuthorization(
        sender1.address,
        nonce,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).cancelAuthorization(
        sender1.address,
        nonce,
        cancellation2.v,
        cancellation2.r,
        cancellation2.s
      )).to.emit(this.token, "AuthorizationAlreadyUsed")
        .withArgs(sender1.address, nonce);
    });

    it("should emit AuthorizationAlreadyUsed when canceling already used authorization", async function() {
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      // Fund sender
      await this.token.transfer(sender1.address, senderBalance);

      // Use the authorization first
      const auth = signTransferAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender1.key
      );

      await this.token.connect(this.spender).transferWithAuthorization(
        sender1.address,
        recipient1.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        auth.v,
        auth.r,
        auth.s
      );

      // Check that the authorization was used
      expect(await this.token.authorizationState(sender1.address, nonce)).to.be.true;

      // Try to cancel the already-used authorization
      const cancellation = signCancelAuthorization(
        sender1.address,
        nonce,
        domainSeparator,
        sender1.key
      );

      await expect(this.token.connect(this.spender).cancelAuthorization(
        sender1.address,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s
      )).to.emit(this.token, "AuthorizationAlreadyUsed")
        .withArgs(sender1.address, nonce);
    });
  });
});
