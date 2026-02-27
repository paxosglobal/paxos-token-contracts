const { ethers } = require("hardhat");
const { ValidateEnvironmentVariables } = require('./utils');

const {
    CONTRACT_ADDRESSES,  // Comma-separated list of modern tokens (USDP, PYUSD, USDG)
    CONTRACT_ADDRESSES_LEGACY,  // Comma-separated list of legacy tokens (PAXG, BUSD)
    ADDRESSES_TO_FREEZE,
    ADDRESSES_TO_UNFREEZE,
    NETWORK,
    CALLER,  // The address that will call freeze/unfreeze (must have ASSET_PROTECTION_ROLE)
    ACTION = 'freeze',  // 'freeze', 'unfreeze', or 'both'
    START_NONCE = '0',
    FILE_NAME = 'freeze_commands.json',
    NO_COMMENTS  // Set to 'true' to suppress comments
} = process.env;

function printComment(comment) {
    if (NO_COMMENTS !== 'true') {
        console.log(comment);
    }
}

function parseAddressList(addressString) {
    return addressString ? addressString.split(',').map(addr => addr.trim()) : [];
}

function validateAddresses(addresses, errorPrefix) {
    for (const address of addresses) {
        if (!ethers.isAddress(address)) {
            console.error(`Error: Invalid ${errorPrefix}: ${address}`);
            process.exit(1);
        }
    }
}

function validatePositiveNumber(value, errorMessage) {
    const parsed = parseInt(value);
    if (isNaN(parsed) || parsed < 0) {
        console.error(errorMessage);
        process.exit(1);
    }
    return parsed;
}

function generateCommand(contractAddress, caller, method, args, nonce, isFirstCommand) {
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} ${method} ${args} ${inFlag}-e ${nonce} -f ${FILE_NAME}`;
}

function formatAddressArray(addresses) {
    return `[${addresses.map(addr => `"${addr}"`).join(',')}]`;
}

function processOperations(operation, contracts, addresses, isModern, currentNonce, isFirstCommand) {
    const results = { nonce: currentNonce, firstCommand: isFirstCommand };
    
    if (contracts.length === 0) return results;
    
    for (const contractAddress of contracts) {
        if (isModern) {
            // Modern contracts: always use batch
            const method = operation === 'freeze' ? 'freezeBatch' : 'unfreezeBatch';
            const args = formatAddressArray(addresses);
            
            console.log(generateCommand(contractAddress, CALLER, method, args, results.nonce, results.firstCommand));
            results.nonce++;
            results.firstCommand = false;
        } else {
            // Legacy contracts: individual operations
            const method = operation === 'freeze' ? 'freeze' : 'unfreeze';
            
            for (const address of addresses) {
                console.log(generateCommand(contractAddress, CALLER, method, address, results.nonce, results.firstCommand));
                results.nonce++;
                results.firstCommand = false;
            }
        }
        printComment('');
    }
    
    return results;
}

async function main() {
    const required = [
        'CALLER',
        'NETWORK'
    ];
    ValidateEnvironmentVariables(required);

    if (!CONTRACT_ADDRESSES && !CONTRACT_ADDRESSES_LEGACY) {
        console.error('Error: Either CONTRACT_ADDRESSES or CONTRACT_ADDRESSES_LEGACY must be provided');
        process.exit(1);
    }

    if (!ADDRESSES_TO_FREEZE && !ADDRESSES_TO_UNFREEZE) {
        console.error('Error: Either ADDRESSES_TO_FREEZE or ADDRESSES_TO_UNFREEZE must be provided');
        process.exit(1);
    }

    if (ACTION !== 'freeze' && ACTION !== 'unfreeze' && ACTION !== 'both') {
        console.error('Error: ACTION must be "freeze", "unfreeze", or "both"');
        process.exit(1);
    }

    const contractAddresses = parseAddressList(CONTRACT_ADDRESSES);
    const legacyContractAddresses = parseAddressList(CONTRACT_ADDRESSES_LEGACY);
    const addressesToFreeze = parseAddressList(ADDRESSES_TO_FREEZE);
    const addressesToUnfreeze = parseAddressList(ADDRESSES_TO_UNFREEZE);

    validateAddresses([CALLER], 'CALLER address');
    validateAddresses(contractAddresses, 'contract address');
    validateAddresses(legacyContractAddresses, 'legacy contract address');
    validateAddresses(addressesToFreeze, 'address to freeze');
    validateAddresses(addressesToUnfreeze, 'address to unfreeze');
    let currentNonce = validatePositiveNumber(START_NONCE, 'Error: START_NONCE must be a valid number');

    printComment('// Freeze/Unfreeze Transaction Commands');
    printComment(`// Network: ${NETWORK}`);
    printComment(`// Caller: ${CALLER}`);
    printComment(`// Action: ${ACTION}`);
    printComment(`// Modern contracts: ${contractAddresses.length}`);
    printComment(`// Legacy contracts: ${legacyContractAddresses.length}`);
    printComment(`// Addresses to freeze: ${addressesToFreeze.length}`);
    printComment(`// Addresses to unfreeze: ${addressesToUnfreeze.length}`);
    printComment('');
    printComment('// IMPORTANT: ');
    printComment('// - CALLER must have ASSET_PROTECTION_ROLE for all contracts');
    printComment('// - Modern contracts always use batch operations (freezeBatch/unfreezeBatch)');
    printComment('// - Legacy contracts only support individual freeze/unfreeze operations');
    printComment('');

    let isFirstCommand = true;

    // Process freeze operations
    if ((ACTION === 'freeze' || ACTION === 'both') && addressesToFreeze.length > 0) {
        printComment('// === FREEZE OPERATIONS ===');
        printComment('');

        // Process modern contracts
        let result = processOperations('freeze', contractAddresses, addressesToFreeze, true, currentNonce, isFirstCommand);
        currentNonce = result.nonce;
        isFirstCommand = result.firstCommand;

        // Process legacy contracts
        result = processOperations('freeze', legacyContractAddresses, addressesToFreeze, false, currentNonce, isFirstCommand);
        currentNonce = result.nonce;
        isFirstCommand = result.firstCommand;
    }

    // Process unfreeze operations
    if ((ACTION === 'unfreeze' || ACTION === 'both') && addressesToUnfreeze.length > 0) {
        if (ACTION === 'both' && addressesToFreeze.length > 0) {
            printComment('');
        }
        printComment('// === UNFREEZE OPERATIONS ===');
        printComment('');

        // Process modern contracts
        let result = processOperations('unfreeze', contractAddresses, addressesToUnfreeze, true, currentNonce, isFirstCommand);
        currentNonce = result.nonce;
        isFirstCommand = result.firstCommand;

        // Process legacy contracts
        result = processOperations('unfreeze', legacyContractAddresses, addressesToUnfreeze, false, currentNonce, isFirstCommand);
        currentNonce = result.nonce;
        isFirstCommand = result.firstCommand;
    }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });