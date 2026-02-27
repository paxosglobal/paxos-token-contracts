const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { signPermit, computeFacetDomainSeparator, PERMIT_TYPEHASH, MAX_UINT256 } = require('./helpers/signature');
const { ACCOUNTS, roles } = require('./helpers/constants');
const { grantAllTestRoles, impersonateAccountWithBalance } = require('./helpers/testHelpers');

describe("TokenExtensionsFacet - EIP2612 Permit", function () {
  let domainSeparator;

  let sender = ACCOUNTS[0];
  let recipient = ACCOUNTS[1];
  let deadline = MAX_UINT256;
  let senderBalance = 10e6;
  let transactionValue = 1e6;
  let permitAllowance = 10e6;
  let nonce = 0;

  const initialBalance = 100e6;

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.increaseSupplyToAddress(initialBalance, this.owner.address);
    await this.token.increaseSupply(initialBalance);
    domainSeparator = await computeFacetDomainSeparator(this.token);

    this.spender = this.acc2;
  });

  // Note: PERMIT_TYPEHASH constant is not exposed as public getter in the facet

  it("executes a transferFrom with a valid authorization", async function() {
    // Fund sender
    await this.token.transfer(sender.address, senderBalance);

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );
    // Spender executes the permit transaction
    var result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'Permit transaction failed');
    expect(BigInt(await this.token.nonces(sender.address))).to.equal(1);
    expect(BigInt(await this.token.balanceOf(recipient.address))).to.equal(0);

    result = await this.token.connect(this.spender).transferFrom(sender.address, recipient.address, transactionValue)
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'TransferFrom transaction failed');

    expect(BigInt(await this.token.balanceOf(sender.address))).to.equal(
      senderBalance - transactionValue);
    expect(BigInt(await this.token.balanceOf(recipient.address))).to.equal(
      transactionValue);
  });

  it("revert when deadline is expired", async function() {
    // Use blockchain time to ensure deadline is actually expired
    const { time } = require('@nomicfoundation/hardhat-network-helpers');
    const currentTime = await time.latest();
    var deadline = currentTime - 10; // 10 seconds ago in blockchain time

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      deadline,
      domainSeparator,
      sender.key
    );

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "PermitExpired");
  });

  it("revert when signature is invalid", async function() {
    // incorrect user signs the permit
    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      Math.floor(Date.now() / 1000) + 1000,
      domainSeparator,
      ACCOUNTS[3].key
    );

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance + 10e6, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "InvalidSignature");
  });

  it("multiple permit with incremental nonce should be success", async function() {
    var { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      deadline,
      domainSeparator,
      sender.key
    );

    result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s);
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'Permit transaction failed');

    var { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce + 1,
      deadline,
      domainSeparator,
      sender.key
    );

    result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s);
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'Permit transaction failed');
  });

  it("revert when multiple permit with non-incremental nonce", async function() {
    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      deadline,
      domainSeparator,
      sender.key
    );
    result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s);
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'Permit transaction failed');

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "InvalidSignature");
  });

  it("reverts when owner is zero address", async function() {
    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );

    await expect(
      this.token.connect(this.spender).permit(ZeroAddress, this.spender.address, permitAllowance, deadline, v, r, s)
    ).to.be.revertedWithCustomError(this.token, "ZeroAddress");
  });

  it("reverts when spender is zero address", async function() {
    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );

    await expect(
      this.token.connect(this.spender).permit(sender.address, ZeroAddress, permitAllowance, deadline, v, r, s)
    ).to.be.revertedWithCustomError(this.token, "ZeroAddress");
  });

  it("revert when contract is paused", async function() {
    await this.token.pause();

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      deadline,
      domainSeparator,
      sender.key
    );

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "ContractPaused");
    // Unpause
    await this.token.unpause();
    result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s);
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'Permit transaction failed');
  });

  it("revert permit when sender is ZeroAddress", async function() {
    const { v, r, s } = signPermit(
      ZeroAddress,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );

    await expect(this.token.connect(this.spender).permit(ZeroAddress, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "ZeroAddress");
  });

  it("revert permit when spender is ZeroAddress", async function() {
    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );

    await expect(this.token.connect(this.spender).permit(sender.address, ZeroAddress, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "ZeroAddress");
  });

  describe("ECrecover test cases", function() {
    it("ECrecover, invalid v", async function() {
      const { _, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        deadline,
        domainSeparator,
        sender.key
      );

      await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, 35, r, s)).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });

    it("ECrecover, invalid s", async function() {
      const { v, r, _ } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        deadline,
        domainSeparator,
        sender.key
      );

      await expect(this.token.connect(this.spender)
        .permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, "0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1"))
        .to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });
  });

  describe("Permit Cancellation", function() {
    it("should cancel a single permit", async function() {
      const testSigner = this.acc;
      const initialNonce = await this.token.nonces(testSigner.address);

      await expect(this.token.connect(testSigner).cancelPermits(1))
        .to.emit(this.token, "PermitInvalidated")
        .withArgs(testSigner.address, initialNonce + BigInt(1));

      const newNonce = await this.token.nonces(testSigner.address);
      expect(newNonce).to.equal(initialNonce + BigInt(1));
    });

    it("should cancel multiple permits", async function() {
      const testSigner = this.acc;
      const initialNonce = await this.token.nonces(testSigner.address);
      const count = 5;

      await expect(this.token.connect(testSigner).cancelPermits(count))
        .to.emit(this.token, "PermitInvalidated")
        .withArgs(testSigner.address, initialNonce + BigInt(count));

      const newNonce = await this.token.nonces(testSigner.address);
      expect(newNonce).to.equal(initialNonce + BigInt(count));
    });

    it("should cancel pending permit", async function() {
      await this.token.transfer(sender.address, senderBalance);
      const currentNonce = await this.token.nonces(sender.address);

      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        Number(currentNonce),
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const senderSigner = await impersonateAccountWithBalance(sender.address);

      await this.token.connect(senderSigner).cancelPermits(1);

      await expect(
        this.token.connect(this.spender).permit(
          sender.address,
          this.spender.address,
          permitAllowance,
          MAX_UINT256,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });

    it("should cancel multiple pending permits", async function() {
      await this.token.transfer(sender.address, senderBalance);
      const currentNonce = await this.token.nonces(sender.address);

      const permit1 = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        Number(currentNonce),
        MAX_UINT256,
        domainSeparator,
        sender.key
      );
      const permit2 = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        Number(currentNonce) + 1,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );
      const permit3 = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        Number(currentNonce) + 2,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const senderSigner = await impersonateAccountWithBalance(sender.address);

      await this.token.connect(senderSigner).cancelPermits(3);

      await expect(
        this.token.connect(this.spender).permit(
          sender.address,
          this.spender.address,
          permitAllowance,
          MAX_UINT256,
          permit1.v,
          permit1.r,
          permit1.s
        )
      ).to.be.revertedWithCustomError(this.token, "InvalidSignature");

      await expect(
        this.token.connect(this.spender).permit(
          sender.address,
          this.spender.address,
          permitAllowance,
          MAX_UINT256,
          permit2.v,
          permit2.r,
          permit2.s
        )
      ).to.be.revertedWithCustomError(this.token, "InvalidSignature");

      await expect(
        this.token.connect(this.spender).permit(
          sender.address,
          this.spender.address,
          permitAllowance,
          MAX_UINT256,
          permit3.v,
          permit3.r,
          permit3.s
        )
      ).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });

    it("should allow new permit after cancellation", async function() {
      await this.token.transfer(sender.address, senderBalance);

      const senderSigner = await impersonateAccountWithBalance(sender.address);

      await this.token.connect(senderSigner).cancelPermits(1);

      const newNonce = await this.token.nonces(sender.address);

      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        Number(newNonce),
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      await expect(
        this.token.connect(this.spender).permit(
          sender.address,
          this.spender.address,
          permitAllowance,
          MAX_UINT256,
          v,
          r,
          s
        )
      ).to.not.be.reverted;

      expect(await this.token.allowance(sender.address, this.spender.address))
        .to.equal(permitAllowance);
    });

    it("should revert when canceling zero permits", async function() {
      const testSigner = this.acc2;
      await expect(
        this.token.connect(testSigner).cancelPermits(0)
      ).to.be.revertedWithCustomError(this.token, "InvalidNonceCount");
    });

    it("should revert when canceling more than MAX_NONCE_INCREMENT permits", async function() {
      const testSigner = this.acc2;
      const MAX_NONCE_INCREMENT = await this.token.MAX_NONCE_INCREMENT();

      await expect(
        this.token.connect(testSigner).cancelPermits(Number(MAX_NONCE_INCREMENT) + 1)
      ).to.be.revertedWithCustomError(this.token, "InvalidNonceCount");
    });

    it("should allow canceling exactly MAX_NONCE_INCREMENT permits", async function() {
      const testSigner = this.acc2;
      const MAX_NONCE_INCREMENT = await this.token.MAX_NONCE_INCREMENT();
      const initialNonce = await this.token.nonces(testSigner.address);

      await expect(this.token.connect(testSigner).cancelPermits(Number(MAX_NONCE_INCREMENT)))
        .to.emit(this.token, "PermitInvalidated")
        .withArgs(testSigner.address, initialNonce + MAX_NONCE_INCREMENT);

      const newNonce = await this.token.nonces(testSigner.address);
      expect(newNonce).to.equal(initialNonce + MAX_NONCE_INCREMENT);
    });

    it("should track cancellations independently per address", async function() {
      const signer1 = this.acc2;
      const signer2 = this.owner;

      const signer1Nonce = await this.token.nonces(signer1.address);
      const signer2Nonce = await this.token.nonces(signer2.address);

      await this.token.connect(signer1).cancelPermits(3);
      await this.token.connect(signer2).cancelPermits(5);

      expect(await this.token.nonces(signer1.address))
        .to.equal(signer1Nonce + BigInt(3));
      expect(await this.token.nonces(signer2.address))
        .to.equal(signer2Nonce + BigInt(5));
    });

    it("should revert when contract is paused", async function() {
      const testSigner = this.acc2;

      await this.token.pause();

      await expect(
        this.token.connect(testSigner).cancelPermits(1)
      ).to.be.revertedWithCustomError(this.token, "ContractPaused");

      await this.token.unpause();

      // Should succeed after unpause
      await expect(this.token.connect(testSigner).cancelPermits(1))
        .to.emit(this.token, "PermitInvalidated");
    });
  });

  describe("Permit with bytes signature", function() {
    it("executes a permit with valid bytes signature", async function() {
      await this.token.transfer(sender.address, senderBalance);

      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      var result = await this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        sender.address, 
        this.spender.address, 
        permitAllowance, 
        deadline, 
        signature
      );
      var transactionRecp = await result.wait()
      assert.equal(transactionRecp.status, 1, 'Permit transaction failed');
      expect(BigInt(await this.token.nonces(sender.address))).to.equal(1);
      
      expect(await this.token.allowance(sender.address, this.spender.address))
        .to.equal(permitAllowance);
    });

    it("revert bytes signature permit when deadline is expired", async function() {
      const { time } = require('@nomicfoundation/hardhat-network-helpers');
      const currentTime = await time.latest();
      var deadline = currentTime - 10;

      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        deadline,
        domainSeparator,
        sender.key
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      await expect(this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        sender.address, 
        this.spender.address, 
        permitAllowance, 
        deadline, 
        signature
      )).to.be.revertedWithCustomError(this.token, "PermitExpired");
    });

    it("revert bytes signature permit when signature is invalid", async function() {
      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        Math.floor(Date.now() / 1000) + 1000,
        domainSeparator,
        ACCOUNTS[3].key // wrong signer
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      await expect(this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        sender.address,
        this.spender.address,
        permitAllowance,
        deadline,
        signature
      )).to.be.revertedWithCustomError(this.token, "InvalidSignature");
    });

    it("revert bytes signature permit when contract is paused", async function() {
      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      await this.token.pause();

      await expect(this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        sender.address,
        this.spender.address,
        permitAllowance,
        deadline,
        signature
      )).to.be.revertedWithCustomError(this.token, "ContractPaused");
    });

    it("revert bytes signature permit when owner is zero address", async function() {
      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      await expect(this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        ZeroAddress,
        this.spender.address,
        permitAllowance,
        deadline,
        signature
      )).to.be.revertedWithCustomError(this.token, "ZeroAddress");
    });

    it("revert bytes signature permit when spender is zero address", async function() {
      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        permitAllowance,
        nonce,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [r, s, v]);

      await expect(this.token.connect(this.spender)['permit(address,address,uint256,uint256,bytes)'](
        sender.address,
        ZeroAddress,
        permitAllowance,
        deadline,
        signature
      )).to.be.revertedWithCustomError(this.token, "ZeroAddress");
    });
  });
});
