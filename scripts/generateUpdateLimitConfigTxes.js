const { ethers } = require("hardhat");
const { ValidateEnvironmentVariables, ReadConfig, getNonceForNetwork } = require('./utils');
const { 
    loadTokenContracts,
    loadWalletAddresses
} = require('./helpers/configLoader');

const {
    SUPPLY_CONTROLLER,
    TOKENS,
    NETWORKS,
    AUTHORITY_WALLET,
    ENVIRONMENT,
    SMART_CONTRACT_DEPLOYS_PATH, // Path to smart-contract-deploys repo. E.g. '../smart-contract-deploys'
    SMART_CONTRACT_LIST_PATH, // Path to smart contract configuration in wallet-management. E.g. '../wallet-management/staging/smart_contract_list.yaml'
    WALLET_CONFIG_PATH, // Path to wallet configuration in wallet-management. E.g. '../wallet-management/staging/network_evm_wallets.yaml'
    START_NONCES, // Optional: Override blockchain nonces if provided
    FILE_NAME = 'update_limit_config_commands.json',
    NO_COMMENTS
} = process.env;

function printComment(comment) {
    if (NO_COMMENTS !== 'true') {
        console.log(comment);
    }
}

function validateAddress(address, errorPrefix) {
    if (!ethers.isAddress(address)) {
        console.error(`Error: Invalid ${errorPrefix}: ${address}`);
        process.exit(1);
    }
}

function parseCommaSeparatedList(value) {
    return value ? value.split(',').map(item => item.trim().toUpperCase()) : [];
}

function parseCommaSeparatedNumbers(value) {
    return value ? value.split(',').map(item => parseInt(item.trim())) : [];
}

function buildConfigPath(smartContractDeploysPath, network, token, environment) {
    const networkLower = network.toLowerCase();
    const tokenLower = token.toLowerCase();
    
    return `${smartContractDeploysPath}/configs/${networkLower}/${tokenLower}/deploy/${environment}/deploy.yaml`;
}

function loadConfigurations(network, token, smartContractDeploysPath) {
    const configPath = buildConfigPath(smartContractDeploysPath, network, token, ENVIRONMENT);
    
    let smartContractConfig;
    try {
        smartContractConfig = ReadConfig(configPath);
    } catch (error) {
        // Don't log since it's expected some network/token combinations won't exist
        return null;
    }
    
    try {
        // Use the common configLoader to get addresses
        const contractAddresses = loadTokenContracts(SMART_CONTRACT_LIST_PATH, network, token);
        return { 
            smartContractConfig, 
            supplyControllerProxy: contractAddresses.supplyControlProxy,
            configPath 
        };
    } catch (error) {
        console.error(`Error loading smart contract addresses: ${error.message}`);
        return null;
    }
}

function getSupplyControllerConfig(smartContractConfig) {
    const supplyControllers = smartContractConfig.SUPPLY_CONTROLLERS;
    if (!supplyControllers) {
        throw new Error('SUPPLY_CONTROLLERS section not found in smart contract config');
    }
    
    const controllerConfig = supplyControllers[SUPPLY_CONTROLLER];
    if (!controllerConfig) {
        throw new Error(`Supply controller '${SUPPLY_CONTROLLER}' not found in smart contract config`);
    }
    
    if (!controllerConfig.ADDRESS || !controllerConfig.LIMIT_CAPACITY || !controllerConfig.REFILL_PER_SECOND) {
        throw new Error(`Missing ADDRESS, LIMIT_CAPACITY or REFILL_PER_SECOND for supply controller '${SUPPLY_CONTROLLER}'`);
    }
    
    return {
        name: SUPPLY_CONTROLLER,
        address: controllerConfig.ADDRESS,
        limitCapacity: controllerConfig.LIMIT_CAPACITY,
        refillPerSecond: controllerConfig.REFILL_PER_SECOND
    };
}

function findCallerAddress(walletAddresses) {
    const walletData = walletAddresses[AUTHORITY_WALLET];
    if (!walletData) {
        throw new Error(`Authority wallet '${AUTHORITY_WALLET}' not found in wallet config`);
    }
    if (walletData.status !== 'active') {
        throw new Error(`Authority wallet '${AUTHORITY_WALLET}' is not active`);
    }
    return walletData.address;
}

