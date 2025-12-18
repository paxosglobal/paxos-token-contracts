// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { PaxosBaseAbstract } from "./PaxosBaseAbstract.sol";
import { EIP712Domain } from "./EIP712Domain.sol";
import { EIP3009Definitions } from "./EIP3009Definitions.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title EIP3009 contract
 * @dev An abstract contract to provide EIP3009 functionality.
 * @notice These functions do not prevent replay attacks when an initial
 * transaction fails. If conditions change, such as the contract going
 * from paused to unpaused, an external observer can reuse the data from the
 * failed transaction to execute it later.
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract EIP3009 is PaxosBaseAbstract, EIP712Domain, EIP3009Definitions {
    /**
     * @dev authorizer address => nonce => state (true = used / false = unused)
     */
    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;

    // Storage gap: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
    uint256[10] __gap_EIP3009;

    /**
     * @notice Returns the state of an authorization
     * @dev Nonces are randomly generated 32-byte data unique to the authorizer's
     * address
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @return True if the nonce is used
     */
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /**
     * @notice Execute a transfer with a signed authorization
     * @param from          Payer's address (Authorizer)
     * @param to            Payee's address
     * @param value         Amount to be transferred
     * @param validAfter    The time after which this is valid (unix time)
     * @param validBefore   The time before which this is valid (unix time)
     * @param nonce         Unique nonce
     * @param v             v of the signature
     * @param r             r of the signature
     * @param s             s of the signature
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        bytes memory signature = abi.encodePacked(r, s, v);
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );
    }

    /**
     * @notice Execute a transfer with a signed authorization
     * @param from          Payer's address (Authorizer)
     * @param to            Payee's address
     * @param value         Amount to be transferred
     * @param validAfter    The time after which this is valid (unix time)
     * @param validBefore   The time before which this is valid (unix time)
     * @param nonce         Unique nonce
     * @param signature     Unstructured bytes signature signed by an EOA wallet or a contract wallet
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );
    }

    /**
     * @notice Execute multiple transfers with signed authorizations
     * @param from          Array of Payer's addresses (Authorizers)
     * @param to            Array of Payee's addresses
     * @param value         Array of amounts to be transferred
     * @param validAfter    Array of times after which this is valid (unix time)
     * @param validBefore   Array of times before which this is valid (unix time)
     * @param nonce         Array of unique nonces
     * @param v             Array of v values of the signatures
     * @param r             Array of r values of the signatures
     * @param s             Array of s values of the signatures
     */
    function transferWithAuthorizationBatch(
        address[] memory from,
        address[] memory to,
        uint256[] memory value,
        uint256[] memory validAfter,
        uint256[] memory validBefore,
        bytes32[] memory nonce,
        uint8[] memory v,
        bytes32[] memory r,
        bytes32[] memory s
    ) external whenNotPaused {
        // Validate length of each parameter with "from" argument to make sure lengths of all input arguments are the same.
        if (
            !(to.length == from.length &&
                value.length == from.length &&
                validAfter.length == from.length &&
                validBefore.length == from.length &&
                nonce.length == from.length &&
                v.length == from.length &&
                r.length == from.length &&
                s.length == from.length)
        ) {
            revert ArgumentLengthMismatch();
        }

        for (uint16 i = 0; i < from.length; i++) {
            bytes memory signature = abi.encodePacked(r[i], s[i], v[i]);
            _transferWithAuthorization(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from[i],
                to[i],
                value[i],
                validAfter[i],
                validBefore[i],
                nonce[i],
                signature
            );
        }
    }

    /**
     * @notice Execute multiple transfers with signed authorizations (bytes signature version)
     * @param from          Array of Payer's addresses (Authorizers)
     * @param to            Array of Payee's addresses
     * @param value         Array of amounts to be transferred
     * @param validAfter    Array of times after which this is valid (unix time)
     * @param validBefore   Array of times before which this is valid (unix time)
     * @param nonce         Array of unique nonces
     * @param signature     Array of packed signatures (bytes format)
     */
    function transferWithAuthorizationBatch(
        address[] memory from,
        address[] memory to,
        uint256[] memory value,
        uint256[] memory validAfter,
        uint256[] memory validBefore,
        bytes32[] memory nonce,
        bytes[] memory signature
    ) external whenNotPaused {
        // Validate length of each parameter with "from" argument to make sure lengths of all input arguments are the same.
        if (
            !(to.length == from.length &&
                value.length == from.length &&
                validAfter.length == from.length &&
                validBefore.length == from.length &&
                nonce.length == from.length &&
                signature.length == from.length)
        ) {
            revert ArgumentLengthMismatch();
        }

        for (uint16 i = 0; i < from.length; i++) {
            _transferWithAuthorization(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from[i],
                to[i],
                value[i],
                validAfter[i],
                validBefore[i],
                nonce[i],
                signature[i]
            );
        }
    }

    /**
     * @notice Receive a transfer with a signed authorization from the payer
     * @dev This has an additional check to ensure that the payee's address matches
     * the caller of this function to prevent front-running attacks. (See security
     * considerations)
     * @param from          Payer's address (Authorizer)
     * @param to            Payee's address
     * @param value         Amount to be transferred
     * @param validAfter    The time after which this is valid (unix time)
     * @param validBefore   The time before which this is valid (unix time)
     * @param nonce         Unique nonce
     * @param v             v of the signature
     * @param r             r of the signature
     * @param s             s of the signature
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        if (to != msg.sender) revert CallerMustBePayee();

        bytes memory signature = abi.encodePacked(r, s, v);
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );
    }

    /**
     * @notice Receive a transfer with a signed authorization from the payer
     * @dev This has an additional check to ensure that the payee's address matches
     * the caller of this function to prevent front-running attacks. (See security
     * considerations)
     * @param from          Payer's address (Authorizer)
     * @param to            Payee's address
     * @param value         Amount to be transferred
     * @param validAfter    The time after which this is valid (unix time)
     * @param validBefore   The time before which this is valid (unix time)
     * @param nonce         Unique nonce
     * @param signature     Unstructured bytes signature signed by an EOA wallet or a contract wallet
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused {
        if (to != msg.sender) revert CallerMustBePayee();

        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            from,
            to,
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );
    }

    /**
     * @notice Attempt to cancel an authorization
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @param v             v of the signature
     * @param r             r of the signature
     * @param s             s of the signature
     */
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        bytes memory signature = abi.encodePacked(r, s, v);
        _cancelAuthorization(authorizer, nonce, signature);
    }

    /**
     * @notice Attempt to cancel an authorization
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @param signature     Unstructured bytes signature signed by an EOA wallet or a contract wallet
     */
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        bytes memory signature
    ) external whenNotPaused {
        _cancelAuthorization(authorizer, nonce, signature);
    }

    /**
     * @dev Internal function to cancel an authorization using bytes signature
     * @param authorizer    Authorizer's address
     * @param nonce         Nonce of the authorization
     * @param signature     Packed signature bytes
     */
    function _cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (_isAddrFrozen(authorizer)) revert AddressFrozen();
        if (_authorizationStates[authorizer][nonce]) {
            emit AuthorizationAlreadyUsed(authorizer, nonce);
            return; //Return instead of throwing an error to prevent front running from blocking complex txs
        }

        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce))
        ));

        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) revert InvalidSignature();

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }


    /*
     * @dev Internal function to execute a single transfer with a signed authorization using bytes signature
     * @param typeHash      The typehash of transfer or receive.
     * @param from          Payer's address (Authorizer)
     * @param to            Payee's address
     * @param value         Amount to be transferred
     * @param validAfter    The time after which this is valid (unix time)
     * @param validBefore   The time before which this is valid (unix time)
     * @param nonce         Unique nonce
     * @param signature     Signature byte array produced by an EOA wallet or a contract wallet
     */
    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationInvalid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();

        if (_authorizationStates[from][nonce]) {
            emit AuthorizationAlreadyUsed(from, nonce);
            return; //Return instead of throwing an error to prevent front running from blocking batches
        }

        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce))
        ));

        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }
}
