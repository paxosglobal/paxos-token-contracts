const { deployPAXGFixtureV1, deploySupplyControlFixture } = require('../helpers/paxgFixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert } = require('chai');
const { expect } = require('chai');
const { MaxUint256 } = require("hardhat").ethers;
const { limits, ACCOUNTS } = require('../helpers/constants');
const { signPermit, signTransferAuthorization, MAX_UINT256 } = require('../helpers/signature');
const { impersonateAccountWithBalance } = require('../helpers/testHelpers');

const PAXG_V1 = "V1"
const PAXG_V2 = "V2"

// Testing the upgrade is focused on testing the consistency of the storage model.
// The goal is to read every piece of mutable data that exists in V1 and make sure
// it doesn't change in the upgrade. Also verifies that the storage migration
// (scalar slot rewrites + frozen mapping override) works correctly.

describe('PAXG UpgradeToV2', function () {
  let supply;
  let amount;
  let subAmount;
  let admin, owner, supplyController, assetProtection, recipient, purchaser, holder, bystander, frozenAddr;
  let ownerSigner, adminSigner, supplyControllerSigner, assetProtectionSigner, recipientSigner, purchaserSigner, holderSigner, bystanderSigner, frozenSigner;

  beforeEach(async function () {
    this.setData = async function (version) {
      // Set roles
      if (version == PAXG_V2) {
        await this.supplyControl.addSupplyController(supplyController, MaxUint256, limits.REFILL_PER_SECOND, [supplyController], false, { from: owner });
      } else {
        await this.token.setSupplyController(supplyController);
      }

      if (version == PAXG_V1) {
        await this.token.setAssetProtectionRole(assetProtection);
      }

      // Emulate some purchases and transfers
      if (version == PAXG_V2) {
        await this.token.connect(supplyControllerSigner).increaseSupplyToAddress(supply, supplyController);
      } else {
        await this.token.connect(supplyControllerSigner).increaseSupply(supply);
      }
      await this.token.connect(supplyControllerSigner).transfer(purchaser, amount);
      await this.token.connect(supplyControllerSigner).transfer(holder, amount);
      await this.token.connect(purchaserSigner).transfer(recipient, BigInt(10) + subAmount);

      // Emulate a redemption
      await this.token.connect(purchaserSigner).transfer(supplyController, subAmount);
      if (version == PAXG_V2) {
        await this.token.connect(supplyControllerSigner).decreaseSupplyFromAddress(subAmount, supplyController);
      } else {
        await this.token.connect(supplyControllerSigner).decreaseSupply(subAmount);
      }

      // Make an approval
      await this.token.connect(holderSigner).approve(bystander, subAmount);

      // Freeze someone
      await this.token.connect(assetProtectionSigner).freeze(frozenAddr);
    };

    this.checkData = async function () {
      // ownerDeprecated is at slot 4 low bytes — same position in both layouts
      assert.strictEqual(this.owner, await this.token.ownerDeprecated());
      // Note: supplyControllerDeprecated and assetProtectionRoleDeprecated return
      // stale values (unmigrated deprecated slots) — not asserted, same as PYUSD convention
      // Balances and allowances should be unchanged (slots 1-3 are identical)
      assert.deepStrictEqual(this.scBalance, await this.token.balanceOf(supplyController));
      assert.deepStrictEqual(this.purchaserBalance, await this.token.balanceOf(purchaser));
      assert.deepStrictEqual(this.holderBalance, await this.token.balanceOf(holder));
      assert.deepStrictEqual(this.bystanderApproval, await this.token.allowance(holder, bystander));
      assert.deepStrictEqual(this.frozenApproval, await this.token.allowance(holder, frozenAddr));
      // Frozen state should be preserved (via slot 7 override)
      assert.strictEqual(this.bystanderFrozen, await this.token.isFrozen(bystander));
      assert.strictEqual(this.frozenFrozen, await this.token.isFrozen(frozenAddr));
      // Total supply and paused should be preserved (paused migrated to slot 4)
      assert.deepStrictEqual(this.totalSupply, await this.token.totalSupply());
      assert.strictEqual(this.paused, await this.token.paused());
      // Domain separator should be updated (new EIP-712 format includes chainId)
      assert.notStrictEqual(this.domainSeparator, await this.token.DOMAIN_SEPARATOR());
    };

    // Deploy the contracts
    [ownerSigner, adminSigner, supplyControllerSigner, assetProtectionSigner, recipientSigner, purchaserSigner, holderSigner, bystanderSigner, frozenSigner] = await hre.ethers.getSigners();
    [owner, admin, supplyController, assetProtection, recipient, purchaser, holder, bystander, frozenAddr] = [ownerSigner.address, adminSigner.address, supplyControllerSigner.address, assetProtectionSigner.address, recipientSigner.address, purchaserSigner.address, holderSigner.address, bystanderSigner.address, frozenSigner.address];
    Object.assign(this, await loadFixture(deployPAXGFixtureV1));

    supply = BigInt(1000);
    amount = BigInt(100);
    subAmount = BigInt(10);
    await this.setData(PAXG_V1);

    // Read the data before upgrade
    this.currentSC = await this.token.supplyController();
    assert.strictEqual(this.currentSC, supplyController);
    this.currentAP = await this.token.assetProtectionRole();
    assert.strictEqual(this.currentAP, assetProtection);

    this.owner = await this.token.owner();
    this.scBalance = await this.token.balanceOf(supplyController);
    this.purchaserBalance = await this.token.balanceOf(purchaser);
    this.holderBalance = await this.token.balanceOf(holder);
    this.bystanderApproval = await this.token.allowance(holder, bystander);
    this.frozenApproval = await this.token.allowance(holder, frozenAddr);
    this.bystanderFrozen = await this.token.isFrozen(bystander);
    this.frozenFrozen = await this.token.isFrozen(frozenAddr);
    this.totalSupply = await this.token.totalSupply();
    this.paused = await this.token.paused();
    this.domainSeparator = await this.token.EIP712_DOMAIN_HASH();
  });

  async function upgradeToV2(proxy, adminSigner, ownerAddr, assetProtection) {
    const implNew = await hre.ethers.deployContract("PAXG");
    const { abi: paxgAbi } = require("../../artifacts/contracts/stablecoins/PAXG.sol/PAXG.json");
    const paxgInterface = new ethers.Interface(paxgAbi);
    const data = paxgInterface.encodeFunctionData("initialize", [
      60 * 60 * 3,
      ownerAddr,
      ownerAddr,
      assetProtection
    ]);
    await proxy.connect(adminSigner).upgradeToAndCall(await implNew.getAddress(), data);
    return implNew.attach(await proxy.getAddress());
  }

  it('can survive an upgrade when not paused', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);
    await this.checkData();

    // Can still pause after upgrade
    await this.token.pause({ from: owner });
    assert.isTrue(await this.token.paused());
  });

  it('can survive an upgrade when paused', async function () {
    // Pause first
    await this.token.pause({ from: owner });
    this.paused = await this.token.paused();
    assert.isTrue(this.paused);

    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);
    await this.checkData();

    // Unpause after upgrade
    await this.token.unpause({ from: owner });
    assert.isFalse(await this.token.paused());
  });

  it('preserves frozen state through the migration', async function () {
    // Verify frozen before upgrade
    assert.isTrue(await this.token.isFrozen(frozenAddr));
    assert.isFalse(await this.token.isFrozen(bystander));

    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    // Frozen state preserved via slot 7 override
    assert.isTrue(await this.token.isFrozen(frozenAddr));
    assert.isFalse(await this.token.isFrozen(bystander));

    // Can freeze/unfreeze after upgrade (writes to slot 7)
    // assetProtection already has ASSET_PROTECTION_ROLE from initialize
    await this.token.connect(assetProtectionSigner).freeze(bystander);
    assert.isTrue(await this.token.isFrozen(bystander));
    await this.token.connect(assetProtectionSigner).unfreeze(bystander);
    assert.isFalse(await this.token.isFrozen(bystander));
  });

  it('gives the same result as if we upgraded first', async function () {
    // Deploy fresh V1
    const paxgV1 = await hre.ethers.deployContract("PAXGImplementation");
    const ProxyFactory = await hre.ethers.getContractFactory("AdminUpgradeabilityProxy");
    const proxy = await ProxyFactory.connect(adminSigner).deploy(await paxgV1.getAddress());
    await proxy.waitForDeployment();
    const proxiedPaxg = paxgV1.attach(await proxy.getAddress());

    await proxiedPaxg.initialize();
    await proxiedPaxg.setAssetProtectionRole(assetProtection);
    await proxiedPaxg.setSupplyController(supplyController);

    assert.notStrictEqual(await this.token.getAddress(), await proxiedPaxg.getAddress());
    this.token = proxiedPaxg;

    // Upgrade to V2 first
    this.token = await upgradeToV2(proxy, adminSigner, owner, assetProtection);

    const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
    this.supplyControl = await upgrades.deployProxy(supplyControlFactory, [owner, owner, await proxy.getAddress(), []], {
      initializer: "initialize",
    });
    await this.token.setSupplyControl(await this.supplyControl.getAddress());

    // Set the data on the new contracts after the upgrade this time
    await this.setData(PAXG_V2);
    // Check that the data on the contract is the same
    await this.checkData();
  });

  it('blocks transfers involving frozen addresses after upgrade', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    // Set up supply control so we can test minting
    const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
    const sc = await upgrades.deployProxy(supplyControlFactory, [owner, owner, await this.proxy.getAddress(), []], {
      initializer: "initialize",
    });
    await this.token.setSupplyControl(await sc.getAddress());
    await sc.addSupplyController(supplyController, MaxUint256, limits.REFILL_PER_SECOND, [supplyController], false, { from: owner });

    // frozenAddr was frozen in V1 — verify it's still blocked after upgrade
    assert.isTrue(await this.token.isFrozen(frozenAddr));

    // transfer TO frozen address should revert
    await expect(
      this.token.connect(holderSigner).transfer(frozenAddr, 1)
    ).to.be.revertedWithCustomError(this.token, "AddressFrozen");

    // transfer FROM frozen address should revert
    await expect(
      this.token.connect(frozenSigner).transfer(holder, 1)
    ).to.be.revertedWithCustomError(this.token, "AddressFrozen");

    // transferFrom with frozen msg.sender should revert
    await expect(
      this.token.connect(frozenSigner).transferFrom(holder, bystander, 1)
    ).to.be.revertedWithCustomError(this.token, "AddressFrozen");

    // approve with frozen spender should revert
    await expect(
      this.token.connect(holderSigner).approve(frozenAddr, 1)
    ).to.be.revertedWithCustomError(this.token, "AddressFrozen");

    // approve with frozen owner should revert
    await expect(
      this.token.connect(frozenSigner).approve(holder, 1)
    ).to.be.revertedWithCustomError(this.token, "AddressFrozen");

    // wipeFrozenAddress should succeed
    await this.token.connect(assetProtectionSigner).wipeFrozenAddress(frozenAddr);
    assert.deepStrictEqual(await this.token.balanceOf(frozenAddr), BigInt(0));
  });

  it('supports mint and burn after upgrade', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    // Wire up SupplyControl
    const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
    const sc = await upgrades.deployProxy(supplyControlFactory, [owner, owner, await this.proxy.getAddress(), []], {
      initializer: "initialize",
    });
    await this.token.setSupplyControl(await sc.getAddress());
    await sc.addSupplyController(supplyController, MaxUint256, limits.REFILL_PER_SECOND, [supplyController], false, { from: owner });

    const supplyBefore = await this.token.totalSupply();
    const mintAmount = BigInt(500);

    // Mint
    await this.token.connect(supplyControllerSigner).increaseSupplyToAddress(mintAmount, supplyController);
    assert.deepStrictEqual(await this.token.totalSupply(), supplyBefore + mintAmount);
    assert.deepStrictEqual(await this.token.balanceOf(supplyController), this.scBalance + mintAmount);

    // Burn
    await this.token.connect(supplyControllerSigner).decreaseSupplyFromAddress(mintAmount, supplyController);
    assert.deepStrictEqual(await this.token.totalSupply(), supplyBefore);
  });

  it('supports EIP-2612 permit after upgrade', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    // Use a known-key account for signing
    const signer = ACCOUNTS[0];
    const spenderAddr = bystander;

    // Fund the signer via impersonation of the holder
    await this.token.connect(holderSigner).transfer(signer.address, BigInt(50));

    const domainSeparator = await this.token.DOMAIN_SEPARATOR();
    const nonce = await this.token.nonces(signer.address);
    const permitAmount = BigInt(50);

    const { v, r, s } = signPermit(
      signer.address,
      spenderAddr,
      permitAmount,
      nonce,
      MAX_UINT256,
      domainSeparator,
      signer.key
    );

    // Execute permit — should succeed with V2 domain separator
    await this.token.connect(bystanderSigner).permit(
      signer.address, spenderAddr, permitAmount, MAX_UINT256, v, r, s
    );
    assert.deepStrictEqual(await this.token.allowance(signer.address, spenderAddr), permitAmount);

    // Use the allowance
    await this.token.connect(bystanderSigner).transferFrom(signer.address, bystander, permitAmount);
    assert.deepStrictEqual(await this.token.balanceOf(spenderAddr), permitAmount);
  });

  it('supports EIP-3009 transferWithAuthorization after upgrade', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    const signer = ACCOUNTS[0];
    const recipientAddr = bystander;

    // Fund the signer
    await this.token.connect(holderSigner).transfer(signer.address, BigInt(50));

    const domainSeparator = await this.token.DOMAIN_SEPARATOR();
    const transferAmount = BigInt(25);
    const validAfter = 0;
    const validBefore = MAX_UINT256;
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    const { v, r, s } = signTransferAuthorization(
      signer.address,
      recipientAddr,
      transferAmount,
      validAfter,
      validBefore,
      nonce,
      domainSeparator,
      signer.key
    );

    // Execute transferWithAuthorization
    await this.token.connect(bystanderSigner).transferWithAuthorization(
      signer.address, recipientAddr, transferAmount, validAfter, validBefore, nonce, v, r, s
    );
    assert.deepStrictEqual(await this.token.balanceOf(recipientAddr), transferAmount);
  });

  it('cannot run storage migration twice', async function () {
    this.token = await upgradeToV2(this.proxy, adminSigner, this.owner, assetProtection);

    // Trying to initialize again should fail (reinitializer guard)
    await expect(
      this.token.initialize(0, this.owner, this.owner, assetProtection)
    ).to.be.reverted;
  });

  it('works as a fresh deploy without migration', async function () {
    // Deploy PAXG fresh (no V1 predecessor) — simulates a new chain
    const paxgImpl = await hre.ethers.deployContract("PAXG");
    const ProxyFactory = await hre.ethers.getContractFactory("AdminUpgradeabilityProxy");
    const proxy = await ProxyFactory.connect(adminSigner).deploy(await paxgImpl.getAddress());
    await proxy.waitForDeployment();
    const token = paxgImpl.attach(await proxy.getAddress());

    // Initialize — should skip migration since initializedV1 is false
    await token.initialize(0, owner, owner, assetProtection);

    // Basic functionality works
    assert.equal(await token.name(), "Paxos Gold");
    assert.equal(await token.symbol(), "PAXG");
    assert.equal(await token.decimals(), 18);
    assert.isFalse(await token.paused());
    assert.deepStrictEqual(await token.totalSupply(), BigInt(0));

    // On fresh deploy, deprecated slots should be zero (no V1 data to migrate)
    const proxyAddr = await proxy.getAddress();
    const readSlot = async (s) => ethers.provider.getStorage(proxyAddr, s);
    // Slot 4: ownerDeprecated is zero on fresh deploy (V2 uses AccessControl, not slot 4)
    assert.strictEqual(BigInt(await readSlot(4)), BigInt(0));
    // Slot 13: should be zero (no feeRate, no supplyControl yet)
    assert.strictEqual(BigInt(await readSlot(13)), BigInt(0));

    // Freeze works (writes to slot 7, reads from slot 7)
    await token.connect(assetProtectionSigner).freeze(bystander);
    assert.isTrue(await token.isFrozen(bystander));
    await token.connect(assetProtectionSigner).unfreeze(bystander);
    assert.isFalse(await token.isFrozen(bystander));
  });
});
