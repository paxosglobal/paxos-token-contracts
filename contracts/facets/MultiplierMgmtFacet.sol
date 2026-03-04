// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";
import { MultiplierGrowthLib } from "../lib/MultiplierGrowthLib.sol";
import { SharesLib } from "../lib/SharesLib.sol";
import { StorageLib } from "../lib/StorageLib.sol";
import { Roles } from "../lib/Roles.sol";

/**
 * @title MultiplierMgmtFacet
 * @notice Diamond facet for multiplier management functionality
 * @dev Handles multiplier configuration, rate management, and multiplier-specific views
 *
 * @dev STORAGE: All storage variables inherited from ClaimableRewardsStorageV3 for shared access.
 *      Storage is shared with main contract through ClaimableRewardsStorageV3 inheritance.
 *
 * Functions:
 * - Multiplier management (8 functions)
 * - Multiplier-specific view functions (12 functions)
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract MultiplierMgmtFacet is ClaimableRewardsBase {
    // NOTE: Events inherited from ClaimableRewardsEvents
    // NOTE: Shared errors are inherited via ClaimableRewardsBase:
    //       - From ClaimableRewardsErrors: MultiplierIndexNotFound
    //       - From ClaimableRewardsBase: AddressFrozen

    // Facet-specific errors
    error MultiplierCannotBeZero();
    error InvalidRebaseRate(uint256 rate);
    error InsufficientRewardFunding(uint256 required, uint256 available);
    error ArrayLengthMismatch();
    error EmptyArrays();
    error ScheduleTimeInPast();
    error InvalidReferenceTime();
    error MultiplierInUse(uint32 multiplierId, uint32 payoutGroupCount);
    error MultiplierHasBalance(uint256 balance, uint256 shares);

    // Custom errors for access control
    error UnauthorizedMultAdminRole();
    error UnauthorizedMultRateRole();

    // Modifiers
    modifier onlyMultAdminRole() {
        if (!hasRole(Roles.MULT_ADMIN_ROLE, msg.sender)) revert UnauthorizedMultAdminRole();
        _;
    }

    modifier onlyMultRateRole() {
        if (!hasRole(Roles.MULT_RATE_ROLE, msg.sender)) revert UnauthorizedMultRateRole();
        _;
    }

    // ============ MULTIPLIER MANAGEMENT FUNCTIONS ============

    /**
     * @notice Create a new multiplier configuration
     * @dev Auto-assigns multiplier ID. Initializes with multiplier=1.0 (12 decimals) and provided APR rate (10 decimals).
     * @dev Claim source must be set separately via setClaimSource() or during initialization
     * @dev Requires rate bounds to be configured via setRateBoundsByAPR() first
     * @param apr The APR rate at 10 decimals
     * @return id The newly created multiplier ID
     */
    function createMultiplier(
        uint256 apr
    ) external onlyMultAdminRole returns (uint32 id) {
        // Validate APR against configured bounds (reverts if bounds not configured)
        _validateAPRBounds(apr);
        // Auto-assign next sequential ID (starts at 1, IDs never reused)
        id = nextMultiplierId;
        nextMultiplierId++;

        // Initialize with multiplier = 1.0 (12 decimals)
        uint256 multiplier12 = 1e12;  // 1.0 at 12 decimals

        // Add new multiplier configuration with linked list (rate already at 10 decimals - APR)
        multipliers[id] = MultiplierData({
            beforeRate: StorageLib.toUint40APR(0),  // No previous rate (just created)
            afterRate: StorageLib.toUint40APR(apr),  // Initial rate (already at 10 decimals - APR)
            switchTime: StorageLib.toUint40Timestamp(block.timestamp + 1),  // Rate becomes active next block (avoids same-block issues)
            switchTimeMultiplier: StorageLib.toUint48Multiplier(multiplier12),
            nextActiveId: firstActiveId  // Link to current head of list (0 if empty)
        });

        // Update linked list head and count
        firstActiveId = uint16(id);  // New multiplier becomes head
        activeMultiplierCount++;

        emit MultiplierCreated(id, apr, block.timestamp);
    }

    /**
     * @notice Delete a multiplier (remove from active list)
     * @dev Restricted to MULT_ADMIN_ROLE. Requires multiplier to have zero balance and shares.
     * @dev Removes multiplier from linked list by updating previous node's nextActiveId
     * @param multiplierId The multiplier ID to delete
     */
    function deleteMultiplier(uint32 multiplierId) external onlyMultAdminRole {
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);

        // CRITICAL SAFETY CHECK: Ensure no active payout groups reference this multiplier (O(1) check)
        // This prevents orphaning payout groups and breaking reward calculations
        uint256 payoutGroupCount = multiplierPayoutGroupCount[multiplierId];
        if (payoutGroupCount > 0) {
            revert MultiplierInUse(multiplierId, uint32(payoutGroupCount));
        }

        // Remove from linked list by finding and updating previous node
        if (firstActiveId == multiplierId) {
            // Deleting head - update firstActiveId to next
            firstActiveId = multipliers[multiplierId].nextActiveId;
        } else {
            // Find previous node in list
            uint16 prevId = firstActiveId;
            bool found = false;
            for (uint16 id = firstActiveId; id != 0; id = multipliers[id].nextActiveId) {
                if (multipliers[id].nextActiveId == multiplierId) {
                    prevId = id;
                    found = true;
                    break;
                }
            }
            if (!found) revert MultiplierIndexNotFound(multiplierId); // Should never happen if _multiplierExists passed

            // Update previous node to skip over deleted node
            multipliers[prevId].nextActiveId = multipliers[multiplierId].nextActiveId;
        }

        // Mark as deleted by zeroing switchTimeMultiplier (makes _multiplierExists return false)
        delete multipliers[multiplierId];

        // Decrement active count
        activeMultiplierCount--;

        emit MultiplierDeleted(multiplierId);
    }

    /**
     * @notice Set the global maturity period with automatic catchup
     * @dev Catches up all multipliers before changing the period
     * @param period The period in seconds (must be > 0)
     */
    function setMaturityPeriod(uint32 period) external onlyMultAdminRole {
        if (period == 0) revert InvalidRebaseRate(0);

        // First, catch up all multipliers with the current period
        // In shares model, no need to checkpoint rewards - they're implicit in shares
        uint256 currentPeriod = globalTransferSettings.maturityPeriod;
        if (currentPeriod > 0 && activeMultiplierCount > 0) {
            // Perform catchup before changing period
            for (uint16 id = firstActiveId; id != 0; id = multipliers[id].nextActiveId) {
                uint256 activeMultiplier12 = getActiveMultiplier(id); // Already at 12 decimals

                MultiplierData storage multData = multipliers[id];

                // Check if there's a future scheduled rate that we need to preserve
                if (multData.switchTime > block.timestamp && multData.afterRate > 0) {
                    // Future scheduled rate - preserve it and recalculate with new period
                    // Keep switchTime unchanged (absolute timestamp remains valid)
                    // Recalculate switchTimeMultiplier: project from current multiplier to switchTime using new period
                    uint256 newSwitchTimeMultiplier = MultiplierGrowthLib.projectMultiplier(
                        activeMultiplier12,
                        uint256(multData.beforeRate),
                        block.timestamp,
                        uint256(multData.switchTime),
                        period, // Use NEW period for projection
                        globalTransferSettings.referenceTime
                    );

                    multData.switchTimeMultiplier = StorageLib.toUint48Multiplier(newSwitchTimeMultiplier);
                    // Keep afterRate unchanged (preserve scheduled rate)
                    // switchTime remains unchanged (preserve exact activation timestamp)
                } else {
                    // No future scheduled rate - commit any activated rate and reset to current time
                    _commitActivatedRate(multData);

                    multData.switchTimeMultiplier = StorageLib.toUint48Multiplier(activeMultiplier12);
                    multData.switchTime = StorageLib.toUint40Timestamp(block.timestamp);
                    multData.afterRate = StorageLib.toUint40APR(0); // Clear any activated/old scheduled rate
                }
            }
        }

        // Update global maturity period
        globalTransferSettings.maturityPeriod = StorageLib.toUint32RewardPeriod(period);

        emit MaturityPeriodSet(0, period); // Use index 0 for global setting
    }

    /**
     * @notice Set the reference time for period calculation (realigns period boundaries)
     * @dev Catches up all multipliers and adjusts referencePeriodNum to preserve current period
     * @dev This allows aligning periods to specific times (e.g., midnight UTC) without changing current period
     * @param newReferenceTime The new reference timestamp (must be <= current time)
     */
    function setReferenceTime(uint40 newReferenceTime) external onlyMultAdminRole {
        if (newReferenceTime > block.timestamp) revert InvalidReferenceTime();

        // Catch up all multipliers to current values before changing reference
        if (globalTransferSettings.maturityPeriod > 0 && activeMultiplierCount > 0) {
            for (uint16 id = firstActiveId; id != 0; id = multipliers[id].nextActiveId) {
                uint256 activeMultiplier12 = getActiveMultiplier(id);
                MultiplierData storage multData = multipliers[id];

                // Check if there's a future scheduled rate that we need to preserve
                if (multData.switchTime > block.timestamp && multData.afterRate > 0) {
                    // Future scheduled rate - preserve it and recalculate with new reference time
                    // Keep switchTime unchanged (absolute timestamp remains valid)
                    // Recalculate switchTimeMultiplier: project from current multiplier to switchTime using new reference
                    uint256 newSwitchTimeMultiplier = MultiplierGrowthLib.projectMultiplier(
                        activeMultiplier12,
                        uint256(multData.beforeRate),
                        block.timestamp,
                        uint256(multData.switchTime),
                        globalTransferSettings.maturityPeriod,
                        newReferenceTime // Use NEW reference time for projection
                    );

                    multData.switchTimeMultiplier = StorageLib.toUint48Multiplier(newSwitchTimeMultiplier);
                    // Keep afterRate and switchTime unchanged (preserve scheduled rate)
                } else {
                    // No future scheduled rate - commit any activated rate and reset to current time
                    _commitActivatedRate(multData);

                    multData.switchTimeMultiplier = StorageLib.toUint48Multiplier(activeMultiplier12);
                    multData.switchTime = StorageLib.toUint40Timestamp(block.timestamp);
                    multData.afterRate = StorageLib.toUint40APR(0); // Clear any activated/old scheduled rate
                }
            }
        }

        // Store old value for event
        uint40 oldReferenceTime = globalTransferSettings.referenceTime;

        // Update reference time (referencePeriodNum removed)
        globalTransferSettings.referenceTime = newReferenceTime;

        emit ReferenceTimeUpdated(oldReferenceTime, newReferenceTime);
    }

    /**
     * @notice Set the global claim source address
     * @param claimSource The claim source address
     */
    function setClaimSource(address claimSource) external onlyMultAdminRole {
        _validateClaimSource(claimSource);

        address oldClaimSource = adminConfig.claimSource;
        adminConfig.claimSource = claimSource;
        emit ClaimSourceSet(oldClaimSource, claimSource);
    }



    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Get all active multiplier IDs
     * @dev Traverses the linked list of active multipliers
     * @return Array of active multiplier IDs
     */
    function getAllActiveMultipliers() external view returns (uint32[] memory) {
        // Allocate array based on activeMultiplierCount
        uint32[] memory multiplierIds = new uint32[](activeMultiplierCount);

        // Traverse linked list to populate array
        uint256 index = 0;
        for (uint16 id = firstActiveId; id != 0; id = multipliers[id].nextActiveId) {
            multiplierIds[index] = id;
            index++;
        }

        return multiplierIds;
    }

    /**
     * @notice Get the current active multiplier for a given ID
     * @dev This function now handles scheduled rate changes automatically
     * @param multiplierId The multiplier ID
     * @return The current multiplier value (12 decimals)
     */
    function getActiveMultiplier(uint32 multiplierId) public view returns (uint256) {
        // Delegate to internal implementation which handles scheduled rate changes
        return _getActiveMultiplier(multiplierId);
    }


    /**
     * @notice Get maturity period
     * @return Maturity period in seconds
     */
    function getMaturityPeriod() external view returns (uint32) {
        return uint32(globalTransferSettings.maturityPeriod);
    }

    /**
     * @notice Get reference time for period calculation
     * @return The reference timestamp
     */
    function getReferenceTime() external view returns (uint40) {
        return globalTransferSettings.referenceTime;
    }


    /**
     * @notice Get current period number
     * @return The current period number
     */
    function getCurrentPeriodNum() external view returns (uint32) {
        return SharesLib.getCurrentPeriodNum(
            globalTransferSettings.referenceTime,
            globalTransferSettings.maturityPeriod,
            block.timestamp
        );
    }

    /**
     * @notice Get global reward source address
     * @return The reward source address
     */
    function getClaimSource() external view returns (address) {
        return adminConfig.claimSource;
    }

    /**
     * @notice Get global minimum APR bound
     * @return The minimum APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     */
    function getMinAPR() external view returns (uint256) {
        return uint256(adminConfig.minRate);
    }

    /**
     * @notice Get global maximum APR bound
     * @return The maximum APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     */
    function getMaxAPR() external view returns (uint256) {
        return uint256(adminConfig.maxRate);
    }

    /**
     * @notice Get next scheduled APR for a multiplier
     * @param multiplierId The multiplier ID
     * @return The next APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR, 0 if none scheduled)
     */
    function getNextAPR(uint32 multiplierId) external view returns (uint256) {
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);

        MultiplierData storage multData = multipliers[multiplierId];

        // Only return afterRate if switchTime is in the future (scheduled rate)
        // If switchTime <= now, it's a past rate change, not a future scheduled rate
        if (multData.switchTime <= block.timestamp) return 0;

        return uint256(multData.afterRate); // APR stored at 10 decimal precision
    }

    /**
     * @notice Get next scheduled APY for a multiplier
     * @dev Converts the scheduled next APR to APY using current period setting
     * @dev Returns 0 if no rate is scheduled
     * @param multiplierId The multiplier ID
     * @return The next APY as a fractional rate with 10 decimals (e.g., 0.04081 × 10^10 = 408100000 for 4.081% APY, 0 if none scheduled)
     */
    function getNextAPY(uint32 multiplierId) external view returns (uint256) {
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);

        MultiplierData storage multData = multipliers[multiplierId];

        // Only return afterRate if switchTime is in the future (scheduled rate)
        // If switchTime <= now, it's a past rate change, not a future scheduled rate
        if (multData.switchTime <= block.timestamp) return 0;

        uint256 nextAPR = uint256(multData.afterRate);
        if (nextAPR == 0) return 0; // No scheduled rate

        uint32 period = globalTransferSettings.maturityPeriod;
        if (period == 0) {
            revert StorageLib.InvalidPeriodLength();
        }

        return _calculateAPYFromAPR(nextAPR, period);
    }

    /**
     * @notice Get switch time for a multiplier (when rate change occurs)
     * @dev Returns the stored timestamp directly (no conversion needed)
     * @dev Works for both APR and APY queries (they activate at the same time)
     * @param multiplierId The multiplier ID
     * @return The timestamp when rate switch occurs (0 if none scheduled)
     */
    function getSwitchTime(uint32 multiplierId) external view returns (uint256) {
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);

        MultiplierData storage multData = multipliers[multiplierId];

        // Check if there's actually a scheduled rate (afterRate must be non-zero)
        if (multData.afterRate == 0) return 0;  // No scheduled rate

        uint40 switchTime = multData.switchTime;

        // Only return switchTime if it's in the future (pending rate change)
        if (uint256(switchTime) <= block.timestamp) return 0;  // Rate change already occurred

        return uint256(switchTime);
    }



    // ============ APR-BASED RATE FUNCTIONS ============

    /**
     * @notice Set multiplier rate using APR (Annual Percentage Rate)
     * @dev APR is preserved when period changes (APY changes slightly)
     * @dev APR is stored as a fractional rate with 10 decimals
     * @dev We add 1 to block.timestamp to avoid transaction ordering issues within a block.
     *      Without this, transfer transactions in the same block as setMultiplierRateByAPR
     *      could have different rates depending on their position in the block, leading to
     *      inconsistent behavior. By scheduling the rate change for the next second, all
     *      transactions in the current block use the same rate.
     * @param multiplierId The multiplier ID to update
     * @param apr The APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     */
    function setMultiplierRateByAPR(uint32 multiplierId, uint256 apr) external onlyMultAdminRole {
        // IMPORTANT: APR is stored as a fraction at 10 decimals
        // Example: 5% APR = 0.05 × 10^10 = 500,000,000
        // This is the ANNUAL rate - conversion to per-period rate happens in MultiplierGrowthLib
        _scheduleRateChange(multiplierId, apr, uint32(block.timestamp + 1));
    }

    /**
     * @notice Schedule a rate change to occur at a specific time using APR
     * @dev Restricted to MULT_RATE_ROLE (hot wallet). atTime must be a future time.
     * @dev Stores timestamp directly - immune to both period and reference time changes
     *
     * BOUNDARY SEMANTICS:
     * @dev The atTime parameter specifies when the new rate starts being applied.
     * @dev The new rate applies to the period boundary containing or following atTime
     * @dev - All compounding BEFORE that period boundary uses the OLD rate
     * @dev - All compounding FROM that period boundary onward uses the NEW rate
     *
     * @param multiplierId The multiplier ID
     * @param apr The new APR to schedule as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     * @param atTime The timestamp when the rate should become active (must be future time)
     */
    function scheduleNextMultRateByAPR(uint32 multiplierId, uint256 apr, uint32 atTime) external onlyMultRateRole {
        _scheduleRateChange(multiplierId, apr, atTime);
    }

    /**
     * @notice Get the current APR for a multiplier
     * @param multiplierId The multiplier ID
     * @return The APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     */
    function getCurrentAPR(uint32 multiplierId) external view returns (uint256) {
        if (!_multiplierExists(multiplierId)) {
            revert MultiplierIndexNotFound(multiplierId);
        }

        MultiplierData storage multData = multipliers[multiplierId];
        return _getCurrentEffectiveRate(multData);
    }

    /**
     * @notice Get the current APY for a multiplier
     * @dev Convenience function that combines getCurrentAPR() with calculateAPYFromAPR()
     * @dev Uses the current global reward period setting for compounding calculation
     * @param multiplierId The multiplier ID
     * @return The APY as a fractional rate with 10 decimals (e.g., 0.04081 × 10^10 = 408100000 for 4.081% APY)
     */
    function getCurrentAPY(uint32 multiplierId) external view returns (uint256) {
        if (!_multiplierExists(multiplierId)) {
            revert MultiplierIndexNotFound(multiplierId);
        }

        MultiplierData storage multData = multipliers[multiplierId];

        // Get current APR (considering activated rate changes)
        uint256 apr = _getCurrentEffectiveRate(multData);

        uint32 period = globalTransferSettings.maturityPeriod;
        if (period == 0) {
            revert StorageLib.InvalidPeriodLength();
        }

        return _calculateAPYFromAPR(apr, period);
    }

    /**
     * @notice Set rate bounds using APR
     * @param minAPR Minimum APR as a fractional rate with 10 decimals (e.g., 0.01 × 10^10 = 100000000 for 1% APR)
     * @param maxAPR Maximum APR as a fractional rate with 10 decimals (e.g., 0.10 × 10^10 = 1000000000 for 10% APR)
     * @dev Use type(uint40).max for maxAPR to allow effectively unlimited APR
     * @dev Setting both to 0 means only 0% APR is allowed (no rewards)
     */
    function setRateBoundsByAPR(uint256 minAPR, uint256 maxAPR) external onlyMultAdminRole {
        _validateRateBounds(minAPR, maxAPR);

        // Store APR bounds as fraction at 10 decimals
        adminConfig.minRate = StorageLib.toUint40APR(minAPR);
        adminConfig.maxRate = StorageLib.toUint40APR(maxAPR);
    }

    /**
     * @notice Calculate APY from APR given current period
     * @dev IMPORTANT: APY calculation uses the CURRENT global reward period setting.
     * @dev If the period changes between now and when a scheduled rate activates,
     * @dev the actual APY earned will differ from this calculation.
     * @dev APY formula: (1 + r/n)^n - 1, where r = APR and n = periods per year
     * @param apr The APR as a fractional rate with 10 decimals (e.g., 0.04 × 10^10 = 400000000 for 4% APR)
     * @return The APY as a fractional rate with 10 decimals (e.g., 0.04081 × 10^10 = 408100000 for 4.081% APY)
     */
    function calculateAPYFromAPR(uint256 apr) external view returns (uint256) {
        uint32 period = globalTransferSettings.maturityPeriod;
        if (period == 0) {
            revert StorageLib.InvalidPeriodLength();
        }

        return _calculateAPYFromAPR(apr, period);
    }

    // ============ INTERNAL HELPER FUNCTIONS ============
    // NOTE: _multiplierExists() is inherited from ClaimableRewardsBase

    /**
     * @dev Internal helper to schedule a rate change at a specific time
     * @param multiplierId The multiplier ID
     * @param apr The new APR to schedule as a fractional rate with 10 decimals
     * @param atTime The timestamp when the rate should become active
     */
    function _scheduleRateChange(uint32 multiplierId, uint256 apr, uint32 atTime) internal {
        if (!_multiplierExists(multiplierId)) revert MultiplierIndexNotFound(multiplierId);
        if (atTime <= block.timestamp) revert ScheduleTimeInPast();

        _validateAPRBounds(apr);
        
        // Schedule the rate change (store timestamp directly for period change resilience)
        MultiplierData storage multData = multipliers[multiplierId];

        // Commit any currently scheduled rate to beforeRate if it has activated
        // This ensures beforeRate always reflects the current effective rate
        _commitActivatedRate(multData);

        // Get the current effective rate for projection
        uint256 currentRate = uint256(multData.beforeRate);

        // Calculate what the multiplier WILL BE at the future switchTime
        // This is critical: switchTimeMultiplier must represent "the multiplier at switchTime"
        uint256 currentMultiplier = _getActiveMultiplier(multiplierId);
        uint256 multiplierAtSwitchTime = MultiplierGrowthLib.projectMultiplier(
            currentMultiplier,
            currentRate,
            block.timestamp,
            atTime,  // Project forward to switchTime
            globalTransferSettings.maturityPeriod,
            globalTransferSettings.referenceTime
        );

        multData.afterRate = StorageLib.toUint40APR(apr);
        multData.switchTime = StorageLib.toUint40Timestamp(atTime);
        multData.switchTimeMultiplier = StorageLib.toUint48Multiplier(multiplierAtSwitchTime);

        emit MultiplierRateScheduled(multiplierId, apr, atTime);
    }

    /**
     * @dev Internal helper to validate APR against global rate bounds
     * @param apr The APR to validate (10 decimals)
     */
    function _validateAPRBounds(uint256 apr) internal view {
        if (apr < adminConfig.minRate) {
            revert InvalidRebaseRate(apr);
        }
        if (apr > adminConfig.maxRate) {
            revert InvalidRebaseRate(apr);
        }
    }

    /**
     * @dev Internal helper to calculate APY from APR
     * @param apr The APR as a fractional rate with 10 decimals
     * @param period The reward period in seconds
     * @return The APY as a fractional rate with 10 decimals
     */
    function _calculateAPYFromAPR(uint256 apr, uint32 period) internal pure returns (uint256) {
        // Calculate per-period rate: scale to 18 decimals BEFORE division to avoid precision loss
        uint256 periodsPerYear = SharesLib.SECONDS_PER_YEAR / period;
        uint256 perPeriodRate = (apr * SharesLib.SCALE_10_TO_18) / periodsPerYear;

        // Calculate APY: (1 + perPeriodRate)^periodsPerYear - 1
        // Base is at 18 decimals (1e18 + perPeriodRate)
        uint256 base = 1e18 + perPeriodRate;
        uint256 finalValue = MultiplierGrowthLib.power(base, periodsPerYear);

        // Result is (1 + APY) at 18 decimals, convert back to 10 decimals and subtract 1 to get APY
        uint256 apyAt10Decimals = finalValue / SharesLib.SCALE_10_TO_18;
        return apyAt10Decimals > SharesLib.RATE_BASE ?
            apyAt10Decimals - SharesLib.RATE_BASE : 0;
    }

    /**
     * @dev Commits an activated scheduled rate to beforeRate if switchTime has passed
     * @param multData The multiplier data to update
     */
    function _commitActivatedRate(MultiplierData storage multData) internal {
        if (multData.switchTime <= block.timestamp && multData.afterRate > 0) {
            multData.beforeRate = multData.afterRate;
        }
    }
}
