// This script is used to update roles from the legacy multisigs to HSMs.
const { ethers } = require("hardhat");
const { ValidateEnvironmentVariables } = require('./utils');

// Role constants
// keccak256("PAUSE_ROLE")
const PAUSE_ROLE = '0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d';
// keccak256("ASSET_PROTECTION_ROLE")
const ASSET_PROTECTION_ROLE = '0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796';
// keccak256("SUPPLY_CONTROLLER_MANAGER_ROLE")
const SUPPLY_CONTROLLER_MANAGER_ROLE = '0x5d3e9f1ecbcdad7b0da30e7d29c9eddaef83a4502dafe3d2dd85cfdb12e4af10';

// Environment variables
const {
    TOKEN_CONTRACT_ADDRESS,
    NETWORK,
    NEW_OWNER,  // DEFAULT_ADMIN_ROLE holder or owner for legacy tokens
    NEW_PROXY_ADMIN,  // Proxy admin (only for AdminUpgradeabilityProxy tokens)
    NEW_PAUSER,
    NEW_ASSET_PROTECTOR,
    NEW_SUPPLY_CONTROLLER_MANAGER,
    SUPPLY_CONTROL_CONTRACT_ADDRESS,
    USE_ADMIN_PROXY,
    USE_LEGACY_PAXOS_TOKEN,  // Set to 'true' for legacy PaxosToken.sol contracts
    START_NONCE = '0',
    START_NONCE_ADMIN = '0',
    FILE_NAME = 'role_change_commands.txt',
    CURRENT_OWNER,  // Current DEFAULT_ADMIN_ROLE holder or owner for legacy tokens
    CURRENT_PROXY_ADMIN,  // Current proxy admin (only for AdminUpgradeabilityProxy tokens)
    CURRENT_PAUSER,
    CURRENT_ASSET_PROTECTOR,
    CURRENT_SUPPLY_CONTROLLER_MANAGER,
    CHILD_NUM_OWNER, //Multisig child num for DEFAULT_ADMIN_ROLE or owner
    CHILD_NUM_ADMIN, //Multisig child num for proxy admin
    NO_COMMENTS  // Set to 'true' to suppress comments
} = process.env;

// Helper function to generate grantRole command
function generateGrantRoleCommand(contractAddress, caller, role, recipient, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    // Use CHILD_NUM_ADMIN if caller is proxy admin, otherwise CHILD_NUM_OWNER
    const childNum = caller === CURRENT_PROXY_ADMIN ? CHILD_NUM_ADMIN : CHILD_NUM_OWNER;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} grantRole ${role} ${recipient} ${inFlag}-e ${nonce} --multisig -d ${childNum} -f ${FILE_NAME}`;
}

// Helper function to generate revokeRole command
function generateRevokeRoleCommand(contractAddress, caller, role, revokee, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    // Use CHILD_NUM_ADMIN if caller is proxy admin, otherwise CHILD_NUM_OWNER
    const childNum = caller === CURRENT_PROXY_ADMIN ? CHILD_NUM_ADMIN : CHILD_NUM_OWNER;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} revokeRole ${role} ${revokee} ${inFlag}-e ${nonce} --multisig -d ${childNum} -f ${FILE_NAME}`;
}

// Helper function to generate beginDefaultAdminTransfer command
function generateBeginAdminTransferCommand(contractAddress, caller, newAdmin, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    // Use CHILD_NUM_ADMIN if caller is proxy admin, otherwise CHILD_NUM_OWNER
    const childNum = caller === CURRENT_PROXY_ADMIN ? CHILD_NUM_ADMIN : CHILD_NUM_OWNER;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} beginDefaultAdminTransfer ${newAdmin} ${inFlag}-e ${nonce} --multisig -d ${childNum} -f ${FILE_NAME}`;
}

// Helper function to generate proxy admin change command
function generateChangeProxyAdminCommand(contractAddress, currentAdmin, newAdmin, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${currentAdmin} changeAdmin ${newAdmin} ${inFlag}-e ${nonce} --multisig -d ${CHILD_NUM_ADMIN} -f ${FILE_NAME}`;
}

// Helper function to print comment if not suppressed
function printComment(comment) {
    if (NO_COMMENTS !== 'true') {
        console.log(comment);
    }
}

