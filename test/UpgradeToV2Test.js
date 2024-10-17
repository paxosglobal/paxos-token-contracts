const { deployXYZFixtureV1 } = require('./helpers/fixtures');
const { abi: xyzAbi }= require("../artifacts/contracts/PaxosTokenV2.sol/PaxosTokenV2.json")
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert } = require('chai');
const { isStorageLayoutModified } = require('./helpers/storageLayout');
const { limits } = require('./helpers/constants');
const { MaxUint256 } = require("hardhat").ethers;

const XYZ_V1 = "V1"
const XYZ_V2 = "V2"

// Testing an the upgrade is focused on testing the consistency of the memory model. The goal of this test is to
// read every piece of mutable data (constants are not in storage anyway) that exists in the old version
// and make sure it doesn't change in the upgrade.

// We are testing from V1 to V2.
describe('UpgradeToV2', function () {
  let supply;
  let amount;
  let subAmount;
  let admin, owner, supplyController, assetProtection, recipient, purchaser, holder, bystander, frozen;
  let ownerSigner, adminSigner, supplyControllerSigner, assetProtectionSigner, recipientSigner, purchaserSigner, holderSigner, bystanderSigner, frozenSigner;

  beforeEach(async function () {
    // set all types of data - roles, balances, approvals, freezes
    this.setData = async function (version) {
      // set roles
      if (version == XYZ_V2) {
        await this.supplyControl.addSupplyController(supplyController, MaxUint256, limits.REFILL_PER_SECOND, [supplyController], false, {from: owner})
      } else {
        await this.token.setSupplyController(supplyController);
      }

      // emulate some purchases and transfers

      if (version == XYZ_V2) {
        await this.token.connect(supplyControllerSigner).increaseSupplyToAddress(supply, supplyController);
      } else {
        await this.token.connect(supplyControllerSigner).increaseSupply(supply);
      }
      await this.token.connect(supplyControllerSigner).transfer(purchaser, amount);
      await this.token.connect(supplyControllerSigner).transfer(holder, amount);
      await this.token.connect(purchaserSigner).transfer(recipient, BigInt(10) + subAmount);
  
      // emulate a redemption
      await this.token.connect(purchaserSigner).transfer(supplyController, subAmount);
      if (version == XYZ_V2) {
        await this.token.connect(supplyControllerSigner).decreaseSupplyFromAddress(subAmount, supplyController);
      } else {
        await this.token.connect(supplyControllerSigner).decreaseSupply(subAmount);
      }
  
      // make an approval
      await this.token.connect(holderSigner).approve(bystander, subAmount);
  
      // freeze someone
      await this.token.connect(assetProtectionSigner).freeze(frozen);
    };

    this.checkData = async function () {
      assert.strictEqual(this.owner, await this.token.owner());
      assert.strictEqual(this.currentSC, await this.token.supplyControllerDeprecated());
      assert.strictEqual(this.currentAP, await this.token.assetProtectionRoleDeprecated());
      assert.deepStrictEqual(this.scBalance, await this.token.balanceOf(supplyController));
      assert.deepStrictEqual(this.purchaserBalance, await this.token.balanceOf(purchaser));
      assert.deepStrictEqual(this.holderBalance, await this.token.balanceOf(holder));
      assert.deepStrictEqual(this.bystanderApproval, await this.token.allowance(holder, bystander));
      assert.deepStrictEqual(this.frozenApproval, await this.token.allowance(holder, frozen)); // 0
      assert.strictEqual(this.bystanderFrozen, await this.token.isFrozen(bystander));
      // assert.strictEqual(this.frozenFrozen, await this.token.isFrozen(frozen)); //This is actually different behavior
      assert.deepStrictEqual(this.totalSupply, await this.token.totalSupply());
      assert.strictEqual(this.paused, await this.token.paused());
    };

    // deploy the contracts
    [ownerSigner, adminSigner, supplyControllerSigner, assetProtectionSigner, recipientSigner, purchaserSigner, holderSigner, bystanderSigner, frozenSigner] = await hre.ethers.getSigners();
    [owner, admin, supplyController, assetProtection, recipient, purchaser, holder, bystander, frozen] = [ownerSigner.address, adminSigner.address, supplyControllerSigner.address, assetProtectionSigner.address, recipientSigner.address, purchaserSigner.address, holderSigner.address, bystanderSigner.address, frozenSigner.address]
    Object.assign(this, await loadFixture(deployXYZFixtureV1));

    supply = BigInt(1000);
    amount = BigInt(100);
    subAmount = BigInt(10);
    await this.setData(XYZ_V1);

    // read the data - note: the data here is always read before the upgrade

    this.currentSC = await this.token.supplyController();
    assert.strictEqual(this.currentSC, supplyController);
    this.currentAP = await this.token.assetProtectionRole();
    assert.strictEqual(this.currentAP, assetProtection);

    // other things that shouldn't change
    this.owner = await this.token.owner();
    this.scBalance = await this.token.balanceOf(supplyController);
    this.purchaserBalance = await this.token.balanceOf(purchaser);
    this.holderBalance = await this.token.balanceOf(holder);
    this.bystanderApproval = await this.token.allowance(holder, bystander);
    this.frozenApproval = await this.token.allowance(holder, frozen); // 0
    this.bystanderFrozen = await this.token.isFrozen(bystander);
    this.frozenFrozen = await this.token.isFrozen(frozen);
    this.totalSupply = await this.token.totalSupply();
    this.paused = await this.token.paused();
  });

  it('can survive and integration test when not paused', async function () {
    const implNew = await hre.ethers.deployContract("PaxosTokenV2")

    //Upgrade
    const SanctionListContract = require('./artifacts/IAddressList.json');

    const xyzInterface = new ethers.Interface(xyzAbi)
    const data = xyzInterface.encodeFunctionData("initialize", [
      60*60*3,
      this.owner,
      this.owner,
      assetProtection
    ])
    const tx = await this.proxy.connect(adminSigner).upgradeToAndCall(await implNew.getAddress(), data)
    this.token = implNew.attach(await this.proxy.getAddress())

    // check that the data on the contract is the same as what was read before the upgrade
    await this.checkData();

    // can still pause
    await this.token.pause({from: owner});
    this.paused = await this.token.paused();
    assert.isTrue(this.paused);
  });

  it('can survive and integration test when paused', async function () {
    // pause
    await this.token.pause({from: owner});
    this.paused = await this.token.paused();
    assert.isTrue(this.paused);

    const implNew = await hre.ethers.deployContract("PaxosTokenV2")
    //Upgrade
    const SanctionListContract = require('./artifacts/IAddressList.json');

    const xyzInterface = new ethers.Interface(xyzAbi)
    const data = xyzInterface.encodeFunctionData("initialize", [
      60*60*3,
      this.owner,
      this.owner,
      assetProtection
    ])
    const tx = await this.proxy.connect(adminSigner).upgradeToAndCall(await implNew.getAddress(), data)
    this.token = implNew.attach(await this.proxy.getAddress())

    // check that the data on the contract is the same as what was read before the upgrade
    await this.checkData();

    // unpause
    await this.token.unpause({from: owner});
    this.paused = await this.token.paused();
    assert.isFalse(this.paused);
  });

  it('gives the same result as if we upgraded first', async function () {
    const xyz = await hre.ethers.deployContract("XYZImplementationV1")
    let ContractFactory = await hre.ethers.getContractFactory("AdminUpgradeabilityProxy");
    const proxy = await ContractFactory.connect(adminSigner).deploy(await xyz.getAddress())
    await proxy.waitForDeployment()
    const proxiedXYZ = await xyz.attach(await proxy.getAddress())
  
    await proxiedXYZ.initialize();
    await proxiedXYZ.setAssetProtectionRole(assetProtection);
    await proxiedXYZ.setSupplyController(supplyController);

    // make sure these are new contracts
    assert.notStrictEqual(await this.token.getAddress(), await proxiedXYZ.getAddress());
    assert.notStrictEqual(await this.proxy.getAddress(), await proxy.getAddress());
    this.token = proxiedXYZ;
    const paxosTokenV2 = await hre.ethers.deployContract("PaxosTokenV2")
    const xyzInterface = new ethers.Interface(xyzAbi)

    const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
    this.supplyControl = await upgrades.deployProxy(supplyControlFactory, [this.owner, this.owner, await proxy.getAddress(), []], {
      initializer: "initialize",
    });
    const data = xyzInterface.encodeFunctionData("initialize", [
      60*60*3,
      this.owner,
      this.owner,
      assetProtection,
    ])
    const tx = await proxy.connect(adminSigner).upgradeToAndCall(await paxosTokenV2.getAddress(), data)
    this.token = paxosTokenV2.attach(await proxy.getAddress());
    await this.token.setSupplyControl(await this.supplyControl.getAddress())

    const SanctionListContract = require('./artifacts/IAddressList.json');

    // set the data on the new contracts after the upgrade this time
    await this.setData(XYZ_V2);
    // check that the data on the contract is the same as what was read before the upgrade
    await this.checkData();
  });


  it('has the same storage layout', async function () {
    const oldFullQualifiedName = "contracts/archive/XYZImplementationV1.sol:XYZImplementationV1";
    const newFullQualifiedName = "contracts/PaxosTokenV2.sol:PaxosTokenV2";
    assert.isFalse(await isStorageLayoutModified(oldFullQualifiedName, newFullQualifiedName))
  });
});
