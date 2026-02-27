const { ethers, upgrades } = require("hardhat");
const { MaxUint256 } = require("hardhat").ethers;
const { limits, timelockConfig } = require('./constants');

const PAXOS_TOKEN_V1 = "PaxosTokenV1"
const PAXOS_TOKEN_V2 = "PaxosTokenV2"
const PAXOS_TOKEN_CLAIMABLE_REWARDS = "PaxosTokenClaimableRewards"

/**
 * Extract all function selectors from a facet contract's ABI.
 * @param {Object} facetContract - Deployed facet contract with interface
 * @returns {string[]} Array of function selector bytes4 strings
 */
function getSelectorsFromFacet(facetContract) {
  const selectors = [];
  facetContract.interface.forEachFunction((func) => {
    // Get the selector for each function
    selectors.push(func.selector);
  });
  return selectors;
}

/**
 * Deploy all V3 facets and return FacetCut array for initialization.
 * Used for both fresh deployments and upgrade testing.
 * @returns {Promise<Object>} Object with:
 *   - `facetCuts`: Array of {facet, selectors} for contract initialization
 *   - `contracts`: Deployed contract instances for interface building
 *   - Legacy address properties (tokenAdmin, tokenExtensions, etc.) for compatibility
 */
async function deployAllFacets() {
  const tokenAdminFacet = await ethers.deployContract("TokenAdminFacet");
  const tokenExtensionsFacet = await ethers.deployContract("TokenExtensionsFacet");
  const claimableRewardsFacet = await ethers.deployContract("ClaimableRewardsFacet");
  const multiplierMgmtFacet = await ethers.deployContract("MultiplierMgmtFacet");
  const payoutGroupFacet = await ethers.deployContract("PayoutGroupFacet");

  await tokenAdminFacet.waitForDeployment();
  await tokenExtensionsFacet.waitForDeployment();
  await claimableRewardsFacet.waitForDeployment();
  await multiplierMgmtFacet.waitForDeployment();
  await payoutGroupFacet.waitForDeployment();

  // Build FacetCut array for contract initialization
  const facetCuts = [
    { facet: await tokenAdminFacet.getAddress(), selectors: getSelectorsFromFacet(tokenAdminFacet) },
    { facet: await tokenExtensionsFacet.getAddress(), selectors: getSelectorsFromFacet(tokenExtensionsFacet) },
    { facet: await claimableRewardsFacet.getAddress(), selectors: getSelectorsFromFacet(claimableRewardsFacet) },
    { facet: await multiplierMgmtFacet.getAddress(), selectors: getSelectorsFromFacet(multiplierMgmtFacet) },
    { facet: await payoutGroupFacet.getAddress(), selectors: getSelectorsFromFacet(payoutGroupFacet) }
  ];

  return {
    facetCuts,
    // Keep contract references for combined interface
    contracts: { tokenAdminFacet, tokenExtensionsFacet, claimableRewardsFacet, multiplierMgmtFacet, payoutGroupFacet },
    // Legacy address properties for compatibility
    tokenAdmin: await tokenAdminFacet.getAddress(),
    tokenExtensions: await tokenExtensionsFacet.getAddress(),
    claimableRewards: await claimableRewardsFacet.getAddress(),
    multiplierMgmt: await multiplierMgmtFacet.getAddress(),
    payoutGroup: await payoutGroupFacet.getAddress()
  };
}

/**
 * Create a combined interface from token and all facets.
 * This helper only creates an ethers Interface for ABI purposes; it does not
 * store contract references. The facets parameter must be the return value
 * from deployAllFacets() which includes the `contracts` field.
 * @param {Object} token - Token contract with interface property
 * @param {Object} facets - Return value from deployAllFacets()
 * @returns {ethers.Interface} Combined interface with all facet ABIs
 */
function createCombinedInterface(token, facets) {
  const combinedInterface = new ethers.Interface([
    ...token.interface.fragments,
    ...facets.contracts.claimableRewardsFacet.interface.fragments,
    ...facets.contracts.multiplierMgmtFacet.interface.fragments,
    ...facets.contracts.payoutGroupFacet.interface.fragments,
    ...facets.contracts.tokenExtensionsFacet.interface.fragments,
    ...facets.contracts.tokenAdminFacet.interface.fragments
  ]);
  return combinedInterface;
}

