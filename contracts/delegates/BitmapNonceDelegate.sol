// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "../lib/EIP712.sol";
import {ECRecover} from "../lib/ECRecover.sol";

/**
 * @title BitmapNonceDelegate
 * @notice EIP-7702 delegate for ERC-7821 batch execution with unordered nonce replay protection.
 * @dev One EIP-712 signature authorizes an ordered batch of intents. Each intent binds its own
 *      bitmap nonce to one call; regrouping requires a new batch signature but keeps those nonces.
 *      The self mode is an atomic ERC-7821 Call[] executor without bitmap nonces. Signed batches
 *      select all-or-nothing or continue-on-failure execution. Strict failure rolls back every
 *      nonce write; tolerant execution consumes the nonce of each attempted intent, even on failure.
 *      Domain separation uses the live chain and delegated EOA; the ERC-7201 bitmap persists across
 *      implementation changes. Each signed intent packs its target and gas limit into one word.
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract BitmapNonceDelegate {
    /// @dev A single unit of work in a batch. `value` with empty `data` is a native send;
    ///      `value == 0` with encoded `data` is an ERC-20 (or arbitrary) call. No special-casing.
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @dev A replay-protected work item. Nonces must remain stable when re-signing a different batch.
    ///      `targetAndGasLimit` packs the target in bits 0..159 and the gas limit in bits 160..223.
    ///      Zero gas forwards zero gas, plus the ETH stipend.
    struct PackedIntent {
        uint256 targetAndGasLimit;
        uint256 value;
        bytes data;
        uint256 nonce;
    }

    /// @dev Timing, failure policy and gas reserve. The signed EIP-712 Batch also contains Intent[] intents.
    struct BatchMetadata {
        // Executable only while `validAfter < block.timestamp < validBefore`.
        uint256 validAfter;
        uint256 validBefore;
        // true reverts the batch on any failed call; false emits CallFailed and continues.
        bool revertOnFailure;
        // CALL overhead and reply handling allowance for each intent.
        uint64 gasReserve;
    }

    error InvalidSigner();
    error NonceUsed();
    error NotYetValid();
    error Expired();
    error Unauthorized();
    error SelfCallForbidden();
    error UnsupportedExecutionMode();
    error InvalidIntent();
    error InsufficientGas();
    error ReturnDataTooLarge();
    error CallReverted(uint256 nonce, bytes returnData);
    error ExecuteError(uint256 index, bytes error);

    /// @dev A retained log identifies an accepted batch, not success of every inner call.
    event BatchExecuted(bytes32 indexed digest);
    event AuthorizationCanceled(uint256 indexed nonce);
    /// @dev Identifies failed work and its signed batch, including across nested execution.
    event CallFailed(bytes32 indexed batchDigest, uint256 indexed nonce, bytes returnData);

    /// @custom:storage-location erc7201:paxos.storage.BitmapNonceDelegate
    struct Layout {
        // wordPos => 256-bit bitmap of consumed nonces
        mapping(uint256 => uint256) nonces;
    }

    // keccak256(abi.encode(uint256(keccak256("paxos.storage.BitmapNonceDelegate")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _STORAGE_SLOT = 0xc2fc9e42e177dd235e6ad0b26b77e6d7fcb28ef74343e397cf478f9d3c408000;

    /// @notice ERC-7821 batch mode, revert-on-failure, no `opData`: the self path.
    ///         `executionData` is `abi.encode(Call[])`.
    bytes32 public constant MODE_BATCH = 0x0100000000000000000000000000000000000000000000000000000000000000;
    /// @notice Custom signed batch mode (selector 0x50415801): abi.encode(PackedIntent[], opData),
    ///         where opData is abi.encode(BatchMetadata, signature). The standard ERC-7821 Call[] signed
    ///         mode is not advertised because this payload includes per-intent nonces.
    bytes32 public constant MODE_SIGNED_BATCH = 0x0100000000005041580100000000000000000000000000000000000000000000;

    string private constant _NAME = "BitmapNonceDelegate";
    // Bump on every new implementation. The EIP-712 domain binds `_VERSION`, so incrementing it on
    // re-delegation ensures a batch (or cancel) signed for a prior implementation cannot replay on
    // the new one — even though the ERC-7201 nonce bitmap persists in the account's storage.
    string private constant _VERSION = "1";

    bytes32 private constant _INTENT_TYPEHASH =
        keccak256("Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)");
    bytes32 private constant _BATCH_TYPEHASH = keccak256(
        "Batch(Intent[] intents,uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)"
    );
    bytes32 private constant _CANCEL_TYPEHASH = keccak256("CancelAuthorization(uint256 nonce)");

    /// @dev Cap on the return data copied from each inner call. A call target can return arbitrarily
    ///      large data; without a bound, copying it inflates memory-expansion gas and could OOG the
    ///      batch — which would let one malicious recipient defeat `revertOnFailure == false` isolation for the
    ///      rest of the batch. 256 bytes accommodates `Panic(uint256)` and short `Error(string)`
    ///      reasons. Larger replies are replaced with {ReturnDataTooLarge} and are not copied.
    uint256 private constant _MAX_RETURNDATA = 256;

    /// @notice Accept native ETH for value-bearing calls from the delegated EOA.
    receive() external payable {}

    /// @notice Accept unrecognized calls, with or without ETH, like an EOA.
    fallback() external payable {}

    /**
     * @notice Execute an atomic self multicall or a batch of signed intents.
     * @param mode MODE_BATCH for ERC-7821 self execution, MODE_SIGNED_BATCH for relayed execution.
     * @param executionData abi.encode(Call[]) for self execution; abi.encode(PackedIntent[], opData)
     *        for signed execution, where opData is abi.encode(BatchMetadata, a 65-byte r,s,v signature).
     */
    function execute(bytes32 mode, bytes calldata executionData) external {
        if (mode == MODE_SIGNED_BATCH) {
            (PackedIntent[] memory intents, bytes memory opData) = abi.decode(executionData, (PackedIntent[], bytes));
            _authorizeAndExecute(intents, opData);
        } else if (mode == MODE_BATCH) {
            // Self path: the account acting on its own authority. No signature or nonce —
            // the transaction's own authorization is the authority.
            if (msg.sender != address(this)) revert Unauthorized();
            // Self path is always all-or-nothing (no signed policy to carry one).
            _executeBatch(abi.decode(executionData, (Call[])));
        } else {
            revert UnsupportedExecutionMode();
        }
    }

    /// @notice Execution-mode support advertisement.
    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        return mode == MODE_BATCH || mode == MODE_SIGNED_BATCH;
    }

    /// @dev Reserve every ID before the first call. An enclosing revert rolls back every nonce write,
    ///      log, and call effect; a completed tolerant batch consumes failed attempts' IDs too.
    ///      NonceUsed is fatal in both policies. Callbacks cannot consume this batch's later IDs. Batch-level
    ///      signing binds membership/order while amortizing verification over per-intent replay IDs.
    function _authorizeAndExecute(PackedIntent[] memory intents, bytes memory opData) private {
        (BatchMetadata memory metadata, bytes memory sig) = abi.decode(opData, (BatchMetadata, bytes));
        uint256 gasReserve = metadata.gasReserve;

        if (block.timestamp <= metadata.validAfter) revert NotYetValid();
        if (block.timestamp >= metadata.validBefore) revert Expired();

        bytes32 digest = _hashTypedData(_hashBatch(metadata, intents));
        // ECRecover rejects malleable (high-s) and zero-address recoveries, so binding to the
        // account's own key is sufficient. Under 7702 `address(this)` is the authority EOA.
        if (_recover(digest, sig) != address(this)) revert InvalidSigner();

        _validateAndReserveIntents(_layout(), intents);
        emit BatchExecuted(digest);

        for (uint256 i; i < intents.length; ++i) {
            PackedIntent memory intent = intents[i];
            (bool ok, bytes memory ret) = _callTarget(intent.targetAndGasLimit, intent.value, intent.data, gasReserve);
            if (!ok) {
                if (metadata.revertOnFailure) revert CallReverted(intent.nonce, ret);
                emit CallFailed(digest, intent.nonce, ret);
            }
        }
    }

    /**
     * @notice Cancel an unconsumed nonce so its intent can never execute — the signed-cancel
     *         analogue of EIP-3009's `cancelAuthorization` (§3009). Authorized by the account's own
     *         key and relayer-submittable, exactly like an intent. Reverts `NonceUsed` if the nonce
     *         is already consumed (the intent was attempted in a completed batch) or already
     *         cancelled. Cancellation can only burn an unused bit; it cannot clear a set bit.
     * @param nonce The bitmap position to burn.
     * @param signature A 65-byte `(r, s, v)` signature from the account over the CancelAuthorization.
     */
    function cancelAuthorization(uint256 nonce, bytes calldata signature) external {
        bytes32 digest = _hashTypedData(keccak256(abi.encode(_CANCEL_TYPEHASH, nonce)));
        if (_recover(digest, signature) != address(this)) revert InvalidSigner();
        _useNonce(_layout(), nonce);
        emit AuthorizationCanceled(nonce);
    }

    /// @notice Whether a nonce has been consumed.
    function isNonceUsed(uint256 nonce) external view returns (bool) {
        (uint256 wordPos, uint256 mask) = _noncePosition(nonce);
        return _layout().nonces[wordPos] & mask != 0;
    }

    /// @notice The EIP-712 domain separator, recomputed from the live account and chain. Under
    ///         7702 `address(this)` is the authority EOA.
    function domainSeparator() external view returns (bytes32) {
        return EIP712._makeDomainSeparator(_NAME, _VERSION);
    }

    /// @notice EIP-712 digest authorizing the complete ordered batch, including every intent ID.
    function hashBatch(BatchMetadata memory metadata, PackedIntent[] memory intents) external view returns (bytes32) {
        return _hashTypedData(_hashBatch(metadata, intents));
    }

    /// @notice The EIP-712 digest the account must sign to cancel `nonce`. Exposed for off-chain signers.
    function hashCancelAuthorization(uint256 nonce) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(_CANCEL_TYPEHASH, nonce)));
    }

    /// @dev Self execution is atomic; failures include the call index.
    function _executeBatch(Call[] memory calls) private {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = _call(calls[i]);
            if (!ok) revert ExecuteError(i, ret);
        }
    }

    /// @dev A single inner call, copying at most {_MAX_RETURNDATA} bytes of return data (see the
    ///      constant for why the cap matters). Raw `call` — never `transfer`/`send` — so the
    ///      2,300-gas stipend can't break contract recipients and native sends to code-less EOAs
    ///      are not rejected.
    function _call(Call memory c) private returns (bool ok, bytes memory ret) {
        assembly {
            // Call memory layout: to, value, data pointer.
            let data := mload(add(c, 0x40))
            ok := call(gas(), mload(c), mload(add(c, 0x20)), add(data, 0x20), mload(data), 0, 0)
        }
        ret = _failureData(ok);
    }

    function _callTarget(uint256 targetAndGasLimit, uint256 value, bytes memory data, uint256 gasReserve)
        private
        returns (bool ok, bytes memory ret)
    {
        assembly {
            let to := and(targetAndGasLimit, 0xffffffffffffffffffffffffffffffffffffffff)
            let gasLimit := and(shr(160, targetAndGasLimit), 0xffffffffffffffff)
            if lt(gas(), add(add(gasLimit, div(gasLimit, 63)), gasReserve)) {
                mstore(0, shl(224, 0x1c26714c)) // InsufficientGas()
                revert(0, 4)
            }
            ok := call(gasLimit, to, value, add(data, 0x20), mload(data), 0, 0)
        }
        ret = _failureData(ok);
    }

    /// @dev Successful return data is unused; only failures need a buffer.
    function _failureData(bool ok) private pure returns (bytes memory ret) {
        assembly {
            ret := 0x60
            if iszero(ok) {
                let size := returndatasize()
                ret := mload(0x40)
                let n := size
                if gt(size, _MAX_RETURNDATA) {
                    n := 0
                    size := 4
                    mstore(add(ret, 0x20), shl(224, 0xa644c3eb)) // ReturnDataTooLarge()
                }
                mstore(ret, size)
                returndatacopy(add(ret, 0x20), 0, n)
                // Allocate only the bounded failure data.
                mstore(0x40, add(add(ret, 0x20), and(add(size, 0x1f), not(0x1f))))
            }
        }
    }

    /// @dev Consume a nonce; revert if already set. A gap (unset bit) is permanent, costs nothing,
    ///      and blocks nothing. Duplicate submission reverts rather than silently no-oping so relayer
    ///      retry logic cannot mask a bug.
    function _useNonce(Layout storage $, uint256 nonce) private {
        (uint256 wordPos, uint256 mask) = _noncePosition(nonce);
        uint256 word = $.nonces[wordPos];
        if (word & mask != 0) revert NonceUsed();
        $.nonces[wordPos] = word | mask;
    }

    /// @dev Reject signed calls to this account so they cannot enter self mode and bypass signed-mode checks.
    ///      Reject signed self-calls and invalid IDs before any target runs. Pending bits also
    ///      reject duplicates; every cached word is flushed before callbacks can modify storage.
    function _validateAndReserveIntents(Layout storage $, PackedIntent[] memory intents) private {
        if (intents.length == 0) revert InvalidIntent();
        if (intents.length == 1) {
            PackedIntent memory intent = intents[0];
            if (address(uint160(intent.targetAndGasLimit)) == address(this)) revert SelfCallForbidden();
            _useNonce($, intent.nonce);
            return;
        }
        uint256 wordPos = intents[0].nonce >> 8;
        uint256 word = $.nonces[wordPos];
        for (uint256 i; i < intents.length; ++i) {
            PackedIntent memory intent = intents[i];
            if (address(uint160(intent.targetAndGasLimit)) == address(this)) revert SelfCallForbidden();
            (uint256 nextWordPos, uint256 mask) = _noncePosition(intent.nonce);
            if (nextWordPos != wordPos) {
                $.nonces[wordPos] = word;
                wordPos = nextWordPos;
                word = $.nonces[wordPos];
            }
            if (word & mask != 0) revert NonceUsed();
            word |= mask;
        }
        $.nonces[wordPos] = word;
    }

    /// @dev Split a nonce into its (word, bit-mask) bitmap coordinates.
    function _noncePosition(uint256 nonce) private pure returns (uint256 wordPos, uint256 mask) {
        wordPos = nonce >> 8;
        mask = 1 << (nonce & 0xff);
    }

    /// @dev EIP-712 `\x19\x01` typed-data digest over the recomputed domain.
    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", EIP712._makeDomainSeparator(_NAME, _VERSION), structHash));
    }

    /// @dev EIP-712 Batch hash, binding the full `intents[]` array.
    function _hashBatch(BatchMetadata memory metadata, PackedIntent[] memory intents) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _BATCH_TYPEHASH,
                _hashIntents(intents),
                metadata.validAfter,
                metadata.validBefore,
                metadata.revertOnFailure,
                metadata.gasReserve
            )
        );
    }

    /// @dev EIP-712 array hash of `intents`. A `bytes32[]` stores its elements as contiguous words,
    ///      so its data region can be hashed without another memory copy.
    function _hashIntents(PackedIntent[] memory intents) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](intents.length);
        for (uint256 i; i < intents.length; ++i) {
            PackedIntent memory intent = intents[i];
            if (intent.targetAndGasLimit >> 224 != 0) revert InvalidIntent();
            hashes[i] = keccak256(
                abi.encode(
                    _INTENT_TYPEHASH,
                    address(uint160(intent.targetAndGasLimit)),
                    uint64(intent.targetAndGasLimit >> 160),
                    intent.value,
                    keccak256(intent.data),
                    intent.nonce
                )
            );
        }
        bytes32 result;
        assembly {
            result := keccak256(add(hashes, 0x20), mul(mload(hashes), 0x20))
        }
        return result;
    }

    /// @dev Recover the signer from a 65-byte `(r, s, v)` signature.
    function _recover(bytes32 digest, bytes memory sig) private pure returns (address) {
        if (sig.length != 65) revert InvalidSigner();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ECRecover.recover(digest, v, r, s);
    }

    function _layout() private pure returns (Layout storage $) {
        assembly {
            $.slot := _STORAGE_SLOT
        }
    }

    /// @notice Accept an ERC-721 safe transfer. The account takes custody and does nothing else.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    /// @notice Accept an ERC-1155 safe transfer of one token id.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    /// @notice Accept an ERC-1155 safe transfer of several token ids.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    /// @notice ERC-165: ERC-165, ERC-721 receiver, ERC-1155 receiver, and ERC-1271.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0
            || interfaceId == 0x1626ba7e;
    }

    /// @notice ERC-1271: accept a signature by the account's own key.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _recover(hash, signature) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
