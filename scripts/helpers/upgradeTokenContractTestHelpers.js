/**
 * Helper functions for mainnet upgrade smoke testing
 * 
 * This module provides utilities for capturing token state,
 * comparing before/after states, and executing upgrades on forked mainnet.
 */

const { ethers } = require("hardhat");

// Constants
const IMPERSONATION_FUNDING = "0x56BC75E2D63100000"; // 100 ETH for gas when impersonating accounts
const TEST_ALLOWANCE_AMOUNT = 100n; // Standard allowance amount for testing approve/transferFrom

// Get contract with UUPS upgrade interface
const upgradeAbi = [
    "function upgradeTo(address newImplementation) external",
    "function upgradeToAndCall(address newImplementation, bytes memory data) external payable",
];

/**
 * Capture comprehensive state of a token contract
 * @param {Contract} token - The token contract instance
 * @param {Array} addressesToCheck - List of addresses to check balances for
 * @returns {Object} Complete state snapshot
 */
async function captureTokenState(token, addressesToCheck = []) {
    const state = {};

    try {
        // Basic token info
        state.name = await token.name();
        state.symbol = await token.symbol();
        state.decimals = await token.decimals();
        state.totalSupply = await token.totalSupply();

        // Implementation address (for proxy patterns)
        try {
            // Try to get implementation address directly
            state.implementation = await token.implementation();
        } catch {
            // If that fails, try reading from storage slot for AdminUpgradeabilityProxy
            // Slot: keccak256("org.zeppelinos.proxy.implementation") - 1
            const implSlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
            const implAddress = await ethers.provider.getStorage(await token.getAddress(), implSlot);
            state.implementation = ethers.getAddress('0x' + implAddress.slice(26));
        }

        // Pause state
        try {
            state.paused = await token.paused();
        } catch {
            state.paused = null;
        }

        // Roles (try different patterns)
        state.roles = {};

        // Legacy roles (V1 pattern)
        try {
            state.roles.owner = await token.owner();
        } catch {
            state.roles.owner = null;
        }

        // Modern roles (AccessControl pattern)
        const roleNames = ['DEFAULT_ADMIN_ROLE', 'PAUSER_ROLE', 'ASSET_PROTECTION_ROLE'];
        for (const roleName of roleNames) {
            try {
                const roleHash = await token[roleName]();
                const roleCount = await token.getRoleMemberCount(roleHash);
                state.roles[roleName] = [];
                for (let i = 0; i < roleCount; i++) {
                    const member = await token.getRoleMember(roleHash, i);
                    state.roles[roleName].push(member);
                }
            } catch {
                // Role doesn't exist in this version
            }
        }

        // Balances
        state.balances = {};
        for (const address of addressesToCheck) {
            try {
                state.balances[address] = await token.balanceOf(address);
            } catch (e) {
                console.log(`Warning: Could not get balance for ${address}: ${e.message}`);
            }
        }

        // Domain separator (for EIP-712)
        try {
            state.domainSeparator = await token.DOMAIN_SEPARATOR();
        } catch {
            state.domainSeparator = null;
        }

        // Supply control configuration (if applicable)
        try {
            const supplyControlAddress = await token.supplyControl();
            if (supplyControlAddress !== ethers.ZeroAddress) {
                state.supplyControl = {
                    address: supplyControlAddress,
                };
            }
        } catch {
            state.supplyControl = null;
        }

    } catch (error) {
        console.error(`Error capturing token state: ${error.message}`);
        throw error;
    }

    return state;
}

/**
 * Compare two token states and return differences
 * @param {Object} before - State before upgrade
 * @param {Object} after - State after upgrade
 * @returns {Object} Differences between states
 */