// Legacy token helper functions
function generateSetAssetProtectionRoleCommand(contractAddress, caller, newAssetProtector, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} setAssetProtectionRole ${newAssetProtector} ${inFlag}-e ${nonce} --multisig -d ${CHILD_NUM_OWNER} -f ${FILE_NAME}`;
}

function generateSetSupplyControllerCommand(contractAddress, caller, newSupplyController, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} setSupplyController ${newSupplyController} ${inFlag}-e ${nonce} --multisig -d ${CHILD_NUM_OWNER} -f ${FILE_NAME}`;
}

function generateProposeOwnerCommand(contractAddress, caller, proposedOwner, nonce, initialNonce) {
    const isFirstCommand = nonce === initialNonce;
    const inFlag = isFirstCommand ? '' : `--in ${FILE_NAME} `;
    return `bin/pax-contract -n ${NETWORK} -c ${contractAddress} call ${caller} proposeOwner ${proposedOwner} ${inFlag}-e ${nonce} --multisig -d ${CHILD_NUM_OWNER} -f ${FILE_NAME}`;
}
// End legacy token helper functions

async function main() {
    // Validate required environment variables
    const required = [
        'TOKEN_CONTRACT_ADDRESS',
        'CURRENT_OWNER',
        'NETWORK',
        'CHILD_NUM_OWNER'
    ];

    // Additional required variables for AdminUpgradeabilityProxy tokens
    if (USE_ADMIN_PROXY === 'true') {
        required.push('NEW_PROXY_ADMIN');
    }

    ValidateEnvironmentVariables(required);

    // Additional address validation
    const addresses = {
        ...(TOKEN_CONTRACT_ADDRESS && { TOKEN_CONTRACT_ADDRESS }),
        ...(NEW_PROXY_ADMIN && { NEW_PROXY_ADMIN }),
        ...(NEW_OWNER && { NEW_OWNER }),
        ...(NEW_PAUSER && { NEW_PAUSER }),
        ...(NEW_ASSET_PROTECTOR && { NEW_ASSET_PROTECTOR }),
        ...(NEW_SUPPLY_CONTROLLER_MANAGER && { NEW_SUPPLY_CONTROLLER_MANAGER }),
        ...(SUPPLY_CONTROL_CONTRACT_ADDRESS && { SUPPLY_CONTROL_CONTRACT_ADDRESS }),
        ...(CURRENT_OWNER && { CURRENT_OWNER }),
        ...(CURRENT_PROXY_ADMIN && { CURRENT_PROXY_ADMIN }),
        ...(CURRENT_PAUSER && { CURRENT_PAUSER }),
        ...(CURRENT_ASSET_PROTECTOR && { CURRENT_ASSET_PROTECTOR }),
        ...(CURRENT_SUPPLY_CONTROLLER_MANAGER && { CURRENT_SUPPLY_CONTROLLER_MANAGER })
    };

    // Validate addresses using ethers
    for (const [name, address] of Object.entries(addresses)) {
        if (!ethers.isAddress(address)) {
            console.error(`Error: Invalid address for ${name}: ${address}`);
            process.exit(1);
        }
    }

    let currentNonce = parseInt(START_NONCE);
    if (isNaN(currentNonce)) {
        console.error('Error: START_NONCE must be a valid number');
        process.exit(1);
    }
    const initialNonce = currentNonce;  // Store initial nonce for first command detection

    // For proxy admin operations, we need a separate nonce
    let adminNonce = parseInt(process.env.START_NONCE_ADMIN);
    if (isNaN(adminNonce)) {
        console.error('Error: START_NONCE_ADMIN must be a valid number');
        process.exit(1);
    }
    const initialAdminNonce = adminNonce;

    if (CHILD_NUM_OWNER && isNaN(parseInt(CHILD_NUM_OWNER))) {
        console.error('Error: CHILD_NUM_OWNER must be a valid number');
        process.exit(1);
    }

    // Print header comments
    printComment('// Role Change Transaction Commands');
    printComment(`// Token Contract: ${TOKEN_CONTRACT_ADDRESS}`);
    printComment(`// Network: ${NETWORK}`);
    printComment(`// Token Type: ${USE_LEGACY_PAXOS_TOKEN === 'true' ? 'Legacy PaxosToken' : (USE_ADMIN_PROXY === 'true' ? 'AdminUpgradeabilityProxy' : 'AccessControlDefaultAdminRules')}`);
    printComment(`// Generated at: ${new Date().toISOString()}`);
    printComment('');

    // Handle legacy tokens or modern tokens
    if (USE_LEGACY_PAXOS_TOKEN === 'true') {
        currentNonce = handleLegacyTokenRoleChanges(currentNonce, initialNonce);
    } else {
        const result = handleModernTokenRoleChanges(currentNonce, initialNonce, adminNonce, initialAdminNonce);
        currentNonce = result.ownerNonce;
        adminNonce = result.adminNonce;
    }

    // Step 5: Handle proxy admin change for AdminUpgradeabilityProxy tokens
    if (USE_ADMIN_PROXY === 'true' && CURRENT_PROXY_ADMIN && NEW_PROXY_ADMIN) {
        if (!CHILD_NUM_ADMIN) {
            printComment('');
            console.error('Error: Please set CHILD_NUM_ADMIN environment variable');
            process.exit(1);
        }

        printComment('');
        printComment('// Step 5: Change AdminUpgradeabilityProxy proxy admin (controls upgrades).  THIS IS A HIGH RISK TX - DOUBLE CHECK THIS!!!');
        printComment('// Note: Proxy admin and token owner (DEFAULT_ADMIN_ROLE) are separate roles');
        printComment('// Note: Creates a separate file since this is a different signer from the owner');
        printComment('');

        console.log(generateChangeProxyAdminCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_PROXY_ADMIN,
            NEW_PROXY_ADMIN,
            adminNonce,
            -1 //Hack to force --in flag to be added
        ));
        currentNonce++ //Just for tracking the # of total transactions
    }

    printComment('// END OF GENERATED COMMANDS');
}

