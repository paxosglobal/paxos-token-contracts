const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;
const { limits } = require('./constants');

const XYZ_V1 = "XYZImplementationV1"
const PAXOS_TOKEN_V2 = "PaxosTokenV2"

async function InitializePaxosTokenContract(admin, owner, assetProtectionRole, contractName) {
  const contract = await ethers.deployContract(contractName)
  let ContractFactory = await ethers.getContractFactory("AdminUpgradeabilityProxy");
  const proxy = await ContractFactory.connect(admin).deploy(await contract.getAddress())
  await proxy.waitForDeployment()
  const proxiedPaxosToken = contract.attach(await proxy.getAddress())
  let supplyControl;

  if (contractName == XYZ_V1) { //V1 uses old initialization pattern
    await proxiedPaxosToken.initialize();
    await proxiedPaxosToken.setAssetProtectionRole(assetProtectionRole.address);
  } else {
    await proxiedPaxosToken.initialize(0, owner.address, owner.address, assetProtectionRole.address);
    supplyControl = await deploySupplyControlFixture(owner, proxiedPaxosToken);
  }

  return [proxiedPaxosToken, proxy, supplyControl];
};

async function deploySupplyControlFixture(owner, proxiedPaxosToken) {
  const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
  const scInitializationConfig = [[owner.address, [MaxUint256, limits.REFILL_PER_SECOND], [owner.address], false]]
  supplyControl = await upgrades.deployProxy(supplyControlFactory, [owner.address, owner.address, await proxiedPaxosToken.getAddress(), scInitializationConfig], {
    initializer: "initialize",
  });
  await proxiedPaxosToken.setSupplyControl(await supplyControl.getAddress())

  return supplyControl;
}

async function deployContractFixture(contractName) {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();
  const [token, proxy, supplyControl] = await InitializePaxosTokenContract(admin, owner, assetProtectionRole, contractName);
  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token, amount, proxy, supplyControl };
}

async function deployUUPSContractFixture(contractName) {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();

  const initializerArgs = [0, owner.address, owner.address, assetProtectionRole.address];
  const contractFactory = await ethers.getContractFactory(contractName);
  const token = await upgrades.deployProxy(contractFactory, initializerArgs, {
    initializer: "initialize",
  });

  supplyControl = await deploySupplyControlFixture(owner, token);

  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token, amount, supplyControl };
}

async function deployXYZFixtureV1() {
  return deployContractFixture(XYZ_V1)
}

async function deployPaxosTokenFixtureV2() {
  return deployContractFixture(PAXOS_TOKEN_V2)
}

async function deployPaxosTokenFixtureLatest() {
    return deployPaxosTokenFixtureV2();
}

async function deployStableCoinFixturePYUSD() {
  return deployContractFixture("PYUSD");
}

async function deployStableCoinFixtureUSDP() {
  return deployContractFixture("USDP");
}

async function deployStableCoinFixtureUSDG() {
  return deployUUPSContractFixture("USDG");
}

async function deployRateLimitTest() {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();
  const rateLimit = await ethers.deployContract("RateLimitFixture", [[limits.LIMIT_CAPACITY, limits.REFILL_PER_SECOND]])
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, rateLimit };
}


module.exports = {
  InitializePaxosTokenContract,
  deployXYZFixtureV1,
  deployPaxosTokenFixtureV2,
  deployPaxosTokenFixtureLatest,
  deployStableCoinFixturePYUSD,
  deployStableCoinFixtureUSDP,
  deployStableCoinFixtureUSDG,
  deployRateLimitTest
}
