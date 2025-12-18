// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title EIP2612Definitions
 * @dev Shared constants and errors for EIP-2612 (Permit) functionality
 * @notice This contract only defines constants and errors - no storage or functions
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP2612Definitions {
    // keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
    bytes32 public constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;
    
    // Maximum number of permits that can be canceled in a single transaction
    uint256 public constant MAX_NONCE_INCREMENT = 100;

    /**
     * @dev Emitted when an owner invalidates their nonces to cancel pending permits
     * @param owner The address whose nonces were invalidated
     * @param newNonce The new nonce value after invalidation
     */
    event PermitInvalidated(address indexed owner, uint256 newNonce);

    error PermitExpired();
    error InvalidNonceCount();
}
