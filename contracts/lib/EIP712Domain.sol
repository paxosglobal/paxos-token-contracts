// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title EIP712Domain contract
 * @dev An Abstract contract to provide the domain separator for EIP712 signatures.
 * This contract is inherited by EIP3009 and EIP2612.
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP712Domain {
    // EIP-712 version prefix used in signature verification
    bytes2 public constant EIP712_VERSION_PREFIX = hex"1901";
    
    /**
     * @dev Storage slot for deprecated domain separator (kept for storage compatibility)
     * @dev This storage variable is no longer used as domain separator is always recomputed
     */
    bytes32 private DOMAIN_SEPARATOR_DEPRECATED; // solhint-disable-line var-name-mixedcase

    /**
     * @notice EIP712 Domain Separator
     * @dev Returns domain separator, always recomputed to handle chain forks
     * @return The domain separator for EIP-712 signatures
     */
    function DOMAIN_SEPARATOR() public view virtual returns (bytes32);
}
