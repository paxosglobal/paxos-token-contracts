/**
 * Configuration Loader Utility
 * 
 * Provides common functionality for loading wallet and smart contract configurations
 * from YAML files for use across various scripts.
 */

const fs = require('fs');
const yaml = require('js-yaml');
const { ethers } = require('hardhat');

/**
 * Load YAML file with proper hex address support
 * @param {string} filePath - Path to YAML file
 * @returns {Object} Parsed YAML content
 */
function loadYamlWithHexSupport(filePath) {
    try {
        // Read the file as text
        let content = fs.readFileSync(filePath, 'utf-8');
        
        // Pre-process: Quote hex addresses to prevent scientific notation parsing
        // This regex matches hex addresses (0x followed by hex chars)
        content = content.replace(/:\s*(0x[a-fA-F0-9]+)(\s|$)/g, ': "$1"$2');
        
        // Now parse the modified YAML
        return yaml.load(content);
    } catch (error) {
        throw new Error(`Error loading YAML file ${filePath}: ${error.message}`);
    }
}

/**
 * Load smart contract addresses from configuration
 * @param {string} smartContractListPath - Path to smart_contract_list.yaml
 * @param {string} network - Network name (e.g., 'ethereum', 'arbitrum')
 * @param {string} token - Token name (e.g., 'PYUSD', 'USDP', 'USDG')
 * @returns {Object} Token contract addresses
 */
function loadTokenContracts(smartContractListPath, network, token) {
    const smartContractList = loadYamlWithHexSupport(smartContractListPath);
    
    const networkLower = network.toLowerCase();
    const tokenUpper = token.toUpperCase();
    
    const networkData = smartContractList.networks?.[networkLower];
    if (!networkData) {
        throw new Error(`Network '${network}' not found in smart contract list`);
    }
    
    const tokenData = networkData[tokenUpper];
    if (!tokenData) {
        throw new Error(`Token '${token}' not found for network '${network}' in smart contract list`);
    }
    
    return {
        tokenProxy: tokenData.token_proxy,
        supplyControlProxy: tokenData.supply_control_proxy,
        oftWrapper: tokenData.oft_wrapper
    };
}

/**
 * Load wallet addresses from configuration
 * @param {string} walletConfigPath - Path to network_evm_wallets.yaml
 * @returns {Object} Wallet addresses mapped by their names
 */
function loadWalletAddresses(walletConfigPath) {
    const walletConfig = loadYamlWithHexSupport(walletConfigPath);
    
    const wallets = {};
    
    // Process EVM wallets
    if (walletConfig.networks?.evm?.wallets) {
        for (const [walletName, walletData] of Object.entries(walletConfig.networks.evm.wallets)) {
            wallets[walletName] = {
                address: walletData.public_key,
                name: walletData.name,
                entity: walletData.entity,
                description: walletData.description,
                status: walletData.wallet_status
            };
        }
    }

    return wallets;
}

/**
 * Load smart contract addresses from configuration for a specific network
 * @param {string} smartContractListPath - Path to smart_contract_list.yaml
 * @param {string} network - Network name (e.g., 'ethereum', 'arbitrum')
 * @returns {Object} Smart contract addresses mapped by their names (e.g., TIMELOCK_CONTROLLER)
 */
function loadTimelockContracts(smartContractListPath, network) {
    const smartContractList = loadYamlWithHexSupport(smartContractListPath);
    const networkLower = network.toLowerCase();
    const networkData = smartContractList.networks?.[networkLower];

    if (!networkData) {
        return {};
    }

    const contracts = {};

    // Look through all tokens in the network for special contract addresses
    for (const [tokenName, tokenData] of Object.entries(networkData)) {
        if (typeof tokenData !== 'object') continue;

        // Extract timelock_controller if present
        if (tokenData.timelock_controller) {
            // Use token-prefixed key to allow different timelocks per token
            contracts[`${tokenName}_TIMELOCK_CONTROLLER`] = tokenData.timelock_controller;
            // Also set a generic TIMELOCK_CONTROLLER if not already set
            if (!contracts['TIMELOCK_CONTROLLER']) {
                contracts['TIMELOCK_CONTROLLER'] = tokenData.timelock_controller;
            }
        }
    }

    return contracts;
}

/**
 * Get known wallet addresses for a specific network and environment
 * @param {Object} wallets - Loaded wallet configuration
 * @param {Object} smartContracts - Loaded smart contract addresses
 * @param {Object} roleMapping - Mapping of role names to wallet/contract names
 * @returns {Object} Known addresses for roles
 */
function getTokenAuthorityAddresses(wallets, smartContracts, roleMapping) {

    // Build known addresses from the mapping
    const knownAddresses = {};

    for (const [role, sourceName] of Object.entries(roleMapping)) {
        // First check if it's a smart contract address
        if (smartContracts[sourceName]) {
            knownAddresses[role] = smartContracts[sourceName];
        } else if (wallets[sourceName]) {
            // Then check wallets
            knownAddresses[role] = wallets[sourceName].address;
        } else {
            console.warn(`Warning: '${sourceName}' not found in wallets or smart contracts for role '${role}'`);
            knownAddresses[role] = null;
        }
    }
    
    // Validate all addresses
    for (const [role, address] of Object.entries(knownAddresses)) {
        if (!address) {
            console.warn(`Warning: No address found for role '${role}'`);
        } else if (!ethers.isAddress(address)) {
            throw new Error(`Invalid address for role '${role}': ${address}`);
        }
    }
    
    return knownAddresses;
}

