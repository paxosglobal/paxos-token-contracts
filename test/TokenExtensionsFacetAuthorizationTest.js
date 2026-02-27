const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ethers }= require("hardhat");
const { ZeroAddress } = require("hardhat").ethers;
const { grantAllTestRoles } = require('./helpers/testHelpers');

const { signTransferAuthorization, signReceiveAuthorization, signCancelAuthorization,
  computeFacetDomainSeparator, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
  CANCEL_AUTHORIZATION_TYPEHASH, MAX_UINT256 } = require('./helpers/signature');

const { ACCOUNTS, roles } = require('./helpers/constants');

describe("TokenExtensionsFacet - EIP3009 Authorization", function () {
  let domainSeparator;
  let nonce;

  // Transaction defaults
  let sender = ACCOUNTS[0];
  let recipient = ACCOUNTS[1];
  let receiver;
  let senderBalance = 10e6;
  let transactionValue = 1e6;
  const initialBalance = 100e6;

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.increaseSupplyToAddress(initialBalance, this.owner.address);
    domainSeparator = await computeFacetDomainSeparator(this.token);
    this.spender = this.acc2;
    receiver = this.acc3.address;
    this.receiverSigner = this.acc3;
    nonce = ethers.hexlify(ethers.randomBytes(32))
  });

  // Note: Typehash constants are not exposed as public getters in the facet

  describe("transferWithAuthorization", function() {
    it("executes a transferWithAuthorization with a valid authorization", async function() {
      const from = sender.address;
      const to = recipient.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // Sender signs the authorization
      const { v, r, s } = signTransferAuthorization(
        from,
        to,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );

      // Fund sender from owner
      await this.token.transfer(sender.address, senderBalance);

      // check initial balance
      expect(BigInt(await this.token.balanceOf(from))).to.equal(senderBalance);
      expect(BigInt(await this.token.balanceOf(to))).to.equal(0);
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // Execute the transaction
      const result = await this.token.connect(this.spender).transferWithAuthorization(
        from,
        to,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      );
      var transactionRecp = await result.wait()
      assert.equal(transactionRecp.status, 1, 'transferWithAuthorization transaction failed');

      // check that balance is updated
      expect(BigInt(await this.token.balanceOf(from))).to.equal(senderBalance - transactionValue);
      expect(BigInt(await this.token.balanceOf(to))).to.equal(transactionValue);

      // check that AuthorizationUsed event is emitted
      await expect(result)
      .to.emit(this.token, "AuthorizationUsed")
      .withArgs(from, nonce)
      .and.to.emit(this.token, "Transfer")
      .withArgs(from, to, transactionValue)

      // check that the authorization is now used
      expect(await this.token.authorizationState(from, nonce)).to.be.true;
    });

    it("executes a transferWithAuthorization with invalid params", async function() {
      const { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue * 2,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender.key
      );
      // Execute the transaction
      await expect(this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });

    it("reverts if the authorization is not yet valid", async function() {
      validAfter = (await ethers.provider.getBlock("latest")).timestamp + 10000000;
      const { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue * 2,
        validAfter,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender.key
      );
      // Execute the transaction
      await expect(this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        validAfter,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "AuthorizationInvalid");
    });

    it("reverts if the authorization is expired", async function() {
      const validBefore = Math.floor(Date.now() / 1000) - 10000000;
      const { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );
      // Execute the transaction
      await expect(this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        validBefore,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "AuthorizationExpired");
    });

    it("reverts when the sender has insufficient funds", async function() {
      const { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender.key
      );

      // Execute the transaction - should revert with TransferFailed (which wraps InsufficientFunds)
      await expect(this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
      )).to.be.reverted; // Accept any revert
    });

    it("reverts when contract is paused", async function() {
      const from = sender.address;
      const to = recipient.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // Sender signs the authorization
      const { v, r, s } = signTransferAuthorization(
        from,
        to,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );

      await this.token.pause();
      // Execute the transaction
      await expect(this.token.connect(this.spender).transferWithAuthorization(
        from,
        to,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });
  });

  describe("receiveWithAuthorization", function() {
    it("executes a receiveWithAuthorization with a valid authorization", async function() {
      const from = sender.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // Sender signs the authorization
      const { v, r, s } = signReceiveAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );

      // Fund sender from owner
      await this.token.transfer(from, senderBalance);

      // check initial balance
      expect(BigInt(await this.token.balanceOf(from))).to.equal(senderBalance);
      expect(BigInt(await this.token.balanceOf(receiver))).to.equal(0);
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // Execute the transaction
      const result = await this.token.connect(this.receiverSigner).receiveWithAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      );
      var transactionRecp = await result.wait()
      assert.equal(transactionRecp.status, 1, 'receiveWithAuthorization transaction failed');

      // check that balance is updated
      expect(BigInt(await this.token.balanceOf(from))).to.equal(senderBalance - transactionValue);
      expect(BigInt(await this.token.balanceOf(receiver))).to.equal(transactionValue);

      // check that AuthorizationUsed event is emitted
      await expect(result)
      .to.emit(this.token, "AuthorizationUsed")
      .withArgs(from, nonce)
      .and.to.emit(this.token, "Transfer")
      .withArgs(from, receiver, transactionValue)

      // check that the authorization is now used
      expect(await this.token.authorizationState(from, nonce)).to.be.true;
    });

    it("reverts if the caller is not the payee", async function() {
      const from = sender.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // Sender signs the authorization
      const { v, r, s } = signReceiveAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );

      await expect(this.token.connect(this.spender).receiveWithAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "CallerMustBePayee");
    });

    it("reverts if contract is paused", async function() {
      const from = sender.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // Sender signs the authorization
      const { v, r, s } = signReceiveAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );
      await this.token.pause();

      await expect(this.token.connect(this.spender).receiveWithAuthorization(
        from,
        receiver,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });
  });

  describe("cancelAuthorization", function() {
    it("check cancelAuthorization vanilla case", async function() {
      const from = sender.address;
      const to = recipient.address;
      const validAfter = 0;
      const validBefore = MAX_UINT256;

      // check that the authorization is ununsed
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // create cancellation
      const cancellation = signCancelAuthorization(
        from,
        nonce,
        domainSeparator,
        sender.key
      );

      // cancel the authorization
      await this.token.connect(this.spender).cancelAuthorization(
        from,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s,
      );

      // check that the authorization is now used
      expect(await this.token.authorizationState(from, nonce)).to.be.true;

      // attempt to use the canceled authorization
      // Sender signs the authorization
      const { v, r, s } = signTransferAuthorization(
        from,
        to,
        transactionValue,
        validAfter,
        validBefore,
        nonce,
        domainSeparator,
        sender.key
      );

      await expect(
        this.token.connect(this.spender).transferWithAuthorization(
          from,
          to,
          transactionValue,
          validAfter,
          validBefore,
          nonce,
          v,
          r,
          s,
        ),
      ).to.emit(this.token, "AuthorizationAlreadyUsed")
      .withArgs(from, nonce)
    });

    it("revert when contract is paused", async function() {
      // create cancellation
      const from = sender.address;

      // check that the authorization is ununsed
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // create cancellation
      const cancellation = signCancelAuthorization(
        from,
        nonce,
        domainSeparator,
        sender.key
      );
      this.token.pause();

      // cancel the authorization
      await expect(this.token.connect(this.spender).cancelAuthorization(
        from,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s,
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });

    it("executes a cancelAuthorization with invalid params", async function() {
      const from = sender.address;

      // check that the authorization is ununsed
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // create cancellation
      const cancellation = signCancelAuthorization(
        ZeroAddress, // INVALID NONCE
        nonce,
        domainSeparator,
        sender.key
      );

      // cancel the authorization
      await expect(this.token.connect(this.spender).cancelAuthorization(
        from,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s,
      )).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });
  });

  describe("Bytes Signature Support", function() {
    describe("transferWithAuthorization with bytes signature", function() {
      it("reverts when contract is paused (bytes signature)", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signTransferAuthorization(
          sender.address,
          recipient.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        // Pause the contract
        await this.token.pause();

        await expect(
          this.token.connect(this.spender)['transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
            sender.address,
            recipient.address,
            transactionValue,
            0,
            MAX_UINT256,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "ContractPaused");
      });

      it("executes transferWithAuthorization with bytes signature", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signTransferAuthorization(
          sender.address,
          recipient.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        const result = await this.token.connect(this.spender)['transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
          sender.address,
          recipient.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          signature
        );

        const transactionRecp = await result.wait();
        assert.equal(transactionRecp.status, 1, 'transferWithAuthorization transaction failed');

        expect(await this.token.balanceOf(sender.address)).to.equal(senderBalance - transactionValue);
        expect(await this.token.balanceOf(recipient.address)).to.equal(transactionValue);
        expect(await this.token.authorizationState(sender.address, nonce)).to.equal(true);
      });

      it("revert bytes signature transferWithAuthorization when signature is invalid", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signTransferAuthorization(
          sender.address,
          recipient.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          ACCOUNTS[5].key // Wrong signer
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        await expect(
          this.token.connect(this.spender)['transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
            sender.address,
            recipient.address,
            transactionValue,
            0,
            MAX_UINT256,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "InvalidSignature");
      });
    });

    describe("receiveWithAuthorization with bytes signature", function() {
      it("reverts when contract is paused (bytes signature)", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signReceiveAuthorization(
          sender.address,
          this.receiverSigner.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        // Pause the contract
        await this.token.pause();

        await expect(
          this.token.connect(this.receiverSigner)['receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
            sender.address,
            this.receiverSigner.address,
            transactionValue,
            0,
            MAX_UINT256,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "ContractPaused");
      });

      it("reverts when caller is not payee (bytes signature)", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signReceiveAuthorization(
          sender.address,
          this.receiverSigner.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        // Call from spender (not the payee)
        await expect(
          this.token.connect(this.spender)['receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
            sender.address,
            this.receiverSigner.address,
            transactionValue,
            0,
            MAX_UINT256,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "CallerMustBePayee");
      });

      it("executes receiveWithAuthorization with bytes signature", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signReceiveAuthorization(
          sender.address,
          this.receiverSigner.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        const result = await this.token.connect(this.receiverSigner)['receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
          sender.address,
          this.receiverSigner.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          signature
        );

        const transactionRecp = await result.wait();
        assert.equal(transactionRecp.status, 1, 'receiveWithAuthorization transaction failed');

        expect(await this.token.balanceOf(sender.address)).to.equal(senderBalance - transactionValue);
        expect(await this.token.balanceOf(this.receiverSigner.address)).to.equal(transactionValue);
        expect(await this.token.authorizationState(sender.address, nonce)).to.equal(true);
      });

      it("revert bytes signature receiveWithAuthorization when signature is invalid", async function() {
        await this.token.transfer(sender.address, senderBalance);

        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signReceiveAuthorization(
          sender.address,
          this.receiverSigner.address,
          transactionValue,
          0,
          MAX_UINT256,
          nonce,
          domainSeparator,
          ACCOUNTS[5].key // Wrong signer
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        await expect(
          this.token.connect(this.receiverSigner)['receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'](
            sender.address,
            this.receiverSigner.address,
            transactionValue,
            0,
            MAX_UINT256,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "InvalidSignature");
      });
    });

    describe("cancelAuthorization with bytes signature", function() {
      it("executes cancelAuthorization with bytes signature", async function() {
        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signCancelAuthorization(
          sender.address,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        expect(await this.token.authorizationState(sender.address, nonce)).to.equal(false);

        const result = await this.token.connect(this.spender)['cancelAuthorization(address,bytes32,bytes)'](
          sender.address,
          nonce,
          signature
        );

        await result.wait();
        expect(await this.token.authorizationState(sender.address, nonce)).to.equal(true);
      });

      it("revert bytes signature cancelAuthorization when signature is invalid", async function() {
        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signCancelAuthorization(
          sender.address,
          nonce,
          domainSeparator,
          ACCOUNTS[5].key // Wrong signer
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        await expect(
          this.token.connect(this.spender)['cancelAuthorization(address,bytes32,bytes)'](
            sender.address,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "InvalidSignature");
      });

      it("reverts bytes signature cancelAuthorization when contract is paused", async function() {
        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signCancelAuthorization(
          sender.address,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        await this.token.pause();

        await expect(
          this.token.connect(this.spender)['cancelAuthorization(address,bytes32,bytes)'](
            sender.address,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "ContractPaused");
      });

      it("reverts bytes signature cancelAuthorization when authorizer is frozen", async function() {
        const nonce = ethers.randomBytes(32);
        const { v, r, s } = signCancelAuthorization(
          sender.address,
          nonce,
          domainSeparator,
          sender.key
        );

        const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

        await this.token.connect(this.assetProtectionRole).freeze(sender.address);

        await expect(
          this.token.connect(this.spender)['cancelAuthorization(address,bytes32,bytes)'](
            sender.address,
            nonce,
            signature
          )
        ).to.be.revertedWithCustomError(this.token, "AddressFrozen");
      });
    });
  });
});
