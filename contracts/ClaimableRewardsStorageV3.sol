// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsErrors } from "./ClaimableRewardsErrors.sol";

/**
 * @title ClaimableRewardsStorageV3
 * @dev V3 storage layer for claimable rewards functionality (pure storage, no inheritance)
 *
 * STORAGE VERSIONING:
 * ===================
 * BaseStorage (V2)             - Core token storage (simple storage for PaxosTokenV2)
 * BaseStorageV3 (V3)           - V3 packed storage (DOMAIN_SEPARATOR_DEPRECATED, _nonces, _authorizationStates, packed BalanceData)
 * ClaimableRewardsStorageV3    - V3 additions (payout groups, multipliers, rewards)
 *
 * DIAMOND PATTERN ALIGNMENT:
 * =========================
 * This contract does NOT inherit from BaseStorageV3 to allow flexible composition:
 *
 * Main contract:  BaseStorageV3 → AccessControl (201 slots) → ClaimableRewardsStorageV3
 * Facets:         BaseStorageV3 → FacetStorage (201-slot gap) → ClaimableRewardsStorageV3
 *
 * Both arrangements place V3 storage at the same absolute slots, enabling correct
 * delegatecall behavior for diamond pattern facets.
 *
 * V3 storage variables appear at slot 252+ (after AccessControl/gap in both).
 * Changes to V3 storage are safe and don't break V2→V3 upgrade compatibility.
 */
