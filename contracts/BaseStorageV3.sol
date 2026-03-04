// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { SupplyControl } from "./SupplyControl.sol";
import { SharesLib } from "./lib/SharesLib.sol";
import { StorageLib } from "./lib/StorageLib.sol";

/**
 * @title BaseStorageV3
 * @dev V3 base storage layer with packed storage for PaxosTokenRebaseClaims
 *
 * STORAGE VERSIONING:
 * ===================
 * BaseStorage (V2)   - Core token storage (simple balances, frozen mappings) - used by PaxosTokenV2
 * BaseStorageV3 (V3) - Packed storage at SAME slots for V2→V3 upgrade compatibility
 * ClaimableRewardsStorageV3 - Adds payout groups, multipliers, rewards (V3 additions)
 *
 * CRITICAL: V2→V3 UPGRADE COMPATIBILITY
 * =====================================
 * This contract does NOT inherit BaseStorage. Instead, it duplicates all storage variables
 * with balanceData and tokenAccountFlags at slots 1 and 7 (where V2's balances and frozen were).
 *
 * When upgrading from V2 to V3:
 * - Slot 1: mapping(address => uint256) balances → mapping(address => BalanceData) balanceData
 *   V2 stores uint256, V3 reads BalanceData.balance (uint64) from same slot
 * - Slot 7: mapping(address => bool) frozen → unchanged in V3
 *   Both V2 and V3 use the same bool mapping for frozen status
 *
 * Data is preserved through slot-level reinterpretation - no migration needed!
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract BaseStorageV3 {
    // ==================================================================================
    // STRUCT DEFINITIONS AND CONSTANTS (no storage impact, kept at top for readability)
    // ==================================================================================

    // SLOT 1: ERC20 balance data - REPLACES BaseStorage's mapping(address => uint256) balances
    // Packed struct for gas efficiency with shares-based model
    struct TokenAccountData {
        uint64 balance;                           // 8 bytes (up to ~18 trillion at 6 decimals)
        uint64 shares;                            // 8 bytes (up to 18 trillion at 6 decimals)
                                                  // shares * multiplier represents total value
        uint16 payoutGroupId;                     // 2 bytes (max 65k payout groups)
        uint40 lastUpdateTime;                    // 5 bytes - timestamp when wallet was last updated
        // Total: 23 bytes (9 bytes unused in 32-byte slot)
    }

    // Slot 4: Global transfer settings with paused flag (replaces ownerDeprecated + paused packed in V2)
    // V2 had: address ownerDeprecated (20 bytes) + bool paused (1 byte at offset 20)
    // OPTIMIZATION: Single SLOAD gets all period data + paused flag (saves 2100 gas per transfer)
    // HOT PATH: Loaded on every transfer to check paused state and calculate rewards
    struct GlobalTransferSettings {
        uint40 referenceTime;                   // 5 bytes - start time of all periods
        uint32 maturityPeriod;                  // 4 bytes - seconds for rewards to mature
        bool partnerSignedRegistrationsEnabled; // 1 byte - feature flag
        bytes10 __gap_remaining;                // 10 bytes - padding
        bool paused;                            // 1 byte - pause flag (V2 position at byte 20!)
        // Total: 21 bytes used, 11 bytes remaining in 32-byte slot
    }

    // SLOT 7: Frozen status - same as BaseStorage V2

    // ==================================================================================
    // STORAGE LAYOUT - Duplicates BaseStorage with packed types at slots 1 and 7
    // ==================================================================================

    // Slot 0: Check if contract is initialized until version 1
    bool internal initializedV1;

    // Slot 1: Packed balance data (struct defined above)
    mapping(address => TokenAccountData) internal balanceData;

    // Slot 2: Total supply
    uint256 internal totalSupply_;

    // Slot 3: Storage to keep track of allowances
    mapping(address => mapping(address => uint256)) internal allowed;

    // Slot 4: Global transfer settings (struct defined above)
    GlobalTransferSettings public globalTransferSettings;

    // Slot 5: Asset protection data: Deprecated
    address public assetProtectionRoleDeprecated;

    // Slot 7: Frozen status mapping (matches V2 BaseStorage layout)
    mapping(address => bool) internal frozen;

    // Slot 8: Supply controller of the contract: Deprecated
    address public supplyControllerDeprecated;

    // Slot 9: Proposed owner of the contract: Deprecated
    address public proposedOwnerDeprecated;

    // Slot 10: Delegated transfer data: Deprecated
    address public betaDelegateWhitelisterDeprecated;

    // Slot 11: Deprecated
    mapping(address => bool) internal betaDelegateWhitelistDeprecated;

    // Slot 12: Deprecated
    mapping(address => uint256) internal nextSeqsDeprecated;

    // Slot 13: Hash of the EIP712 Domain Separator data: Deprecated
    // solhint-disable-next-line var-name-mixedcase
    bytes32 public EIP712_DOMAIN_HASH_DEPRECATED;

    // Slot 14: Address of the supply control contract
    SupplyControl public supplyControl;

    // Storage gap: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
    uint256[24] __gap_BaseStorageV3;

    // ==================================================================================
    // EIP712/EIP2612/EIP3009 STORAGE - ORDERED FOR V2→V3 UPGRADE COMPATIBILITY
    // ==================================================================================

    // Slot after BaseStorage gap: EIP-712 Domain Separator (DEPRECATED)
    // This storage variable is no longer used as domain separator is always recomputed
    bytes32 private DOMAIN_SEPARATOR_DEPRECATED; // solhint-disable-line var-name-mixedcase

    // EIP-2612 Permit storage
    mapping(address => uint256) internal _nonces;

    // Storage gap for EIP2612 compatibility (10 slots)
    uint256[10] private __gap_EIP2612_compat;

    // EIP-3009 Authorization storage
    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;

    // Storage gap for EIP3009 compatibility (10 slots)
    uint256[10] private __gap_EIP3009_compat;

    // ==================================================================================
    // STORAGE ACCESSOR FUNCTIONS
    // ==================================================================================
    // These functions provide safe access to BaseStorageV3 storage with proper type conversions.
    // Placed here (not in ClaimableRewardsBase) to be accessible by both:
    // - PaxosTokenClaimableRewards (main contract)
    // - ClaimableRewardsBase (inherited by facets)

    /**
     * @dev Get balance from unified storage
     * @param account The address to get balance for
     * @return The balance as uint256
     */
    function _getBalance(address account) internal view returns (uint256) {
        return uint256(balanceData[account].balance);
    }

    /**
     * @dev Set balance data in unified storage (single SSTORE)
     * @param account The address to set values for
     * @param balance The balance to set
     * @param shares The shares to set
     * @param payoutGroupId The payout group ID to set
     * @param lastUpdateTime The timestamp when this update occurs
     */
    function _setBalanceData(
        address account,
        uint256 balance,
        uint256 shares,
        uint256 payoutGroupId,
        uint40 lastUpdateTime
    ) internal {
        balanceData[account] = TokenAccountData({
            balance: StorageLib.toUint64Balance(balance),
            shares: StorageLib.toUint64Shares(shares),
            payoutGroupId: uint16(payoutGroupId),
            lastUpdateTime: lastUpdateTime
        });
    }

    /**
     * @dev Get complete balance data from unified storage (single SLOAD)
     * @param account The address to get values for
     * @return data The complete TokenAccountData struct
     */
    function _getBalanceData(address account) internal view returns (TokenAccountData memory data) {
        data = balanceData[account];
    }

    /**
     * @dev Check if address is frozen
     * @param account The address to check
     * @return True if address is frozen
     */
    function _isFrozen(address account) internal view returns (bool) {
        return frozen[account];
    }

    /**
     * @dev Set frozen status for an address
     * @param account The address to set frozen status for
     * @param isFrozen Whether this address should be frozen
     */
    function _setFrozen(address account, bool isFrozen) internal {
        frozen[account] = isFrozen;
    }

}
