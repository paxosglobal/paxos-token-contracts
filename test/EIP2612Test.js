const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { signPermit, PERMIT_TYPEHASH, MAX_UINT256 } = require('./helpers/signature');
const { ACCOUNTS, roles } = require('./helpers/constants');

describe("EIP2612", function () {
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
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    await this.token.increaseSupplyToAddress(initialBalance, this.owner.address);
    await this.token.increaseSupply(initialBalance);
    domainSeparator = await this.token.DOMAIN_SEPARATOR()

    this.spender = this.acc2;
  });

  it("has the expected type hash for permit", async function() {
    expect(await this.token.PERMIT_TYPEHASH()).to.equal(
      PERMIT_TYPEHASH
    );
  });

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
    assert.equal(transactionRecp.status, 1, 'Pemit transaction failed');
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

  it("executes a BATCH transferFrom with a valid authorization", async function() {
    const batches = 5;
    var senders = [];
    var recipients = [];
    var amounts = [];

    for (var i = 0; i < batches; i++) {
      var sender = ACCOUNTS[i + 2]
      // Fund sender
      await this.token.transfer(sender.address, transactionValue);

      senders.push(sender.address)
      recipients.push(recipient.address)
      amounts.push(transactionValue)

      const { v, r, s } = signPermit(
        sender.address,
        this.spender.address,
        transactionValue * (batches + 1),
        nonce,
        MAX_UINT256,
        domainSeparator,
        sender.key
      );

      // Spender executes the permit transaction
      var result = await this.token.connect(this.spender).permit(sender.address, this.spender.address, transactionValue * (batches + 1), deadline, v, r, s)
      var transactionRecp = await result.wait()
      assert.equal(transactionRecp.status, 1, 'Pemit transaction failed');
    }
    result = await this.token.connect(this.spender).transferFromBatch(senders, recipients, amounts)
    var transactionRecp = await result.wait()
    assert.equal(transactionRecp.status, 1, 'TransferFromBatch transaction failed');

    expect(BigInt(await this.token.balanceOf(recipient.address))).to.equal(
      transactionValue * (batches));
  });

  it("revert when deadline is expired", async function() {
    var deadline = Math.floor(Date.now() / 1000) - 10;

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
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

  it("revert when spender address is frozen", async function() {
    // Spender freezes itself for the test.
    await this.token.connect(this.assetProtectionRole).freeze(this.spender.address);

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
  });

  it("revert when owner address is frozen", async function() {
    // Spender freezes owner for the test.
    await this.token.connect(this.assetProtectionRole).freeze(sender.address);

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );
    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
  });

  it("revert transferFromBatch when spender is frozen", async function() {
    // Freeze sender address
    await this.token.connect(this.assetProtectionRole).freeze(sender.address);

    const { v, r, s } = signPermit(
      sender.address,
      this.spender.address,
      permitAllowance,
      nonce,
      MAX_UINT256,
      domainSeparator,
      sender.key
    );
    // Freeze spender address.
    await this.token.connect(this.assetProtectionRole).freeze(this.spender.address);

    await expect(this.token.connect(this.spender).transferFromBatch([sender.address], [this.spender.address], [permitAllowance])).to.be.revertedWithCustomError(this.token, "AddressFrozen");
  });

  it("revert transferFrom when spender is frozen", async function() {
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
    await this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)

    // Freeze spender address.
    await this.token.connect(this.assetProtectionRole).freeze(this.spender.address);

    await expect(this.token.connect(this.spender).transferFrom(sender.address, recipient.address, transactionValue)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
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
    assert.equal(transactionRecp.status, 1, 'TransferFromBatch transaction failed');

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
    assert.equal(transactionRecp.status, 1, 'TransferFromBatch transaction failed');

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
    assert.equal(transactionRecp.status, 1, 'TransferFromBatch transaction failed');

    await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, v, r, s)).to.be.revertedWithCustomError(this.token, "InvalidSignature");
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
    assert.equal(transactionRecp.status, 1, 'TransferFromBatch transaction failed');

    // Pause again to check transferFrom and transferFromBatch
    await this.token.pause();
    await expect(this.token.connect(this.spender).transferFrom(sender.address, recipient.address, transactionValue)).to.be.revertedWithCustomError(this.token, "ContractPaused");
    await expect(this.token.connect(this.spender).transferFromBatch([sender.address], [recipient.address], [transactionValue])).to.be.revertedWithCustomError(this.token, "ContractPaused");
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

      await expect(this.token.connect(this.spender).permit(sender.address, this.spender.address, permitAllowance, deadline, 35, r, s)).to.be.revertedWithCustomError(this.token, "InvalidECRecoverSignature"); 
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
        .to.be.revertedWithCustomError(this.token, "InvalidValueS");
    });
  });
});