// Function to handle modern token role changes
function handleModernTokenRoleChanges(currentNonce, initialNonce, adminNonce, initialAdminNonce) {
    let nonce = currentNonce;
    let currentAdminNonce = adminNonce;
    
    // Modern tokens with role-based access control
    printComment('// Step 1: Grant new token roles');
    printComment('');

    // Grant PAUSE_ROLE
    if (NEW_PAUSER) {
        console.log(generateGrantRoleCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_OWNER,
            PAUSE_ROLE,
            NEW_PAUSER,
            nonce++,
            initialNonce
        ));
    }

    // Grant ASSET_PROTECTION_ROLE
    if (NEW_ASSET_PROTECTOR) {
        console.log(generateGrantRoleCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_OWNER,
            ASSET_PROTECTION_ROLE,
            NEW_ASSET_PROTECTOR,
            nonce++,
            initialNonce
        ));
    }

    // Grant SUPPLY_CONTROLLER_MANAGER_ROLE (if applicable) - uses proxy admin as caller
    if (NEW_SUPPLY_CONTROLLER_MANAGER && SUPPLY_CONTROL_CONTRACT_ADDRESS) {
        console.log(generateGrantRoleCommand(
            SUPPLY_CONTROL_CONTRACT_ADDRESS,
            CURRENT_PROXY_ADMIN,
            SUPPLY_CONTROLLER_MANAGER_ROLE,
            NEW_SUPPLY_CONTROLLER_MANAGER,
            currentAdminNonce++,
            -1 //A hack for this first admin tx since otherwise it'll think this is the first tx
        ));
    }

    // Step 2: Revoke old roles (if current addresses provided)
    if (CURRENT_OWNER || CURRENT_PAUSER || CURRENT_ASSET_PROTECTOR || CURRENT_SUPPLY_CONTROLLER_MANAGER) {
        printComment('');
        printComment('// Step 2: Revoke old roles');
        printComment('// WARNING: Ensure new roles are confirmed before executing these commands!');
        printComment('');

        // Revoke PAUSE_ROLE
        if (CURRENT_PAUSER && CURRENT_PAUSER !== NEW_PAUSER) {
            console.log(generateRevokeRoleCommand(
                TOKEN_CONTRACT_ADDRESS,
                CURRENT_OWNER,
                PAUSE_ROLE,
                CURRENT_PAUSER,
                nonce++,
                initialNonce
            ));
        }

        // Revoke ASSET_PROTECTION_ROLE
        if (CURRENT_ASSET_PROTECTOR && CURRENT_ASSET_PROTECTOR !== NEW_ASSET_PROTECTOR) {
            console.log(generateRevokeRoleCommand(
                TOKEN_CONTRACT_ADDRESS,
                CURRENT_OWNER,
                ASSET_PROTECTION_ROLE,
                CURRENT_ASSET_PROTECTOR,
                nonce++,
                initialNonce
            ));
        }

        // Revoke SUPPLY_CONTROLLER_MANAGER_ROLE - uses proxy admin as caller
        if (CURRENT_SUPPLY_CONTROLLER_MANAGER && CURRENT_SUPPLY_CONTROLLER_MANAGER !== NEW_SUPPLY_CONTROLLER_MANAGER && SUPPLY_CONTROL_CONTRACT_ADDRESS) {
            console.log(generateRevokeRoleCommand(
                SUPPLY_CONTROL_CONTRACT_ADDRESS,
                CURRENT_PROXY_ADMIN,
                SUPPLY_CONTROLLER_MANAGER_ROLE,
                CURRENT_SUPPLY_CONTROLLER_MANAGER,
                currentAdminNonce++,
                initialAdminNonce
            ));
        }
    }

    // Step 3: Begin DEFAULT_ADMIN_ROLE transfer
    printComment('');
    printComment('// Step 3: Begin DEFAULT_ADMIN_ROLE transfer. Note: ');
    printComment('//   1. The current owner must first call beginDefaultAdminTransfer(newOwner)');
    printComment('//   2. After the delay period, the new owner must call acceptDefaultAdminTransfer()');
    printComment('// This two-step process provides additional security for admin transfers.');
    printComment('');

    // Begin admin transfer for Supply Control contract - uses proxy admin as caller
    if (SUPPLY_CONTROL_CONTRACT_ADDRESS && NEW_OWNER) {
        console.log(generateBeginAdminTransferCommand(
            SUPPLY_CONTROL_CONTRACT_ADDRESS,
            CURRENT_PROXY_ADMIN,
            NEW_OWNER,
            currentAdminNonce++,
            initialAdminNonce
        ));
    }

    // Begin admin transfer for token contract (newer tokens only)
    console.log(generateBeginAdminTransferCommand(
        TOKEN_CONTRACT_ADDRESS,
        CURRENT_OWNER,
        NEW_OWNER,
        nonce++,
        initialNonce
    ));

    // Step 4: Accept DEFAULT_ADMIN_ROLE transfer
    printComment('');
    printComment('// Step 4: After delay period (typically 3 hours), new owner must accept the transfer');
    printComment('// Use the generateAcceptAdminTransferTxes.js script to generate these commands');
    printComment('');

    return { ownerNonce: nonce, adminNonce: currentAdminNonce };
}

