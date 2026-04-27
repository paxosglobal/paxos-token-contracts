// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { PaxosBaseAbstract } from "./PaxosBaseAbstract.sol";
import { EIP712Domain } from "./EIP712Domain.sol";
import { EIP2612Definitions } from "./EIP2612Definitions.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title EIP2612 contract
 * @dev An abstract contract to provide EIP2612 functionality.
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP2612 is PaxosBaseAbstract, EIP712Domain, EIP2612Definitions {
    mapping(address => uint256) internal _nonces;
    // Storage gap: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
    uint256[10] __gap_EIP2612;

    /**
     * @notice Nonces for permit
     * @param owner Token owner's address
     * @return Next nonce
     */
    function nonces(address owner) external view returns (uint256) {
        return _nonces[owner];
    }

    /**
     * @notice Update allowance with a signed permit
     * @param owner     Token owner's address (Authorizer)
     * @param spender   Spender's address
     * @param value     Amount of allowance
     * @param deadline  The time at which this expires (unix time)
     * @param v         v of the signature
     * @param r         r of the signature
     * @param s         s of the signature
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused isNonZeroAddress(owner) isNonZeroAddress(spender) {
        bytes memory signature = abi.encodePacked(r, s, v);
        _permit(owner, spender, value, deadline, signature);
    }

    /**
     * @notice Update allowance with a signed permit
     * @param owner     Token owner's address (Authorizer)
     * @param spender   Spender's address
     * @param value     Amount of allowance
     * @param deadline  The time at which this expires (unix time)
     * @param signature Unstructured bytes signature signed by an EOA wallet or a contract wallet
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes memory signature
    ) external whenNotPaused isNonZeroAddress(owner) isNonZeroAddress(spender) {
        _permit(owner, spender, value, deadline, signature);
    }

    /**
     * @dev Internal function to execute a permit with a signed authorization using bytes signature
     * @param owner     Token owner's address (Authorizer)
     * @param spender   Spender's address
     * @param value     Amount of allowance
     * @param deadline  The time at which this expires (unix time)
     * @param signature Signature byte array produced by an EOA wallet or a contract wallet
     */
    function _permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes memory signature
    ) internal {
        if (deadline < block.timestamp) revert PermitExpired();
        if (_isAddrFrozen(spender) || _isAddrFrozen(owner)) revert AddressFrozen();

        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _nonces[owner]++, deadline))
        ));

        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidSignature();

        _approve(owner, spender, value);
    }

    /**
     * @notice Cancel one or more pending permits
     * @dev This function increments the caller's nonce by the specified count,
     * effectively invalidating all permits signed with nonces from the current
     * nonce up to (current + count - 1).
     *
     * Provides a mechanism to cancel pending EIP-2612 permits before expiry.
     *
     * @param count Number of permits to cancel (must be > 0 and <= MAX_NONCE_INCREMENT)
     *
     * Example:
     * - Current nonce: 5
     * - Call cancelPermits(3)
     * - New nonce: 8
     * - Canceled permits: those signed with nonces 5, 6, and 7
     */
    function cancelPermits(uint256 count) external whenNotPaused {
        if (_isAddrFrozen(msg.sender)) revert AddressFrozen();
        if (count == 0 || count > MAX_NONCE_INCREMENT) revert InvalidNonceCount();

        _nonces[msg.sender] += count;
        emit PermitInvalidated(msg.sender, _nonces[msg.sender]);
    }
}
