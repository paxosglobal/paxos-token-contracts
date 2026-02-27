/**
 * Multi-Network Token Upgrade Smoke Test Script
 * 
 * This script tests upgrading PYUSD, USDP, USDG, and other tokens on any supported network.
 * It dynamically loads configuration from YAML files and captures state before/after upgrade.
 * 
 * Usage:
 *   export FORK_URL=<rpc_url> && npm run test:upgrade-smoke
 *   
 * Environment variables:
 *   NETWORK - Network to test (ethereum, arbitrum, xlayer, ink, etc.)
 *   TOKENS - Comma-separated list of tokens to test (PYUSD,USDP,USDG)
 *   NEW_<TOKEN>_IMPL - New implementation address for specific token
 *   SMART_CONTRACT_LIST_PATH - Path to smart_contract_list.yaml
 *   WALLET_CONFIG_PATH - Path to network_evm_wallets.yaml
 *   SKIP_FUNCTIONALITY_TESTS - Skip functionality tests if set to 'true'
 */

const { ethers } = require("hardhat");
const { 
    captureTokenState, 
    compareStates, 
    executeProxyUpgrade, 
    executeUUPSUpgrade,
    testTokenFunctionality,
    formatDiff 
} = require("./helpers/upgradeTokenContractTestHelpers");
const {
    getNetworkTokenConfigurations,
    getNetworkChainId
} = require("./helpers/configLoader");

// Environment variables
const {
    NETWORK = 'ethereum',
    TOKENS,
    SMART_CONTRACT_LIST_PATH = './smart_contract_list.yaml',
    WALLET_CONFIG_PATH = './network_evm_wallets.yaml',
    SKIP_FUNCTIONALITY_TESTS,
} = process.env;

async function getCurrentImplementation(tokenAddress, proxyType) {
    if (proxyType === "AdminUpgradeabilityProxy") {
        // Read implementation from storage slot: keccak256("org.zeppelinos.proxy.implementation") - 1
        const implSlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
        const implData = await ethers.provider.getStorage(tokenAddress, implSlot);
        return ethers.getAddress('0x' + implData.slice(26));
    } else if (proxyType === "UUPS") {
        // For UUPS, read from EIP-1967 implementation slot
        const implSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
        const implData = await ethers.provider.getStorage(tokenAddress, implSlot);
        return ethers.getAddress('0x' + implData.slice(26));
    }
    return null;
}

/**
 * Extract function selectors from a facet contract interface
 * @param {Object} facetContract - Deployed facet contract with interface
 * @returns {string[]} Array of function selector bytes4 strings
 */
function getSelectorsFromFacet(facetContract) {
    const selectors = [];
    facetContract.interface.forEachFunction((func) => {
        selectors.push(func.selector);
    });
    return selectors;
}

/**
 * Deploy all V3 facets and return FacetCut array for initialization.
 * Facets are stateless, so they can be deployed by anyone.
 */
async function deployAllFacets() {
    console.log("\nDeploying V3 facets...");

    const FACETS = [
        'TokenAdminFacet',
        'TokenExtensionsFacet',
        'ClaimableRewardsFacet',
        'MultiplierMgmtFacet',
        'PayoutGroupFacet'
    ];

    const contracts = {};
    const facetCuts = [];

    for (const facetName of FACETS) {
        const facetFactory = await ethers.getContractFactory(facetName);
        const facet = await facetFactory.deploy();
        await facet.waitForDeployment();
        const facetAddress = await facet.getAddress();
        console.log(`  ${facetName}: ${facetAddress}`);
        contracts[facetName] = facet;

        // Build FacetCut entry
        facetCuts.push({
            facet: facetAddress,
            selectors: getSelectorsFromFacet(facet)
        });
    }

    console.log("  ✓ All facets deployed");
    return { facetCuts, contracts };
}

/**
 * Encode initializeV3 calldata for atomic upgrade via upgradeToAndCall.
 * @param {Object} implContract - The new implementation contract (for ABI encoding)
 * @param {Object} facets - Deployed facet data from deployAllFacets() (includes facetCuts)
 * @param {string} adminAddress - Address to assign all V3 roles (for smoke testing)
 * @returns {string} Encoded initializeV3 calldata
 */