/**
 * Get token configuration for a specific network
 * @param {string} smartContractListPath - Path to smart_contract_list.yaml
 * @param {string} walletConfigPath - Path to network_evm_wallets.yaml
 * @param {string} network - Network name
 * @param {Object} roleMapping - Optional mapping of role names to wallet/contract names
 * @returns {Object} Complete token configurations for the network
 */
function getNetworkTokenConfigurations(smartContractListPath, walletConfigPath, network, roleMapping) {
    const smartContractList = loadYamlWithHexSupport(smartContractListPath);
    const wallets = loadWalletAddresses(walletConfigPath);
    const smartContracts = loadTimelockContracts(smartContractListPath, network);
    const knownAddresses = getTokenAuthorityAddresses(wallets, smartContracts, roleMapping);

    const networkLower = network.toLowerCase();
    const networkData = smartContractList.networks?.[networkLower];
    if (!networkData) {
        throw new Error(`Network '${network}' not found in smart contract list`);
    }
    const tokenConfigs = {};
    for (const [tokenName, tokenData] of Object.entries(networkData)) {
        // Skip non-EVM tokens
        if (!tokenData.token_proxy) continue;
        // Determine proxy type based on token
        let proxyType;
        let proxyAdmin;
        if (tokenName === 'USDG' || tokenName === 'FLX') {
            // UUPS tokens - use token-specific timelock controller if available
            proxyType = 'UUPS';
            proxyAdmin = tokenData.timelock_controller;
        } else {
            // AdminUpgradeabilityProxy tokens (PYUSD, USDP, PAXG, BUSD)
            proxyType = 'AdminUpgradeabilityProxy';
            proxyAdmin = knownAddresses.proxyAdmin;
        }
        
        tokenConfigs[tokenName] = {
            name: getTokenFullName(tokenName),
            symbol: tokenName,
            address: tokenData.token_proxy,
            proxyType: proxyType,
            proxyAdmin: proxyAdmin,
            supplyControl: tokenData.supply_control_proxy,
            oftWrapper: tokenData.oft_wrapper,
            timelockController: tokenData.timelock_controller
        };
    }
    
    return {
        tokens: tokenConfigs,
        knownAddresses: knownAddresses,
        smartContracts: smartContracts,
        network: network
    };
}

/**
 * Get full token name from symbol
 * @param {string} symbol - Token symbol
 * @returns {string} Full token name
 */
function getTokenFullName(symbol) {
    const tokenNames = {
        'PYUSD': 'PayPal USD',
        'USDP': 'Pax Dollar',
        'USDG': 'Global Dollar',
        'PAXG': 'Pax Gold',
        'BUSD': 'Binance USD',
        'USDL': 'Lift Dollar',
        'FLX': 'Flux Token'
    };
    
    return tokenNames[symbol] || symbol;
}

/**
 * Get RPC URL for a specific network
 * @param {string} network - Network name
 * @returns {string} RPC URL from environment
 */
function getNetworkRpcUrl(network) {
    const networkLower = network.toLowerCase();
    
    const rpcUrls = {
        'ethereum': process.env.URL_ETH_MAINNET,
        'arbitrum': process.env.URL_ARB_MAINNET,
        'xlayer': process.env.URL_XLAYER_MAINNET,
        'ink': process.env.URL_INK_MAINNET,
        'base': process.env.URL_BASE_MAINNET,
        'ethsepolia': process.env.URL_ETH_SEPOLIA,
        'arbsepolia': process.env.URL_ARB_SEPOLIA,
        'xlayertestnet': process.env.URL_XLAYER_TESTNET,
        'inksepolia': process.env.URL_INK_SEPOLIA,
        'basesepolia': process.env.URL_BASE_SEPOLIA
    };
    
    const rpcUrl = rpcUrls[networkLower];
    if (!rpcUrl) {
        throw new Error(`No RPC URL configured for network '${network}'. Please set the appropriate URL_* environment variable.`);
    }
    
    return rpcUrl;
}

/**
 * Get chain ID for a specific network
 * @param {string} network - Network name
 * @returns {number} Chain ID
 */
function getNetworkChainId(network) {
    const networkLower = network.toLowerCase();
    
    const chainIds = {
        'ethereum': 1,
        'arbitrum': 42161,
        'xlayer': 196,
        'ink': 57073,
        'base': 8453,
        'ethsepolia': 11155111,
        'arbsepolia': 421614,
        'xlayertestnet': 1952,
        'inksepolia': 763373,
        'basesepolia': 84532
    };
    
    return chainIds[networkLower] || null;
}

module.exports = {
    loadYamlWithHexSupport,
    loadTokenContracts,
    loadWalletAddresses,
    loadTimelockContracts,
    getTokenAuthorityAddresses,
    getNetworkTokenConfigurations,
    getTokenFullName,
    getNetworkRpcUrl,
    getNetworkChainId
};