// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { SharesLib } from "../lib/SharesLib.sol";

/**
 * @title SharesLibTest
 * @dev Test contract to measure gas costs of SharesLib functions in isolation
 * @notice Function names use `exposed_` prefix instead of `test` to avoid Foundry fuzz interpretation
 */
contract SharesLibTest {
    /**
     * @dev Test wrapper for updateSharesWithRewardPreservation
     */
    function exposed_updateSharesWithRewardPreservation(
        uint256 oldBalance,
        uint256 newBalance,
        uint256 currentShares,
        uint256 currentMultiplier
    ) external pure returns (uint256) {
        return SharesLib.updateSharesWithRewardPreservation(
            oldBalance,
            newBalance,
            currentShares,
            currentMultiplier
        );
    }

    /**
     * @dev Test wrapper for calcShares
     */
    function exposed_calcShares(uint256 balance, uint256 multiplier) external pure returns (uint256) {
        return SharesLib.calcShares(balance, multiplier);
    }

    /**
     * @dev Test wrapper for calcBalance
     */
    function exposed_calcBalance(uint256 shares, uint256 multiplier) external pure returns (uint256) {
        return SharesLib.calcBalance(shares, multiplier);
    }

    /**
     * @dev Test wrapper for calcRewards
     */
    function exposed_calcRewards(uint256 shares, uint256 multiplier, uint256 balance) external pure returns (uint256) {
        return SharesLib.calcRewards(shares, multiplier, balance);
    }

    /**
     * @dev Test wrapper for getCurrentPeriodNum
     * Uses uint256 for referenceTime and maturityPeriod to allow testing overflow cases
     */
    function exposed_getCurrentPeriodNum(
        uint40 referenceTime,
        uint32 maturityPeriod,
        uint256 currentTime
    ) external pure returns (uint32) {
        return SharesLib.getCurrentPeriodNum(referenceTime, maturityPeriod, currentTime);
    }
}
