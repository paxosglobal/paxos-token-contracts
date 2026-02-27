// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title Roles
 * @notice Centralized role constants for access control across the token system
 * @dev All role identifiers are keccak256 hashes of role names
 *
 * Role Organization:
 * - Multiplier Management: Control reward calculation parameters
 * - Payout Group Management: Control reward distribution groups
 * - Claim Management: Control reward claiming operations
 * - Admin/Protection: Control token pause and freeze operations
 */
library Roles {
    // ==================== Multiplier Management Roles ====================

    /**
     * @dev Controls multiplier lifecycle (create, delete) and reward rate parameters.
     * This role manages the fundamental reward calculation mechanisms but CANNOT redirect funds.
     * Typical holder: Admin cold wallet
     * keccak256("MULT_ADMIN_ROLE")
     */
    bytes32 internal constant MULT_ADMIN_ROLE = 0xf87083816642e3d7d4c29c8bd120d38d20e635cf3accc9943b0756f540e63540;

    /**
     * @dev Schedules future rate changes for multipliers (time-delayed updates).
     * This role enables operational flexibility for rate adjustments but CANNOT redirect funds.
     * Typical holder: Hot wallet
     * keccak256("MULT_RATE_ROLE")
     */
    bytes32 internal constant MULT_RATE_ROLE = 0x14682d1851e1b102da952c0c155677821e8e89b896948538617aeba3934d06d0;

    // ==================== Payout Group Management Roles ====================

    /**
     * @dev Manages payout group lifecycle (create, delete), account registrations, and multiplier assignments.
     * This role controls which accounts earn rewards in which groups and which multiplier curve is applied,
     * but CANNOT redirect funds (claims always go to pre-configured destinations).
     * Typical holder: Hot wallet
     * keccak256("PAYOUT_GROUP_REGISTRAR_ROLE")
     */
    bytes32 internal constant PAYOUT_GROUP_REGISTRAR_ROLE = 0xf5c39a02a674f3b0c47512a808c655a0c55648b86b6692986c44c50338bc017b;

    /**
     * @dev Configures payout group parameters (claimer, manager, destination).
     * ⚠️ PRIVILEGED: This role CAN redirect funds by changing payout destinations to arbitrary addresses.
     * Must be held by a highly secure wallet due to fund redirection capability.
     * Typical holder: Cold wallet
     * keccak256("PAYOUT_GROUP_ADMIN_ROLE")
     */
    bytes32 internal constant PAYOUT_GROUP_ADMIN_ROLE = 0x2a0ee64a69dc50e5023a090c1c7c133118b1a3e330e9b8e053b6b63523a91a9d;

    // ==================== Claim Management Roles ====================

    /**
     * @dev Claims rewards for payout groups to their pre-configured destinations.
     * This role enables operational claiming but CANNOT redirect funds to arbitrary addresses
     * (destination is determined by payout group configuration).
     * Typical holder: Hot wallet
     * keccak256("CLAIM_OPERATOR_ROLE")
     */
    bytes32 internal constant CLAIM_OPERATOR_ROLE = 0x36dc7495d0ae0bc2a620bf292049e4d4e5f800043895b13c08a1977d3a3297f5;

    /**
     * @dev Claims rewards for payout groups with ability to specify custom destination addresses.
     * ⚠️ PRIVILEGED: This role CAN redirect funds by specifying arbitrary claim destinations.
     * Must be held by a highly secure wallet due to fund redirection capability.
     * Typical holder: Cold wallet
     * keccak256("CLAIM_ADMIN_ROLE")
     */
    bytes32 internal constant CLAIM_ADMIN_ROLE = 0xb552f1bea17e2734c4b1d253bbc784c04b883a78e93589442d4b5d6e6a2f73bd;

    // ==================== Admin/Protection Roles ====================

    /**
     * @dev Controls token pause/unpause functionality.
     * keccak256("PAUSE_ROLE")
     */
    bytes32 internal constant PAUSE_ROLE = 0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d;

    /**
     * @dev Controls address freeze/unfreeze and balance wipe functionality.
     * keccak256("ASSET_PROTECTION_ROLE")
     */
    bytes32 internal constant ASSET_PROTECTION_ROLE = 0xe3e4f9d7569515307c0cdec302af069a93c9e33f325269bac70e6e22465a9796;
}
