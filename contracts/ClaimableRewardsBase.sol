// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { BaseStorageV3 } from "./BaseStorageV3.sol";
import { PaxosBaseAbstract } from "./lib/PaxosBaseAbstract.sol";
import { AccessControlDefaultAdminRulesUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlDefaultAdminRulesUpgradeable.sol";
import { ClaimableRewardsStorageV3 } from "./ClaimableRewardsStorageV3.sol";
import { ClaimableRewardsEvents } from "./ClaimableRewardsEvents.sol";
import { TokenAdminEvents } from "./TokenAdminEvents.sol";
import { SharesLib } from "./lib/SharesLib.sol";
import { MultiplierGrowthLib } from "./lib/MultiplierGrowthLib.sol";
import { StorageLib } from "./lib/StorageLib.sol";
import { Roles } from "./lib/Roles.sol";
import { EIP712 } from "./lib/EIP712.sol";

/**
 * @title ClaimableRewardsBase
 * @dev Base contract with shared business logic for all claimable rewards facets in diamond pattern
 *
 * ARCHITECTURE:
 * ============
 * This contract provides complex business logic for claimable rewards functionality:
 * - Claim reward functions (_claimIndividualRewards, _executeClaimAll, _claimRewards)
 * - Hierarchical balance update functions (_updatePayoutGroupBals)
 * - Period timing functions (_getCurrentPeriodNum, _getCurrentCheckpointNum, etc.)
 * - Multiplier projection functions (_getActiveMultiplier)
 *
 * STORAGE/LOGIC SEPARATION:
 * =========================
 * - BaseStorageV3: Storage declarations + accessor functions for BaseStorageV3 storage
 * - ClaimableRewardsStorageV3: Storage declarations + accessor functions for ClaimableRewardsStorageV3 storage
 * - StorageLib: Pure utility functions for type conversions (library)
 * - ClaimableRewardsBase (this): Complex business logic only
 *
 * This separation ensures:
 * 1. Storage accessor functions are close to their storage declarations (maintainability)
 * 2. Both main contract and facets can access the same storage accessors
 * 3. Complex business logic is centralized in base contract (testability)
 * 4. Diamond pattern facets have consistent storage layout via delegatecall
 *
 * DIAMOND PATTERN STORAGE ALIGNMENT:
 * ==================================
 * This contract inherits storage in the same order as the main contract to ensure
 * storage layout compatibility when facets are called via delegatecall:
 *
 * Storage Layout (shared between main contract and facets):
 * - BaseStorageV3 (slots 0-50): Core token storage with packed structs
 * - AccessControlDefaultAdminRulesUpgradeable (slots 51-251): Role management
 * - ClaimableRewardsStorageV3 (slots 252+): V3 claimable rewards storage
 *
 * Main contract:  BaseStorageV3 → AccessControl → ClaimableRewardsStorageV3
 * Facet (this):   BaseStorageV3 → AccessControl → ClaimableRewardsStorageV3 ✓ ALIGNED
 *
 * IMPORTANT: By inheriting AccessControl here, facets can call hasRole() internally
 * without external calls. All role state is shared through delegatecall context.
 *
 * IMPORTANT: V3 uses packed storage (balanceData, tokenAccountFlags) from BaseStorageV3,
 * while V2 BaseStorage variables (balances, frozen) remain for compatibility but are not used in V3.
 */
contract ClaimableRewardsBase is PaxosBaseAbstract, BaseStorageV3, AccessControlDefaultAdminRulesUpgradeable, ClaimableRewardsStorageV3, ClaimableRewardsEvents, TokenAdminEvents {
    // NOTE: Most errors are inherited from ClaimableRewardsErrors via ClaimableRewardsStorageV3
    // This includes: ClaimSourceNotSet, InsufficientClaimSourceBalance, etc.

    // Custom errors for ClaimableRewardsBase
    error InsufficientFunds();

    // EIP-712 version prefix used in signature verification
    bytes2 public constant EIP712_VERSION_PREFIX = hex"1901";

    // NOTE: AddressFrozen is inherited from PaxosBaseAbstract
    // This ensures both main contract and facets have access to the same error

    // ==================================================================================
    // PAXOSBASEABSTRACT IMPLEMENTATION
    // ==================================================================================
    // Implement abstract functions required by PaxosBaseAbstract inheritance

    /**
     * @dev See {PaxosBaseAbstract-_isPaused}
     * @return True if contract is paused
     */
    function _isPaused() internal view virtual override returns (bool) {
        return globalTransferSettings.paused;
    }

    /**
     * @dev See {PaxosBaseAbstract-_isAddrFrozen}
     * @param addr The address to check
     * @return True if address is frozen
     */
    function _isAddrFrozen(address addr) internal view virtual override returns (bool) {
        return _isFrozen(addr);
    }

    /**
     * @dev See {PaxosBaseAbstract-_approve}
     * @param owner The token owner
     * @param spender The address to approve
     * @param value The allowance amount
     */
    function _approve(address owner, address spender, uint256 value) internal virtual override {
        allowed[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    // NOTE: _transfer is implemented below in the TRANSFER FUNCTIONS section

    // ==================================================================================
    // EIP-712 DOMAIN SEPARATOR (with chain fork protection)
    // ==================================================================================

    /**
     * @notice EIP712 Domain Separator
     * @dev Returns domain separator, always recomputed to handle chain forks
     * @return The domain separator for EIP-712 signatures
     */
    function DOMAIN_SEPARATOR() public view virtual returns (bytes32) {
        return EIP712._makeDomainSeparator(name(), "1");
    }

    // ==================================================================================
    // CLAIM LOGIC AND HIERARCHICAL UPDATE FUNCTIONS
    // ==================================================================================

    // ============ AUTHORIZATION HELPER FUNCTIONS ============

    /**
     * @dev Check if caller is authorized as claimer (either the claimer or has CLAIM_OPERATOR_ROLE)
     * @param payoutGroupId The payout group ID
     * @return True if caller is authorized as claimer
     */
    function _isAuthorizedAsClaimer(uint32 payoutGroupId) internal view returns (bool) {
        bool isClaimer = payoutIdToClaimer[payoutGroupId] == msg.sender;
        return isClaimer || hasRole(Roles.CLAIM_OPERATOR_ROLE, msg.sender);
    }

    /**
     * @dev Check if caller is authorized as manager (either the manager or has CLAIM_ADMIN_ROLE)
     * @param payoutGroupId The payout group ID
     * @return True if caller is authorized as manager
     */
    function _isAuthorizedAsManager(uint32 payoutGroupId) internal view returns (bool) {
        bool isManager = payoutIdToManager[payoutGroupId] == msg.sender;
        return isManager || hasRole(Roles.CLAIM_ADMIN_ROLE, msg.sender);
    }

    /**
     * @dev Validate that addresses are not frozen (caller, account if provided, destination)
     * @param caller The caller address to check
     * @param account Optional account address to check (use address(0) to skip)
     * @param destination The destination address to check
     */
    function _validateNotFrozen(address caller, address account, address destination) internal view {
        if (_isFrozen(caller)) revert AddressFrozen();
        if (account != address(0) && _isFrozen(account)) revert AddressFrozen();
        if (_isFrozen(destination)) revert AddressFrozen();
    }

    /**
     * @dev Validate claim source address - shared by setClaimSource() and initialization
     * @param claimSource The address to validate as claim source
     */
    function _validateClaimSource(address claimSource) internal view {
        // Check registration first (most specific error), then zero address, then frozen
        TokenAccountData memory wallet = _getBalanceData(claimSource);
        if (wallet.payoutGroupId != 0) revert ClaimSourceCannotBeRegistered();
        if (claimSource == address(0)) revert ZeroAddress();
        if (_isFrozen(claimSource)) revert AddressFrozen();
    }

    /**
     * @dev Validate rate bounds - shared by setRateBoundsByAPR() and initialization
     * @param minRate Minimum APR bound
     * @param maxRate Maximum APR bound
     */
    function _validateRateBounds(uint256 minRate, uint256 maxRate) internal pure {
        if (minRate > maxRate) revert InvalidRateBounds();
    }

    /**
     * @dev Check if caller is the claimer OR manager for a payout group (without role checking)
     * @param payoutGroupId The payout group ID
     * @return True if caller is claimer or manager
     */
    function _isClaimerOrManager(uint32 payoutGroupId) internal view returns (bool) {
        bool isClaimer = payoutIdToClaimer[payoutGroupId] == msg.sender;
        bool isManager = payoutIdToManager[payoutGroupId] == msg.sender;
        return isClaimer || isManager;
    }

    // ==================================================================================
    // BUSINESS LOGIC FUNCTIONS
    // ==================================================================================
    // NOTE: Storage accessor functions are now in BaseStorageV3 and ClaimableRewardsStorageV3
    // for access by both PaxosTokenClaimableRewards and ClaimableRewardsBase.
    // This contract contains only complex business logic.

    // ============ CORE LOGIC FUNCTIONS ============

    /**
     * @dev Apply a signed delta to a uint64 value with underflow protection
     * @param current The current value
     * @param delta The signed change (can be positive or negative)
     * @return The new value after applying the delta (clamped to 0 if underflow)
     */
    function _applyDelta(uint64 current, int256 delta) private pure returns (uint64) {
        if (delta >= 0) {
            return current + StorageLib.toUint64Balance(uint256(delta));
        } else {
            uint64 decrease64 = StorageLib.toUint64Balance(uint256(-delta));
            return current >= decrease64 ? current - decrease64 : 0;
        }
    }

    /**
     * @dev Update payout group balance and shares (hierarchical update)
     * @dev Optimized to use single SSTORE by reading to memory, modifying, then writing back
     * OPTIMIZATION: Accepts pre-loaded payoutGroup to avoid redundant SLOAD when caller already has it
     * @param payoutGroupId The payout group ID
     * @param payoutGroup The payout group data (pre-loaded, will be modified)
     * @param balanceDelta The change in balance (can be negative)
     * @param sharesDelta The change in shares (can be negative)
     */
    function _updatePayoutGroupBals(uint32 payoutGroupId, PayoutGroupData memory payoutGroup, int256 balanceDelta, int256 sharesDelta) internal {
        // Work directly on passed struct - NO SLOAD needed

        // Update balance and shares using common delta logic
        payoutGroup.balance = _applyDelta(payoutGroup.balance, balanceDelta);
        payoutGroup.shares = _applyDelta(payoutGroup.shares, sharesDelta);

        // Write entire struct back (single SSTORE)
        payoutData[payoutGroupId] = payoutGroup;
    }


    // ============ SHARED CLAIM FUNCTIONS (used by both ClaimableRewardsFacet and PayoutGroupFacet) ============

    // NOTE: ERC20 events declared here (used by _transfer and _approve)
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @dev Check if multiplier ID exists in mapping
     * @param multiplierId The multiplier ID to check
     * @return True if multiplier exists (has non-zero switchTimeMultiplier)
     */
    function _multiplierExists(uint32 multiplierId) internal view returns (bool) {
        return multiplierId > 0 && multiplierId < nextMultiplierId && multipliers[multiplierId].switchTimeMultiplier > 0;
    }

    /**
     * @dev Get the multiplier value at a specific target time
     * @param multiplierId The multiplier ID
     * @param targetTime The target timestamp to query
     * @return The multiplier value at the target time (12 decimals)
     */
    function _getMultiplierAtTime(uint32 multiplierId, uint256 targetTime) internal view returns (uint256) {
        // OPTIMIZATION: Load struct first to avoid duplicate SLOAD
        MultiplierData storage config = multipliers[multiplierId];

        // Check if multiplier exists (switchTimeMultiplier == 0 means deleted/nonexistent)
        if (config.switchTimeMultiplier == 0) {
            revert MultiplierIndexNotFound(multiplierId);
        }

        // OPTIMIZATION: Cache globalTransferSettings fields to avoid repeated field accesses
        uint256 maturityPeriod = globalTransferSettings.maturityPeriod;
        uint256 referenceTime = globalTransferSettings.referenceTime;

        // Check if there's a scheduled rate change
        uint40 switchTime = config.switchTime;
        uint40 afterRate = config.afterRate;

        // Determine which rate to use based on whether the scheduled rate change has occurred
        uint256 rateToUse;
        if (afterRate > 0 && targetTime >= switchTime) {
            // Rate change has occurred - use the new rate
            rateToUse = uint256(afterRate);
        } else {
            // Either no scheduled rate (afterRate == 0) or targetTime is before switchTime
            // In both cases, use beforeRate
            rateToUse = uint256(config.beforeRate);
        }

        // Use unified bidirectional projection - handles both forward and backward automatically
        // switchTimeMultiplier is the multiplier at switchTime, project to targetTime
        return MultiplierGrowthLib.projectMultiplier(
            uint256(config.switchTimeMultiplier),
            rateToUse,
            uint256(switchTime),
            targetTime,
            maturityPeriod,
            referenceTime
        );
    }

    /**
     * @dev Get the current active multiplier for a given ID
     * @dev This function now handles scheduled rate changes automatically
     * @param multiplierId The multiplier ID
     * @return The current multiplier value (12 decimals)
     */
    function _getActiveMultiplier(uint32 multiplierId) internal view returns (uint256) {
        return _getMultiplierAtTime(multiplierId, block.timestamp);
    }


    /**
     * @dev Internal function to claim individual account rewards (shares model)
     * @param account The account to claim for
     * @param destination The destination for rewards
     * @return The rewards claimed
     */
    function _claimIndividualRewards(address account, address destination) internal returns (uint256) {
        TokenAccountData memory wallet = _getBalanceData(account);
        return _claimIndividualRewardsWithData(account, wallet, destination);
    }

    /**
     * @dev Internal function to claim individual account rewards (shares model) - optimized version
     * @dev OPTIMIZATION: Accepts pre-loaded wallet data to avoid duplicate SLOAD
     * @param account The account to claim for
     * @param wallet The account's wallet data (pre-loaded by caller)
     * @param destination The destination for rewards
     */
    function _claimIndividualRewardsWithData(
        address account,
        TokenAccountData memory wallet,
        address destination
    ) internal returns (uint256) {
        if (wallet.payoutGroupId == 0) {
            return 0;
        }

        PayoutGroupData memory payoutGroup = payoutData[uint32(wallet.payoutGroupId)];
        uint32 multiplierId = uint32(payoutGroup.multiplierId);
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);

        // Handle claimAll detection using timestamps (monotonically non-decreasing)
        uint256 shares = SharesLib.handleClaimAllDetection(
            uint256(wallet.balance),
            uint256(wallet.shares),
            wallet.lastUpdateTime,
            payoutGroup.lastClaimAllTime,
            uint256(payoutGroup.lastClaimAllMultiplier)
        );

        // Calculate rewards up to "now"
        uint256 rewards = SharesLib.calcRewards(shares, currentMultiplier, uint256(wallet.balance));

        if (rewards == 0) {
            return 0;
        }

        // Reset shares to balance equivalent to fully clear rewards
        uint256 newShares = SharesLib.calcShares(uint256(wallet.balance), currentMultiplier);

        // Update wallet with new shares and current timestamp
        uint40 currentTime = uint40(block.timestamp);
        _setBalanceData(
            account,
            uint256(wallet.balance),
            newShares,
            uint256(wallet.payoutGroupId),
            currentTime
        );

        // Update hierarchical shares (shares decreased, so delta is negative)
        int256 sharesDelta = int256(newShares) - int256(shares);

        _updatePayoutGroupBals(wallet.payoutGroupId, payoutGroup, 0, sharesDelta);

        // Claim rewards to destination
        _claimRewards(destination, rewards);

        emit RewardsClaimed(account, wallet.payoutGroupId, destination, rewards);
        return rewards;
    }

    /**
     * @dev Internal function to execute claim all for a payout group (shares model)
     * @dev OPTIMIZATION: Load to memory, modify, write once to avoid repeat SLOADs
     * @param payoutGroupId The payout group ID
     * @param destination The destination for rewards
     * @return The total rewards claimed
     */
    function _executeClaimAll(uint32 payoutGroupId, address destination) internal returns (uint256) {
        // Check frozen status before any state changes, consistent with direct claim functions
        if (_isFrozen(destination)) revert AddressFrozen();

        // Load entire struct to memory to avoid warm SLOADs on field access
        PayoutGroupData memory payoutGroup = payoutData[payoutGroupId];
        uint32 multiplierId = uint32(payoutGroup.multiplierId);

        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);

        uint256 groupBalance = uint256(payoutGroup.balance);
        uint256 groupShares = uint256(payoutGroup.shares);

        // Calculate rewards up to "now"
        uint256 groupRewards = SharesLib.calcRewards(groupShares, currentMultiplier, groupBalance);

        if (groupRewards == 0) {
            return 0;
        }

        // Reset shares and record claimAll event
        // This claims ALL rewards up to "now", so we reset the shares model
        payoutGroup.lastClaimAllTime = uint40(block.timestamp);
        payoutGroup.lastClaimAllMultiplier = StorageLib.toUint48Multiplier(currentMultiplier);

        uint256 newGroupShares = SharesLib.calcShares(groupBalance, currentMultiplier);
        payoutGroup.shares = StorageLib.toUint64Shares(newGroupShares);

        // Write entire struct back to storage (single SSTORE)
        payoutData[payoutGroupId] = payoutGroup;

        _claimRewards(destination, groupRewards);

        emit ClaimAllExecuted(payoutGroupId, msg.sender, destination, groupRewards);
        return groupRewards;
    }

    /**
     * @dev Internal function to claim rewards (transfer from claim source to destination)
     * @param destination The destination address
     * @param amount The amount to claim
     */
    function _claimRewards(address destination, uint256 amount) internal {
        // Check frozen status before early return, consistent with _transfer behavior
        if (_isFrozen(destination)) revert AddressFrozen();
        if (amount == 0) return;

        address claimSource = adminConfig.claimSource;
        if (claimSource == address(0)) revert ClaimSourceNotSet();
        if (_isFrozen(claimSource)) revert AddressFrozen();

        // Update claim source balance (simple path - claim source cannot be in payout group)
        TokenAccountData memory sourceData = _getBalanceData(claimSource);
        uint256 sourceBalance = uint256(sourceData.balance);
        if (sourceBalance < amount) revert InsufficientClaimSourceBalance(amount, sourceBalance);
        _setBalanceData(
            claimSource,
            sourceBalance - amount,
            0,
            0,
            0 // lastUpdateTime not needed for non-payout-group accounts
        );

        // Update destination balance (preserves existing rewards if in payout group)
        TokenAccountData memory destData = _getBalanceData(destination);
        uint256 newDestBalance = uint256(destData.balance) + amount;
        uint40 currentTime = uint40(block.timestamp);
        _updateWalletWithPayoutGroup(destination, destData, newDestBalance, currentTime);

        emit Transfer(claimSource, destination, amount);
    }


    // ============ TRANSFER FUNCTIONS ============
    // These functions handle ERC20 transfers with payout group and multiplier updates
    // Moved from main contract to allow facets (e.g., TokenExtensionsFacet) to call directly

    /**
     * @dev See {PaxosBaseAbstract-_transfer}
     * @dev Internal function to transfer balances from => to.
     * @dev Optimized for minimal SLOAD/SSTORE operations
     * @dev Marked virtual to allow main contract to override for multiple inheritance resolution
     * @param from address The address which you want to send tokens from
     * @param to address The address which you want to transfer to
     * @param value uint256 the amount of tokens to be transferred
     */
    function _transfer(address from, address to, uint256 value) internal virtual override {
        // Check for zero address - use inherited error from PaxosBaseAbstract
        if (to == address(0)) revert ZeroAddress();
        if (_isFrozen(to) || _isFrozen(from)) revert AddressFrozen();

        // Early exit for zero value transfers
        if (value == 0) {
            emit Transfer(from, to, value);
            return;
        }

        // Single SLOAD for both wallets (2 SLOAD total)
        TokenAccountData memory fromWallet = _getBalanceData(from);
        TokenAccountData memory toWallet = _getBalanceData(to);

        if (value > fromWallet.balance) revert InsufficientFunds();

        // Early exit for self-transfers (prevent double-write vulnerability)
        if (from == to) {
            emit Transfer(from, to, value);
            return;
        }

        // Calculate new balances
        uint256 newFromBalance;
        uint256 newToBalance;
        unchecked {
            newFromBalance = uint256(fromWallet.balance) - value;
            newToBalance = uint256(toWallet.balance) + value;
        }

        // OPTIMIZATION 1: No payout groups (most common case)
        if (fromWallet.payoutGroupId == 0 && toWallet.payoutGroupId == 0) {
            // Direct balance updates only - 2 SSTORE total
            _setBalanceData(from, newFromBalance, 0, 0, 0);
            _setBalanceData(to, newToBalance, 0, 0, 0);
            emit Transfer(from, to, value);
            return; // ACHIEVED: 2 SLOAD, 2 SSTORE
        }

        // OPTIMIZATION 2: Same payout group (net zero aggregation change)
        if (fromWallet.payoutGroupId == toWallet.payoutGroupId && fromWallet.payoutGroupId > 0) {
            // Get current multiplier for this group
            PayoutGroupData memory payoutGroup = payoutData[fromWallet.payoutGroupId];

            // Check if payout group is still active (multiplierId == 0 means deleted)
            // If deleted, fall through to normal path to cleanup both orphaned accounts
            if (payoutGroup.multiplierId == 0) {
                _transferWithDifferentPayouts(from, to, fromWallet, toWallet, newFromBalance, newToBalance);
                emit Transfer(from, to, value);
                return;
            }

            uint256 currentMultiplier = _getActiveMultiplier(payoutGroup.multiplierId);
            uint40 currentTime = uint40(block.timestamp);

            // Update FROM and TO balance data with shares - delegate to helper
            _updateWalletSharesForTransfer(from, fromWallet, newFromBalance, payoutGroup, currentMultiplier, currentTime);
            _updateWalletSharesForTransfer(to, toWallet, newToBalance, payoutGroup, currentMultiplier, currentTime);

            // CRITICAL OPTIMIZATION: Skip aggregation updates!
            // When both accounts have same payout group, the net change is zero (shares cancel out)

            emit Transfer(from, to, value);
            return; // ACHIEVED: 4 SLOAD, 2 SSTORE
        }

        // OPTIMIZATION 3: Different payout groups or mixed scenarios
        _transferWithDifferentPayouts(from, to, fromWallet, toWallet, newFromBalance, newToBalance);
        emit Transfer(from, to, value);
    }

    /**
     * @dev Handle transfers between different payout addresses or mixed scenarios
     * @dev Optimized for minimal SLOAD/SSTORE operations with shares-based model
     */
    function _transferWithDifferentPayouts(
        address from,
        address to,
        TokenAccountData memory fromWallet,
        TokenAccountData memory toWallet,
        uint256 newFromBalance,
        uint256 newToBalance
    ) internal {
        uint40 currentTime = uint40(block.timestamp);

        // Update both wallets with payout group tracking
        _updateWalletWithPayoutGroup(from, fromWallet, newFromBalance, currentTime);
        _updateWalletWithPayoutGroup(to, toWallet, newToBalance, currentTime);
    }

    /**
     * @dev Update wallet with payout group (extracted to reduce stack depth)
     * @dev Handles claimAll detection and shares update for a single wallet
     * @param account The account address
     * @param accountData The account wallet data
     * @param newBalance The new balance
     * @param currentTime The current timestamp (pre-computed by caller to avoid redundant SLOAD)
     */
    function _updateWalletWithPayoutGroup(
        address account,
        TokenAccountData memory accountData,
        uint256 newBalance,
        uint40 currentTime
    ) internal {
        if (accountData.payoutGroupId > 0) {
            PayoutGroupData memory payoutGroup = payoutData[accountData.payoutGroupId];

            // Check if payout group is still active (multiplierId == 0 means deleted)
            if (payoutGroup.multiplierId == 0) {
                // Orphaned account - use cleanup function to clear invalid payout reference
                // This allows transfers to succeed even after payout group deletion
                _processWalletChangeWithCleanup(account, accountData, newBalance);
                return;
            }
            uint256 multiplier = _getActiveMultiplier(payoutGroup.multiplierId);

            // Handle claimAll detection using timestamps (monotonically non-decreasing)
            uint256 shares = SharesLib.handleClaimAllDetection(
                uint256(accountData.balance),
                uint256(accountData.shares),
                accountData.lastUpdateTime,
                payoutGroup.lastClaimAllTime,
                uint256(payoutGroup.lastClaimAllMultiplier)
            );

            // Update shares for new balance
            uint256 newShares = SharesLib.updateSharesWithRewardPreservation(
                uint256(accountData.balance), newBalance, shares, multiplier
            );

            _setBalanceData(
                account,
                newBalance,
                newShares,
                uint256(accountData.payoutGroupId),
                currentTime
            );

            // Update hierarchical shares
            int256 balanceDelta = int256(newBalance) - int256(uint256(accountData.balance));
            int256 sharesDelta = SharesLib.calcSharesDelta(balanceDelta, multiplier);
            _updatePayoutGroupBals(accountData.payoutGroupId, payoutGroup, balanceDelta, sharesDelta);
        } else {
            _setBalanceData(account, newBalance, 0, 0, 0);
        }
    }

    /**
     * @dev Process wallet change with cleanup of invalid payout assignment
     * Clears the invalid payout group reference from the wallet
     * @param accountAddr The account address
     * @param wallet The current wallet data
     * @param newBalance The new balance amount
     */
    function _processWalletChangeWithCleanup(
        address accountAddr,
        TokenAccountData memory wallet,
        uint256 newBalance
    ) internal {
        if (uint256(wallet.balance) == newBalance) return; // Early exit for no-change

        // Clear the invalid payout assignment completely (shares=0, groupId=0, periodNum=0)
        _setBalanceData(accountAddr, newBalance, 0, 0, 0);
    }

    /**
     * @dev Update wallet shares for transfer within same payout group (extracted to reduce stack depth)
     * @param account The account address
     * @param accountData The account data
     * @param newBalance The new balance
     * @param payoutGroup The payout group data
     * @param currentMultiplier The current multiplier
     * @param currentTime The current timestamp (pre-computed by caller to avoid redundant SLOAD)
     * @return newShares The updated shares
     */
    function _updateWalletSharesForTransfer(
        address account,
        TokenAccountData memory accountData,
        uint256 newBalance,
        PayoutGroupData memory payoutGroup,
        uint256 currentMultiplier,
        uint40 currentTime
    ) internal returns (uint256 newShares) {
        // Handle claimAll detection using timestamps (monotonically non-decreasing)
        uint256 shares = SharesLib.handleClaimAllDetection(
            uint256(accountData.balance),
            uint256(accountData.shares),
            accountData.lastUpdateTime,
            payoutGroup.lastClaimAllTime,
            uint256(payoutGroup.lastClaimAllMultiplier)
        );

        // Update shares for new balance
        newShares = SharesLib.updateSharesWithRewardPreservation(
            uint256(accountData.balance), newBalance, shares, currentMultiplier
        );

        _setBalanceData(
            account,
            newBalance,
            newShares,
            uint256(accountData.payoutGroupId),
            currentTime
        );
    }

    /**
     * @dev Get the current effective rate for a multiplier (view function)
     * @dev Returns afterRate if the switchTime has passed, otherwise beforeRate
     * @param multData The multiplier data
     * @return The current effective rate (10 decimals APR)
     */
    function _getCurrentEffectiveRate(MultiplierData storage multData) internal view returns (uint256) {
        if (multData.switchTime <= block.timestamp && multData.afterRate > 0) {
            return uint256(multData.afterRate);
        }
        return uint256(multData.beforeRate);
    }

}
