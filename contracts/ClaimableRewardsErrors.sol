// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ClaimableRewardsErrors
 * @dev Shared error definitions for V3 claimable rewards system
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract ClaimableRewardsErrors {
    // ==================================================================================
    // CORE ERRORS
    // ==================================================================================

    /**
     * @dev Thrown when attempting a claim operation but the claim source address is not set
     */
    error ClaimSourceNotSet();

    /**
     * @dev Thrown when the claim source does not have sufficient balance to fund a claim
     * @param required The amount of tokens required for the claim
     * @param available The actual balance available in the claim source
     */
    error InsufficientClaimSourceBalance(uint256 required, uint256 available);

    /**
     * @dev Thrown when attempting to register the claim source address to a payout group
     */
    error ClaimSourceCannotBeRegistered();

    // NOTE: AddressFrozen is NOT included here because it's already defined in PaxosBaseAbstract
    // and would cause a conflict when main contract inherits from both chains.
    // Facets get AddressFrozen from ClaimableRewardsBase where it's declared locally.

    // ==================================================================================
    // STORAGE ERRORS
    // ==================================================================================

    /**
     * @dev Thrown when total balance calculation would overflow
     */
    error TotalBalanceOverflow();

    /**
     * @dev Thrown when attempting to register an account that is already registered
     */
    error AlreadyRegistered();

    /**
     * @dev Thrown when attempting to operate on an unregistered account
     */
    error NotRegistered();

    // ==================================================================================
    // PAYOUT GROUP ERRORS
    // ==================================================================================

    /**
     * @dev Thrown when attempting to operate on an inactive payout group
     * @dev A payout group is inactive if it has been deleted or never created
     */
    error InactivePayoutGroup();

    /**
     * @dev Thrown when an invalid claimer address is provided
     * @dev Used in both claim operations and payout group management
     */
    error InvalidClaimer();

    /**
     * @dev Thrown when the caller is not authorized as the account claimer
     * @dev Used to restrict claim operations to authorized parties
     */
    error NotAccountClaimer();

    /**
     * @dev Thrown when attempting to operate with an invalid account address (e.g., zero address)
     */
    error InvalidAccount();

    /**
     * @dev Thrown when attempting to register the contract address to a payout group
     */
    error ContractCannotBeRegistered();

    /**
     * @dev Thrown when attempting to operate on a payout group that doesn't exist
     */
    error PayoutGroupNotFound();

    /**
     * @dev Thrown when attempting to accept a registration that doesn't exist
     */
    error NoRegistrationProposal();

    /**
     * @dev Thrown when the payout group ID in the proposal doesn't match the requested ID
     * @param expected The payout group ID in the pending proposal
     * @param actual The payout group ID provided in the accept call
     */
    error PayoutGroupMismatch(uint32 expected, uint32 actual);

    /**
     * @dev Thrown when attempting to cancel a proposal but caller is not the proposer
     */
    error NotProposer();

    // ==================================================================================
    // MULTIPLIER ERRORS
    // ==================================================================================

    /**
     * @dev Thrown when attempting to access a multiplier that doesn't exist
     * @param index The multiplier index that was not found
     */
    error MultiplierIndexNotFound(uint32 index);

    /**
     * @dev Thrown when minRate > maxRate in rate bounds configuration
     */
    error InvalidRateBounds();
}
