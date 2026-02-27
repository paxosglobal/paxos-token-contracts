// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ClaimableRewardsEvents
 * @dev Shared event definitions for V3 claimable rewards functionality
 * This contract ensures consistent event signatures across main contract and facets
 */
contract ClaimableRewardsEvents {
    // Multiplier Management Events
    event MultiplierCreated(uint32 indexed multiplierId, uint256 apr, uint256 timestamp);
    event MultiplierDeleted(uint32 indexed multiplierId);
    event MaturityPeriodSet(uint32 indexed multiplierId, uint256 maturityPeriod);
    event MultiplierRateScheduled(uint32 indexed multiplierId, uint256 newRate, uint256 scheduledTime);
    event ClaimSourceSet(address indexed oldSource, address indexed newSource);
    event RateBoundsSet(uint256 minRate, uint256 maxRate);
    event ReferenceTimeUpdated(uint40 oldReferenceTime, uint40 newReferenceTime);

    // Payout Group Management Events
    event PayoutGroupCreated(uint32 indexed payoutGroupId, address indexed claimer, uint32 indexed multiplierId);
    event PayoutGroupDeleted(uint32 indexed payoutGroupId, address indexed claimer);
    event PayoutGroupMultiplierUpdated(uint32 indexed payoutGroupId, address indexed claimer, uint32 oldMultiplierId, uint32 newMultiplierId);
    event PayoutClaimerUpdated(uint32 indexed payoutGroupId, address indexed oldClaimer, address indexed newClaimer);
    event PayoutGroupManagerSet(uint32 indexed payoutGroupId, address indexed oldManager, address indexed newManager);
    event PayoutGroupDestinationSet(uint32 indexed payoutGroupId, address indexed oldDestination, address indexed newDestination);
    event PartnerSignedRegistrationsEnabledSet(bool enabled);
    event AccountRegistered(address indexed account, uint32 indexed payoutGroupId, address indexed claimer);
    event AccountDeregistered(address indexed account, uint32 indexed payoutGroupId, address indexed claimer);
    event RegistrationProposed(address indexed account, uint32 indexed payoutGroupId, address indexed proposer);
    event RegistrationAccepted(address indexed account, uint32 indexed payoutGroupId);
    event RegistrationProposalCancelled(address indexed account, uint32 indexed payoutGroupId, address indexed proposer);

    // Claiming Events
    event RewardsClaimed(address indexed account, uint32 indexed payoutGroupId, address indexed recipient, uint256 amount);
    event RewardsClaimedBatch(uint32 indexed payoutGroupId, address indexed executor, address indexed destination, uint256 totalAmount, uint256 accountCount);
    event ClaimAllExecuted(uint32 indexed payoutGroupId, address indexed executor, address indexed destination, uint256 amount);
}