function compareStates(before, after) {
    const diff = {
        unchanged: {},
        changed: {},
        added: {},
        removed: {}
    };

    // Helper to serialize values for comparison (handles BigInt)
    const serialize = (value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                return value.map(serialize);
            }
            const result = {};
            for (const k in value) {
                result[k] = serialize(value[k]);
            }
            return result;
        }
        return value;
    };

    // Compare all fields from before state
    for (const key in before) {
        if (!(key in after)) {
            diff.removed[key] = before[key];
        } else if (JSON.stringify(serialize(before[key])) === JSON.stringify(serialize(after[key]))) {
            diff.unchanged[key] = before[key];
        } else {
            diff.changed[key] = {
                before: before[key],
                after: after[key]
            };
        }
    }

    // Check for added fields
    for (const key in after) {
        if (!(key in before)) {
            diff.added[key] = after[key];
        }
    }

    return diff;
}

/**
 * Execute upgrade for AdminUpgradeabilityProxy pattern tokens (PYUSD, USDP)
 * @param {string} proxyAddress - Address of the proxy contract
 * @param {string} adminAddress - Address of the proxy admin
 * @param {string} newImplementation - Address of new implementation
 * @param {string} initData - Initialization data (optional)
 */
async function executeProxyUpgrade(proxyAddress, adminAddress, newImplementation, initData = '0x') {
    // Impersonate the admin
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [adminAddress],
    });

    // Fund the admin account with ETH for gas
    await hre.network.provider.send("hardhat_setBalance", [
        adminAddress,
        IMPERSONATION_FUNDING,
    ]);

    const adminSigner = await ethers.getSigner(adminAddress);

    const proxy = new ethers.Contract(proxyAddress, upgradeAbi, adminSigner);

    // Execute upgrade
    let tx;
    if (initData !== '0x' && initData.length > 2) {
        tx = await proxy.upgradeToAndCall(newImplementation, initData);
    } else {
        tx = await proxy.upgradeTo(newImplementation);
    }

    await tx.wait();

    // Stop impersonating
    await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [adminAddress],
    });

    return tx;
}

/**
 * Execute upgrade for UUPS pattern tokens (USDG)
 * @param {string} proxyAddress - Address of the proxy contract
 * @param {string} adminAddress - Address with DEFAULT_ADMIN_ROLE
 * @param {string} newImplementation - Address of new implementation
 * @param {string} initData - Initialization data (optional)
 */
async function executeUUPSUpgrade(proxyAddress, adminAddress, newImplementation, initData = '0x') {
    // Impersonate the admin
    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [adminAddress],
    });

    // Fund the admin account with ETH for gas
    await hre.network.provider.send("hardhat_setBalance", [
        adminAddress,
        IMPERSONATION_FUNDING,
    ]);

    const adminSigner = await ethers.getSigner(adminAddress);

    const contract = new ethers.Contract(proxyAddress, upgradeAbi, adminSigner);

    // Execute upgrade
    let tx;
    if (initData !== '0x' && initData.length > 2) {
        tx = await contract.upgradeToAndCall(newImplementation, initData);
    } else {
        tx = await contract.upgradeTo(newImplementation);
    }

    await tx.wait();

    // Stop impersonating
    await hre.network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [adminAddress],
    });

    return tx;
}

/**
 * Test minting functionality with balance verification
 * @param {Contract} token - Token contract instance
 * @param {string} minterAddress - Address with minting rights
 * @returns {Object} Test result with state verification
 */
