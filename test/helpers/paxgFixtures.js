const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;

const PAXG_V1 = "PAXGImplementation"
const PAXG_V2 = "PAXG"

async function deploySupplyControlFixture(owner, proxiedToken) {
  const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
  const scInitializationConfig = [[owner.address, [MaxUint256, 0], [owner.address], false]];
  const supplyControl = await upgrades.deployProxy(supplyControlFactory, [owner.address, owner.address, await proxiedToken.getAddress(), scInitializationConfig], {
    initializer: "initialize",
  });

  await proxiedToken.setSupplyControl(await supplyControl.getAddress());

  return supplyControl;
}

async function deployPAXGFixtureV1() {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();

  const paxgImpl = await ethers.deployContract(PAXG_V1);
  const ProxyFactory = await ethers.getContractFactory("AdminUpgradeabilityProxy");
  const proxy = await ProxyFactory.connect(admin).deploy(await paxgImpl.getAddress());
  await proxy.waitForDeployment();

  const token = paxgImpl.attach(await proxy.getAddress());
  await token.initialize();

  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token, amount, proxy };
}

async function deployPAXGFixtureV2() {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();

  const paxgImpl = await ethers.deployContract(PAXG_V2);
  const ProxyFactory = await ethers.getContractFactory("AdminUpgradeabilityProxy");
  const proxy = await ProxyFactory.connect(admin).deploy(await paxgImpl.getAddress());
  await proxy.waitForDeployment();

  const token = paxgImpl.attach(await proxy.getAddress());
  // PAXG.initialize calls super.initialize; on fresh deploy, skips migration
  await token.initialize(0, owner.address, owner.address, assetProtectionRole.address);

  const supplyControl = await deploySupplyControlFixture(owner, token);

  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token, amount, proxy, supplyControl };
}

module.exports = {
  deployPAXGFixtureV1,
  deployPAXGFixtureV2,
  deploySupplyControlFixture,
}
