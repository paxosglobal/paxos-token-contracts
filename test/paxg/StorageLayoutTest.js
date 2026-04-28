const { deployPAXGFixtureV1 } = require('../helpers/paxgFixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert } = require('chai');

// Verifies that after the PAXG V1 -> V2 upgrade:
// - paused is migrated from slot 5 byte 20 to slot 4 byte 20
// - mislabeled deprecated slots (5, 6, 8, 14, 15) are zeroed
// - slot 7 is left alone (still the active frozen mapping base)

describe('PAXG StorageMigration', function () {
  it('migrates paused and zeroes mislabeled deprecated slots', async function () {
    const [ownerSigner, adminSigner, , assetProtectionSigner] = await hre.ethers.getSigners();
    const { token, proxy } = await loadFixture(deployPAXGFixtureV1);

    const owner = ownerSigner.address;
    const assetProtection = assetProtectionSigner.address;

    // Set up V1 state with non-zero values in all relevant slots
    await token.setSupplyController(owner);
    await token.setAssetProtectionRole(assetProtection);
    await token.pause();
    // Set a fee rate so slot 13 is non-zero
    await token.setFeeRate(200);
    await token.setFeeController(owner);

    const proxyAddr = await proxy.getAddress();
    const readSlot = async (slot) => ethers.provider.getStorage(proxyAddr, slot);

    // Verify V1 layout before upgrade
    assert.strictEqual((BigInt(await readSlot(4)) >> BigInt(160)) & BigInt(0xff), BigInt(0), "paused NOT in slot 4 before migration");
    assert.strictEqual((BigInt(await readSlot(5)) >> BigInt(160)) & BigInt(0xff), BigInt(1), "paused in slot 5 byte 20 in V1");
    assert.notStrictEqual(BigInt(await readSlot(6)), BigInt(0), "slot 6 (assetProtectionRole) non-zero in V1");
    assert.strictEqual(BigInt(await readSlot(7)), BigInt(0), "slot 7 (frozen mapping base) already zero in V1");
    assert.notStrictEqual(BigInt(await readSlot(8)), BigInt(0), "slot 8 (supplyController) non-zero in V1");

    // Upgrade to V2
    const implNew = await hre.ethers.deployContract("PAXG");
    const { abi: paxgAbi } = require("../../artifacts/contracts/stablecoins/PAXG.sol/PAXG.json");
    const paxgInterface = new ethers.Interface(paxgAbi);
    const data = paxgInterface.encodeFunctionData("initialize", [
      60 * 60 * 3, owner, owner, assetProtection
    ]);
    await proxy.connect(adminSigner).upgradeToAndCall(await implNew.getAddress(), data);

    // Slot 4: owner preserved + paused migrated
    const v2Slot4 = await readSlot(4);
    const ownerInSlot4 = "0x" + BigInt(v2Slot4).toString(16).padStart(64, '0').slice(-40);
    assert.strictEqual(ownerInSlot4.toLowerCase(), owner.toLowerCase(), "owner preserved in slot 4");
    assert.strictEqual((BigInt(v2Slot4) >> BigInt(160)) & BigInt(0xff), BigInt(1), "paused migrated to slot 4 byte 20");

    // Mislabeled deprecated slots zeroed
    assert.strictEqual(BigInt(await readSlot(5)), BigInt(0), "slot 5 zeroed");
    assert.strictEqual(BigInt(await readSlot(6)), BigInt(0), "slot 6 zeroed");
    assert.strictEqual(BigInt(await readSlot(8)), BigInt(0), "slot 8 zeroed");
    assert.strictEqual(BigInt(await readSlot(14)), BigInt(0), "slot 14 zeroed");
    assert.strictEqual(BigInt(await readSlot(15)), BigInt(0), "slot 15 zeroed");

    // Slot 7: untouched — still the active frozen mapping base
    assert.strictEqual(BigInt(await readSlot(7)), BigInt(0), "slot 7 still zero (active frozen mapping base)");

    // Slot 13: not zeroed by migration — setSupplyControl() overwrites it
    // (still holds old feeRate until setSupplyControl is called)
  });
});
