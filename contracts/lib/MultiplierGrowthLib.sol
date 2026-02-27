// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SharesLib } from "./SharesLib.sol";

/**
 * @title MultiplierGrowthLib
 * @notice Utility library for time-based multiplier growth calculations using compound interest
 * @dev Implements period-aligned compound interest: multiplier * (1 + rate)^periods
 *      Uses binary exponentiation (squaring) for O(log n) gas efficiency
 *
 *      PRECISION STRATEGY - 18 DECIMALS FOR INTERMEDIATE CALCULATIONS:
 *      ================================================================
 *      All intermediate calculations use 18 decimals (Ethereum standard) to maximize precision:
 *      - Input APR: 10 decimals (e.g., 0.05 × 10^10 = 500M for 5% APR)
 *      - Input/Output Multipliers: 12 decimals (e.g., 1.0 × 10^12 = 1T)
 *      - Intermediate calculations: 18 decimals (per-period rate, growth factor)
 *      - Final result: scaled back to 12 decimals
 *
 *      Why 18 decimals for intermediates?
 *      - Balanced representation: 18 decimals below + ~20 decimals above = ~38 total (fits in 128 bits)
 *      - Can represent values from 10^-18 to ~10^20 without overflow
 *      - Multiplication-safe: (10^38 × 10^38) / 10^18 = 10^58 < 10^77 (uint256 max)
 *
 *      APR SCALING (10 decimals):
 *      ==========================
 *      APR is stored at 10 decimals (e.g., 0.05 × 10^10 = 500M for 5% APR).
 *      The per-period rate is calculated directly from APR using the period length.
 *
 *      IMPORTANT: Cannot use Solidity's `**` operator for exponentiation.
 *      Example: (1.05e18)^365 would compute intermediate values that overflow uint256.
 *      Instead, we use binary exponentiation with rescaling at each step to maintain precision.
 */
