// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { RateLimit } from "../RateLimit.sol";

/**
 * @dev Wrapper around RateLimit.
 * Used for testing purposes only
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract RateLimitFixture {
    RateLimit.Storage rateLimitStorage;

    constructor(RateLimit.LimitConfig memory limitConfig) {
        rateLimitStorage.limitConfig = limitConfig;
    }

    function checkNewEvent(
        uint256 timestamp,
        uint256 amount
    ) external {
        RateLimit.checkNewEvent(timestamp, amount, rateLimitStorage);
    }

    function getRemainingAmount(uint256 timestamp) external view returns (uint256) {
        return RateLimit.getRemainingAmount(timestamp, rateLimitStorage);
    }

    function updateLimitConfig(
        RateLimit.LimitConfig memory limitConfig_
    )
        external
    {
        rateLimitStorage.limitConfig = limitConfig_;
    }

    function getLimitConfig() public view returns (RateLimit.LimitConfig memory) {
        return rateLimitStorage.limitConfig;
    }

    function remainingAmount() public view returns (uint256) {
        return rateLimitStorage.remainingAmount;
    }
}