// Function to handle legacy token role changes
function handleLegacyTokenRoleChanges(currentNonce, initialNonce) {
    let nonce = currentNonce;
    
    // For legacy tokens, we set roles directly
    printComment('// Step 1: Set new roles for legacy PaxosToken');
    printComment('// Note: Legacy tokens use setAssetProtectionRole/setSupplyController instead of grantRole');
    printComment('');

    // Set asset protection role
    if (NEW_ASSET_PROTECTOR && (!CURRENT_ASSET_PROTECTOR || CURRENT_ASSET_PROTECTOR !== NEW_ASSET_PROTECTOR)) {
        console.log(generateSetAssetProtectionRoleCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_OWNER,
            NEW_ASSET_PROTECTOR,
            nonce++,
            initialNonce
        ));
    }

    // Set supply controller (directly on token, not SupplyControl contract)
    if (NEW_SUPPLY_CONTROLLER_MANAGER && (!CURRENT_SUPPLY_CONTROLLER_MANAGER || CURRENT_SUPPLY_CONTROLLER_MANAGER !== NEW_SUPPLY_CONTROLLER_MANAGER)) {
        console.log(generateSetSupplyControllerCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_OWNER,
            NEW_SUPPLY_CONTROLLER_MANAGER,
            nonce++,
            initialNonce
        ));
    }

    // Note: Legacy tokens don't have a separate pause role - owner controls pause/unpause
    if (NEW_PAUSER && NEW_PAUSER !== NEW_OWNER) {
        printComment('// WARNING: Legacy tokens do not have a separate pause role. Only the owner can pause/unpause.');
    }

    printComment('');
    printComment('// Note: Legacy tokens automatically replace roles when setting new ones.');
    printComment('// No explicit revoke needed.');

    // Legacy token ownership transfer
    if (NEW_OWNER && CURRENT_OWNER !== NEW_OWNER) {
        printComment('');
        printComment('// Step 3: Begin ownership transfer for legacy PaxosToken');
        printComment('// Note: Legacy tokens use proposeOwner/claimOwnership pattern');
        printComment('');

        console.log(generateProposeOwnerCommand(
            TOKEN_CONTRACT_ADDRESS,
            CURRENT_OWNER,
            NEW_OWNER,
            nonce++,
            initialNonce
        ));

        printComment('');
        printComment('// Step 4: New owner must call claimOwnership');
        printComment('// Use the generateAcceptAdminTransferTxes.js script to generate this command');
        printComment('');
    }
    return nonce;
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });