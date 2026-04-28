// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ClaimableRewardsBase } from "../ClaimableRewardsBase.sol";
import { EIP2612Definitions } from "../lib/EIP2612Definitions.sol";
import { EIP3009Definitions } from "../lib/EIP3009Definitions.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title TokenExtensionsFacet
 * @dev Diamond facet providing EIP-2612 (Permit) and EIP-3009 (Transfer with Authorization) functionality
 * @notice This facet extends the token with meta-transaction capabilities via EIP-712 signatures
 *
 * @dev STORAGE: All storage variables inherited from ClaimableRewardsStorageV3 for shared access:
 *      - _nonces: EIP-2612 permit nonces
 *      - _authorizationStates: EIP-3009 authorization tracking
 *
 * @dev DEPLOYMENT: This facet IS registered and functional via diamond proxy delegatecall.
 *      Storage is shared with main contract through ClaimableRewardsStorageV3 inheritance.
 *
 * EIP-2612 Functions:
 * - permit: Update allowance with a signed permit
 * - nonces: Get permit nonce for an address
 * - cancelPermits: Invalidate pending permits by incrementing nonce
 *
 * EIP-3009 Functions:
 * - transferWithAuthorization: Execute transfer with signature
 * - transferWithAuthorizationBatch: Execute multiple transfers with signatures
 * - receiveWithAuthorization: Receive transfer with signature (payee must be caller)
 * - cancelAuthorization: Cancel a pending authorization
 * - authorizationState: Check if authorization nonce has been used
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract TokenExtensionsFacet is ClaimableRewardsBase, EIP2612Definitions, EIP3009Definitions {
    // Storage inherited from ClaimableRewardsStorageV3:
    // - mapping(address => uint256) internal _nonces;
    // - mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;

    // NOTE: EIP-2612 and EIP-3009 constants, errors, and events inherited from EIP2612Definitions and EIP3009Definitions
    // NOTE: Approval event inherited from ClaimableRewardsBase
    // NOTE: Additional inherited errors from ClaimableRewardsBase: AddressFrozen, InsufficientFunds
    // NOTE: Additional inherited errors from PaxosBaseAbstract (via ClaimableRewardsBase): InvalidSignature, ContractPaused, ZeroAddress, ArgumentLengthMismatch

    /**
     * @notice Returns the token name for EIP-712 domain
     * @return The token name
     */
    function name() public view virtual override returns (string memory) {
        return "Global Dollar";
    }

    // ============ EIP-2612 PERMIT FUNCTIONS ============

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
    ) external {
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
    ) external {
        _permit(owner, spender, value, deadline, signature);
    }


    /**
     * @notice Invalidate one or more pending permits by incrementing the caller's nonce
     * @dev Increments the caller's nonce by `count`, invalidating any permits signed with nonces < new nonce
     * @param count Number of nonces to invalidate (must be > 0 and <= MAX_NONCE_INCREMENT)
     *
     * Example: If current nonce is 5 and count is 3:
     * - New nonce: 8
     * - Canceled permits: those signed with nonces 5, 6, and 7
     */
    function cancelPermits(uint256 count) external {
        if (globalTransferSettings.paused) revert ContractPaused();
        if (_isFrozen(msg.sender)) revert AddressFrozen();
        if (count == 0 || count > MAX_NONCE_INCREMENT) revert InvalidNonceCount();

        _nonces[msg.sender] += count;
        emit PermitInvalidated(msg.sender, _nonces[msg.sender]);
    }

    // ============ EIP-3009 TRANSFER WITH AUTHORIZATION FUNCTIONS ============

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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
        if (
            to.length != from.length ||
                value.length != from.length ||
                validAfter.length != from.length ||
                validBefore.length != from.length ||
                nonce.length != from.length ||
                v.length != from.length ||
                r.length != from.length ||
                s.length != from.length
        ) revert ArgumentLengthMismatch();

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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
        if (
            to.length != from.length ||
                value.length != from.length ||
                validAfter.length != from.length ||
                validBefore.length != from.length ||
                nonce.length != from.length ||
                signature.length != from.length
        ) revert ArgumentLengthMismatch();

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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
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
    ) external {
        if (globalTransferSettings.paused) revert ContractPaused();
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
    ) external {
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
    ) external {
        _cancelAuthorization(authorizer, nonce, signature);
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
        if (globalTransferSettings.paused) revert ContractPaused();
        if (owner == address(0)) revert ZeroAddress();
        if (spender == address(0)) revert ZeroAddress();
        if (deadline < block.timestamp) revert PermitExpired();
        if (_isFrozen(spender) || _isFrozen(owner)) revert AddressFrozen();

        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, _nonces[owner]++, deadline))
        ));

        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidSignature();

        allowed[owner][spender] = value;
        emit Approval(owner, spender, value);
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
        if (globalTransferSettings.paused) revert ContractPaused();
        if (_isFrozen(authorizer)) revert AddressFrozen();
        if (_authorizationStates[authorizer][nonce]) {
            emit AuthorizationAlreadyUsed(authorizer, nonce);
            return;
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
            return;
        }

        bytes32 digest = keccak256(abi.encodePacked(
            EIP712_VERSION_PREFIX,
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce))
        ));

        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        // Execute transfer directly - no callback needed
        // _transfer() is inherited from ClaimableRewardsBase (shared logic)
        // No external call needed - executes in same delegatecall context with shared storage
        _transfer(from, to, value);
    }
}