async function InitializePaxosTokenContract(admin, owner, assetProtectionRole, contractName) {
  let contract;

  // Library linking is no longer needed for PaxosTokenClaimableRewards after refactoring
  contract = await ethers.deployContract(contractName);
  let ContractFactory = await ethers.getContractFactory("AdminUpgradeabilityProxy");
  const proxy = await ContractFactory.connect(admin).deploy(await contract.getAddress())
  await proxy.waitForDeployment()
  const proxiedPaxosToken = contract.attach(await proxy.getAddress())
  let supplyControl;
  let facets;

  if (contractName == PAXOS_TOKEN_V1) { //V1 uses old initialization pattern
    await proxiedPaxosToken.initialize();
    await proxiedPaxosToken.setAssetProtectionRole(assetProtectionRole.address);
  } else if (contractName == PAXOS_TOKEN_CLAIMABLE_REWARDS) {
    // For ClaimableRewards: Deploy facets FIRST, then initialize with them
    facets = await deployAllFacets();

    // Initialize with facetCuts array + config
    await proxiedPaxosToken.initialize(
      0,                                    // initialDelay
      owner.address,                        // initialOwner
      owner.address,                        // pauser
      assetProtectionRole.address,          // assetProtector
      facets.facetCuts,                     // FacetCut[] array
      owner.address,                        // claimSource
      0,                                    // minRate
      0,                                    // maxRate
      {                                     // V3RoleAddresses struct
        multAdmin: owner.address,
        multRateAdmin: owner.address,
        payoutGroupAdmin: owner.address,
        payoutGroupRegistrar: owner.address,
        claimOperator: owner.address,
        claimAdmin: owner.address
      }
    );

    // Create combined interface for the proxy
    const combinedInterface = createCombinedInterface(proxiedPaxosToken, facets);
    const tokenWithFacet = new ethers.Contract(await proxiedPaxosToken.getAddress(), combinedInterface, proxiedPaxosToken.runner);

    // Deploy supply control (facets already registered, so setSupplyControl will work)
    supplyControl = await deploySupplyControlFixture(owner, tokenWithFacet, false);

    return [tokenWithFacet, proxy, supplyControl, facets];
  } else {
    // V2 token - original initialization
    await proxiedPaxosToken.initialize(0, owner.address, owner.address, assetProtectionRole.address);
    supplyControl = await deploySupplyControlFixture(owner, proxiedPaxosToken, false);
  }

  return [proxiedPaxosToken, proxy, supplyControl];
};

async function deploySupplyControlFixture(owner, proxiedPaxosToken, skipSetSupplyControl = false) {
  const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
  const scInitializationConfig = [[owner.address, [MaxUint256, 0], [owner.address], false]] // 0 refill rate = no rate limiting
  supplyControl = await upgrades.deployProxy(supplyControlFactory, [owner.address, owner.address, await proxiedPaxosToken.getAddress(), scInitializationConfig], {
    initializer: "initialize",
  });

  // For ClaimableRewards contracts, setSupplyControl is in TokenAdminFacet and must be called after facet registration
  if (!skipSetSupplyControl) {
    await proxiedPaxosToken.setSupplyControl(await supplyControl.getAddress());
  }

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

  // Check if this is a ClaimableRewards-based contract (USDG) vs V2-based (USDGv2)
  const isClaimableRewardsBased = contractName === "USDG";

  const contractFactory = await ethers.getContractFactory(contractName);

  if (isClaimableRewardsBased) {
    // For ClaimableRewards: Deploy facets FIRST, then initialize with them
    const facets = await deployAllFacets();

    // Initialize with facetCuts array + config
    const initializerArgs = [
      0,                                    // initialDelay
      owner.address,                        // initialOwner
      owner.address,                        // pauser
      assetProtectionRole.address,          // assetProtector
      facets.facetCuts,                     // FacetCut[] array
      owner.address,                        // claimSource
      0,                                    // minRate
      0,                                    // maxRate
      {                                     // V3RoleAddresses struct
        multAdmin: owner.address,
        multRateAdmin: owner.address,
        payoutGroupAdmin: owner.address,
        payoutGroupRegistrar: owner.address,
        claimOperator: owner.address,
        claimAdmin: owner.address
      }
    ];

    const token = await upgrades.deployProxy(contractFactory, initializerArgs, {
      initializer: "initialize",
      kind: 'uups',
      unsafeAllow: ['missing-initializer']
    });

    // Create combined interface (facets already registered in initialize)
    const combinedInterface = createCombinedInterface(token, facets);
    const tokenWithFacet = new ethers.Contract(await token.getAddress(), combinedInterface, token.runner);

    // Deploy supply control (facets already registered, so setSupplyControl will work)
    const supplyControl = await deploySupplyControlFixture(owner, tokenWithFacet, false);

    let amount = 100;
    return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token: tokenWithFacet, amount, supplyControl };
  }

  // V2-based contract (USDGv2) - original initialization
  const initializerArgs = [0, owner.address, owner.address, assetProtectionRole.address];
  const token = await upgrades.deployProxy(contractFactory, initializerArgs, {
    initializer: "initialize",
    kind: 'uups',
    unsafeAllow: ['missing-initializer']
  });

  const supplyControl = await deploySupplyControlFixture(owner, token, false);

  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token, amount, supplyControl };
}

