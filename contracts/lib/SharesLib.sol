// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title SharesLib
 * @dev Shares-based reward calculation library for V3 rebase claims
 *
 * Key Formula: shares * multiplier / MULT_BASE = balance + rewards
 * - Shares are stored at 6 decimals (same as balance)
 * - Multiplier is stored at 12 decimals (MULT_BASE = 1e12)
 * - Rates (APR) are stored at 10 decimals (RATE_BASE = 1e10)
 * - Rewards = (shares * multiplier / MULT_BASE) - balance
 */
library SharesLib {
    uint256 internal constant MULT_BASE = 1e12; // 12 decimals for multipliers
    uint256 internal constant RATE_BASE = 1e10; // 10 decimals for APR rates
    uint256 internal constant PRECISION_18 = 1e18; // 18 decimals for intermediate calculations
    uint256 internal constant SCALE_10_TO_18 = 1e8; // Scaling factor: 1e18 / 1e10
    uint256 internal constant SECONDS_PER_YEAR = 365 days; // 31,536,000 seconds

    // Errors
    error ZeroMultiplier();
    error PeriodNumOverflow();

    /**
     * @dev Convert balance to shares at current multiplier
     * Formula: shares = (balance * MULT_BASE) / multiplier
     * @param balance The balance amount (6 decimals)
     * @param multiplier The current multiplier (12 decimals)
     * @return shares The calculated shares (6 decimals)
     */
    function calcShares(uint256 balance, uint256 multiplier) internal pure returns (uint256 shares) {
        if (multiplier == 0) revert ZeroMultiplier();
        return (balance * MULT_BASE) / multiplier;
    }

    /**
     * @dev Convert shares to balance equivalent
     * Formula: balance = (shares * multiplier) / MULT_BASE
     * @param shares The shares amount (6 decimals)
     * @param multiplier The current multiplier (12 decimals)
     * @return balance The calculated balance (6 decimals)
     */
    function calcBalance(uint256 shares, uint256 multiplier) internal pure returns (uint256 balance) {
        return (shares * multiplier) / MULT_BASE;
    }

    /**
     * @dev Calculate rewards from shares and current balance
     * Formula: rewards = (shares * multiplier / MULT_BASE) - balance
     * @param shares The shares amount (6 decimals)
     * @param multiplier The current multiplier (12 decimals)
     * @param balance The current balance (6 decimals)
     * @return rewards The calculated rewards (6 decimals), or 0 if negative
     */
    function calcRewards(uint256 shares, uint256 multiplier, uint256 balance) internal pure returns (uint256 rewards) {
        uint256 totalValue = calcBalance(shares, multiplier);
        return totalValue > balance ? totalValue - balance : 0;
    }

    /**
     * @dev Calculate current period number from global settings
     * Periods are calculated from referenceTime and maturityPeriod
     * @param referenceTime The timestamp for period 0 or reference
     * @param maturityPeriod The period in seconds for each period
     * @param currentTime The current block timestamp
     * @return periodNum The current period number
     */
    function getCurrentPeriodNum(
        uint40 referenceTime,
        uint32 maturityPeriod,
        uint256 currentTime
    ) internal pure returns (uint32 periodNum) {
        if (maturityPeriod == 0) {
            return 0; // No periods, stay at 0
        }

        // Calculate periods elapsed since reference time
        uint256 timeElapsed = currentTime > referenceTime
            ? currentTime - referenceTime
            : 0;
        uint256 periodsElapsed = timeElapsed / maturityPeriod;

        if (periodsElapsed > type(uint32).max) revert PeriodNumOverflow();

        return uint32(periodsElapsed);
    }

    /**
     * @dev Update shares when balance changes, preserving unclaimed rewards
     * Formula: newShares = (newBalance + unclaimedRewards) * MULT_BASE / multiplier
     * where: unclaimedRewards = (currentShares * multiplier / MULT_BASE) - oldBalance
     * @param oldBalance Previous balance (6 decimals)
     * @param newBalance New balance (6 decimals)
     * @param currentShares Current shares (6 decimals)
     * @param currentMultiplier Current multiplier (12 decimals)
     * @return newShares The updated shares (6 decimals)
     */
    function updateSharesWithRewardPreservation(
        uint256 oldBalance,
        uint256 newBalance,
        uint256 currentShares,
        uint256 currentMultiplier
    ) internal pure returns (uint256 newShares) {
        // Note: multiplier == 0 check is in calcShares(), no need to duplicate here

        if (currentShares == 0) {
            // No existing shares - just convert new balance
            return newBalance > 0 ? calcShares(newBalance, currentMultiplier) : 0;
        }

        // Calculate current unclaimed rewards
        uint256 unclaimedRewards = calcRewards(currentShares, currentMultiplier, oldBalance);

        // New shares preserve unclaimed rewards
        return calcShares(newBalance + unclaimedRewards, currentMultiplier);
    }

    /**
     * @dev Handle claimAll detection and adjust shares accordingly
     *
     * lastClaimAllMultiplier is the multiplier value from which token accounts accrue rewards
     * since the last claimAll. By forcing claimAll when multiplier changes, future accrual
     * computation works in units of the new multiplier.
     *
     * Uses timestamp-based detection: if wallet was updated before or at claimAll time,
     * recalculate shares using lastClaimAllMultiplier as the new base. Timestamp-based detection
     * is reliable because block.timestamp is monotonically non-decreasing, unlike period numbers
     * which can reset when setMaturityPeriod or setReferenceTime is called.
     *
     * @param balance Current balance (6 decimals)
     * @param currentShares Current shares (6 decimals)
     * @param walletLastUpdate Timestamp when wallet was last updated
     * @param lastClaimAllTime Timestamp when last claimAll occurred
     * @param lastClaimAllMultiplier Payout group's multiplier value from which to accrue (12 decimals)
     * @return adjustedShares The adjusted shares after claimAll (6 decimals)
     */
    function handleClaimAllDetection(
        uint256 balance,
        uint256 currentShares,
        uint40 walletLastUpdate,
        uint40 lastClaimAllTime,
        uint256 lastClaimAllMultiplier
    ) internal pure returns (uint256 adjustedShares) {
        // Check if wallet was updated AFTER the last claimAll using timestamps
        // Timestamps are monotonically non-decreasing, so this comparison is always reliable
        if (walletLastUpdate > lastClaimAllTime) {
            // Wallet updated after claimAll - shares already correct
            return currentShares;
        }

        // Wallet updated before or at claimAll - claimAll zeroed rewards
        // Recalculate shares based purely on balance (zero rewards)
        // Note: multiplier == 0 check is in calcShares(), no need to duplicate here
        return calcShares(balance, lastClaimAllMultiplier);
    }

    /**
     * @dev Calculate sharesDelta for a balance change
     * This is used to maintain share conservation across hierarchical levels
     * @param balanceDelta The change in balance (can be positive or negative in int256)
     * @param multiplier The current multiplier (12 decimals)
     * @return sharesDelta The change in shares (6 decimals)
     */
    function calcSharesDelta(int256 balanceDelta, uint256 multiplier) internal pure returns (int256 sharesDelta) {
        // Note: multiplier == 0 check is in calcShares(), no need to duplicate here

        if (balanceDelta >= 0) {
            uint256 positiveDelta = uint256(balanceDelta);
            return int256(calcShares(positiveDelta, multiplier));
        } else {
            uint256 negativeDelta = uint256(-balanceDelta);
            return -int256(calcShares(negativeDelta, multiplier));
        }
    }
}
