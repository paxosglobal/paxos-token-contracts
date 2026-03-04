// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";
import { SupplyControl } from "../SupplyControl.sol";
import { Roles } from "../lib/Roles.sol";
import { SharesLib } from "../lib/SharesLib.sol";
import { StorageLib } from "../lib/StorageLib.sol";

/**
 * @title TokenAdminFacet
 * @notice Diamond facet for administrative functions
 * @dev Handles pause/freeze/supply control configuration functions
 *
 * @dev STORAGE: Inherits from ClaimableRewardsBase which provides shared storage access.
 *      Storage is shared with main contract via delegatecall.
 *
 * DIAMOND PATTERN STORAGE ALIGNMENT:
 * ==================================
 * Main contract has AccessControl (201 slots) between BaseStorageV3 and V3 storage.
 * This facet uses FacetStorageWithGap which provides the matching gap.
 *
 * Main:  BaseStorageV3 (0-50) → AccessControl (51-251) → V3 (252+)
 * Facet: BaseStorageV3 (0-50) → Gap (51-251) → aligned for delegatecall
 *
 * Functions:
 * - Pause/Unpause (2 functions)
 * - Supply Control Configuration (1 function)
 * - Asset Protection: freeze/unfreeze (4 functions)
 *
 * NOTE: Supply modification functions (mint/burn/wipe) remain in main contract
 *       due to tight integration with reward calculation logic.
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract TokenAdminFacet is ClaimableRewardsBase {
    // NOTE: onlyRole modifier inherited from AccessControlUpgradeable - no external call needed
    // NOTE: isNonZeroAddress modifier inherited from PaxosBaseAbstract via ClaimableRewardsBase

    // Errors
    // NOTE: AddressFrozen, ZeroAddress, AlreadyPaused, AlreadyUnPaused inherited from PaxosBaseAbstract via ClaimableRewardsBase

    // PAUSE/UNPAUSE

    /**
     * @notice Pause the contract
     * @dev Called by PAUSE_ROLE to pause, triggers stopped state
     */
    function pause() public onlyRole(Roles.PAUSE_ROLE) {
        if (globalTransferSettings.paused) revert AlreadyPaused();
        globalTransferSettings.paused = true;
        emit Pause();
    }

    /**
     * @notice Unpause the contract
     * @dev Called by PAUSE_ROLE to unpause, returns to normal state
     */
    function unpause() public onlyRole(Roles.PAUSE_ROLE) {
        if (!globalTransferSettings.paused) revert AlreadyUnPaused();
        globalTransferSettings.paused = false;
        emit Unpause();
    }

    // SUPPLY CONTROL CONFIGURATION

    /**
     * @notice Update the supply control contract which controls minting and burning for this token
     * @dev Called by DEFAULT_ADMIN_ROLE to set supply control contract address
     * @param supplyControlAddress Supply control contract address
     */
    function setSupplyControl(
        address supplyControlAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) isNonZeroAddress(supplyControlAddress) {
        supplyControl = SupplyControl(supplyControlAddress);
        emit SupplyControlSet(supplyControlAddress);
    }

    // ASSET PROTECTION - FREEZE/UNFREEZE

    /**
     * @dev Freezes an address balance from being transferred
     * @param addr The address to freeze
     */
    function freeze(address addr) public onlyRole(Roles.ASSET_PROTECTION_ROLE) {
        _freeze(addr);
    }

    /**
     * @dev Freezes multiple addresses' balances from being transferred
     * @param addresses The addresses to freeze
     */
    function freezeBatch(address[] calldata addresses) public onlyRole(Roles.ASSET_PROTECTION_ROLE) {
        for (uint256 i = 0; i < addresses.length; ) {
            _freeze(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Unfreezes an address balance allowing transfer
     * @param addr The address to unfreeze
     */
    function unfreeze(address addr) public onlyRole(Roles.ASSET_PROTECTION_ROLE) {
        _unfreeze(addr);
    }

    /**
     * @dev Unfreezes multiple addresses' balances allowing transfer
     * @param addresses The addresses to unfreeze
     */
    function unfreezeBatch(address[] calldata addresses) public onlyRole(Roles.ASSET_PROTECTION_ROLE) {
        for (uint256 i = 0; i < addresses.length; ) {
            _unfreeze(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    // INTERNAL HELPERS

    /**
     * @dev Private function to freeze an address balance
     * @dev Freezes any accrued rewards and removes rewards from the payout group (stored for potential restoration on unfreeze)
     * @param addr The address to freeze
     */
    function _freeze(address addr) private {
        TokenAccountData memory wallet = _getBalanceData(addr);

        if (_isPayoutGroupActive(wallet.payoutGroupId)) {
            // Only process rewards and payout group updates if address has a balance
            // Zero balance means zero shares and zero rewards - nothing to store or update
            if (wallet.balance > 0) {
                PayoutGroupData memory payoutGroup = payoutData[wallet.payoutGroupId];
                uint256 currentMultiplier = _getActiveMultiplier(payoutGroup.multiplierId);

                // Get actual shares after claimAll detection
                uint256 actualShares = SharesLib.handleClaimAllDetection(
                    uint256(wallet.balance),
                    uint256(wallet.shares),
                    wallet.lastUpdateTime,
                    payoutGroup.lastClaimAllTime,
                    uint256(payoutGroup.lastClaimAllMultiplier)
                );

                // Calculate frozen rewards (token amount)
                uint256 rewards = SharesLib.calcRewards(actualShares, currentMultiplier, uint256(wallet.balance));

                // Store frozen data (rewards + payout group for restoration on unfreeze)
                frozenData[addr] = FrozenData({
                    rewards: uint64(rewards),
                    payoutGroupId: wallet.payoutGroupId
                });

                // Always emit when storing frozen data (even if rewards == 0)
                // This provides audit trail of which payout group the address was removed from
                emit RewardsFrozen(addr, wallet.payoutGroupId, rewards);

                // Remove completely from payout group (subtract both balance AND shares)
                int256 balanceDelta = -int256(uint256(wallet.balance));
                int256 sharesDelta = -int256(actualShares);
                _updatePayoutGroupBals(wallet.payoutGroupId, payoutGroup, balanceDelta, sharesDelta);
            }

            // Always clear wallet from payout group (keep balance, zero shares, zero payoutGroupId)
            _setBalanceData(addr, wallet.balance, 0, 0, 0);
        }

        _setFrozen(addr, true);
        emit FreezeAddress(addr);
    }

    /**
     * @dev Private function to unfreeze an address balance
     * @dev Restores to original payout group with frozen rewards if payout group still active
     * @param addr The address to unfreeze
     */
    function _unfreeze(address addr) private {
        // Get stored frozen data
        FrozenData memory frozen = frozenData[addr];

        // Check if original payout group is still active
        if (_isPayoutGroupActive(frozen.payoutGroupId)) {
            TokenAccountData memory wallet = _getBalanceData(addr);
            PayoutGroupData memory payoutGroup = payoutData[frozen.payoutGroupId];
            uint256 currentMultiplier = _getActiveMultiplier(payoutGroup.multiplierId);

            // Calculate new shares including restored rewards
            uint256 newShares = SharesLib.calcShares(uint256(wallet.balance) + frozen.rewards, currentMultiplier);

            // Add balance and shares back to payout group
            int256 balanceDelta = int256(uint256(wallet.balance));
            int256 sharesDelta = int256(newShares);
            _updatePayoutGroupBals(frozen.payoutGroupId, payoutGroup, balanceDelta, sharesDelta);

            // Restore wallet to payout group with new shares
            _setBalanceData(
                addr,
                wallet.balance,
                StorageLib.toUint64Shares(newShares),
                frozen.payoutGroupId,
                uint40(block.timestamp)
            );
        } else if (frozen.payoutGroupId > 0 && frozen.rewards > 0) {
            // Payout group was deleted - rewards are lost
            emit FrozenRewardsLost(addr, frozen.payoutGroupId, frozen.rewards);
        }

        // Clear frozen data (no-op if already zeros)
        delete frozenData[addr];

        _setFrozen(addr, false);
        emit UnfreezeAddress(addr);
    }

    // ADDITIONAL ADMIN FUNCTIONS (Moved from main contract for size reduction)

    /**
     * @notice Reclaim all tokens at the contract address
     * @dev Transfers the tokens this contract holds, to the owner of smart contract.
     * Note: This is not affected by freeze constraints.
     * Uses _transfer to ensure payout group and multiplier balances are updated correctly.
     */
    function reclaimToken() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 _balance = _getBalance(address(this));

        // Get owner directly - inherited from AccessControlDefaultAdminRulesUpgradeable
        address owner = owner();

        // Use _transfer to properly update payout groups and multipliers
        // _transfer handles zero balance gracefully (early exit)
        _transfer(address(this), owner, _balance);
    }

    /**
     * @notice Wipe the token balance of a frozen address
     * @dev Wipes the balance of a frozen address, and burns the tokens
     * @param addr The frozen address to wipe
     */
    function wipeFrozenAddress(address addr) external onlyRole(Roles.ASSET_PROTECTION_ROLE) {
        if (!_isFrozen(addr)) revert AddressNotFrozen();

        // Account was already removed from payout group at freeze time
        // Just need to clear balance and frozen data
        uint256 balance = _getBalance(addr);

        _setBalanceData(addr, 0, 0, 0, 0);
        delete frozenData[addr];

        totalSupply_ -= balance;

        emit FrozenAddressWiped(addr);
        emit SupplyDecreased(addr, balance);
        emit Transfer(addr, address(0), balance);
    }

    // VIEW FUNCTIONS (Moved from main contract for size reduction)

    /**
     * @notice Return the freeze status of an address.
     * @dev Check if whether the address is currently frozen.
     * @param addr The address to check if frozen.
     * @return A bool representing whether the given address is frozen.
     */
    function isFrozen(address addr) external view returns (bool) {
        return _isFrozen(addr);
    }

    /**
     * @notice Return the pause status of the contract.
     * @dev Check whether the contract is currently paused.
     * @return A bool representing whether the contract is paused.
     */
    function paused() external view returns (bool) {
        return globalTransferSettings.paused;
    }

    /**
     * @notice Get frozen rewards data for a frozen address.
     * @dev Returns the rewards and payout group ID stored when the address was frozen.
     *      Returns (0, 0) if the address was never frozen or has no frozen data.
     * @param addr The address to query frozen data for.
     * @return rewards The frozen reward amount (base units).
     * @return payoutGroupId The original payout group ID for restoration on unfreeze.
     */
    function getFrozenData(address addr) external view returns (uint256 rewards, uint32 payoutGroupId) {
        FrozenData memory frozen = frozenData[addr];
        return (frozen.rewards, frozen.payoutGroupId);
    }

    // Additional errors for new functions
    error AddressNotFrozen();
}