async function deployPaxosTokenFixtureV1() {
  return deployContractFixture(PAXOS_TOKEN_V1)
}

async function deployPaxosTokenFixtureV2() {
  return deployContractFixture(PAXOS_TOKEN_V2)
}

async function deployPaxosTokenFixtureLatest() {
    return deployPaxosTokenFixtureV2();
}

async function deployPaxosTokenClaimableRewardsFixture() {
  // InitializePaxosTokenContract (called by deployContractFixture) handles
  // facet deployment and registration via initialize() for ClaimableRewards
  const result = await deployContractFixture(PAXOS_TOKEN_CLAIMABLE_REWARDS);

  // For ClaimableRewards, deployContractFixture handles facet deployment and
  // registration atomically via initialize(). Token already has combined interface.

  // Set up claim source and fund it generously for all test scenarios
  // Note: claimSource was set to owner.address in initialize(), but we need to fund it
  const claimSourceAddress = result.owner.address;

  // Fund claim source with generous amount for testing
  // This needs to be enough to cover all potential claims in tests
  const claimSourceFunding = ethers.parseUnits("10000000", 6); // 10M tokens at 6 decimals
  await result.token.connect(result.owner).increaseSupply(claimSourceFunding);

  // Note: The tokens are already in the owner's wallet (which is the claim source)
  // so no transfer is needed

  // Add claimSource property for tests that need it
  return { ...result, claimSource: result.owner };
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

async function deployUSDGv2Fixture() {
  // Deploy old V2-based USDG (pre-ClaimableRewards) from archive
  return deployUUPSContractFixture("USDGv2");
}

async function deployUSDGClaimableRewardsFixture() {
  // Deploy new ClaimableRewards-based USDG with facets
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();

  // Deploy facets FIRST
  const facets = await deployAllFacets();

  // Initialize with facets + selectors + config using struct parameters
  const initializerArgs = [
    0,                                    // initialDelay
    owner.address,                        // initialOwner
    owner.address,                        // pauser
    assetProtectionRole.address,          // assetProtector
    {                                     // V3FacetAddresses struct
      tokenAdmin: facets.tokenAdmin,
      tokenExtensions: facets.tokenExtensions,
      claimableRewards: facets.claimableRewards,
      multiplierMgmt: facets.multiplierMgmt,
      payoutGroup: facets.payoutGroup
    },
    facets.selectors,                     // V3FacetSelectors struct
    owner.address,                        // claimSource
    0,                                    // minRate
    0,                                    // maxRate
    {                                     // V3RoleAddresses struct
      multAdmin: owner.address,
      multRateAdmin: owner.address,
      payoutGroupAdmin: owner.address,
      payoutGroupRegistrar: owner.address,
      claimOperator: owner.address,
      claimAdmin: owner.address
    }
  ];

  const contractFactory = await ethers.getContractFactory("USDG");
  const token = await upgrades.deployProxy(contractFactory, initializerArgs, {
    initializer: "initialize",
    kind: 'uups',
    unsafeAllow: ['missing-initializer']
  });

  // Create combined interface (facets already registered in initialize)
  const combinedInterface = createCombinedInterface(token, facets);
  const tokenWithFacet = new ethers.Contract(await token.getAddress(), combinedInterface, token.runner);

  // Deploy supply control (facets already registered, so setSupplyControl will work)
  const supplyControl = await deploySupplyControlFixture(owner, tokenWithFacet, false);

  // Fund claim source with generous amount for testing
  const claimSourceFunding = ethers.parseUnits("10000000", 6);
  await tokenWithFacet.connect(owner).increaseSupply(claimSourceFunding);

  let amount = 100;
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, token: tokenWithFacet, amount, supplyControl, claimSource: owner };
}

