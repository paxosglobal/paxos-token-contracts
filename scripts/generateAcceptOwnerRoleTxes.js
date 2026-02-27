// This script generates acceptDefaultAdminTransfer commands for multiple contracts
const { ethers } = require("hardhat");
const { ValidateEnvironmentVariables } = require('./utils');

// Environment variables
const {
    CONTRACT_ADDRESSES,  // Comma-separated list of contract addresses (modern tokens)
    CONTRACT_ADDRESSES_LEGACY,  // Comma-separated list of legacy contract addresses
    NETWORK,
    NEW_OWNER,  // The address that will call acceptDefaultAdminTransfer/claimOwnership
    START_NONCE = '0',
    FILE_NAME = 'accept_admin_commands.json',
    NO_COMMENTS  // Set to 'true' to suppress comments
} = process.env;

// Helper function to print comment if not suppressed
function printComment(comment) {
    if (NO_COMMENTS !== 'true') {
        console.log(comment);
    }
}

// Helper function to generate acceptDefaultAdminTransfer command
function generateAcceptAdminTransferCommand(contractAddress, caller, nonce, isFirstCommand) {
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} acceptDefaultAdminTransfer ${inFlag}-e ${nonce} -f ${FILE_NAME}`;
}

// Helper function to generate claimOwnership command for legacy contracts
function generateClaimOwnershipCommand(contractAddress, caller, nonce, isFirstCommand) {
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} claimOwnership ${inFlag}-e ${nonce} -f ${FILE_NAME}`;
}

async function main() {
    // Validate required environment variables
    const required = [
        'NEW_OWNER',
        'NETWORK'
    ];

    // At least one of CONTRACT_ADDRESSES or CONTRACT_ADDRESSES_LEGACY must be provided
    if (!CONTRACT_ADDRESSES && !CONTRACT_ADDRESSES_LEGACY) {
        console.error('Error: Either CONTRACT_ADDRESSES or CONTRACT_ADDRESSES_LEGACY must be provided');
        process.exit(1);
    }

    ValidateEnvironmentVariables(required);

    // Parse and validate contract addresses
    const contractAddresses = CONTRACT_ADDRESSES ? 
        CONTRACT_ADDRESSES.split(',').map(addr => addr.trim()) : [];
    const legacyContractAddresses = CONTRACT_ADDRESSES_LEGACY ? 
        CONTRACT_ADDRESSES_LEGACY.split(',').map(addr => addr.trim()) : [];
    
    // Validate NEW_OWNER address
    if (!ethers.isAddress(NEW_OWNER)) {
        console.error(`Error: Invalid NEW_OWNER address: ${NEW_OWNER}`);
        process.exit(1);
    }

    // Validate each contract address
    for (const address of contractAddresses) {
        if (!ethers.isAddress(address)) {
            console.error(`Error: Invalid contract address: ${address}`);
            process.exit(1);
        }
    }
    
    // Validate each legacy contract address
    for (const address of legacyContractAddresses) {
        if (!ethers.isAddress(address)) {
            console.error(`Error: Invalid legacy contract address: ${address}`);
            process.exit(1);
        }
    }

    // Parse starting nonce
    let currentNonce = parseInt(START_NONCE);
    if (isNaN(currentNonce)) {
        console.error('Error: START_NONCE must be a valid number');
        process.exit(1);
    }

    // Print header comments
    printComment('// Accept Admin Transfer Commands');
    printComment(`// Network: ${NETWORK}`);
    printComment(`// New Owner: ${NEW_OWNER}`);
    printComment(`// Modern contracts: ${contractAddresses.length}`);
    printComment(`// Legacy contracts: ${legacyContractAddresses.length}`);
    printComment(`// Total contracts: ${contractAddresses.length + legacyContractAddresses.length}`);
    printComment(`// Generated at: ${new Date().toISOString()}`);
    printComment('');
    printComment('// IMPORTANT: ');
    printComment('// - Modern contracts: Execute after delay period from beginDefaultAdminTransfer');
    printComment('// - Legacy contracts: Execute after proposeOwner was called');
    printComment('// - All commands must be executed by NEW_OWNER');
    printComment('');

    let isFirstCommand = true;
    let commandIndex = 1;

    // Generate commands for modern contracts
    if (contractAddresses.length > 0) {
        printComment('// === MODERN CONTRACTS (acceptDefaultAdminTransfer) ===');
        contractAddresses.forEach((contractAddress, index) => {
            printComment(`// Contract ${commandIndex}: ${contractAddress}`);
            
            console.log(generateAcceptAdminTransferCommand(
                contractAddress,
                NEW_OWNER,
                currentNonce,
                isFirstCommand
            ));
            
            currentNonce++;
            commandIndex++;
            isFirstCommand = false;
            
            if (index < contractAddresses.length - 1 || legacyContractAddresses.length > 0) {
                printComment('');
            }
        });
    }

    // Generate commands for legacy contracts
    if (legacyContractAddresses.length > 0) {
        if (contractAddresses.length > 0) {
            printComment('');
        }
        printComment('// === LEGACY CONTRACTS (claimOwnership) ===');
        legacyContractAddresses.forEach((contractAddress, index) => {
            printComment(`// Contract ${commandIndex}: ${contractAddress}`);
            
            console.log(generateClaimOwnershipCommand(
                contractAddress,
                NEW_OWNER,
                currentNonce,
                isFirstCommand
            ));
            
            currentNonce++;
            commandIndex++;
            isFirstCommand = false;
            
            if (index < legacyContractAddresses.length - 1) {
                printComment('');
            }
        });
    }

    // Print footer comments
    printComment('');
    printComment(`// Total transactions: ${contractAddresses.length + legacyContractAddresses.length}`);
    printComment('// END OF GENERATED COMMANDS');
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });