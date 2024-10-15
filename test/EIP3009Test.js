const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ethers }= require("hardhat");
const { ZeroAddress } = require("hardhat").ethers;


const { signTransferAuthorization, signReceiveAuthorization, signCancelAuthorization,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH, RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
  CANCEL_AUTHORIZATION_TYPEHASH, MAX_UINT256 } = require('./helpers/signature');

const { ACCOUNTS, roles } = require('./helpers/constants');

describe("EIP3009", function () {
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
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    await this.token.increaseSupplyToAddress(initialBalance, this.owner.address);
    domainSeparator = await this.token.DOMAIN_SEPARATOR()
    this.spender = this.acc2;
    receiver = this.acc3.address;
    this.receiverSigner = this.acc3;
    nonce = ethers.hexlify(ethers.randomBytes(32))

  });

  it("validate type hashes", async function() {
    expect(await this.token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH()).to.equal(
      TRANSFER_WITH_AUTHORIZATION_TYPEHASH
    );

    expect(await this.token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH()).to.equal(
      RECEIVE_WITH_AUTHORIZATION_TYPEHASH
    );
    expect(await this.token.CANCEL_AUTHORIZATION_TYPEHASH()).to.equal(
      CANCEL_AUTHORIZATION_TYPEHASH
    );
  });


  describe("transferWithAuthorization", function() {
    function transferWithAuthorizationBatchSetup(sender, recipient, transactionValue, domainSeparator, batches=5) {
      var rs = [];
      var ss = [];
      var vs = [];
      var tos = [];
      var transactionValues = [];
      var froms = [];
      var validAfters = [];
      var validBefores = [];
      var nonces = [];


      // Create arguments.
      for (var i = 0; i < batches; i++) {
        sender = ACCOUNTS[i + 2];
        froms.push(sender.address)
        tos.push(recipient.address)
        transactionValues.push(transactionValue)
        validAfters.push(0)
        validBefores.push(MAX_UINT256)
        nonce = ethers.hexlify(ethers.randomBytes(32))
        nonces.push(nonce);

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
        vs.push(v)
        rs.push(r)
        ss.push(s)
      }

      return [vs, rs, ss, tos, transactionValues, froms, validAfters, validBefores, nonces]
    }


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
      // var transactionRecp = await web3.eth.getTransactionReceipt(result.logs[0].transactionHash);
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

    it("executes transferWithAuthorizationBatch with a valid authorization", async function() {
      const batches = 5;
      let [vs, rs, ss, tos, transactionValues, froms, validAfters, validBefores, nonces] = transferWithAuthorizationBatchSetup(sender, recipient, transactionValue, domainSeparator, batches);
 
      for (from of froms) {
        // Fund sender from owner
        await this.token.transfer(from, transactionValue);
      }

      // Execute the transaction
      const result = await this.token.connect(this.spender).transferWithAuthorizationBatch(
        froms,
        tos,
        transactionValues,
        validAfters,
        validBefores,
        nonces,
        vs,
        rs,
        ss,
      );

      var transactionRecp = await result.wait()
      assert.equal(transactionRecp.status, 1, 'transferWithAuthorizationBatch transaction failed');

      log_line = 0
      for (i = 0; i < batches; i++, log_line = log_line + 2) {
        // check sender balance is updated
        expect(BigInt(await this.token.balanceOf(froms[i]))).to.equal(0);

        // check that AuthorizationUsed event is emitted
        await expect(result)
        .to.emit(this.token, "AuthorizationUsed")
        .withArgs(froms[i], nonces[i])
        .and.to.emit(this.token, "Transfer")
        .withArgs(froms[i], tos[i], transactionValue)

        // nonce should be used.
        expect(await this.token.authorizationState(froms[i], nonces[i])).to.be.true;
      }
      // check recipient balance is updated
      expect(BigInt(await this.token.balanceOf(tos[0]))).to.equal(transactionValue * batches);
    });

    it("reverts transferWithAuthorizationBatch when there is argument length mismatch", async function() {
      let [vs, rs, ss, tos, transactionValues, froms, validAfters, validBefores, nonces] = transferWithAuthorizationBatchSetup(sender, recipient, transactionValue, domainSeparator);

      // All test case validation is done in single test to avoid setup overhead.
      allParams = [froms, tos, transactionValues, validAfters, validBefores, nonces, vs, rs, ss]

      assert(allParams.length==9, "incomplete check for the number of arguments to transferWithAuthorizationBatch")
      for (let i = 0 ; i < allParams.length; i++) {
        const currentParam = allParams[i];
        val = currentParam.pop();
        // Execute the transaction
        await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
          froms,
          tos,
          transactionValues,
          validAfters,
          validBefores,
          nonces,
          vs,
          rs,
          ss,
        )).to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch")
        currentParam.push(val);
      }
    });

    it("reverts transferWithAuthorizationBatch when contract is paused", async function() {
      let [vs, rs, ss, tos, transactionValues, froms, validAfters, validBefores, nonces] = transferWithAuthorizationBatchSetup(sender, recipient, transactionValue, domainSeparator);

      this.token.pause();

      // Execute the transaction
       await expect(this.token.connect(this.spender).transferWithAuthorizationBatch(
        froms,
        tos,
        transactionValues,
        validAfters,
        validBefores,
        nonces,
        vs,
        rs,
        ss,
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");

    });

    it("executes a transferWithAuthorization with invalid params", async function() {// Sender signs the authorization
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

    it("executes a transferWithAuthorization when signed with invalid key", async function() {
      const { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue * 2,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        recipient.key
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

    it("reverts if the authorization has already been used", async function() {
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

      // Fund sender from owner
      await this.token.transfer(sender.address, senderBalance);

      // Valid transfer
      this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
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
      )).to.emit(this.token, "AuthorizationAlreadyUsed")
      .withArgs(sender.address, nonce)
    });

    it("reverts when nonce that has already been used by the signer", async function() {
      var { v, r, s } = signTransferAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender.key
      );

      // Fund sender from owner
      await this.token.transfer(sender.address, senderBalance);
      await this.token.transfer(ACCOUNTS[3].address, senderBalance);

      // Valid transfer
      this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
        0,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
      );

      // Execute a different transaction.
      var { v, r, s } = signTransferAuthorization(
        sender.address,
        ACCOUNTS[3].address,
        transactionValue - 10,
        0,
        MAX_UINT256,
        nonce,
        domainSeparator,
        sender.key
      );

      await expect(this.token.connect(this.spender).transferWithAuthorization(
        sender.address,
        ACCOUNTS[3].address,
        transactionValue - 10,
        0,
        MAX_UINT256,
        nonce,
        v,
        r,
        s,
      )).to.emit(this.token, "AuthorizationAlreadyUsed")
      .withArgs(sender.address, nonce)
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
      )).to.be.revertedWithCustomError(this.token, "InsufficientFunds");
    });

    it("reverts when the receipient is frozen", async function() {
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

      // use spender as asset protection role and freeze recipient
      await this.token.grantRole(roles.ASSET_PROTECTION_ROLE, this.spender.address);
      await this.token.connect(this.assetProtectionRole).freeze(recipient.address);

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
      )).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it("reverts when authorization is not for transferWithAuthorization", async function() {
      const { v, r, s } = signReceiveAuthorization(
        sender.address,
        recipient.address,
        transactionValue,
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

    it("revert when cancellation is already used", async function() {
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

      // cancel the authorization
      await this.token.connect(this.spender).cancelAuthorization(
        from,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s,
      );
      expect(await this.token.authorizationState(from, nonce)).to.be.true;

      // submit a cancelled authorization again
      await expect(
        this.token.connect(this.spender).cancelAuthorization(
          from,
          nonce,
          cancellation.v,
          cancellation.r,
          cancellation.s,
        )).to.emit(this.token, "AuthorizationAlreadyUsed")
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

    it("revert when authorizer is frozen", async function() {
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

      // freeze authorizer
      await this.token.connect(this.assetProtectionRole).freeze(from);

      // cancel the authorization
      await expect(this.token.connect(this.spender).cancelAuthorization(
        from,
        nonce,
        cancellation.v,
        cancellation.r,
        cancellation.s,
      )).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it("executes a cancelAuthorization with invalid params", async function() {// Sender signs the authorization
      const from = sender.address;

      // check that the authorization is ununsed
      expect(await this.token.authorizationState(from, nonce)).to.be.false;

      // create cancellation
      const cancellation = signCancelAuthorization(
        //this.acc2.address, // INVALID SIGNER ADDR
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

});
