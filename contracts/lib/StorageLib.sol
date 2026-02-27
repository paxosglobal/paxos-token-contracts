// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SharesLib } from "./SharesLib.sol";

/**
 * @title StorageLib
 * @dev Library for pure type conversion and validation functions
 *
 * ARCHITECTURE:
 * ============
 * This library provides pure helper functions for V3's packed storage architecture.
 * By using a library for type conversions, we achieve clean separation of concerns:
 * - Storage contracts: Pure storage variables and structs
 * - StorageLib: Pure type conversions and validations
 * - Base contracts: Business logic and storage access
 *
 * TYPE CONVERSIONS:
 * ================
 * All conversions include overflow checks and revert with specific errors.
 * This ensures safe downcasting from uint256 to smaller types used in packed storage.
 */
library StorageLib {
    // Overflow protection errors for data type conversions
    error BalanceOverflow();
    error SharesOverflow();
    error MultiplierOverflow();
    error TimestampOverflow();
    error RewardPeriodOverflow();
    error RateOverflow();
    error InvalidPeriodLength();

    /**
     * @dev Safe conversion from uint256 to uint64 with overflow check for balances
     * @param value The uint256 value to convert (6 decimals for USDG)
     * @return The safely converted uint64 value
     */
    function toUint64Balance(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) {
            revert BalanceOverflow();
        }
        return uint64(value);
    }

    /**
     * @dev Safe conversion from uint256 to uint64 with overflow check for shares
     * @param value The uint256 value to convert
     * @return The safely converted uint64 value
     */
    function toUint64Shares(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) {
            revert SharesOverflow();
        }
        return uint64(value);
    }

    /**
     * @dev Safe conversion from uint256 to uint48 with overflow check for multipliers
     * @param value The uint256 value to convert (12 decimals)
     * @return The safely converted uint48 value
     */
    function toUint48Multiplier(uint256 value) internal pure returns (uint48) {
        if (value > type(uint48).max) {
            revert MultiplierOverflow();
        }
        return uint48(value);
    }

    /**
     * @dev Safe conversion from uint256 to uint40 with overflow check for timestamps
     * @param value The uint256 value to convert
     * @return The safely converted uint40 value
     */
    function toUint40Timestamp(uint256 value) internal pure returns (uint40) {
        if (value > type(uint40).max) {
            revert TimestampOverflow();
        }
        return uint40(value);
    }

    /**
     * @dev Safe conversion from uint256 to uint32 with overflow check for reward periods
     * @param value The uint256 value to convert
     * @return The safely converted uint32 value
     */
    function toUint32RewardPeriod(uint256 value) internal pure returns (uint32) {
        if (value > type(uint32).max) {
            revert RewardPeriodOverflow();
        }
        return uint32(value);
    }

    /**
     * @dev Safe conversion from uint256 to uint40 with overflow check for APR
     * @param value The uint256 value to convert (10 decimals, max 100 = 10,000% APR)
     * @return The safely converted uint40 value
     */
    function toUint40APR(uint256 value) internal pure returns (uint40) {
        if (value > type(uint40).max) {
            revert RateOverflow();
        }
        return uint40(value);
    }
}
