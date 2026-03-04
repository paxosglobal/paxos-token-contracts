// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title TokenAdminEvents
 * @dev Shared event definitions for token administration functionality
 * This contract ensures consistent event signatures across main contract and facets
 */
contract TokenAdminEvents {
    // Pause/Unpause Events
    event Pause();
    event Unpause();

    // Freeze/Unfreeze Events
    event FreezeAddress(address indexed addr);
    event UnfreezeAddress(address indexed addr);
    event FrozenAddressWiped(address indexed addr);
    event RewardsFrozen(address indexed addr, uint32 indexed payoutGroupId, uint256 rewards);
    event FrozenRewardsLost(address indexed addr, uint32 indexed payoutGroupId, uint256 rewards);

    // Supply Control Events
    event SupplyIncreased(address indexed to, uint256 value);
    event SupplyDecreased(address indexed from, uint256 value);
    event SupplyControlSet(address indexed supplyControlAddress);
}
