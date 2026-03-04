// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";

/**
 * @title ClaimableRewardsFacet
 * @notice Diamond facet for claiming rewards functionality
 * @dev Handles all 4 claim functions with upToCheckpoint parameter
 *
 * @dev STORAGE: All storage variables inherited from ClaimableRewardsStorageV3 for shared access.
 *      Storage is shared with main contract through ClaimableRewardsStorageV3 inheritance.
 *
 * Functions:
 * - Claimer functions (2): claimAll, claimForAddresses
 * - Manager functions (2): claimAllTo, claimForAddressesTo
 *
 * All functions accept upToCheckpoint parameter:
 * - upToCheckpoint = false (default): claim rewards up to current time ("now")
 * - upToCheckpoint = true: claim rewards up to the last checkpoint time
 *
 * Authorization logic now delegated to ClaimableRewardsBase helpers (_isAuthorizedAsClaimer,
 * _isAuthorizedAsManager, _validateNotFrozen) to eliminate code duplication.
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract ClaimableRewardsFacet is ClaimableRewardsBase {
    // NOTE: Role constants (CLAIM_OPERATOR_ROLE, CLAIM_ADMIN_ROLE) inherited from ClaimableRewardsBase
    // NOTE: Shared errors are inherited via ClaimableRewardsBase:
    //       - From ClaimableRewardsErrors: InactivePayoutGroup, InvalidClaimer, NotAccountClaimer, PayoutGroupMismatch
    //       - From ClaimableRewardsBase: AddressFrozen, InsufficientFunds
    //       - From PaxosBaseAbstract (via ClaimableRewardsBase): ContractPaused, ZeroAddress

    // Facet-specific errors
    error InvalidDestination();

    // NOTE: whenNotPaused modifier inherited from PaxosBaseAbstract via ClaimableRewardsBase

    // Modifiers
    modifier validDestination(address destination) {
        if (destination == address(0)) revert InvalidDestination();
        _;
    }

    // ============ CLAIMER FUNCTIONS ============

    /**
     * @notice Claim all rewards for entire payout group (to configured destination)
     * @dev Callable by: Payout Group Claimer OR CLAIM_OPERATOR_ROLE
     * @param payoutGroupId The payout group ID
     * @return totalClaimed The total amount of rewards claimed
     */
    function claimAll(uint32 payoutGroupId) external whenNotPaused returns (uint256 totalClaimed) {
        return _claimAllAsClaimer(payoutGroupId);
    }

    /**
     * @notice Claim rewards for one or more accounts (to configured destination)
     * @dev Callable by: Payout Group Claimer OR CLAIM_OPERATOR_ROLE
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to claim for (can be single account)
     * @return totalClaimed The total amount of rewards claimed
     */
    function claimForAddresses(uint32 payoutGroupId, address[] calldata accounts) external whenNotPaused returns (uint256 totalClaimed) {
        return _claimForAddressesAsClaimer(payoutGroupId, accounts);
    }

    // ============ MANAGER FUNCTIONS ============

    /**
     * @notice Claim all rewards for entire payout group (to specified destination)
     * @dev Callable by: Payout Group Manager OR CLAIM_ADMIN_ROLE
     * @param payoutGroupId The payout group ID
     * @param destination The address to send claimed rewards to
     * @return totalClaimed The total amount of rewards claimed
     */
    function claimAllTo(uint32 payoutGroupId, address destination) external validDestination(destination) whenNotPaused returns (uint256 totalClaimed) {
        return _claimAllAsManager(payoutGroupId, destination);
    }

    /**
     * @notice Claim rewards for one or more accounts (to specified destination)
     * @dev Callable by: Payout Group Manager OR CLAIM_ADMIN_ROLE
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to claim for (can be single account)
     * @param destination The address to send rewards to
     * @return totalClaimed The total amount of rewards claimed
     */
    function claimForAddressesTo(uint32 payoutGroupId, address[] calldata accounts, address destination) external validDestination(destination) whenNotPaused returns (uint256 totalClaimed) {
        return _claimForAddressesAsManager(payoutGroupId, accounts, destination);
    }

    // ============ INTERNAL HELPER FUNCTIONS ============

    /**
     * @dev Internal helper for claimAll (claimer functions)
     * @param payoutGroupId The payout group ID
     * @return totalClaimed The total amount of rewards claimed
     */
    function _claimAllAsClaimer(uint32 payoutGroupId) internal returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Check authorization and freeze status
        if (!_isAuthorizedAsClaimer(payoutGroupId)) revert NotAccountClaimer();

        address destination = _getPayoutDestination(uint32(payoutGroupId));
        if (destination == address(0)) revert InvalidDestination();

        _validateNotFrozen(msg.sender, address(0), destination);

        return _executeClaimAll(payoutGroupId, destination);
    }

    /**
     * @dev Internal helper for claimForAddresses (claimer functions)
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to claim for
     * @return totalClaimed The total amount of rewards claimed
     */
    function _claimForAddressesAsClaimer(uint32 payoutGroupId, address[] calldata accounts) internal returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Check authorization
        if (!_isAuthorizedAsClaimer(payoutGroupId)) revert NotAccountClaimer();

        address destination = _getPayoutDestination(uint32(payoutGroupId));
        if (destination == address(0)) revert InvalidDestination();

        // Validate caller and destination are not frozen (account check happens in loop)
        _validateNotFrozen(msg.sender, address(0), destination);

        return _processBatchClaims(payoutGroupId, accounts, destination);
    }

    /**
     * @dev Internal helper for claimAllTo (manager functions)
     * @param payoutGroupId The payout group ID
     * @param destination The address to send claimed rewards to
     * @return totalClaimed The total amount of rewards claimed
     */
    function _claimAllAsManager(uint32 payoutGroupId, address destination) internal returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Check authorization
        if (!_isAuthorizedAsManager(payoutGroupId)) revert InvalidClaimer();

        // Validate freeze status
        _validateNotFrozen(msg.sender, address(0), destination);

        return _executeClaimAll(payoutGroupId, destination);
    }

    /**
     * @dev Internal helper for claimForAddressesTo (manager functions)
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to claim for
     * @param destination The address to send rewards to
     * @return totalClaimed The total amount of rewards claimed
     */
    function _claimForAddressesAsManager(uint32 payoutGroupId, address[] calldata accounts, address destination) internal returns (uint256) {
        if (!_isPayoutGroupActive(payoutGroupId)) revert InactivePayoutGroup();

        // Check authorization
        if (!_isAuthorizedAsManager(payoutGroupId)) revert InvalidClaimer();

        // Validate caller and destination are not frozen (account check happens in loop)
        _validateNotFrozen(msg.sender, address(0), destination);

        return _processBatchClaims(payoutGroupId, accounts, destination);
    }

    /**
     * @dev Process batch claims for multiple accounts
     * @param payoutGroupId The payout group ID
     * @param accounts Array of accounts to claim for
     * @param destination The destination address for rewards
     * @return totalClaimed The total amount of rewards claimed
     */
    function _processBatchClaims(uint32 payoutGroupId, address[] calldata accounts, address destination) internal returns (uint256 totalClaimed) {
        uint256 accountCount = accounts.length;
        for (uint256 i = 0; i < accountCount;) {
            address account = accounts[i];

            TokenAccountData memory accountData = _getBalanceData(account);
            if (accountData.payoutGroupId != payoutGroupId) revert PayoutGroupMismatch(payoutGroupId, accountData.payoutGroupId);

            // Check if account being claimed is frozen (individual check per account)
            if (_isFrozen(account)) revert AddressFrozen();

            // OPTIMIZATION: Pass already-loaded accountData to avoid duplicate SLOAD
            totalClaimed += _claimIndividualRewardsWithData(account, accountData, destination);

            unchecked { ++i; }
        }

        emit RewardsClaimedBatch(payoutGroupId, msg.sender, destination, totalClaimed, accountCount);
        return totalClaimed;
    }
}
