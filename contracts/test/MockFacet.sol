// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";

/**
 * @title MockFacet
 * @dev Simple test facet for validating Diamond pattern delegation
 */
contract MockFacet is ClaimableRewardsBase {
    // Custom error for testing revert forwarding
    error MockFacetError(string message);

    /**
     * @notice Test function that modifies storage via delegatecall
     * @dev When called via fallback, should modify main contract's storage
     * @param value The value to set in totalSupply_ (uses existing storage slot)
     */
    function setTestValue(uint256 value) external {
        totalSupply_ = value; // Modify main contract storage
    }

    /**
     * @notice Test view function to read storage
     * @dev Reads from main contract's storage when delegatecalled
     * @return The current test value (totalSupply_)
     */
    function getTestValue() external view returns (uint256) {
        return totalSupply_;
    }

    /**
     * @notice Test function that returns data
     * @dev Tests that return data is properly forwarded through fallback
     * @param a First number
     * @param b Second number
     * @return sum The sum of a and b
     */
    function calculateSum(uint256 a, uint256 b) external pure returns (uint256 sum) {
        return a + b;
    }

    /**
     * @notice Test function that reverts with custom error
     * @dev Tests that revert data is properly forwarded through fallback
     * @param shouldRevert If true, reverts with custom error
     */
    function maybeRevert(bool shouldRevert) external pure {
        if (shouldRevert) {
            revert MockFacetError("Test revert message");
        }
    }

    /**
     * @notice Test function that reverts with require
     * @dev Tests that require revert messages are forwarded
     * @param condition The condition to check
     */
    function requireCheck(bool condition) external pure {
        require(condition, "Require failed in facet");
    }

    /**
     * @notice Test function with multiple return values
     * @dev Tests complex return data forwarding
     * @param value Input value
     * @return doubled The value doubled
     * @return tripled The value tripled
     * @return message A string message
     */
    function multipleReturns(uint256 value) external pure returns (
        uint256 doubled,
        uint256 tripled,
        string memory message
    ) {
        return (value * 2, value * 3, "Success");
    }
}