contract ClaimableRewardsStorageV3 is ClaimableRewardsErrors {
    // ==================================================================================
    // V3 STRUCT DEFINITIONS (no storage impact, kept at top for readability)
    // ==================================================================================

    // Payout Group Data - shares-based model
    struct PayoutGroupData {
        uint64 balance;                           // 8 bytes (up to ~18 trillion at 6 decimals)
        uint64 shares;                            // 8 bytes (up to 18 trillion at 6 decimals)
                                                  //   (shares * multiplier represents total value)
        uint16 multiplierId;                      // 2 bytes (max 65k multipliers)
        uint40 lastClaimAllTime;                  // 5 bytes - timestamp when last claimAll occurred
        uint48 lastClaimAllMultiplier;            // 6 bytes (12 decimals, max 281x growth)
                                                  // The multiplier value from which token accounts accrue rewards
                                                  // since the last claimAll. By forcing claimAll when multiplier
                                                  // changes, future accrual works in units of the new multiplier.
        // Total: 29 bytes (3 bytes unused in 32-byte slot)
    }

    // Multiplier Data needed to figure out current multiplier
    struct MultiplierData {
        uint40 beforeRate;                      // 5 bytes - APR rate (fraction w/o 1, 10 decimals)
        uint40 afterRate;                       // 5 bytes - scheduled next rate (10 decimals)
        uint40 switchTime;                      // 5 bytes - timestamp when rate switches (type(uint40).max = no scheduled rate)
        uint48 switchTimeMultiplier;            // 6 bytes - multiplier at switchTime (12 decimals)
        uint16 nextActiveId;                    // 2 bytes - next active multiplier ID (0 = end of list)
        // Total: 23 bytes (9 bytes unused in 32-byte slot)
    }

    // Admin Config Settings - COLD PATH (admin operations only)
    // Separate struct to avoid loading on every transfer
    struct AdminConfigSettings {
        address claimSource;          // 20 bytes - single global claim source (funds all claims)
        uint40 minRate;              // 5 bytes, 10 decimals - Global minimum allowed APR
        uint40 maxRate;              // 5 bytes, 10 decimals - Global maximum allowed APR
        // Total: 30 bytes used, 2 bytes remaining in 32-byte slot
    }

    // Pending Registration Proposal - for smart contract address registration
    // Allows propose-accept flow for addresses that cannot sign EIP712 messages
    struct PendingRegistration {
        uint32 payoutGroupId;        // 4 bytes - payout group ID
        address proposer;            // 20 bytes - who proposed this registration
        // Total: 24 bytes (8 bytes unused)
    }

    // Frozen Data - stored when an address is frozen
    // Contains rewards and payout group ID for restoration on unfreeze
    struct FrozenData {
        uint64 rewards;              // 8 bytes - Frozen reward amount (base units, max ~18 trillion for 6 decimals)
        uint32 payoutGroupId;        // 4 bytes - Original payout group (for restoration on unfreeze)
        // Total: 12 bytes (20 bytes unused in 32-byte slot)
    }

    // NOTE: BalanceData struct, balanceData mapping, and tokenAccountFlags mapping
    // are now inherited from BaseStorage for V2→V3 upgrade compatibility

    // ==================================================================================
    // V3 STORAGE VARIABLES (Slot 252+ in both main contract and facets after alignment)
    // ==================================================================================

    // MAPPING TYPE DESIGN PATTERN:
    // - Keys use uint256 for forward compatibility: allows expansion beyond packed storage
    //   limits (uint24, uint32, etc.) without rewriting mappings. Hash cost is same
    //   regardless of key size, and casts are free.
    // - Values sized appropriately: uint32 provides reasonable ID limits (~4 billion)
    //   while minimizing storage costs on writes.

    mapping(uint256 => PayoutGroupData) internal payoutData;
    mapping(uint256 => address) internal payoutIdToClaimer;
    mapping(uint256 => address) internal payoutIdToManager;
    mapping(uint256 => address) internal payoutIdToDestination;
    uint16 internal nextPayoutId;

    // Multiplier storage with linked list for deletion support
    // Using double mapping (no arrays) to eliminate bounds checks on hot path (-2,100 gas)
    mapping(uint256 => MultiplierData) internal multipliers;
    mapping(uint256 => uint256) internal multiplierPayoutGroupCount; // O(1) deletion safety check
    uint16 internal nextMultiplierId;        // Next ID to assign (starts at 1, 0 = invalid/no multiplier)
    uint16 internal firstActiveId;           // Head of linked list (0 = empty list)
    uint16 internal activeMultiplierCount;   // Count of active multipliers

    AdminConfigSettings internal adminConfig;   // COLD PATH: admin operations only
    mapping(address => mapping(bytes32 => bool)) internal _registrationAuthState;
    mapping(address => PendingRegistration) internal _pendingRegistrations;  // Pending propose-accept registrations
    mapping(address => FrozenData) internal frozenData;  // Frozen data for frozen addresses (rewards + original payout group)

    // Storage gap for future upgrades
    // This gap, combined with the gaps above, reserves space for future V3+ storage additions
    // Total ClaimableRewardsStorage slots used (beyond BaseStorage):
    //   - 1 (_nonces) + 10 (EIP2612 gap) = 11 slots
    //   - 1 (_authorizationStates) + 10 (EIP3009 gap) = 11 slots
    //   - 101 (AccessControl reserved) = 101 slots
    //   - ~15 (new V3 variables: 6 mappings + 1 uint32 + 1 array + 1 mapping + 1 struct + 1 mapping)
    //   - Total used: ~138 slots beyond BaseStorage
    // Leaving this gap smaller to accommodate the reserved AccessControl space

    // ==================================================================================
    // STORAGE ACCESSOR FUNCTIONS
    // ==================================================================================
    // These functions provide safe access to ClaimableRewardsStorageV3 storage.
    // Placed here (not in ClaimableRewardsBase) to be accessible by both:
    // - PaxosTokenClaimableRewards (main contract)
    // - ClaimableRewardsBase (inherited by facets)

    /**
     * @dev Check if payout group is active (has valid claimer)
     * @dev This is the primary check used by facets and is more reliable than checking struct fields
     * @dev The claimer mapping is cleared on deletion, making this a definitive check
     * @param payoutId The payout ID to check
     * @return True if active (payoutId > 0 and has claimer)
     */
    function _isPayoutGroupActive(uint32 payoutId) internal view returns (bool) {
        return payoutId > 0 && payoutIdToClaimer[payoutId] != address(0);
    }

    /**
     * @dev Get payout destination from payout ID
     * @param payoutId The payout ID to look up
     * @return The payout destination address (defaults to claimer if not set, or address(0) if payout group is inactive)
     */
    function _getPayoutDestination(uint32 payoutId) internal view returns (address) {
        address destination = payoutIdToDestination[payoutId];
        return destination != address(0) ? destination : payoutIdToClaimer[payoutId];
    }
}
