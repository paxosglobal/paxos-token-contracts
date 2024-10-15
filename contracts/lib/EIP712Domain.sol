// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title EIP712Domain contract
 * @dev An Abstract contract to store the domain separator for EIP712 signature.
 * This contract is inherited by EIP3009 and EIP2612.
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP712Domain {
    /**
     * @dev EIP712 Domain Separator
     */
    bytes32 public DOMAIN_SEPARATOR; // solhint-disable-line var-name-mixedcase
}