async function deployRateLimitTest() {
  const [owner, admin, recipient, assetProtectionRole, acc, acc2, acc3] = await ethers.getSigners();
  const rateLimit = await ethers.deployContract("RateLimitFixture", [[limits.LIMIT_CAPACITY, limits.REFILL_PER_SECOND]])
  return { owner, admin, recipient, acc, acc2, acc3, assetProtectionRole, rateLimit };
}

async function deployTimelockControllerFixture() {
  const { impersonateAccount, setBalance, stopImpersonatingAccount, time } = require("@nomicfoundation/hardhat-network-helpers");

  // Deploy USDG via existing fixture
  const usdgResult = await deployStableCoinFixtureUSDG();

  // Assign roles: acc = proposer, acc2 = executor, acc3 = canceller
  const proposer = usdgResult.acc;
  const executor = usdgResult.acc2;
  const canceller = usdgResult.acc3;

  // Deploy TimelockController
  // Constructor: (minDelay, proposers[], executors[], admin)
  // Admin is set to owner initially so we can configure it
  const TimelockController = await ethers.getContractFactory(
    "@openzeppelin/contracts-v5/governance/TimelockController.sol:TimelockController"
  );
  const timelock = await TimelockController.deploy(
    timelockConfig.MIN_DELAY,
    [proposer.address], // proposers
    [executor.address], // executors
    usdgResult.owner.address // admin
  );
  await timelock.waitForDeployment();

  // Grant CANCELLER_ROLE to canceller
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  await timelock.connect(usdgResult.owner).grantRole(CANCELLER_ROLE, canceller.address);

  // Transfer DEFAULT_ADMIN_ROLE to timelock using the two-step process
  // (USDG uses AccessControlDefaultAdminRulesUpgradeable which prevents direct grants)
  const timelockAddress = await timelock.getAddress();

  // Step 1: Owner begins the admin transfer to the timelock
  await usdgResult.token.connect(usdgResult.owner).beginDefaultAdminTransfer(timelockAddress);

  // Step 2: Wait for the admin transfer delay to pass
  const [, schedule] = await usdgResult.token.pendingDefaultAdmin();
  const scheduleNum = Number(schedule);
  if (scheduleNum > 0) {
    await time.increaseTo(scheduleNum + 1);
  } else {
    await time.increase(1);
  }

  // Step 3: Impersonate the timelock to accept the admin transfer
  await impersonateAccount(timelockAddress);
  try {
    await setBalance(timelockAddress, ethers.parseEther("1"));
    const timelockSigner = await ethers.getSigner(timelockAddress);
    await usdgResult.token.connect(timelockSigner).acceptDefaultAdminTransfer();
  } finally {
    await stopImpersonatingAccount(timelockAddress);
  }

  return {
    ...usdgResult,
    timelock,
    proposer,
    executor,
    canceller
  };
}


module.exports = {
  InitializePaxosTokenContract,
  deployAllFacets,
  createCombinedInterface,
  deployPaxosTokenFixtureV1,
  deployPaxosTokenFixtureV2,
  deployPaxosTokenFixtureLatest,
  deployPaxosTokenClaimableRewardsFixture,
  deployStableCoinFixturePYUSD,
  deployStableCoinFixtureUSDP,
  deployStableCoinFixtureUSDG,
  deployUSDGv2Fixture,
  deployUSDGClaimableRewardsFixture,
  deployRateLimitTest,
  deployTimelockControllerFixture
}