library MultiplierGrowthLib {
    /**
     * @dev Project multiplier between two time points (bidirectional)
     * @notice Automatically handles both forward and backward projection based on time ordering.
     * @param knownMultiplier The multiplier value at knownTime (12 decimals)
     * @param apr The annual percentage rate at 10 decimals
     *            Example: for 5% APR: 500,000,000 (representing 0.05 × 10^10)
     * @param knownTime The timestamp when the multiplier value is known
     * @param targetTime The timestamp to project to (can be before or after knownTime)
     * @param periodLength Length of each compound period in seconds (e.g., 86400 = 1 day)
     * @param referenceTime Global reference time for period alignment
     * @return The projected multiplier value at targetTime (12 decimals)
     */
    function projectMultiplier(
        uint256 knownMultiplier,
        uint256 apr,
        uint256 knownTime,
        uint256 targetTime,
        uint256 periodLength,
        uint256 referenceTime
    ) internal pure returns (uint256) {
        if (periodLength == 0 || targetTime == knownTime) {
            return knownMultiplier;
        }

        if (targetTime > knownTime) {
            // Forward projection: grow from knownTime to targetTime
            uint256 periods = calculatePeriodsCrossed(knownTime, targetTime, periodLength, referenceTime);
            if (periods == 0) return knownMultiplier;

            uint256 perPeriodRate18 = (apr * periodLength * SharesLib.SCALE_10_TO_18) / SharesLib.SECONDS_PER_YEAR;
            uint256 base18 = SharesLib.PRECISION_18 + perPeriodRate18;
            uint256 growth18 = power(base18, periods);

            return (knownMultiplier * growth18) / SharesLib.PRECISION_18;
        } else {
            // Backward projection: undo growth from targetTime to knownTime
            uint256 periods = calculatePeriodsCrossed(targetTime, knownTime, periodLength, referenceTime);
            if (periods == 0) return knownMultiplier;

            uint256 perPeriodRate18 = (apr * periodLength * SharesLib.SCALE_10_TO_18) / SharesLib.SECONDS_PER_YEAR;
            uint256 base18 = SharesLib.PRECISION_18 + perPeriodRate18;
            uint256 growthFactor18 = power(base18, periods);

            return (knownMultiplier * SharesLib.PRECISION_18) / growthFactor18;
        }
    }

    /**
     * @dev Calculate number of complete period boundaries crossed
     * @param cachedTime Starting timestamp
     * @param currentTime Ending timestamp
     * @param periodLength Period duration in seconds
     * @param referenceTime Reference time for period alignment
     * @return Number of complete periods where period end time occurred
     */
    function calculatePeriodsCrossed(
        uint256 cachedTime,
        uint256 currentTime,
        uint256 periodLength,
        uint256 referenceTime
    ) internal pure returns (uint256) {
        // Early exit: if we haven't reached the reference time yet
        if (currentTime < referenceTime) {
            return 0;
        }

        // Calculate which period each timestamp falls in
        uint256 cachedPeriodNum = cachedTime >= referenceTime
            ? (cachedTime - referenceTime) / periodLength
            : 0;

        uint256 currentPeriodNum = (currentTime - referenceTime) / periodLength;

        // Early exit: haven't crossed to next period yet
        if (currentPeriodNum <= cachedPeriodNum) {
            return 0;
        }

        return currentPeriodNum - cachedPeriodNum;
    }

    /**
     * @dev High-precision binary exponentiation: base^exponent at 18 decimals
     * @param base Base value at 18 decimals (e.g., 1.05e18 for 1.05)
     * @param exponent Power to raise to
     * @return result = base^exponent at 18 decimals
     *
     * All inputs and outputs are at 18 decimal precision (Ethereum standard, like Wei).
     * This function maintains 18 decimals throughout - no scaling up or down.
     *
     * Algorithm: Repeated squaring method (binary exponentiation)
     * - For exponent = 13 (binary: 1101):
     *   result = base^8 * base^4 * base^1
     * - Only requires 4 iterations instead of 13
     *
     * Why 18 decimals? Optimal balance for uint256 arithmetic:
     * - Representation space: ~38 decimal digits fit in 128 bits (2^128 ≈ 3.4 × 10^38)
     * - Balanced split: 18 decimals below decimal point + ~20 decimals above
     * - Decimal value range: 10^-18 (precision) to 10^20 (magnitude)
     * - Storage range: 1 to ~10^38 (fits in 128 bits)
     * - Multiplication safety: 128 bits × 128 bits = 256 bits (fits in uint256)
     * - Example: (10^38 × 10^38) / 10^18 = 10^58 < 10^77 (uint256 max)
     *
     * Gas cost: O(log exponent)
     * - 365 periods: ~9 iterations (~180K gas)
     * - vs naive loop: 365 iterations (~7.3M gas)
     *
     * Overflow protection: Explicit checks ensure values stay < 2^128 before multiplication
     * Gas optimization: Uses unchecked math after explicit bounds checking (~180-540 gas savings)
     */
    function power(uint256 base, uint256 exponent) internal pure returns (uint256 result) {
        // Safety threshold: values must stay below 2^128 to prevent overflow
        // When multiplying: 2^128 × 2^128 = 2^256 (exactly fits in uint256)
        uint256 MAX_SAFE = type(uint128).max; // 2^128 - 1 ≈ 3.4 × 10^38

        // Base cases
        if (exponent == 0) {
            return SharesLib.PRECISION_18; // x^0 = 1 at 18 decimals
        }
        if (exponent == 1) {
            return base; // x^1 = x
        }

        // Initialize result to 1.0 at 18 decimals
        result = SharesLib.PRECISION_18;

        // Binary exponentiation using repeated squaring
        // Invariant maintained: original_base^original_exponent = result * base^exponent
        while (exponent > 0) {
            // If exponent is odd, multiply result by current base
            if (exponent % 2 == 1) {
                // Explicit overflow check: ensure both operands < 2^128
                if (result > MAX_SAFE || base > MAX_SAFE) {
                    revert("MultiplierGrowth: value exceeds 2^128");
                }
                // Safe to use unchecked: 2^128 × 2^128 = 2^256 (fits in uint256)
                unchecked {
                    result = (result * base) / SharesLib.PRECISION_18;
                }
            }

            // Halve the exponent (division cannot overflow)
            unchecked {
                exponent = exponent / 2;
            }

            // Square the base (only if we'll use it)
            if (exponent > 0) {
                // Explicit overflow check before squaring
                if (base > MAX_SAFE) {
                    revert("MultiplierGrowth: base exceeds 2^128 before squaring");
                }
                // Safe to use unchecked: 2^128 × 2^128 = 2^256 (fits in uint256)
                unchecked {
                    base = (base * base) / SharesLib.PRECISION_18;
                }
            }
        }

        return result; // Result is at 18 decimals
    }

    /**
     * @dev Binary exponentiation at multiplier precision (12 decimals)
     * Scales to 18 decimals, calculates power, then scales back to 12 decimals
     * @param base Base value (12 decimals, e.g., 1.05e12 for 1.05)
     * @param exponent Power to raise to
     * @return result = base^exponent (12 decimals)
     */
    function powerAtMultPrecision(uint256 base, uint256 exponent) internal pure returns (uint256) {
        uint256 scaleTo18 = SharesLib.PRECISION_18 / SharesLib.MULT_BASE; // 1e6
        uint256 base18 = base * scaleTo18;
        uint256 result18 = power(base18, exponent);
        return result18 / scaleTo18;
    }
}