function encodeInitializeV3(implContract, facets, adminAddress) {
    return implContract.interface.encodeFunctionData('initializeV3', [
        facets.facetCuts,
        adminAddress, // claimSource
        0,            // minRate
        0,            // maxRate
        {
            multAdmin: adminAddress,
            multRateAdmin: adminAddress,
            payoutGroupAdmin: adminAddress,
            payoutGroupRegistrar: adminAddress,
            claimOperator: adminAddress,
            claimAdmin: adminAddress
        }
    ]);
}

async function testTokenUpgrade(tokenConfig, knownAddresses, newImplementation) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing ${tokenConfig.name} (${tokenConfig.symbol}) upgrade`);
    console.log(`${"=".repeat(60)}`);
    
    const results = {
        token: tokenConfig.name,
        symbol: tokenConfig.symbol,
        address: tokenConfig.address,
        success: false,
        error: null,
        stateDiff: null,
        functionalityTests: null
    };
    
    try {
        // Get token contract
        const tokenAbi = require("../artifacts/contracts/PaxosTokenV2.sol/PaxosTokenV2.json").abi;
        const token = new ethers.Contract(tokenConfig.address, tokenAbi, ethers.provider);
        
        // Get current implementation
        const currentImpl = await getCurrentImplementation(tokenConfig.address, tokenConfig.proxyType);
        console.log(`Current implementation: ${currentImpl}`);
        
        // Use configured proxy admin
        const proxyAdmin = tokenConfig.proxyAdmin;
        if (!proxyAdmin) {
            throw new Error(`No proxy admin configured for ${tokenConfig.name}`);
        }
        console.log(`Using proxy admin: ${proxyAdmin}`);
        console.log(`Proxy type: ${tokenConfig.proxyType}`);
        
        // Determine new implementation address
        let newImpl = newImplementation;
        
        if (!newImpl) {
            // If no new implementation provided, deploy a new one for testing
            console.log("No new implementation provided, deploying test implementation...");
            
            let ImplFactory;
            let usesDiamondPattern = false;
            
            if (tokenConfig.symbol === "PYUSD") {
                ImplFactory = await ethers.getContractFactory("contracts/stablecoins/PYUSD.sol:PYUSD");
            } else if (tokenConfig.symbol === "USDP") {
                ImplFactory = await ethers.getContractFactory("contracts/stablecoins/USDP.sol:USDP");
            } else if (tokenConfig.symbol === "USDG") {
                // USDG is UUPS-upgradeable and supports diamond pattern via facets
                ImplFactory = await ethers.getContractFactory("contracts/stablecoins/USDG.sol:USDG");
                usesDiamondPattern = true;
            } else {
                // Default to PaxosTokenV2
                ImplFactory = await ethers.getContractFactory("PaxosTokenV2");
            }
            
            const implContract = await ImplFactory.deploy();
            await implContract.waitForDeployment();
            newImpl = await implContract.getAddress();
            console.log(`Deployed new test implementation at: ${newImpl}`);

            // For USDG, deploy facets and prepare atomic initializeV3 calldata
            if (usesDiamondPattern) {
                const facetData = await deployAllFacets();
                const initData = encodeInitializeV3(implContract, facetData, proxyAdmin);
                // Store for use during upgrade
                tokenConfig._initData = initData;
                tokenConfig._facets = facetData.facetCuts; // Used as boolean flag for facet verification
                console.log("Prepared atomic initializeV3 calldata for upgradeToAndCall");
            }
        } else if (tokenConfig.symbol === "USDG") {
            // When implementation is provided externally, CALL_DATA must also be provided
            const callData = process.env.CALL_DATA;
            if (!callData) {
                throw new Error(`CALL_DATA environment variable is required when providing a custom USDG implementation`);
            }
            tokenConfig._initData = callData;
            tokenConfig._facets = true; // Enable facet verification
            console.log(`Using provided CALL_DATA (${callData.length} chars)`);
        }

        // Get addresses to check - just the admin addresses and known addresses
        const addressesToCheck = [
            proxyAdmin,
            knownAddresses.minter,
            knownAddresses.pauser,
            ethers.ZeroAddress // Check zero address balance
        ].filter(addr => addr && ethers.isAddress(addr));

        // Capture state before upgrade
        console.log("\nCapturing pre-upgrade state...");
        const stateBefore = await captureTokenState(token, addressesToCheck);

        // Execute upgrade
        console.log(`\nExecuting upgrade to: ${newImpl}`);
        let upgradeTx;
        if (tokenConfig.proxyType === "AdminUpgradeabilityProxy") {
            upgradeTx = await executeProxyUpgrade(tokenConfig.address, proxyAdmin, newImpl);
        } else if (tokenConfig.proxyType === "UUPS") {
            // For USDG with diamond pattern, use upgradeToAndCall with initializeV3
            const initData = tokenConfig._initData || '0x';
            upgradeTx = await executeUUPSUpgrade(tokenConfig.address, proxyAdmin, newImpl, initData);
        } else {
            throw new Error(`Unknown proxy type: ${tokenConfig.proxyType}`);
        }

        console.log(`Upgrade transaction: ${upgradeTx.hash}`);

        // Verify implementation changed
        const newCurrentImpl = await getCurrentImplementation(tokenConfig.address, tokenConfig.proxyType);
        console.log(`New implementation: ${newCurrentImpl}`);

        if (newCurrentImpl.toLowerCase() !== newImpl.toLowerCase()) {
            throw new Error(`Implementation did not change as expected. Expected: ${newImpl}, Got: ${newCurrentImpl}`);
        }

        // For USDG, verify facet functions work immediately after atomic upgrade
        if (tokenConfig._facets) {
            console.log("\nVerifying facet functions work immediately after atomic upgrade:");
            const v3Abi = [
                "function paused() external view returns (bool)",
                "function getClaimSource() external view returns (address)",
                "function nonces(address) external view returns (uint256)",
                "function getMaturityPeriod() external view returns (uint256)"
            ];
            const v3Token = new ethers.Contract(tokenConfig.address, v3Abi, ethers.provider);

            try {
                const pausedState = await v3Token.paused();
                console.log(`  ✓ paused() = ${pausedState} (TokenAdminFacet)`);
            } catch (e) {
                console.log(`  ✗ paused() failed: ${e.message}`);
            }

            try {
                const claimSource = await v3Token.getClaimSource();
                console.log(`  ✓ getClaimSource() = ${claimSource} (MultiplierMgmtFacet)`);
            } catch (e) {
                console.log(`  ✗ getClaimSource() failed: ${e.message}`);
            }

            try {
                const period = await v3Token.getMaturityPeriod();
                console.log(`  ✓ getMaturityPeriod() = ${period} (MultiplierMgmtFacet)`);
            } catch (e) {
                console.log(`  ✗ getMaturityPeriod() failed: ${e.message}`);
            }
        }

        // Capture state after upgrade
        console.log("\nCapturing post-upgrade state...");
        const stateAfter = await captureTokenState(token, addressesToCheck);
        
        // Compare states
        const diff = compareStates(stateBefore, stateAfter);
        results.stateDiff = diff;
        
        console.log("\n=== State Comparison ===");
        console.log(formatDiff(diff));
        
        // Validate critical state preservation
        // Token metadata must never change
        const metadataFields = ['name', 'symbol', 'decimals'];
        const metadataChanges = [];
        
        for (const field of metadataFields) {
            if (diff.changed[field]) {
                metadataChanges.push(`${field}: ${JSON.stringify(diff.changed[field].before)} → ${JSON.stringify(diff.changed[field].after)}`);
            }
        }
        
        if (metadataChanges.length > 0) {
            console.log("\n❌ TOKEN METADATA CHANGED (CRITICAL ERROR):");
            metadataChanges.forEach(change => console.log(`  - ${change}`));
            throw new Error(`Token metadata must not change during upgrade: ${metadataChanges.join(', ')}`);
        }
        
        // Check other critical fields
        const criticalFields = ['totalSupply', 'paused'];
        const criticalChanges = [];
        
        for (const field of criticalFields) {
            if (diff.changed[field] && field !== 'implementation') {
                criticalChanges.push(`${field} changed unexpectedly`);
            }
        }
        
        // Check balances preservation
        if (diff.changed.balances) {
            for (const [addr, balanceChange] of Object.entries(diff.changed.balances)) {
                if (balanceChange.before !== balanceChange.after) {
                    criticalChanges.push(`Balance changed for ${addr}`);
                }
            }
        }
        
        if (criticalChanges.length > 0) {
            console.log("\n⚠️  CRITICAL CHANGES DETECTED:");
            criticalChanges.forEach(change => console.log(`  - ${change}`));
            throw new Error(`Critical state changes detected: ${criticalChanges.join(', ')}`);
        }
        
        // Test functionality (unless skipped)
        let functionalityPassed = true;
        if (SKIP_FUNCTIONALITY_TESTS !== 'true') {
            console.log("\n=== Testing Token Functionality ===");
            const functionalityResults = await testTokenFunctionality(
                token, 
                knownAddresses.minter, 
                knownAddresses.pauser
            );
            results.functionalityTests = functionalityResults;
            
            console.log("\nFunctionality test summary:");
            const failedTests = [];
            for (const [test, result] of Object.entries(functionalityResults)) {
                if (test === 'stateVerification') continue; // Skip state verification in this loop
                const passed = result === true;
                console.log(`  ${test}: ${passed ? '✓' : '✗'}`);
                if (!passed) {
                    failedTests.push(test);
                }
            }
            
            // Check state verification errors
            if (functionalityResults.stateVerification && functionalityResults.stateVerification.errors.length > 0) {
                functionalityPassed = false;
            }
            
            if (failedTests.length > 0) {
                functionalityPassed = false;
                console.log(`\n⚠️  FUNCTIONALITY TESTS FAILED: ${failedTests.join(', ')}`);
                console.log("Note: All functionality tests must pass for the upgrade test to succeed.");
            }
        }
        
        if (!functionalityPassed) {
            throw new Error(`Critical functionality tests failed. The upgrade succeeded but the token may not be fully functional.`);
        }
        
        results.success = true;
        console.log(`\n✓ ${tokenConfig.name} upgrade test completed successfully`);
        
    } catch (error) {
        console.error(`\n✗ ${tokenConfig.name} upgrade test failed: ${error.message}`);
        results.error = error.message;
    }
    
    return results;
}

async function main() {
    console.log("Multi-Network Token Upgrade Smoke Test");
    console.log("=======================================\n");
    
    // Define role to wallet/contract name mapping
    // Note: USDG uses timelock_controller directly from smart_contract_list.yaml, not from roleMapping
    const roleMapping = {
        minter: 'ETH_COLD_OPS_ADDRESS_AND_SUPPLY_CONTROLLER_PTC_2024',
        pauser: 'ETH_COLD_CONTRACT_OWNER_AND_ASSET_PROTECTOR_AND_FEE_CONTROLLER_PTC_2025',
        proxyAdmin: 'ETH_COLD_CONTRACT_ADMIN_PTC_2025',
        timelockController: 'TIMELOCK_CONTROLLER'  // From smart_contract_list.yaml
    };
    
    // Load configurations
    let networkConfig;
    try {
        networkConfig = getNetworkTokenConfigurations(
            SMART_CONTRACT_LIST_PATH,
            WALLET_CONFIG_PATH,
            NETWORK,
            roleMapping
        );
    } catch (error) {
        console.error(`Failed to load configuration: ${error.message}`);
        process.exit(1);
    }
    
    console.log(`Network: ${NETWORK}`);
    console.log(`Smart Contract List: ${SMART_CONTRACT_LIST_PATH}`);
    console.log(`Wallet Config: ${WALLET_CONFIG_PATH}`);
    console.log(`Available tokens: ${Object.keys(networkConfig.tokens).join(', ')}`);
    
    // Determine which tokens to test
    let tokensToTest = [];
    if (TOKENS) {
        // Parse comma-separated list
        tokensToTest = TOKENS.split(',').map(t => t.trim().toUpperCase());
        // Validate tokens exist
        for (const token of tokensToTest) {
            if (!networkConfig.tokens[token]) {
                console.error(`Token '${token}' not found on network '${NETWORK}'`);
                console.log(`Available tokens: ${Object.keys(networkConfig.tokens).join(', ')}`);
                process.exit(1);
            }
        }
    } else {
        // Default to testing main stablecoins if they exist
        const defaultTokens = ['PYUSD', 'USDP', 'USDG'];
        tokensToTest = defaultTokens.filter(t => networkConfig.tokens[t]);
        
        if (tokensToTest.length === 0) {
            // If none of the defaults exist, test all available tokens
            tokensToTest = Object.keys(networkConfig.tokens);
        }
    }
    
    console.log(`Tokens to test: ${tokensToTest.join(', ')}`);
    
    // Check if we're on a fork
    const blockNumber = await ethers.provider.getBlockNumber();
    console.log(`Current block number: ${blockNumber}`);
    
    // Verify we're on the correct network
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const expectedChainId = getNetworkChainId(NETWORK);
    
    // Allow both actual chain ID and hardhat (31337) for forking
    if (chainId !== BigInt(expectedChainId) && chainId !== 31337n) {
        console.warn(`Warning: Expected chain ID ${expectedChainId} for ${NETWORK}, got ${chainId}`);
    }
    
    // Validate we're actually connected to a forked network by checking if a known contract exists
    console.log("\nValidating network connection...");
    
    // Mine a block before making any calls - workaround for hardfork issues on non-standard networks.
    // Others workarounds like adding hardhat history or changing the hardhat version didn't work. https://github.com/NomicFoundation/hardhat/issues/5511#issuecomment-2288072104
    if (chainId === 31337n) {
        console.log("Mining a block to work around hardfork detection issues...");
        await ethers.provider.send("hardhat_mine", ["0x1"]);
    }
    
    const firstToken = networkConfig.tokens[tokensToTest[0]];
    try {
        const code = await ethers.provider.getCode(firstToken.address);
        if (code === "0x" || code === "0x0") {
            console.error("\n❌ ERROR: No contract code found at the token address!");
            console.error("This usually means you're not connected to a forked network.\n");
            console.error("To run this test, you need to fork the target network:");
            console.error(`   npx hardhat node --fork <YOUR_RPC_URL>\n'`);
            process.exit(1);
        }
        
        // Try to call a basic function to verify the contract is accessible
        const tokenAbi = ["function name() view returns (string)"];
        const tokenContract = new ethers.Contract(firstToken.address, tokenAbi, ethers.provider);
        try {
            const name = await tokenContract.name();
            console.log(`✓ Successfully connected to ${name} at ${firstToken.address}`);
        } catch (callError) {
            console.error("\n❌ ERROR: Cannot interact with token contract!");
            console.error(`Contract exists but calls are failing. Error: ${callError.message}\n`);
            console.error("Possible causes:");
            console.error("1. RPC endpoint is not properly configured");
            console.error("2. Network forking is not working correctly");
            console.error("3. The contract ABI might be incompatible\n");
            process.exit(1);
        }
    } catch (error) {
        console.error(`\n❌ ERROR: Failed to validate network connection: ${error.message}`);
        console.error("\nMake sure you're running against a properly forked network.");
        process.exit(1);
    }
    
    console.log("\nKnown addresses:");
    for (const [role, address] of Object.entries(networkConfig.knownAddresses)) {
        console.log(`  ${role}: ${address || 'NOT CONFIGURED'}`);
    }
    
    const results = [];
    
    // Test each token
    for (const tokenSymbol of tokensToTest) {
        const tokenConfig = networkConfig.tokens[tokenSymbol];
        
        // Get new implementation from environment if specified
        const envVar = `NEW_${tokenSymbol}_IMPL`;
        const newImpl = process.env[envVar];
        
        if (newImpl) {
            console.log(`\nUsing custom implementation for ${tokenSymbol}: ${newImpl}`);
        }
        
        const result = await testTokenUpgrade(
            tokenConfig,
            networkConfig.knownAddresses,
            newImpl
        );
        results.push(result);
    }
    
    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    
    let allPassed = true;
    for (const result of results) {
        const status = result.success ? "✓ PASSED" : "✗ FAILED";
        console.log(`${result.token} (${result.symbol}): ${status}`);
        if (!result.success) {
            allPassed = false;
            console.log(`  Error: ${result.error}`);
        }
    }
    
    console.log("\n" + "=".repeat(60));
    if (allPassed) {
        console.log("✓ All upgrade tests passed successfully!");
    } else {
        console.log("✗ Some upgrade tests failed. Please review the output above.");
        process.exit(1);
    }
}

// Execute main function
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });