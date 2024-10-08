// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { DoubleEndedQueue } from "@openzeppelin/contracts/utils/structs/DoubleEndedQueue.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "hardhat/console.sol";

/**
 * @title RateLimit library
 * @dev Performs rate limiting using an elapsed time algorithm
 * @custom:security-contact smart-contract-security@paxos.com
 */
library RateLimit {
    uint256 constant SKIP_RATE_LIMIT_CHECK = 0;
    struct Storage {
        // Limit configuration
        LimitConfig limitConfig;
        // Remaining amount for the time period
        uint256 remainingAmount;
        //Timestamp of last event
        uint256 lastRefillTime;
    }
    struct LimitConfig {
        // Max amount for the rate limit
        uint256 limitCapacity;
        // Amount to add to limit each second up to the limitCapacity
        uint256 refillPerSecond;
    }

    error RateLimitExceeded();
    error OldTimestamp(uint256 timestamp, uint256 expected);

    /**
     * @dev Uses an elapsed time algorithm to determine if the new event is allowed or not.
     * High level steps:
     *   1. Calculate elapsed time since last event
     *   2. Calculate amount that can be sent at the current `timestamp`
     *   3. Check if rate limit is exceeded or not and update remaining amount
     *
     * @param timestamp Timestamp of the new event
     * @param amount Amount of the new event
     * @param limitStorage Storage data specific to the rate limit check
     */
    function checkNewEvent(uint256 timestamp, uint256 amount, Storage storage limitStorage) internal {
        //Limit time period of 0 is a special value indicating we should skip rate limit checking
        if (limitStorage.limitConfig.refillPerSecond == SKIP_RATE_LIMIT_CHECK) {
            return;
        }
        limitStorage.remainingAmount = refill(timestamp, limitStorage);
        limitStorage.lastRefillTime = timestamp;
        if (amount > limitStorage.remainingAmount) {
            revert RateLimitExceeded();
        }
        limitStorage.remainingAmount -= amount;
    }

    /**
     * @dev Gets remaining amount that can be sent in the window
     * @param timestamp Timestamp to check remaining amount for
     * @param limitStorage Storage data specific to the rate limit check
     */
    function getRemainingAmount(uint256 timestamp, Storage storage limitStorage) internal view returns (uint256) {
        // Limit time period of 0 is a special value indicating we should skip rate limit checking
        if (limitStorage.limitConfig.refillPerSecond == SKIP_RATE_LIMIT_CHECK) {
            return type(uint256).max;
        }
        return refill(timestamp, limitStorage);
    }

    /**
     * @dev Refills the amount based on the elapsed time from the previous event.
     * `timestamp` cannot be older than the `lastRefillTime`.
     * @param timestamp Timestamp of the new event
     * @param limitStorage Storage data specific to the rate limit check
     */
    function refill(uint256 timestamp, Storage storage limitStorage) private view returns (uint256) {
        if (limitStorage.lastRefillTime > timestamp) {
            revert OldTimestamp(timestamp, limitStorage.lastRefillTime);
        }
        uint256 secondsElapsed = timestamp - limitStorage.lastRefillTime;
        (bool safeMul, uint256 newTokens) = SafeMath.tryMul(secondsElapsed, limitStorage.limitConfig.refillPerSecond);
        (bool safeAdd, uint256 amount) = SafeMath.tryAdd(limitStorage.remainingAmount, newTokens);
        if (!safeMul || !safeAdd) {
            return limitStorage.limitConfig.limitCapacity;
        }
        return Math.min(limitStorage.limitConfig.limitCapacity, amount);
    }
}