async function testMint(token, minterAddress) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        // First, test that unauthorized address cannot mint (negative test)
        const [_, randomSigner] = await ethers.getSigners();
        const mintAmount = 10000n;
        
        try {
            await token.connect(randomSigner).increaseSupplyToAddress(mintAmount, randomSigner.address);
            result.errors.push("Unauthorized mint succeeded when it should have failed");
            console.log(`    Mint (negative): ✗ - Random address was able to mint`);
        } catch (e) {
            // Expected to fail - this is good
            console.log(`    Mint (negative): ✓ - Random address correctly blocked from minting`);
            result.balanceChecks.push({
                passed: true,
                details: `Unauthorized mint correctly blocked`
            });
        }

        // Now test authorized minting
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [minterAddress],
        });

        await hre.network.provider.send("hardhat_setBalance", [
            minterAddress,
            IMPERSONATION_FUNDING,
        ]);

        const minterSigner = await ethers.getSigner(minterAddress);

        // Track initial state
        const initialBalance = await token.balanceOf(minterAddress);
        const initialSupply = await token.totalSupply();

        // Execute mint
        const mintTx = await token.connect(minterSigner).increaseSupplyToAddress(mintAmount, minterAddress);
        await mintTx.wait();

        // Verify balance changes
        const postMintBalance = await token.balanceOf(minterAddress);
        const postMintSupply = await token.totalSupply();

        if (postMintBalance !== initialBalance + mintAmount) {
            result.errors.push(
                `Balance mismatch: expected ${initialBalance + mintAmount}, got ${postMintBalance}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: `Minter balance increased by ${mintAmount}`
            });
        }

        if (postMintSupply !== initialSupply + mintAmount) {
            result.errors.push(
                `Supply mismatch: expected ${initialSupply + mintAmount}, got ${postMintSupply}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: `Total supply increased by ${mintAmount}`
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    Mint (authorized): ${result.passed ? '✓' : '✗'} - Minted ${mintAmount} tokens`);

        await hre.network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [minterAddress],
        });

    } catch (e) {
        result.errors.push(`Mint failed: ${e.message}`);
        console.log(`    Mint: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Test transfer functionality with balance verification
 * @param {Contract} token - Token contract instance  
 * @param {Object} signers - Test signers
 * @returns {Object} Test result with state verification
 */
async function testTransfer(token, signers) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        const { tester1, tester2 } = signers;
        const testerBalance = await token.balanceOf(tester1.address);

        if (testerBalance === 0n) {
            console.log(`    Transfer: skipped - no balance`);
            return result;
        }

        const preTransferTester1 = await token.balanceOf(tester1.address);
        const preTransferTester2 = await token.balanceOf(tester2.address);

        const tx = await token.connect(tester1).transfer(tester2.address, 1n);
        await tx.wait();

        const postTransferTester1 = await token.balanceOf(tester1.address);
        const postTransferTester2 = await token.balanceOf(tester2.address);

        if (postTransferTester1 !== preTransferTester1 - 1n) {
            result.errors.push(
                `Source balance mismatch: expected ${preTransferTester1 - 1n}, got ${postTransferTester1}`
            );
        } else if (postTransferTester2 !== preTransferTester2 + 1n) {
            result.errors.push(
                `Dest balance mismatch: expected ${preTransferTester2 + 1n}, got ${postTransferTester2}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: 'Transfer of 1 token verified'
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    Transfer: ${result.passed ? '✓' : '✗'}`);

    } catch (e) {
        result.errors.push(`Transfer failed: ${e.message}`);
        console.log(`    Transfer: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Test approve functionality
 * @param {Contract} token - Token contract instance
 * @param {Object} signers - Test signers
 * @returns {Object} Test result with state verification
 */
async function testApprove(token, signers) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        const { tester1, tester2 } = signers;

        const approveTx = await token.connect(tester1).approve(tester2.address, TEST_ALLOWANCE_AMOUNT);
        await approveTx.wait();

        const allowance = await token.allowance(tester1.address, tester2.address);
        if (allowance !== TEST_ALLOWANCE_AMOUNT) {
            result.errors.push(
                `Allowance mismatch: expected ${TEST_ALLOWANCE_AMOUNT}, got ${allowance}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: `Allowance of ${TEST_ALLOWANCE_AMOUNT} tokens set`
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    Approve: ${result.passed ? '✓' : '✗'}`);

    } catch (e) {
        result.errors.push(`Approve failed: ${e.message}`);
        console.log(`    Approve: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Test transferFrom functionality with balance and allowance verification
 * @param {Contract} token - Token contract instance
 * @param {Object} signers - Test signers
 * @returns {Object} Test result with state verification
 */
async function testTransferFrom(token, signers) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        const { tester1, tester2 } = signers;

        const allowance = await token.allowance(tester1.address, tester2.address);
        const balance = await token.balanceOf(tester1.address);

        if (allowance === 0n || balance === 0n) {
            console.log(`    TransferFrom: skipped - no allowance (${allowance}) or balance (${balance})`);
            return result;
        }

        const preTester1 = await token.balanceOf(tester1.address);
        const preTester2 = await token.balanceOf(tester2.address);

        const tx = await token.connect(tester2).transferFrom(tester1.address, tester2.address, 1n);
        await tx.wait();

        const postTester1 = await token.balanceOf(tester1.address);
        const postTester2 = await token.balanceOf(tester2.address);
        const postAllowance = await token.allowance(tester1.address, tester2.address);

        if (postTester1 !== preTester1 - 1n) {
            result.errors.push(
                `Source balance mismatch: expected ${preTester1 - 1n}, got ${postTester1}`
            );
        } else if (postTester2 !== preTester2 + 1n) {
            result.errors.push(
                `Dest balance mismatch: expected ${preTester2 + 1n}, got ${postTester2}`
            );
        } else if (postAllowance !== allowance - 1n) {
            result.errors.push(
                `Allowance mismatch: expected ${allowance - 1n}, got ${postAllowance}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: 'TransferFrom of 1 token verified with allowance decrease'
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    TransferFrom: ${result.passed ? '✓' : '✗'}`);

    } catch (e) {
        result.errors.push(`TransferFrom failed: ${e.message}`);
        console.log(`    TransferFrom: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Test burn functionality with balance verification
 * @param {Contract} token - Token contract instance
 * @param {string} minterAddress - Address with burn rights
 * @returns {Object} Test result with state verification
 */
async function testBurn(token, minterAddress) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [minterAddress],
        });

        await hre.network.provider.send("hardhat_setBalance", [
            minterAddress,
            IMPERSONATION_FUNDING,
        ]);

        const minterSigner = await ethers.getSigner(minterAddress);
        const minterBalance = await token.balanceOf(minterAddress);

        if (minterBalance === 0n) {
            console.log(`    Burn: skipped - no balance`);
            await hre.network.provider.request({
                method: "hardhat_stopImpersonatingAccount",
                params: [minterAddress],
            });
            return result;
        }

        // First, test that unauthorized address cannot burn (negative test)
        const [_, randomSigner] = await ethers.getSigners();
        const burnAmount = minterBalance > 100n ? 100n : 1n;
        
        try {
            await token.connect(randomSigner).decreaseSupplyFromAddress(burnAmount, minterAddress);
            result.errors.push("Unauthorized burn succeeded when it should have failed");
            console.log(`    Burn (negative): ✗ - Random address was able to burn`);
        } catch (e) {
            // Expected to fail - this is good
            console.log(`    Burn (negative): ✓ - Random address correctly blocked from burning`);
            result.balanceChecks.push({
                passed: true,
                details: `Unauthorized burn correctly blocked`
            });
        }

        // Now test authorized burning
        const preBurnBalance = await token.balanceOf(minterAddress);
        const preBurnSupply = await token.totalSupply();

        const burnTx = await token.connect(minterSigner).decreaseSupplyFromAddress(burnAmount, minterAddress);
        await burnTx.wait();

        const postBurnBalance = await token.balanceOf(minterAddress);
        const postBurnSupply = await token.totalSupply();

        if (postBurnBalance !== preBurnBalance - burnAmount) {
            result.errors.push(
                `Balance mismatch: expected ${preBurnBalance - burnAmount}, got ${postBurnBalance}`
            );
        } else if (postBurnSupply !== preBurnSupply - burnAmount) {
            result.errors.push(
                `Supply mismatch: expected ${preBurnSupply - burnAmount}, got ${postBurnSupply}`
            );
        } else {
            result.balanceChecks.push({
                passed: true,
                details: `Burned ${burnAmount} tokens successfully`
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    Burn (authorized): ${result.passed ? '✓' : '✗'} - Burned ${burnAmount} tokens`);

        await hre.network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [minterAddress],
        });

    } catch (e) {
        result.errors.push(`Burn failed: ${e.message}`);
        console.log(`    Burn: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Test pause/unpause functionality
 * @param {Contract} token - Token contract instance
 * @param {string} pauserAddress - Address with pause rights
 * @returns {Object} Test result with state verification
 */
async function testPause(token, pauserAddress) {
    const result = {
        passed: false,
        balanceChecks: [],
        errors: []
    };

    try {
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [pauserAddress],
        });

        await hre.network.provider.send("hardhat_setBalance", [
            pauserAddress,
            IMPERSONATION_FUNDING,
        ]);

        const pauserSigner = await ethers.getSigner(pauserAddress);

        // Pause the token
        const pauseTx = await token.connect(pauserSigner).pause();
        await pauseTx.wait();

        const isPausedAfterPause = await token.paused();

        // Unpause to restore state
        const unpauseTx = await token.connect(pauserSigner).unpause();
        await unpauseTx.wait();

        const isPausedAfterUnpause = await token.paused();

        if (!isPausedAfterPause) {
            result.errors.push('Token was not paused after pause()');
        } else if (isPausedAfterUnpause) {
            result.errors.push('Token was not unpaused after unpause()');
        } else {
            result.balanceChecks.push({
                passed: true,
                details: 'Pause and unpause state changes verified'
            });
        }

        result.passed = result.errors.length === 0;
        console.log(`    Pause: ${result.passed ? '✓' : '✗'}`);

        await hre.network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [pauserAddress],
        });

    } catch (e) {
        result.errors.push(`Pause failed: ${e.message}`);
        console.log(`    Pause: ✗ - ${e.message}`);
    }

    return result;
}

/**
 * Setup initial token state for testing
 * @param {Contract} token - Token contract instance
 * @param {string} minterAddress - Address with minting rights
 * @param {Object} signers - Test signers
 * @returns {Object} Setup result
 */
async function setupTestTokens(token, minterAddress, signers) {
    const result = {
        success: false,
        error: null
    };

    try {
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [minterAddress],
        });

        await hre.network.provider.send("hardhat_setBalance", [
            minterAddress,
            IMPERSONATION_FUNDING,
        ]);

        const minterSigner = await ethers.getSigner(minterAddress);
        const { tester1 } = signers;

        // Transfer tokens to test account for subsequent tests
        const transferAmount = 5000n;
        const transferTx = await token.connect(minterSigner).transfer(tester1.address, transferAmount);
        await transferTx.wait();

        console.log(`    Setup: Transferred ${transferAmount} tokens to test account`);
        result.success = true;

        await hre.network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [minterAddress],
        });

    } catch (e) {
        result.error = e.message;
        console.log(`    Setup failed: ${e.message}`);
    }

    return result;
}

/**
 * Test basic token functionality with balance verification
 * @param {Contract} token - Token contract instance
 * @param {string} minterAddress - Address with minting rights
 * @param {string} pauserAddress - Address with pause rights
 * @returns {Object} Test results with detailed state verification
 */
async function testTokenFunctionality(token, minterAddress, pauserAddress) {
    const results = {
        transfer: false,
        approve: false,
        transferFrom: false,
        mint: false,
        burn: false,
        pause: false,
        stateVerification: {
            balanceChecks: [],
            errors: []
        }
    };

    try {
        // Get test accounts
        const [tester1, tester2] = await ethers.getSigners();
        const signers = { tester1, tester2 };

        // Run individual tests
        console.log("  Running functionality tests:");

        // Test mint
        const mintResult = await testMint(token, minterAddress);
        results.mint = mintResult.passed;
        results.stateVerification.balanceChecks.push(...mintResult.balanceChecks);
        results.stateVerification.errors.push(...mintResult.errors);

        // Setup tokens for other tests (only if mint passed)
        if (results.mint) {
            const setupResult = await setupTestTokens(token, minterAddress, signers);
            if (!setupResult.success) {
                results.stateVerification.errors.push(`Setup failed: ${setupResult.error}`);
            }
        }

        // Test transfer
        const transferResult = await testTransfer(token, signers);
        results.transfer = transferResult.passed;
        results.stateVerification.balanceChecks.push(...transferResult.balanceChecks);
        results.stateVerification.errors.push(...transferResult.errors);

        // Test approve
        const approveResult = await testApprove(token, signers);
        results.approve = approveResult.passed;
        results.stateVerification.balanceChecks.push(...approveResult.balanceChecks);
        results.stateVerification.errors.push(...approveResult.errors);

        // Test transferFrom
        const transferFromResult = await testTransferFrom(token, signers);
        results.transferFrom = transferFromResult.passed;
        results.stateVerification.balanceChecks.push(...transferFromResult.balanceChecks);
        results.stateVerification.errors.push(...transferFromResult.errors);

        // Test burn (only if mint succeeded)
        if (results.mint) {
            const burnResult = await testBurn(token, minterAddress);
            results.burn = burnResult.passed;
            results.stateVerification.balanceChecks.push(...burnResult.balanceChecks);
            results.stateVerification.errors.push(...burnResult.errors);
        }

        // Test pause
        const pauseResult = await testPause(token, pauserAddress);
        results.pause = pauseResult.passed;
        results.stateVerification.balanceChecks.push(...pauseResult.balanceChecks);
        results.stateVerification.errors.push(...pauseResult.errors);

    } catch (error) {
        console.error(`Error testing functionality: ${error.message}`);
        results.stateVerification.errors.push(`General error: ${error.message}`);
    }

    // Log state verification summary
    if (results.stateVerification.errors.length > 0) {
        console.log(`\n  ⚠️  State verification errors:`);
        results.stateVerification.errors.forEach(err => console.log(`    - ${err}`));
    }

    const passedChecks = results.stateVerification.balanceChecks.filter(c => c.passed).length;
    const totalChecks = results.stateVerification.balanceChecks.length;
    if (totalChecks > 0) {
        console.log(`\n  State verification summary: ${passedChecks}/${totalChecks} balance checks passed`);
    }

    return results;
}

/**
 * Format state diff for display
 * @param {Object} diff - State difference object
 * @returns {string} Formatted diff string
 */
function formatDiff(diff) {
    let output = [];

    // Helper to format values for display (handles BigInt)
    const formatValue = (value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                return value.map(formatValue);
            }
            const result = {};
            for (const k in value) {
                result[k] = formatValue(value[k]);
            }
            return result;
        }
        return value;
    };

    if (Object.keys(diff.changed).length > 0) {
        output.push('\n=== CHANGED ===');
        for (const [key, value] of Object.entries(diff.changed)) {
            output.push(`${key}:`);
            output.push(`  Before: ${JSON.stringify(formatValue(value.before), null, 2)}`);
            output.push(`  After:  ${JSON.stringify(formatValue(value.after), null, 2)}`);
        }
    }

    if (Object.keys(diff.added).length > 0) {
        output.push('\n=== ADDED ===');
        for (const [key, value] of Object.entries(diff.added)) {
            output.push(`${key}: ${JSON.stringify(formatValue(value), null, 2)}`);
        }
    }

    if (Object.keys(diff.removed).length > 0) {
        output.push('\n=== REMOVED ===');
        for (const [key, value] of Object.entries(diff.removed)) {
            output.push(`${key}: ${JSON.stringify(formatValue(value), null, 2)}`);
        }
    }

    if (Object.keys(diff.unchanged).length > 0) {
        output.push('\n=== UNCHANGED (summary) ===');
        output.push(Object.keys(diff.unchanged).join(', '));
    }

    return output.join('\n');
}

module.exports = {
    captureTokenState,
    compareStates,
    executeProxyUpgrade,
    executeUUPSUpgrade,
    testTokenFunctionality,
    formatDiff
};