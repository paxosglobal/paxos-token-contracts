// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { MultiplierGrowthLib } from "../lib/MultiplierGrowthLib.sol";

/**
 * @title MultiplierGrowthLibTest
 * @notice Test harness contract to expose MultiplierGrowthLib internal functions for unit testing
 */
contract MultiplierGrowthLibTest {
    /**
     * @notice Expose calculatePeriodsCrossed for testing
     */
    function calculatePeriodsCrossed(
        uint256 lastTime,
        uint256 currentTime,
        uint256 periodLength,
        uint256 referenceTime
    ) external pure returns (uint256) {
        return MultiplierGrowthLib.calculatePeriodsCrossed(
            lastTime,
            currentTime,
            periodLength,
            referenceTime
        );
    }

    /**
     * @notice Expose power for testing at multiplier precision (12 decimals)
     */
    function power(uint256 base, uint256 exponent) external pure returns (uint256) {
        return MultiplierGrowthLib.powerAtMultPrecision(base, exponent);
    }

    /**
     * @notice Expose projectMultiplier for testing (bidirectional)
     */
    function projectMultiplier(
        uint256 knownMultiplier,
        uint256 apr,
        uint256 knownTime,
        uint256 targetTime,
        uint256 periodLength,
        uint256 referenceTime
    ) external pure returns (uint256) {
        return MultiplierGrowthLib.projectMultiplier(
            knownMultiplier,
            apr,
            knownTime,
            targetTime,
            periodLength,
            referenceTime
        );
    }

    /**
     * @notice Forward projection wrapper (delegates to projectMultiplier)
     */
    function getForwardProjectedMultiplier(
        uint256 cachedMultiplier,
        uint256 apr,
        uint256 cachedTime,
        uint256 currentTime,
        uint256 periodLength,
        uint256 referenceTime
    ) external pure returns (uint256) {
        return MultiplierGrowthLib.projectMultiplier(
            cachedMultiplier,
            apr,
            cachedTime,
            currentTime,
            periodLength,
            referenceTime
        );
    }

    /**
     * @notice Backward projection wrapper (delegates to projectMultiplier)
     */
    function getBackwardProjectedMultiplier(
        uint256 futureMultiplier,
        uint256 apr,
        uint256 targetTime,
        uint256 futureTime,
        uint256 periodLength,
        uint256 referenceTime
    ) external pure returns (uint256) {
        return MultiplierGrowthLib.projectMultiplier(
            futureMultiplier,
            apr,
            futureTime,
            targetTime,
            periodLength,
            referenceTime
        );
    }
}
