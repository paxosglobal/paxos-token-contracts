// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { StorageLib } from "../lib/StorageLib.sol";

/**
 * @title StorageLibTest
 * @dev Test harness contract to expose StorageLib internal functions for unit testing
 * @notice Function names use `exposed_` prefix instead of `test` to avoid Foundry fuzz interpretation
 */
contract StorageLibTest {
    /**
     * @dev Test wrapper for toUint64Balance
     */
    function exposed_toUint64Balance(uint256 value) external pure returns (uint64) {
        return StorageLib.toUint64Balance(value);
    }

    /**
     * @dev Test wrapper for toUint64Shares
     */
    function exposed_toUint64Shares(uint256 value) external pure returns (uint64) {
        return StorageLib.toUint64Shares(value);
    }

    /**
     * @dev Test wrapper for toUint48Multiplier
     */
    function exposed_toUint48Multiplier(uint256 value) external pure returns (uint48) {
        return StorageLib.toUint48Multiplier(value);
    }

    /**
     * @dev Test wrapper for toUint40Timestamp
     */
    function exposed_toUint40Timestamp(uint256 value) external pure returns (uint40) {
        return StorageLib.toUint40Timestamp(value);
    }

    /**
     * @dev Test wrapper for toUint32RewardPeriod
     */
    function exposed_toUint32RewardPeriod(uint256 value) external pure returns (uint32) {
        return StorageLib.toUint32RewardPeriod(value);
    }

    /**
     * @dev Test wrapper for toUint40APR
     */
    function exposed_toUint40APR(uint256 value) external pure returns (uint40) {
        return StorageLib.toUint40APR(value);
    }
}