function generateCommand(network, supplyControllerProxy, caller, supplyControllerAddress, limitCapacity, refillPerSecond, nonce, isFirstCommand) {
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${network} -c ${supplyControllerProxy} call ${caller} updateLimitConfig ${supplyControllerAddress} ${limitCapacity} ${refillPerSecond} ${inFlag}-e ${nonce} -f ${FILE_NAME}`;
}

async function processTokenNetworkCombination(network, token, providedNonce, smartContractDeploysPath, callerAddress, isFirstCommand) {
    try {
        const configs = loadConfigurations(network, token, smartContractDeploysPath);
        if (!configs) {
            return { success: false, nonce: providedNonce, error: 'configuration not found' };
        }
        
        const { smartContractConfig, supplyControllerProxy, configPath } = configs;
        
        // Validate supply controller proxy address
        if (!supplyControllerProxy) {
            throw new Error(`supply_control_proxy not found for token '${token}' on network '${network}'`);
        }
        validateAddress(supplyControllerProxy, `supply controller proxy address for ${network}/${token}`);
        
        // Get nonce - use provided or fetch from blockchain
        let nonce = providedNonce;
        if (nonce === null || nonce === undefined) {
            try {
                const hardhatNetwork = smartContractConfig.HARDHAT_NETWORK;
                if (!hardhatNetwork) {
                    throw new Error('HARDHAT_NETWORK not found in smart contract config');
                }
                nonce = await getNonceForNetwork(callerAddress, hardhatNetwork);
                printComment(`// Fetched nonce ${nonce} from ${hardhatNetwork}`);
            } catch (error) {
                console.error(`Error fetching nonce for ${network}/${token}: ${error.message}`);
                return { success: false, nonce: 0, error: `Failed to fetch nonce: ${error.message}` };
            }
        }
        
        const supplyControllerConfig = getSupplyControllerConfig(smartContractConfig);
        validateAddress(supplyControllerConfig.address, `supply controller address for ${network}/${token}`);
        
        // Use the business unit values (decimal adjustment happens in pax-contract)
        const limitCapacity = supplyControllerConfig.limitCapacity.toString();
        const refillPerSecond = supplyControllerConfig.refillPerSecond.toString();
        
        printComment(`// Update Limit Config Transaction Command - ${network}/${token}`);
        printComment(`// Config Path: ${configPath}`);
        printComment('');
        
        console.log(generateCommand(
            smartContractConfig.NETWORK,
            supplyControllerProxy,
            callerAddress,
            supplyControllerConfig.address,
            limitCapacity,
            refillPerSecond,
            nonce,
            isFirstCommand
        ));
        
        printComment('');
        return { success: true, nonce: nonce + 1 };
        
    } catch (error) {
        return { success: false, nonce: providedNonce, error: error.message };
    }
}

async function main() {
    const required = [SUPPLY_CONTROLLER, AUTHORITY_WALLET, ENVIRONMENT, TOKENS, NETWORKS, SMART_CONTRACT_DEPLOYS_PATH, SMART_CONTRACT_LIST_PATH, WALLET_CONFIG_PATH];
    ValidateEnvironmentVariables(required);
    
    // Validate ENVIRONMENT is one of the allowed values
    const allowedEnvironments = ['staging', 'sandbox', 'production'];
    if (!allowedEnvironments.includes(ENVIRONMENT)) {
        console.error(`Error: ENVIRONMENT must be one of: ${allowedEnvironments.join(', ')}`);
        console.error(`Got: ${ENVIRONMENT}`);
        process.exit(1);
    }
    
    const tokens = parseCommaSeparatedList(TOKENS);
    const networks = parseCommaSeparatedList(NETWORKS);
    
    // Parse start nonces if provided (for override)
    let startNonces = null;
    if (START_NONCES) {
        startNonces = parseCommaSeparatedNumbers(START_NONCES);
        if (startNonces.length !== networks.length) {
            console.error(`Error: START_NONCES must have ${networks.length} values (one per network)`);
            console.error(`Networks: ${networks.join(', ')}`);
            console.error(`Start nonces provided: ${startNonces.length}`);
            process.exit(1);
        }
        
        // Validate all nonces are valid numbers
        startNonces.forEach((nonce, index) => {
            if (isNaN(nonce) || nonce < 0) {
                console.error(`Error: Invalid start nonce for network ${networks[index]}: ${START_NONCES.split(',')[index]?.trim()}`);
                process.exit(1);
            }
        });
    }
    
    const smartContractDeploysPath = SMART_CONTRACT_DEPLOYS_PATH;
    
    // Load wallet addresses using common configLoader
    const walletAddresses = loadWalletAddresses(WALLET_CONFIG_PATH);
    const callerAddress = findCallerAddress(walletAddresses);
    validateAddress(callerAddress, 'caller address');
    
    printComment('// Update Limit Config Transaction Commands');
    printComment(`// Supply Controller: ${SUPPLY_CONTROLLER}`);
    printComment(`// Environment: ${ENVIRONMENT}`);
    printComment(`// Tokens: ${tokens.join(', ')}`);
    printComment(`// Networks: ${networks.join(', ')}`);
    if (startNonces) {
        printComment(`// Using provided nonces: ${startNonces.join(', ')}`);
    } else {
        printComment(`// Nonces will be fetched from blockchain for each network`);
    }
    printComment(`// Authority Wallet: ${AUTHORITY_WALLET}`);
    printComment('');
    
    let successfulCommands = 0;
    let isFirstCommand = true;
    
    // Track results by network
    const networkResults = {};
    
    // Process each token/network combination
    for (let networkIndex = 0; networkIndex < networks.length; networkIndex++) {
        const network = networks[networkIndex];
        let nonce = startNonces ? startNonces[networkIndex] : null;
        
        if (!networkResults[network]) {
            networkResults[network] = { successful: [], failed: [] };
        }
        
        for (const token of tokens) {
            const result = await processTokenNetworkCombination(network, token, nonce, smartContractDeploysPath, callerAddress, isFirstCommand);
            if (result.success) {
                successfulCommands++;
                nonce = result.nonce;
                isFirstCommand = false; // After first successful command
                networkResults[network].successful.push(token);
            } else {
                networkResults[network].failed.push(token);
            }
        }
    }
    
    // Print summary organized by network
    printComment('// Summary:');
    for (const network of networks) {
        const result = networkResults[network];
        if (result.successful.length > 0) {
            printComment(`// ${network.toUpperCase()}: ${result.successful.join(', ')}`);
        }
    }
    printComment(`// Generated ${successfulCommands} commands successfully`);
    
    if (successfulCommands === 0) {
        console.error('No commands were generated. Please check your configuration paths and parameters.');
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });