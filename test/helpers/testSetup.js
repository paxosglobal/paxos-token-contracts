/**
 * Common test setup functions to reduce duplication across test files
 *
 * This module provides reusable setup patterns that appear repeatedly
 * across the test suite, helping to eliminate boilerplate code.
 */

const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { grantAllTestRoles } = require('./testHelpers');

/**
 * Standard rebase environment setup
 * Sets up a token with standard rebase configuration:
 * - Grants all test roles to owner
 * - Sets 1-day reward period (86400 seconds)
 * - Sets rate bounds to 0-100%
 *
 * @param {Object} context - Test context with token and owner
 * @returns {Promise<void>}
 */
async function setupRebaseEnvironment(context) {
    await grantAllTestRoles(context.token, context.owner, context.owner.address);
    await context.token.connect(context.owner).setMaturityPeriod(86400); // 1 day
    await context.token.connect(context.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10)); // 0-10000% APR for testing
}

/**
 * Setup rebase environment with custom rate bounds
 *
 * @param {Object} context - Test context with token and owner
 * @param {BigNumber} minRate - Minimum APR (10 decimals)
 * @param {BigNumber} maxRate - Maximum APR (10 decimals)
 * @returns {Promise<void>}
 */
async function setupRebaseWithCustomRates(context, minRate, maxRate) {
    await grantAllTestRoles(context.token, context.owner, context.owner.address);
    await context.token.connect(context.owner).setMaturityPeriod(86400);
    await context.token.connect(context.owner).setRateBoundsByAPR(minRate, maxRate);
}

/**
 * Setup rebase environment with custom period
 *
 * @param {Object} context - Test context with token and owner
 * @param {number} rewardPeriod - Reward period in seconds
 * @returns {Promise<void>}
 */
async function setupRebaseWithCustomPeriod(context, rewardPeriod) {
    await grantAllTestRoles(context.token, context.owner, context.owner.address);
    await context.token.connect(context.owner).setMaturityPeriod(rewardPeriod);
    await context.token.connect(context.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR (fraction)
}

/**
 * Create a payout group and return its ID
 *
 * @param {Object} context - Test context with token and owner
 * @param {number} multiplierId - The multiplier ID for the payout group
 * @param {SignerWithAddress} claimer - The claimer account
 * @returns {Promise<BigNumber>} The created payout group ID
 */
async function createPayoutGroup(context, multiplierId, claimer) {
    const tx = await context.token.connect(context.owner).createPayoutGroup(multiplierId, claimer.address);
    const receipt = await tx.wait();

    // Extract payoutGroupId from PayoutGroupCreated event
    const event = receipt.logs.find(log => {
        try {
            const parsed = context.token.interface.parseLog(log);
            return parsed && parsed.name === 'PayoutGroupCreated';
        } catch (e) {
            return false;
        }
    });

    if (event) {
        const parsed = context.token.interface.parseLog(event);
        return parsed.args.payoutGroupId;
    }

    throw new Error('PayoutGroupCreated event not found');
}

/**
 * Create a payout group with optional manager and destination, and return its ID
 *
 * @param {Object} context - Test context with token and owner
 * @param {number} multiplierId - The multiplier ID for the payout group
 * @param {SignerWithAddress} claimer - The claimer account
 * @param {string} manager - The manager address (use ethers.ZeroAddress to skip)
 * @param {string} destination - The destination address (use ethers.ZeroAddress to skip)
 * @returns {Promise<BigNumber>} The created payout group ID
 */
async function createPayoutGroupWithRoles(context, multiplierId, claimer, manager, destination) {
    const tx = await context.token.connect(context.owner).createPayoutGroupWithRoles(
        multiplierId,
        claimer.address,
        manager,
        destination
    );
    const receipt = await tx.wait();

    // Extract payoutGroupId from PayoutGroupCreated event
    const event = receipt.logs.find(log => {
        try {
            const parsed = context.token.interface.parseLog(log);
            return parsed && parsed.name === 'PayoutGroupCreated';
        } catch (e) {
            return false;
        }
    });

    if (event) {
        const parsed = context.token.interface.parseLog(event);
        return parsed.args.payoutGroupId;
    }

    throw new Error('PayoutGroupCreated event not found');
}

/**
 * Register an account to a payout group
 *
 * @param {Object} context - Test context with token and owner
 * @param {BigNumber} payoutGroupId - The payout group ID
 * @param {SignerWithAddress} account - The account to register
 * @returns {Promise<void>}
 */
async function registerAccount(context, payoutGroupId, account) {
    await context.token.connect(context.owner).registrarRegisterRewardAddress(payoutGroupId, account.address);
}

/**
 * Mint and transfer tokens to an account
 *
 * @param {Object} context - Test context with token and owner
 * @param {SignerWithAddress} account - The recipient account
 * @param {BigNumber} amount - The amount to mint and transfer
 * @returns {Promise<void>}
 */
async function mintAndTransfer(context, account, amount) {
    await context.token.connect(context.owner).increaseSupply(amount);
    await context.token.connect(context.owner).transfer(account.address, amount);
}

/**
 * Complete payout group setup with registration
 * Creates a payout group, mints tokens, and registers an account
 *
 * @param {Object} context - Test context with token and owner
 * @param {number} multiplierId - The multiplier ID
 * @param {SignerWithAddress} claimer - The claimer account
 * @param {SignerWithAddress} account - The account to register and fund
 * @param {BigNumber} amount - The amount to mint and transfer
 * @returns {Promise<BigNumber>} The created payout group ID
 */
async function setupPayoutGroupWithRegistration(context, multiplierId, claimer, account, amount) {
    const payoutGroupId = await createPayoutGroup(context, multiplierId, claimer);
    await mintAndTransfer(context, account, amount);
    await registerAccount(context, payoutGroupId, account);
    return payoutGroupId;
}

/**
 * Setup multiple payout groups for testing
 *
 * @param {Object} context - Test context with token and owner
 * @param {number} count - Number of payout groups to create
 * @param {number} multiplierId - The multiplier ID to use
 * @param {Array<SignerWithAddress>} claimers - Array of claimer accounts
 * @returns {Promise<Array<BigNumber>>} Array of payout group IDs
 */
async function setupMultiplePayoutGroups(context, count, multiplierId, claimers) {
    const payoutGroupIds = [];
    for (let i = 0; i < count; i++) {
        const payoutGroupId = await createPayoutGroup(context, multiplierId, claimers[i]);
        payoutGroupIds.push(payoutGroupId);
    }
    return payoutGroupIds;
}

/**
 * Fast forward time and return new timestamp
 *
 * @param {number} seconds - Seconds to fast forward
 * @returns {Promise<number>} New timestamp
 */
async function fastForward(seconds) {
    await time.increase(seconds);
    return await time.latest();
}

/**
 * Fast forward to next epoch boundary
 *
 * @param {Object} context - Test context with token
 * @returns {Promise<number>} New timestamp at epoch boundary
 */
async function fastForwardToNextEpoch(context) {
    const rewardPeriod = Number(await context.token.getMaturityPeriod());
    const currentTime = await time.latest();
    const currentEpoch = await context.token.getCurrentPeriodNum();
    const referenceTime = await context.token.getReferenceTime();

    // Calculate next epoch boundary
    // Period number is calculated from referenceTime and maturityPeriod
    const nextEpochNum = currentEpoch + 1n;
    const epochsFromRef = nextEpochNum; // Period numbers start from 0 at referenceTime
    const nextEpochTime = Number(referenceTime) + Number(epochsFromRef) * rewardPeriod;

    await time.increaseTo(nextEpochTime);
    return nextEpochTime;
}

/**
 * Setup claim source with sufficient balance
 *
 * @param {Object} context - Test context with token and owner
 * @param {BigNumber} amount - Amount to fund claim source with
 * @returns {Promise<void>}
 */
async function setupClaimSource(context, amount) {
    await context.token.connect(context.owner).increaseSupply(amount);
    await context.token.connect(context.owner).setClaimSource(context.owner.address);
}

/**
 * Common constants used across tests
 */
const UINT40_MAX = 2n ** 40n - 1n;  // type(uint40).max - use for "effectively unlimited" APR

const TestConstants = {
    ONE_DAY: 86400,
    ONE_HOUR: 3600,
    ONE_MINUTE: 60,
    DEFAULT_RATE_BOUNDS_MAX: ethers.parseUnits("1", 10), // 100% APR (10 decimals)
    SMALL_RATE: ethers.parseUnits("0.0001", 10), // 0.01% APR (10 decimals)
    MEDIUM_RATE: ethers.parseUnits("0.01", 10), // 1% APR (10 decimals)
    HIGH_RATE: ethers.parseUnits("0.1", 10), // 10% APR (10 decimals)
    UINT40_MAX: UINT40_MAX,
};

/**
 * Setup rate bounds and create a multiplier
 * Creates a multiplier with the specified APR after configuring rate bounds.
 * Call this before createPayoutGroup() since multipliers must exist first.
 *
 * Note: This always sets the rate bounds, even if they were previously configured.
 *
 * @param {Object} context - Test context with token and owner
 * @param {bigint} apr - APR for the multiplier (10 decimals), default 0
 * @param {bigint} minAPR - Minimum APR bound (10 decimals), default 0
 * @param {bigint} maxAPR - Maximum APR bound (10 decimals), default UINT40_MAX
 * @returns {Promise<bigint>} The created multiplier ID
 */
async function setupMultiplierWithBounds(context, apr = 0n, minAPR = 0n, maxAPR = UINT40_MAX) {
    // Set rate bounds (will override any existing bounds)
    await context.token.connect(context.owner).setRateBoundsByAPR(minAPR, maxAPR);

    // Create multiplier and get its ID via staticCall
    const multiplierId = await context.token.connect(context.owner).createMultiplier.staticCall(apr);
    await context.token.connect(context.owner).createMultiplier(apr);

    return multiplierId;
}

module.exports = {
    // Setup functions
    setupRebaseEnvironment,
    setupRebaseWithCustomRates,
    setupRebaseWithCustomPeriod,
    createPayoutGroup,
    createPayoutGroupWithRoles,
    registerAccount,
    mintAndTransfer,
    setupPayoutGroupWithRegistration,
    setupMultiplePayoutGroups,
    setupMultiplierWithBounds,

    // Time manipulation
    fastForward,
    fastForwardToNextEpoch,

    // Claim source
    setupClaimSource,

    // Constants
    TestConstants,
    UINT40_MAX,
};
