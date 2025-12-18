// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title EIP3009Definitions
 * @dev Shared constants, errors, and events for EIP-3009 (Transfer with Authorization) functionality
 * @notice This contract only defines constants, errors, and events - no storage or functions
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP3009Definitions {
    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    error CallerMustBePayee();
    error AuthorizationInvalid();
    error AuthorizationExpired();
    error BlockedAccountAuthorizer();

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationAlreadyUsed(address indexed authorizer, bytes32 indexed nonce);
}
