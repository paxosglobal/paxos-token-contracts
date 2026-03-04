// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";
import { SharesLib } from "../lib/SharesLib.sol";
import { StorageLib } from "../lib/StorageLib.sol";
import { Roles } from "../lib/Roles.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title PayoutGroupFacet
 * @notice Diamond facet for payout group and registration management
 * @dev Handles payout group CRUD, account registration, and related view functions
 *
 * @dev STORAGE: All storage variables inherited from ClaimableRewardsStorageV3 for shared access.
 *      Storage is shared with main contract through ClaimableRewardsStorageV3 inheritance.
 *
 * Functions:
 * - Payout group management (10 functions)
 * - Registration (6 functions)
 * - View functions (9 functions)
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract PayoutGroupFacet is ClaimableRewardsBase {
    // EIP-712 typehashes for signature-based registration
    bytes32 public constant REGISTER_REWARD_ADDRESS_TYPEHASH =
        keccak256("RegisterRewardAddress(address account,uint32 payoutGroupId,bytes32 nonce,uint256 deadline)");

    // NOTE: Events inherited from ClaimableRewardsEvents
    // NOTE: Shared errors are inherited via ClaimableRewardsBase:
    //       - From ClaimableRewardsErrors: MultiplierIndexNotFound, InactivePayoutGroup, InvalidClaimer, NotAccountClaimer
    //       - From ClaimableRewardsBase: AddressFrozen
    //       - From PaxosBaseAbstract (via ClaimableRewardsBase): InvalidSignature

    // Facet-specific errors
    error PayoutGroupAddressExists();
    error SignatureExpired();
    error PartnerSignedRegistrationsDisabled();
    error AuthorizationAlreadyUsed();
    error UnauthorizedRegistration();

    /**
     * @notice Returns the token name for EIP-712 domain
     * @return The token name
     */
    function name() public view virtual override returns (string memory) {
        return "Global Dollar";
    }

    // Modifiers
    modifier onlyPayoutGroupAdminRole() {
        if (!hasRole(Roles.PAYOUT_GROUP_ADMIN_ROLE, msg.sender)) revert InvalidClaimer();
        _;
    }

    modifier onlyPayoutGroupRegistrarRole() {
        if (!hasRole(Roles.PAYOUT_GROUP_REGISTRAR_ROLE, msg.sender)) revert InvalidClaimer();
        _;
    }

    // ============ PAYOUT GROUP MANAGEMENT FUNCTIONS ============

    /**
     * @notice Create a new payout group
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Associates claimer with multiplier.
     * @param multiplierId The multiplier ID to use for this group
     * @param claimer The claimer address for the payout group
     * @return payoutId The ID of the newly created payout group
     */
    function createPayoutGroup(uint32 multiplierId, address claimer) external onlyPayoutGroupRegistrarRole returns (uint32 payoutId) {
        return _createPayoutGroup(multiplierId, claimer, address(0), address(0));
    }

    /**
     * @notice Create a new payout group with optional manager and destination
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Use address(0) for manager/destination to skip.
     * @param multiplierId The multiplier ID to use for this group
     * @param claimer The claimer address for the payout group
     * @param manager The manager address (address(0) to skip setting manager)
     * @param destination The destination address (address(0) defaults to claimer)
     * @return payoutId The ID of the newly created payout group
     */
    function createPayoutGroupWithRoles(
        uint32 multiplierId,
        address claimer,
        address manager,
        address destination
    ) external onlyPayoutGroupRegistrarRole returns (uint32 payoutId) {
        return _createPayoutGroup(multiplierId, claimer, manager, destination);
    }

    /**
     * @dev Internal function to create a payout group with optional manager and destination
     * @param multiplierId The multiplier ID to use for this group
     * @param claimer The claimer address for the payout group
     * @param manager The manager address (address(0) to skip setting manager)
     * @param destination The destination address (address(0) defaults to claimer)
     * @return payoutId The ID of the newly created payout group
     */
    function _createPayoutGroup(
        uint32 multiplierId,
        address claimer,
        address manager,
        address destination
    ) internal returns (uint32 payoutId) {
        if (claimer == address(0)) revert InvalidClaimer();
        // Check if multiplier exists using helper
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);
        if (destination != address(0) && _isFrozen(destination)) revert AddressFrozen();

        // Initialize nextPayoutId if not set (diamond pattern storage access issue)
        if (nextPayoutId == 0) {
            nextPayoutId = 1;
        }
        payoutId = nextPayoutId++;

        // Set claimer mapping (note: multiple payout groups can share same claimer)
        payoutIdToClaimer[payoutId] = claimer;

        // Initialize payout group data using PayoutGroupData struct (shares model)
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId); // Already at 12 decimals
        payoutData[payoutId] = PayoutGroupData({
            balance: 0,
            shares: 0,
            multiplierId: uint16(multiplierId),
            lastClaimAllTime: 0, // No claimAll has occurred yet
            lastClaimAllMultiplier: StorageLib.toUint48Multiplier(currentMultiplier) // Already 12 decimals
        });

        // Increment payout group count for this multiplier
        multiplierPayoutGroupCount[multiplierId]++;

        emit PayoutGroupCreated(payoutId, claimer, multiplierId);

        // Set optional manager
        if (manager != address(0)) {
            payoutIdToManager[payoutId] = manager;
            emit PayoutGroupManagerSet(payoutId, address(0), manager);
        }

        // Set optional destination
        if (destination != address(0)) {
            payoutIdToDestination[payoutId] = destination;
            emit PayoutGroupDestinationSet(payoutId, address(0), destination);
        }

        return payoutId;
    }

    /**
     * @notice Delete a payout group
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Requires claiming to configured destination first.
     * @param payoutGroupId The payout group ID to remove
     */
    function deletePayoutGroup(uint32 payoutGroupId) external onlyPayoutGroupRegistrarRole {
        // Idempotent: if already deleted/inactive, skip (no-op)
        if (!_isPayoutGroupActive(payoutGroupId)) {
            return;
        }

        // Force claim all pending rewards before deletion
        address destination = _getPayoutDestination(payoutGroupId);
        _executeClaimAll(payoutGroupId, destination);

        // Decrement payout group count for this multiplier
        uint32 multiplierId = payoutData[payoutGroupId].multiplierId;
        multiplierPayoutGroupCount[multiplierId]--;

        // Get claimer before deletion for event emission
        address claimer = payoutIdToClaimer[payoutGroupId];

        // Clear all mappings by setting to zero
        delete payoutIdToClaimer[payoutGroupId];
        delete payoutIdToManager[payoutGroupId];
        delete payoutIdToDestination[payoutGroupId];
        delete payoutData[payoutGroupId];

        emit PayoutGroupDeleted(payoutGroupId, claimer);
    }

    /**
     * @notice Change the multiplier for a payout group (forces claim)
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Forces claim before changing.
     * @param payoutGroupId The payout group ID
     * @param multiplierId The new multiplier ID
     */
    function adminSetPayoutGroupMultiplier(uint32 payoutGroupId, uint32 multiplierId) external onlyPayoutGroupRegistrarRole {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();
        // Check if multiplier exists using helper
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);

        PayoutGroupData storage payoutGroup = payoutData[payoutGroupId];
        uint32 oldMultId = payoutGroup.multiplierId;

        if (oldMultId == multiplierId) {
            return; // No change needed
        }

        // Force claim before changing multiplier
        address destination = _getPayoutDestination(payoutGroupId);
        _executeClaimAll(payoutGroupId, destination);

        // Update payout group counts for both multipliers
        multiplierPayoutGroupCount[oldMultId]--;  // Decrement old multiplier
        multiplierPayoutGroupCount[multiplierId]++;     // Increment new multiplier

        // Update payout group to new multiplier
        payoutGroup.multiplierId = uint16(multiplierId);

        // Update lastClaimAllMultiplier to the NEW multiplier's current value.
        // lastClaimAllMultiplier is the multiplier value from which token accounts accrue
        // rewards since the last claimAll. By setting it to the new multiplier's value,
        // wallets start accruing rewards immediately at the new rate.
        uint256 newMultiplierValue = _getActiveMultiplier(multiplierId);
        payoutGroup.lastClaimAllMultiplier = StorageLib.toUint48Multiplier(newMultiplierValue);

        // Recalculate group shares with new multiplier to prevent phantom rewards
        // when switching to a higher-valued multiplier
        uint256 groupBalance = uint256(payoutGroup.balance);
        payoutGroup.shares = StorageLib.toUint64Shares(SharesLib.calcShares(groupBalance, newMultiplierValue));

        address claimer = payoutIdToClaimer[payoutGroupId];
        emit PayoutGroupMultiplierUpdated(payoutGroupId, claimer, oldMultId, multiplierId);
    }

    /**
     * @notice Admin set payout group claimer
     * @dev Restricted to PAYOUT_GROUP_ADMIN_ROLE
     * @param payoutGroupId The payout group ID
     * @param newClaimer The new claimer address
     */
    function adminSetPayoutGroupClaimer(uint32 payoutGroupId, address newClaimer) external onlyPayoutGroupAdminRole {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();
        if (newClaimer == address(0)) revert InvalidClaimer();

        address oldClaimer = payoutIdToClaimer[payoutGroupId];

        // Update claimer mapping (note: multiple payout groups can share same claimer)
        payoutIdToClaimer[payoutGroupId] = newClaimer;

        emit PayoutClaimerUpdated(payoutGroupId, oldClaimer, newClaimer);
    }

    /**
     * @notice Admin set payout group manager
     * @dev Restricted to PAYOUT_GROUP_ADMIN_ROLE
     * @param payoutGroupId The payout group ID
     * @param newManager The new manager address (address(0) to remove)
     */
    function adminSetPayoutGroupManager(uint32 payoutGroupId, address newManager) external onlyPayoutGroupAdminRole {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        address oldManager = payoutIdToManager[payoutGroupId];
        payoutIdToManager[payoutGroupId] = newManager;

        emit PayoutGroupManagerSet(payoutGroupId, oldManager, newManager);
    }

    /**
     * @notice Admin set payout group destination
     * @dev Restricted to PAYOUT_GROUP_ADMIN_ROLE
     * @param payoutGroupId The payout group ID
     * @param newDestination The new destination address (address(0) defaults to claimer)
     */
    function adminSetPayoutGroupDestination(uint32 payoutGroupId, address newDestination) external onlyPayoutGroupAdminRole {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();
        if (newDestination != address(0) && _isFrozen(newDestination)) revert AddressFrozen();

        address oldDestination = payoutIdToDestination[payoutGroupId];
        payoutIdToDestination[payoutGroupId] = newDestination;

        emit PayoutGroupDestinationSet(payoutGroupId, oldDestination, newDestination);
    }

    /**
     * @notice Manager set payout group claimer (manager can change claimer)
     * @dev Only callable by the manager of this payout group
     * @param payoutGroupId The payout group ID
     * @param newClaimer The new claimer address
     */
    function setPayoutGroupClaimer(uint32 payoutGroupId, address newClaimer) external {
        // Verify msg.sender is the manager for this payout group
        if (payoutIdToManager[payoutGroupId] != msg.sender) revert InvalidClaimer();
        if (newClaimer == address(0)) revert InvalidClaimer();

        address oldClaimer = payoutIdToClaimer[payoutGroupId];

        // Update claimer mapping (note: multiple payout groups can share same claimer)
        payoutIdToClaimer[payoutGroupId] = newClaimer;

        emit PayoutClaimerUpdated(payoutGroupId, oldClaimer, newClaimer);
    }

    /**
     * @notice Manager set payout group manager
     * @dev Only callable by the manager of this payout group
     * @param payoutGroupId The payout group ID
     * @param newManager The new manager address (address(0) to remove)
     */
    function setPayoutGroupManager(uint32 payoutGroupId, address newManager) external {
        // Verify msg.sender is the manager for this payout group
        if (payoutIdToManager[payoutGroupId] != msg.sender) revert InvalidClaimer();

        address oldManager = payoutIdToManager[payoutGroupId];
        payoutIdToManager[payoutGroupId] = newManager;

        emit PayoutGroupManagerSet(payoutGroupId, oldManager, newManager);
    }

    /**
     * @notice Manager set payout group destination
     * @dev Only callable by the manager of this payout group
     * @param payoutGroupId The payout group ID
     * @param newDestination The new destination address (address(0) defaults to claimer)
     */
    function setPayoutGroupDestination(uint32 payoutGroupId, address newDestination) external {
        // Verify msg.sender is the manager for this payout group
        if (payoutIdToManager[payoutGroupId] != msg.sender) revert InvalidClaimer();
        if (newDestination != address(0) && _isFrozen(newDestination)) revert AddressFrozen();

        address oldDestination = payoutIdToDestination[payoutGroupId];
        payoutIdToDestination[payoutGroupId] = newDestination;

        emit PayoutGroupDestinationSet(payoutGroupId, oldDestination, newDestination);
    }

    /**
     * @notice Enable or disable partner-initiated signature-based registrations
     * @dev Restricted to PAYOUT_GROUP_ADMIN_ROLE
     * @param enabled Whether to enable partner-initiated signature-based registrations
     */
    function setPartnerSignedRegistrationsEnabled(bool enabled) external onlyPayoutGroupAdminRole {
        globalTransferSettings.partnerSignedRegistrationsEnabled = enabled;
        emit PartnerSignedRegistrationsEnabledSet(enabled);
    }

    // ============ REGISTRATION FUNCTIONS ============

    /**
     * @notice Register an account to a payout group (Paxos registrar)
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Preserves any available rewards.
     * @param payoutGroupId The payout group ID
     * @param account The account to register
     */
    function registrarRegisterRewardAddress(uint32 payoutGroupId, address account) external onlyPayoutGroupRegistrarRole {
        _internalRegisterRewardAddress(payoutGroupId, account);
    }

    /**
     * @notice Unregister an account from a payout group (Paxos registrar)
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Includes claiming to configured destination.
     * @param payoutGroupId The payout group ID
     * @param account The account to unregister
     */
    function registrarUnregisterRewardAddress(uint32 payoutGroupId, address account) external onlyPayoutGroupRegistrarRole {
        _internalUnregisterRewardAddress(payoutGroupId, account);
    }

    /**
     * @notice Register multiple accounts to a payout group (Paxos registrar batch)
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Preserves any available rewards.
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to register
     */
    function registrarRegisterRewardAddressBatch(uint32 payoutGroupId, address[] calldata accounts) external onlyPayoutGroupRegistrarRole {
        for (uint256 i = 0; i < accounts.length; i++) {
            _internalRegisterRewardAddress(payoutGroupId, accounts[i]);
        }
    }

    /**
     * @notice Unregister multiple accounts from a payout group (Paxos registrar batch)
     * @dev Restricted to PAYOUT_GROUP_REGISTRAR_ROLE. Includes claiming to configured destination.
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to unregister
     */
    function registrarUnregisterRewardAddressBatch(uint32 payoutGroupId, address[] calldata accounts) external onlyPayoutGroupRegistrarRole {
        for (uint256 i = 0; i < accounts.length; i++) {
            _internalUnregisterRewardAddress(payoutGroupId, accounts[i]);
        }
    }

    /**
     * @notice Register an account to a payout group with signature validation (bytes signature version)
     * @dev Account signs EIP-712 structured data to authorize registration. Supports both EOA and contract wallets via EIP-1271.
     * @param payoutGroupId The payout group ID to register with
     * @param account The account to register (must match signature signer)
     * @param nonce A unique random nonce for this authorization
     * @param deadline Deadline for signature validity
     * @param signature Packed signature bytes (65 bytes for EOA, variable for contract wallets)
     */
    function registerRewardAddress(
        uint32 payoutGroupId,
        address account,
        bytes32 nonce,
        uint256 deadline,
        bytes memory signature
    ) external {
        _registerRewardAddress(payoutGroupId, account, nonce, deadline, signature);
    }

    /**
     * @notice Unregister an account from a payout group (claimer or manager-initiated, no signature required)
     * @dev Claimer OR manager of payoutGroupId calls this to unregister an address. Forces claim too.
     * @param payoutGroupId The payout group ID
     * @param account The account to unregister
     */
    function unregisterRewardAddress(uint32 payoutGroupId, address account) external whenNotPaused {
        // Verify caller is the claimer OR manager for this payout group
        if (!_isClaimerOrManager(payoutGroupId)) revert NotAccountClaimer();

        _internalUnregisterRewardAddress(payoutGroupId, account);
    }

    /**
     * @notice Propose registration of an account to a payout group (for smart contracts that cannot sign)
     * @dev Callable by claimer/manager OR registrar role. Creates pending proposal that must be accepted by account.
     * @param payoutGroupId The payout group ID
     * @param account The account to propose for registration
     */
    function proposeRegisterRewardAddress(uint32 payoutGroupId, address account) external {
        // Check authorization: must be claimer/manager OR registrar
        bool isClaimerOrManager = _isClaimerOrManager(payoutGroupId);
        bool isRegistrar = hasRole(Roles.PAYOUT_GROUP_REGISTRAR_ROLE, msg.sender);

        if (!isClaimerOrManager && !isRegistrar) {
            revert UnauthorizedRegistration();
        }

        // Validate inputs
        if (account == address(0)) revert InvalidAccount();
        if (account == address(this)) revert ContractCannotBeRegistered();
        if (!_isPayoutGroupActive(payoutGroupId)) revert PayoutGroupNotFound();

        // Prevent claim source from being registered to payout groups
        if (account == adminConfig.claimSource) revert ClaimSourceCannotBeRegistered();

        // Note: If account is already registered to another active payout group,
        // _internalRegisterRewardAddress will auto-unregister when the proposal is accepted

        // Store the pending proposal
        _pendingRegistrations[account] = PendingRegistration({
            payoutGroupId: payoutGroupId,
            proposer: msg.sender
        });

        emit RegistrationProposed(account, payoutGroupId, msg.sender);
    }

    /**
     * @notice Accept a pending registration proposal
     * @dev Must be called by the account that was proposed for registration
     * @param payoutGroupId The payout group ID to register to
     */
    function acceptRegisterRewardAddress(uint32 payoutGroupId) external {
        // Load the pending proposal for this caller
        PendingRegistration memory proposal = _pendingRegistrations[msg.sender];

        // Validate proposal exists and matches
        if (proposal.proposer == address(0)) revert NoRegistrationProposal();
        if (proposal.payoutGroupId != payoutGroupId) revert PayoutGroupMismatch(proposal.payoutGroupId, payoutGroupId);

        // Delete the proposal first (checks-effects-interactions pattern)
        // Note: If account is already registered, _internalRegisterRewardAddress will auto-unregister
        delete _pendingRegistrations[msg.sender];

        // Execute the registration
        _internalRegisterRewardAddress(payoutGroupId, msg.sender);

        emit RegistrationAccepted(msg.sender, payoutGroupId);
    }

    /**
     * @notice Cancel a pending registration proposal
     * @dev Can only be called by the address that made the proposal
     * @param account The account whose proposal to cancel
     */
    function cancelRegistrationProposal(address account) external {
        PendingRegistration memory proposal = _pendingRegistrations[account];

        // Validate proposal exists
        if (proposal.proposer == address(0)) revert NoRegistrationProposal();

        // Validate caller is the proposer
        if (proposal.proposer != msg.sender) revert NotProposer();

        // Store payoutGroupId before deletion for event
        uint32 payoutGroupId = proposal.payoutGroupId;

        // Delete the proposal
        delete _pendingRegistrations[account];

        emit RegistrationProposalCancelled(account, payoutGroupId, msg.sender);
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Get available rewards for an account (spec-compliant, shares model)
     * @param account The account to check
     * @return Available rewards amount
     */
    function availableRewardsOf(address account) external view returns (uint256) {
        return _availableRewardsOf(account);
    }

    /**
     * @notice Get available rewards for multiple accounts
     * @param accounts The accounts to check
     * @return rewards Array of available rewards amounts (same order as input accounts)
     */
    function availableRewardsOfBatch(address[] calldata accounts) external view returns (uint256[] memory rewards) {
        rewards = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length;) {
            rewards[i] = _availableRewardsOf(accounts[i]);
            unchecked { ++i; }
        }
        return rewards;
    }

    /**
     * @dev Internal function to calculate available rewards for an account
     * @param account The account to check
     * @return Available rewards amount
     */
    function _availableRewardsOf(address account) internal view returns (uint256) {
        TokenAccountData memory wallet = _getBalanceData(account);

        if (wallet.payoutGroupId == 0) {
            return 0; // No payout group
        }

        if (!_isPayoutGroupActive(wallet.payoutGroupId)) {
            return 0; // Inactive payout group
        }

        // Standard calculation for all accounts (shares model)
        // Get the multiplier for this account's payout group
        PayoutGroupData memory payoutGroup = payoutData[wallet.payoutGroupId];
        uint32 multiplierId = payoutGroup.multiplierId;
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);

        // Handle claimAll detection using timestamps (monotonically non-decreasing)
        uint256 shares = SharesLib.handleClaimAllDetection(
            uint256(wallet.balance),
            uint256(wallet.shares),
            wallet.lastUpdateTime,
            payoutGroup.lastClaimAllTime,
            uint256(payoutGroup.lastClaimAllMultiplier)
        );

        // Calculate rewards from shares using current multiplier
        // This gives rewards "up to now" by applying multiplier growth to the preserved shares
        return SharesLib.calcRewards(shares, currentMultiplier, uint256(wallet.balance));
    }

    /**
     * @notice Get payout group ID for an account
     * @param account The account to check
     * @return The payout group ID (0 if none)
     */
    function payoutGroupIdOf(address account) external view returns (uint32) {
        return _getBalanceData(account).payoutGroupId;
    }


    /**
     * @notice Get payout group available rewards by ID (spec-compliant, shares model)
     * @param payoutGroupId The payout group ID
     * @return Total available rewards for this payout group
     */
    function getPayoutGroupAvailableRewards(uint32 payoutGroupId) external view returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) return 0;

        PayoutGroupData memory payoutGroup = payoutData[payoutGroupId];
        uint32 multiplierId = payoutGroup.multiplierId;

        // Calculate on-demand using shares model (same logic as _executeClaimAll)
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);
        uint256 groupBalance = uint256(payoutGroup.balance);
        uint256 groupShares = uint256(payoutGroup.shares);

        // Calculate rewards from shares
        return SharesLib.calcRewards(groupShares, currentMultiplier, groupBalance);
    }

    /**
     * @notice Get payout group multiplier ID (spec-compliant)
     * @param payoutGroupId The payout group ID
     * @return The multiplier ID for this payout group
     */
    function getPayoutGroupMultId(uint32 payoutGroupId) external view returns (uint32) {
        if (!_isPayoutGroupActive(payoutGroupId)) return 0;

        return payoutData[payoutGroupId].multiplierId;
    }

    /**
     * @notice Get payout group claimer
     * @param payoutGroupId The payout group ID
     * @return The claimer address
     */
    function getPayoutGroupClaimer(uint32 payoutGroupId) external view returns (address) {
        return payoutIdToClaimer[payoutGroupId];
    }

    /**
     * @notice Get payout group manager
     * @param payoutGroupId The payout group ID
     * @return The manager address (address(0) if not set)
     */
    function getPayoutGroupManager(uint32 payoutGroupId) external view returns (address) {
        return payoutIdToManager[payoutGroupId];
    }

    /**
     * @notice Get payout group destination
     * @param payoutGroupId The payout group ID
     * @return The destination address (defaults to claimer if not set)
     */
    function getPayoutGroupDestination(uint32 payoutGroupId) external view returns (address) {
        return _getPayoutDestination(payoutGroupId);
    }

    /**
     * @notice Get pending registration proposal for an account
     * @param account The account to check
     * @return payoutGroupId The payout group ID in the proposal (0 if no proposal)
     * @return proposer The address that proposed the registration (zero address if no proposal)
     */
    function getPendingRegistration(address account) external view returns (uint32 payoutGroupId, address proposer) {
        PendingRegistration memory proposal = _pendingRegistrations[account];
        return (proposal.payoutGroupId, proposal.proposer);
    }

    /**
     * @notice Get payout group balance by ID (spec-compliant)
     * @param payoutGroupId The payout group ID
     * @return The balance for this payout group
     */
    function getPayoutGroupBalance(uint32 payoutGroupId) external view returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) return 0;
        return uint256(payoutData[payoutGroupId].balance);
    }

    /**
     * @notice Check if partner-initiated signature-based registrations are enabled
     * @return Whether partner-initiated signature-based registrations are enabled
     */
    function isPartnerSignedRegistrationsEnabled() external view returns (bool) {
        return globalTransferSettings.partnerSignedRegistrationsEnabled;
    }


    // ============ INTERNAL HELPER FUNCTIONS ============

    /**
     * @dev Internal function to handle reward address registration with bytes signature
     * @param payoutGroupId The payout group ID to register with
     * @param account The account to register (must match signature signer)
     * @param nonce A unique random nonce for this authorization
     * @param deadline Deadline for signature validity
     * @param signature Packed signature bytes
     */
    function _registerRewardAddress(
        uint32 payoutGroupId,
        address account,
        bytes32 nonce,
        uint256 deadline,
        bytes memory signature
    ) internal {
        // Check if feature is enabled
        if (!globalTransferSettings.partnerSignedRegistrationsEnabled) revert PartnerSignedRegistrationsDisabled();

        // Verify caller is the claimer OR manager for this payout group
        if (!_isClaimerOrManager(payoutGroupId)) revert NotAccountClaimer();
        if (block.timestamp > deadline) revert SignatureExpired();

        // Check nonce hasn't been used
        if (_registrationAuthState[account][nonce]) revert AuthorizationAlreadyUsed();

        // Mark nonce as used
        _registrationAuthState[account][nonce] = true;

        // Build EIP-712 digest
        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(
                REGISTER_REWARD_ADDRESS_TYPEHASH,
                account,
                payoutGroupId,
                nonce,
                deadline
            ))
        ));

        // Verify signature matches account
        if (!SignatureChecker.isValidSignatureNow(account, digest, signature)) revert InvalidSignature();

        _internalRegisterRewardAddress(uint32(payoutGroupId), account);
    }

    /**
     * @dev Internal function to register an account to a payout group (shares model)
     */
    function _internalRegisterRewardAddress(uint32 payoutGroupId, address account) internal {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Prevent claim source from being registered to payout groups
        if (account == adminConfig.claimSource) revert ClaimSourceCannotBeRegistered();

        // Prevent frozen accounts from being registered
        if (_isFrozen(account)) revert AddressFrozen();

        // Prevent contract address from being registered to payout groups
        if (account == address(this)) revert ContractCannotBeRegistered();

        // Load account balance data
        TokenAccountData memory wallet = _getBalanceData(account);

        // Idempotent: if already registered to the SAME payout group, skip (no-op)
        if (wallet.payoutGroupId == payoutGroupId) {
            return; // Already in desired state
        }

        // Auto-unregister from current payout group if registered to a different active group
        // This allows users to switch payout groups with a single signature
        // (claims rewards to old destination before switching)
        if (wallet.payoutGroupId != 0 && _isPayoutGroupActive(wallet.payoutGroupId)) {
            _internalUnregisterRewardAddress(wallet.payoutGroupId, account);
            // Reload wallet data after unregister (shares were reset)
            wallet = _getBalanceData(account);
        }

        // Load payout group data
        PayoutGroupData storage payoutGroup = payoutData[payoutGroupId];
        uint32 multiplierId = payoutGroup.multiplierId;
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);

        // Calculate new shares based on actual balance
        uint256 newShares = SharesLib.calcShares(uint256(wallet.balance), currentMultiplier);

        // Update account with new payout group (shares model)
        uint40 currentTime = uint40(block.timestamp);
        _setBalanceData(
            account,
            uint256(wallet.balance),
            newShares,
            uint256(payoutGroupId),
            currentTime
        );

        // Update payout group balance and shares (wallet.balance is never negative)
        // Load payoutGroup to memory for optimization
        PayoutGroupData memory payoutGroupMem = payoutData[payoutGroupId];

        _updatePayoutGroupBals(payoutGroupId, payoutGroupMem, int256(uint256(wallet.balance)), int256(newShares));

        address claimer = payoutIdToClaimer[payoutGroupId];
        emit AccountRegistered(account, payoutGroupId, claimer);
    }

    /**
     * @dev Internal function to unregister an account from a payout group (shares model)
     */
    function _internalUnregisterRewardAddress(uint32 payoutGroupId, address account) internal {
        TokenAccountData memory wallet = _getBalanceData(account);

        // Idempotent: if already unregistered (payoutGroupId == 0), skip (no-op)
        if (wallet.payoutGroupId == 0) {
            return; // Already in desired state
        }

        // Verify account is registered to the correct payout group
        if (wallet.payoutGroupId != payoutGroupId) revert NotAccountClaimer();

        // Verify payout group is active (prevents unregistering from deleted groups)
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Claim any available rewards to configured destination before unregistering
        address destination = _getPayoutDestination(payoutGroupId);
        _claimIndividualRewards(account, destination);

        // Reload wallet data after claim (shares were reset)
        TokenAccountData memory updatedWallet = _getBalanceData(account);

        // Calculate deltas for hierarchical updates (removing this account)
        int256 balanceDelta = -int256(uint256(updatedWallet.balance));
        int256 sharesDelta = -int256(uint256(updatedWallet.shares));

        // Deregister - clear payout group assignment (set shares=0, payoutGroupId=0, lastUpdateTime=0)
        _setBalanceData(account, uint256(updatedWallet.balance), 0, 0, 0);

        // Get payout group data
        PayoutGroupData memory payoutGroup = payoutData[payoutGroupId];
        // Update payout group balance and shares
        _updatePayoutGroupBals(payoutGroupId, payoutGroup, balanceDelta, sharesDelta);

        address claimer = payoutIdToClaimer[payoutGroupId];
        emit AccountDeregistered(account, payoutGroupId, claimer);
    }
}
