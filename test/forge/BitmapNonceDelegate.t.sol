// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "lib/forge-std/src/Test.sol";
import {Vm, VmSafe} from "lib/forge-std/src/Vm.sol";
import {MockERC20} from "lib/forge-std/src/mocks/MockERC20.sol";
import {MockERC721} from "lib/forge-std/src/mocks/MockERC721.sol";
import {BitmapNonceDelegate} from "../../contracts/delegates/BitmapNonceDelegate.sol";

/// @dev A call target that reverts with an oversized reason (64 KiB), to exercise the
///      return-data bound in `BitmapNonceDelegate._call`.
contract ReturnBomb {
    fallback() external payable {
        assembly {
            revert(0, 0x10000)
        }
    }
}

contract ReturnDataTarget {
    function reply(bytes memory data, bool fails) external pure {
        assembly {
            if fails { revert(add(data, 0x20), mload(data)) }
            return(add(data, 0x20), mload(data))
        }
    }
}

contract CallInputTarget {
    bytes32 public dataHash;
    address public sender;

    fallback() external payable {
        dataHash = keccak256(msg.data);
        sender = msg.sender;
    }
}

contract TokenReturnTarget {
    mapping(address => uint256) public balanceOf;
    uint256 internal immutable response;

    constructor(address owner, uint256 response_) {
        balanceOf[owner] = 10;
        response = response_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (response == 0) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (response == 2) {
            assembly { return(0, 0) }
        }
        return true;
    }
}

contract GasBurner {
    fallback() external payable {
        while (true) {}
    }
}

/// @dev Burns its allowance, then reverts with a 256-byte reply: the most expensive copied failure.
contract ReplyBurner {
    fallback() external payable {
        while (gasleft() > 400) {}
        assembly {
            revert(0, 0x100)
        }
    }
}

/// @dev Burns `cost` gas, then records success in slot 0. Starved, it runs out of gas.
contract GasWorker {
    uint256 internal immutable cost;

    constructor(uint256 cost_) {
        cost = cost_;
    }

    fallback() external payable {
        uint256 start = gasleft();
        while (start - gasleft() < cost) {}
        assembly {
            sstore(0, 1)
        }
    }
}

/// @dev Calls `inner` with all its gas; a failed inner call reverts this target too unless `swallow` is set.
contract GasForwarder {
    address internal immutable inner;
    bool internal immutable swallow;

    constructor(address inner_, bool swallow_) {
        inner = inner_;
        swallow = swallow_;
    }

    fallback() external payable {
        (bool ok,) = inner.call("");
        if (!ok && !swallow) revert();
    }
}

/// @dev Gives up without burning gas when it receives less than `threshold`.
contract GasChecker {
    uint256 internal immutable threshold;
    uint256 internal immutable cost;

    constructor(uint256 threshold_, uint256 cost_) {
        threshold = threshold_;
        cost = cost_;
    }

    fallback() external payable {
        if (gasleft() < threshold) revert();
        uint256 start = gasleft();
        while (start - gasleft() < cost) {}
        assembly {
            sstore(0, 1)
        }
    }
}

contract TransferableERC721 is MockERC721 {
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

interface IERC1155ReceiverProbe {
    function onERC1155Received(address operator, address from, uint256 id, uint256 amount, bytes calldata data)
        external
        returns (bytes4);
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external returns (bytes4);
}

/// @dev Performs the ERC-1155 receiver check and nothing else.
contract MinimalERC1155 {
    function safeTransfer(address from, address to, uint256 id, uint256 amount) external {
        require(to.code.length > 0, "not a contract");
        require(
            IERC1155ReceiverProbe(to).onERC1155Received(msg.sender, from, id, amount, "")
                == IERC1155ReceiverProbe.onERC1155Received.selector,
            "rejected"
        );
    }

    function safeBatchTransfer(address from, address to, uint256[] calldata ids, uint256[] calldata amounts) external {
        require(to.code.length > 0, "not a contract");
        require(
            IERC1155ReceiverProbe(to).onERC1155BatchReceived(msg.sender, from, ids, amounts, "")
                == IERC1155ReceiverProbe.onERC1155BatchReceived.selector,
            "rejected"
        );
    }
}

contract ReentrantTarget {
    address internal delegate;
    bytes32 internal mode;
    bytes internal executionData;

    bool public reentrySucceeded;
    bytes4 public reentryError;

    function configure(address delegate_, bytes32 mode_, bytes calldata executionData_) external {
        delegate = delegate_;
        mode = mode_;
        executionData = executionData_;
    }

    function reenter() external {
        (bool ok, bytes memory returnData) =
            delegate.call(abi.encodeWithSignature("execute(bytes32,bytes)", mode, executionData));
        reentrySucceeded = ok;
        if (returnData.length >= 4) {
            bytes4 error;
            assembly {
                error := mload(add(returnData, 0x20))
            }
            reentryError = error;
        }
    }
}

contract BatchNonceObserver {
    bool public allReserved;
    bool public cancellationSucceeded;
    bytes4 public cancellationError;

    function observe(BitmapNonceDelegate delegate, uint256[] calldata nonces) external {
        for (uint256 i; i < nonces.length; ++i) {
            require(delegate.isNonceUsed(nonces[i]), "unreserved ID");
        }
        allReserved = true;
    }

    function cancel(BitmapNonceDelegate delegate, uint256 nonce, bytes calldata signature) external {
        (bool ok, bytes memory result) =
            address(delegate).call(abi.encodeCall(BitmapNonceDelegate.cancelAuthorization, (nonce, signature)));
        cancellationSucceeded = ok;
        if (result.length >= 4) {
            bytes4 error;
            assembly { error := mload(add(result, 0x20)) }
            cancellationError = error;
        }
    }
}

/// @dev Binding for the EIP-7702 cheatcode missing from the pinned forge-std version.
interface IVm7702 {
    function signAndAttachDelegation(address implementation, uint256 privateKey) external;
}

/// @notice Unit tests for signed-intent and self-authorized batch execution.
/// @dev Read from `delegate` before `vm.prank` or `vm.expectRevert`; those cheatcodes apply to the
///      next call.
interface IBoundaryVm {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshot) external returns (bool);
}

contract BitmapNonceDelegateTest is Test {
    // Existing call fixtures are also used by the standard self path. Signed fixtures assign
    // a distinct consecutive nonce to each call and encode production PackedIntent[] and BatchMetadata types.
    struct BatchFixture {
        uint256 validAfter;
        uint256 validBefore;
        uint256 firstNonce;
        bool revertOnFailure;
    }

    function _policy(BatchFixture memory fixture) internal pure returns (BitmapNonceDelegate.BatchMetadata memory) {
        return BitmapNonceDelegate.BatchMetadata(fixture.validAfter, fixture.validBefore, fixture.revertOnFailure, _RESERVE);
    }

    function _intents(BitmapNonceDelegate.Call[] memory calls, uint256 firstNonce)
        internal pure returns (BitmapNonceDelegate.PackedIntent[] memory intents)
    {
        return _intents(calls, firstNonce, _CAP);
    }

    function _intents(BitmapNonceDelegate.Call[] memory calls, uint256 firstNonce, uint64 gasLimit)
        internal pure returns (BitmapNonceDelegate.PackedIntent[] memory intents)
    {
        intents = new BitmapNonceDelegate.PackedIntent[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(
                _pack(calls[i].to, gasLimit), calls[i].value, calls[i].data, firstNonce + i
            );
        }
    }

    // Default cap and reserve for fixtures that do not test gas handling.
    uint64 internal constant _CAP = 200_000;
    // Cap for an intent whose target re-enters with its own signed batch.
    uint64 internal constant _NESTED_CAP = 1_000_000;
    uint64 internal constant _RESERVE = 42_000;

    function _pack(address to, uint64 gasLimit) internal pure returns (uint256) {
        return uint256(uint160(to)) | (uint256(gasLimit) << 160);
    }

    IVm7702 internal constant vm7702 = IVm7702(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    BitmapNonceDelegate internal impl;
    MockERC20 internal token;

    uint256 internal delegatedEOAPk = 0x0117B115;
    address internal delegatedEOA;
    BitmapNonceDelegate internal delegate;

    address internal relayer = address(0xBEEF);
    address internal recipient = address(0xCAFE);

    bytes32 internal MODE_OPDATA;
    bytes32 internal MODE_SELF;

    address[] internal recorders;
    address[] internal replyBurners;

    // Funding-boundary and griefing targets, also installed in `setUp` so they start cold.
    address internal fundingRecorder = address(0xABCD1234);
    // Never touched before a boundary run: reading its balance or code would warm it.
    address internal emptyAccount = address(0xABCD5678);
    address internal fundingBurner;
    address internal fundingReturnBomb;
    GasWorker internal griefWorker;
    GasForwarder internal griefForwarder;
    GasChecker internal griefChecker;

    function setUp() public {
        delegatedEOA = vm.addr(delegatedEOAPk);

        impl = new BitmapNonceDelegate();
        MODE_OPDATA = impl.MODE_SIGNED_BATCH();
        MODE_SELF = impl.MODE_BATCH();

        vm7702.signAndAttachDelegation(address(impl), delegatedEOAPk);
        delegate = BitmapNonceDelegate(payable(delegatedEOA));

        token = new MockERC20();
        token.initialize("Mock", "MOCK", 18);
        deal(address(token), delegatedEOA, 1_000_000e18);
        vm.deal(delegatedEOA, 100 ether);

        // Installed here so each test transaction reaches them cold: an account etched, created or
        // read inside a test stays warm for the rest of it, even across snapshot reverts.
        // GAS is a recorder's first opcode: it stores the actual entry gas, less its two-gas cost.
        vm.etch(fundingRecorder, hex"5a5f5500");
        fundingBurner = address(new GasBurner());
        fundingReturnBomb = address(new ReturnBomb());
        griefWorker = new GasWorker(1_000_000);
        griefForwarder = new GasForwarder(address(griefWorker), true);
        griefChecker = new GasChecker(300_000, 250_000);
        for (uint256 i; i < _BOUNDARY_INTENTS; ++i) {
            address recorder = address(uint160(0xABCD0000 + i));
            vm.etch(recorder, hex"5a5f5500");
            recorders.push(recorder);
            address burner = address(uint160(0xBCDE0000 + i));
            vm.etch(burner, type(ReplyBurner).runtimeCode);
            replyBurners.push(burner);
        }
    }

    // --------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------

    /// @dev Build the custom signed-mode `executionData` for a signed batch, signed by
    ///      the delegated EOA's key. Must be called before any prank/expectRevert (it
    ///      reads `delegate.hashBatch`).
    function _prep(BatchFixture memory fixture, BitmapNonceDelegate.Call[] memory calls)
        internal
        view
        returns (bytes memory)
    {
        return _prep(fixture, calls, _CAP);
    }

    function _prep(BatchFixture memory fixture, BitmapNonceDelegate.Call[] memory calls, uint64 gasLimit)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            _intents(calls, fixture.firstNonce, gasLimit), abi.encode(_policy(fixture), _signBatch(fixture, calls, gasLimit))
        );
    }

    function _signBatch(BatchFixture memory fixture, BitmapNonceDelegate.Call[] memory calls)
        internal
        view
        returns (bytes memory)
    {
        return _signBatch(fixture, calls, _CAP);
    }

    function _signBatch(BatchFixture memory fixture, BitmapNonceDelegate.Call[] memory calls, uint64 gasLimit)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = delegate.hashBatch(_policy(fixture), _intents(calls, fixture.firstNonce, gasLimit));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _erc20Call(address to, uint256 amount) internal view returns (BitmapNonceDelegate.Call memory) {
        return BitmapNonceDelegate.Call({
            to: address(token), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        });
    }

    function _nativeCall(address to, uint256 amount) internal pure returns (BitmapNonceDelegate.Call memory) {
        return BitmapNonceDelegate.Call({to: to, value: amount, data: ""});
    }

    function _batch(uint256 nonce) internal view returns (BatchFixture memory) {
        return BatchFixture({
            validAfter: 0, validBefore: block.timestamp + 1 hours, firstNonce: nonce, revertOnFailure: true
        });
    }

    function _batchContinueOnFailure(uint256 nonce) internal view returns (BatchFixture memory) {
        return BatchFixture({
            validAfter: 0, validBefore: block.timestamp + 1 hours, firstNonce: nonce, revertOnFailure: false
        });
    }

    function _one(BitmapNonceDelegate.Call memory c) internal pure returns (BitmapNonceDelegate.Call[] memory calls) {
        calls = new BitmapNonceDelegate.Call[](1);
        calls[0] = c;
    }

    // --------------------------------------------------------------------------
    // Happy path
    // --------------------------------------------------------------------------

    function test_executesMixedBatch() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 100e18);
        calls[1] = _nativeCall(recipient, 1 ether);
        bytes memory ed = _prep(_batch(1), calls);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        assertEq(token.balanceOf(recipient), 100e18);
        assertEq(recipient.balance, 1 ether);
        assertTrue(delegate.isNonceUsed(1));
    }

    function test_anyRelayerCanSubmit() public {
        bytes memory ed = _prep(_batch(2), _one(_erc20Call(recipient, 5e18)));

        vm.prank(address(0x1234)); // arbitrary relayer
        delegate.execute(MODE_OPDATA, ed);
        assertEq(token.balanceOf(recipient), 5e18);
    }

    function test_advertisesSelfAndCustomSignedModes() public view {
        assertTrue(delegate.supportsExecutionMode(MODE_SELF));
        assertTrue(delegate.supportsExecutionMode(MODE_OPDATA));
        assertFalse(delegate.supportsExecutionMode(bytes32(0)));
    }

    function test_modeConstantsMatchPayloadFormats() public view {
        // Only the self mode uses the standard ERC-7821 Call[] layout.
        assertEq(MODE_SELF, bytes32(0x0100000000000000000000000000000000000000000000000000000000000000));
        assertEq(MODE_OPDATA, bytes32(0x0100000000005041580100000000000000000000000000000000000000000000));

        // "Batch of batches" (…78210002…) is a distinct ERC-7821 mode we deliberately do not support.
        assertFalse(
            delegate.supportsExecutionMode(bytes32(0x0100000000007821000200000000000000000000000000000000000000000000))
        );
    }

    function test_hashBatchMatchesEip712Encoding() public view {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 3e18);
        calls[1] = _nativeCall(recipient, 1 ether);
        BatchFixture memory fixture = _batch(9);

        bytes32 callTypehash = keccak256("Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)");
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            callHashes[i] = keccak256(abi.encode(callTypehash, calls[i].to, _CAP, calls[i].value, keccak256(calls[i].data), fixture.firstNonce + i));
        }
        bytes32 intentTypehash = keccak256(
            "Batch(Intent[] intents,uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)"
        );
        bytes32 intentHash = keccak256(
            abi.encode(
                intentTypehash,
                keccak256(abi.encodePacked(callHashes)),
                fixture.validAfter,
                fixture.validBefore,
                fixture.revertOnFailure,
                _RESERVE
            )
        );
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", delegate.domainSeparator(), intentHash));

        assertEq(delegate.hashBatch(_policy(fixture), _intents(calls, fixture.firstNonce)), expected);
    }

    function test_domainSeparatorMatchesEip712Domain() public view {
        bytes32 domainTypehash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 expected = keccak256(
            abi.encode(
                domainTypehash,
                keccak256(bytes("BitmapNonceDelegate")),
                keccak256(bytes("1")),
                block.chainid,
                delegatedEOA
            )
        );

        assertEq(delegate.domainSeparator(), expected);
    }

    function test_unsupportedModeReverts() public {
        bytes memory executionData = abi.encode(_one(_erc20Call(recipient, 1e18)));
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.UnsupportedExecutionMode.selector);
        delegate.execute(bytes32(uint256(2)), executionData);
    }

    // --------------------------------------------------------------------------
    // Nonce bitmap
    // --------------------------------------------------------------------------

    function test_duplicateSubmissionReverts() public {
        bytes memory ed = _prep(_batch(7), _one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        // Second landing of the same intent must revert, never silently no-op.
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    function test_abandonedNonceDoesNotBlockOthers() public {
        // Never submit nonce 100; a lower and a higher nonce still work.
        bytes memory edLow = _prep(_batch(50), _one(_erc20Call(recipient, 1e18)));
        bytes memory edHigh = _prep(_batch(300), _one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, edLow);
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, edHigh);

        assertFalse(delegate.isNonceUsed(100));
        assertEq(token.balanceOf(recipient), 2e18);
    }

    function test_nonceBitmapWordBoundary() public {
        bytes memory ed255 = _prep(_batch(255), _one(_erc20Call(recipient, 1e18)));
        bytes memory ed256 = _prep(_batch(256), _one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed255);
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed256);

        assertTrue(delegate.isNonceUsed(255));
        assertTrue(delegate.isNonceUsed(256));
        assertEq(token.balanceOf(recipient), 2e18);
    }

    function test_nonceStorageUsesErc7201Slot() public {
        uint256 nonce = 300;
        bytes memory ed = _prep(_batch(nonce), _one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        bytes32 namespaceHash = keccak256("paxos.storage.BitmapNonceDelegate");
        bytes32 storageSlot = bytes32(uint256(keccak256(abi.encode(uint256(namespaceHash) - 1))) & ~uint256(0xff));
        bytes32 wordSlot = keccak256(abi.encode(nonce >> 8, storageSlot));
        assertEq(uint256(vm.load(delegatedEOA, wordSlot)), 1 << (nonce & 0xff));
    }

    // --------------------------------------------------------------------------
    // Authorization
    // --------------------------------------------------------------------------

    function test_validityWindowBoundsRevert() public {
        vm.warp(1_000);
        BatchFixture memory fixture = _batch(3);
        fixture.validAfter = 500;
        fixture.validBefore = 2_000;
        bytes memory ed = _prep(fixture, _one(_erc20Call(recipient, 1e18)));

        vm.warp(fixture.validAfter);
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.NotYetValid.selector);
        delegate.execute(MODE_OPDATA, ed);

        vm.warp(fixture.validBefore);
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.Expired.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    function test_wrongSignerReverts() public {
        // A signature from any key other than the account's own does not recover to
        // `address(this)`.
        uint256 otherPk = 0xB0B;
        BitmapNonceDelegate.Call[] memory calls = _one(_erc20Call(recipient, 1e18));
        BatchFixture memory fixture = _batch(5);

        bytes32 digest = delegate.hashBatch(_policy(fixture), _intents(calls, fixture.firstNonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherPk, digest);
        bytes memory ed = abi.encode(_intents(calls, fixture.firstNonce), abi.encode(_policy(fixture), abi.encodePacked(r, s, v)));

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    function test_tamperedCallsReverts() public {
        BitmapNonceDelegate.Call[] memory signedCalls = _one(_erc20Call(recipient, 1e18));
        bytes memory sig;
        {
            bytes32 digest = delegate.hashBatch(_policy(_batch(6)), _intents(signedCalls, 6));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
            sig = abi.encodePacked(r, s, v);
        }
        // Relayer swaps the amount after signing — digest no longer matches.
        BitmapNonceDelegate.Call[] memory tampered = _one(_erc20Call(recipient, 999e18));
        bytes memory ed = abi.encode(_intents(tampered, 6), abi.encode(_policy(_batch(6)), sig));

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    function test_tamperedIntentFieldsRevert() public {
        vm.warp(1_000);
        BitmapNonceDelegate.Call[] memory calls = _one(_erc20Call(recipient, 1e18));
        BatchFixture memory signedIntent =
            BatchFixture({validAfter: 500, validBefore: 2_000, firstNonce: 6, revertOnFailure: true});
        bytes memory signature = _signBatch(signedIntent, calls);

        for (uint256 i; i < 6; ++i) {
            BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, signedIntent.firstNonce);
            BitmapNonceDelegate.BatchMetadata memory metadata = _policy(signedIntent);
            if (i == 0) metadata.validAfter++;
            else if (i == 1) metadata.validBefore++;
            else if (i == 2) intents[0].nonce++;
            else if (i == 3) metadata.revertOnFailure = false;
            else if (i == 4) intents[0].targetAndGasLimit += uint256(1) << 160;
            else metadata.gasReserve++;
            bytes memory ed = abi.encode(intents, abi.encode(metadata, signature));
            vm.prank(relayer);
            vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
            delegate.execute(MODE_OPDATA, ed);
            assertFalse(delegate.isNonceUsed(signedIntent.firstNonce));
            assertFalse(delegate.isNonceUsed(intents[0].nonce));
            assertEq(token.balanceOf(recipient), 0);
        }
    }

    function test_malformedSignatureLengthReverts() public {
        BatchFixture memory fixture = _batch(7);
        BitmapNonceDelegate.Call[] memory calls = _one(_erc20Call(recipient, 1e18));
        bytes memory ed = abi.encode(_intents(calls, fixture.firstNonce), abi.encode(_policy(fixture), new bytes(64)));

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    // --------------------------------------------------------------------------
    // Self-call invariant
    // --------------------------------------------------------------------------

    function test_selfCallInSignedIntentReverts() public {
        BitmapNonceDelegate.Call[] memory nestedCalls = _one(_erc20Call(recipient, 2e18));
        bytes memory nestedData = abi.encodeCall(BitmapNonceDelegate.execute, (MODE_SELF, abi.encode(nestedCalls)));
        vm.expectCall(address(token), nestedCalls[0].data, uint64(0));
        for (uint256 policy; policy < 2; ++policy) {
            for (uint256 value; value < 2; ++value) {
                for (uint256 capped; capped < 2; ++capped) {
                    BitmapNonceDelegate.BatchMetadata memory metadata = _policy(_batch(11));
                    metadata.revertOnFailure = policy == 0;
                    BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](1);
                    intents[0] = BitmapNonceDelegate.PackedIntent(_pack(delegatedEOA, capped == 0 ? _CAP : 100_000), value, nestedData, 11);
                    bytes memory encoded = _signedBatch(metadata, intents);
                    vm.prank(relayer);
                    vm.expectRevert(BitmapNonceDelegate.SelfCallForbidden.selector);
                    delegate.execute(MODE_OPDATA, encoded);
                    assertFalse(delegate.isNonceUsed(11));
                    assertEq(token.balanceOf(recipient), 0);
                    assertEq(delegatedEOA.balance, 100 ether);
                }
            }
        }
    }

    function test_callbackReentryWithSameNonceReverts() public {
        ReentrantTarget target = new ReentrantTarget();
        BitmapNonceDelegate.Call[] memory calls = _one(
            BitmapNonceDelegate.Call({to: address(target), value: 0, data: abi.encodeCall(ReentrantTarget.reenter, ())})
        );
        bytes memory ed = _prep(_batch(12), calls);
        target.configure(address(delegate), MODE_OPDATA, ed);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        assertFalse(target.reentrySucceeded());
        assertEq(target.reentryError(), BitmapNonceDelegate.NonceUsed.selector);
        assertTrue(delegate.isNonceUsed(12));
    }

    function test_callbackReentryWithDifferentNonceSucceeds() public {
        ReentrantTarget target = new ReentrantTarget();
        bytes memory inner = _prep(_batch(13), _one(_erc20Call(recipient, 1e18)));
        target.configure(address(delegate), MODE_OPDATA, inner);

        BitmapNonceDelegate.Call[] memory calls = _one(
            BitmapNonceDelegate.Call({to: address(target), value: 0, data: abi.encodeCall(ReentrantTarget.reenter, ())})
        );
        bytes memory outer = _prep(_batch(14), calls, _NESTED_CAP);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, outer);

        assertTrue(target.reentrySucceeded());
        assertTrue(delegate.isNonceUsed(13));
        assertTrue(delegate.isNonceUsed(14));
        assertEq(token.balanceOf(recipient), 1e18);
    }

    // --------------------------------------------------------------------------
    // Cancel (EIP-3009-style signed cancel)
    // --------------------------------------------------------------------------

    function _prepCancel(uint256 nonce) internal view returns (bytes memory sig) {
        bytes32 digest = delegate.hashCancelAuthorization(nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function test_cancelBurnsNonceSoIntentCannotExecute() public {
        // Read+sign both the cancel and the same-nonce intent before any prank.
        bytes memory sig = _prepCancel(20);
        bytes memory ed = _prep(_batch(20), _one(_erc20Call(recipient, 1e18)));

        vm.expectEmit(true, false, false, false, delegatedEOA);
        emit BitmapNonceDelegate.AuthorizationCanceled(20);
        vm.prank(relayer);
        delegate.cancelAuthorization(20, sig);
        assertTrue(delegate.isNonceUsed(20));

        // The intent on the cancelled nonce can no longer execute.
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.execute(MODE_OPDATA, ed);
    }

    function test_cancelWrongSignerReverts() public {
        uint256 otherPk = 0xB0B;
        bytes32 digest = delegate.hashCancelAuthorization(21);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.cancelAuthorization(21, sig);
    }

    function test_cancelOfConsumedNonceReverts() public {
        bytes memory ed = _prep(_batch(22), _one(_erc20Call(recipient, 1e18)));
        bytes memory sig = _prepCancel(22);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        // A nonce whose intent already executed cannot be cancelled — a cancel only
        // ever burns an unused bit, never clears a set one.
        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.cancelAuthorization(22, sig);
    }

    function test_anyRelayerCanCancel() public {
        bytes memory sig = _prepCancel(23);

        vm.prank(address(0x1234));
        delegate.cancelAuthorization(23, sig);

        assertTrue(delegate.isNonceUsed(23));
    }

    // --------------------------------------------------------------------------
    // Self path
    // --------------------------------------------------------------------------

    function test_selfPathRequiresSelfCaller() public {
        bytes memory executionData = abi.encode(_one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.Unauthorized.selector);
        delegate.execute(MODE_SELF, executionData);

        // From the account itself the self path executes with no signature.
        vm.prank(delegatedEOA);
        delegate.execute(MODE_SELF, executionData);
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_selfPathExecutesMixedBatch() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 2e18);
        calls[1] = _nativeCall(recipient, 1 ether);

        vm.prank(delegatedEOA);
        delegate.execute(MODE_SELF, abi.encode(calls));

        assertEq(token.balanceOf(recipient), 2e18);
        assertEq(recipient.balance, 1 ether);
    }

    function test_selfPathRevertsAtomically() public {
        ReturnDataTarget target = new ReturnDataTarget();
        bytes memory reason = hex"deadbeef";
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = BitmapNonceDelegate.Call({
            to: address(target), value: 0, data: abi.encodeCall(ReturnDataTarget.reply, (reason, true))
        });

        vm.prank(delegatedEOA);
        vm.expectRevert(abi.encodeWithSelector(BitmapNonceDelegate.ExecuteError.selector, 0, reason));
        delegate.execute(MODE_SELF, abi.encode(_one(calls[1])));

        vm.prank(delegatedEOA);
        vm.expectRevert(abi.encodeWithSelector(BitmapNonceDelegate.ExecuteError.selector, 1, reason));
        delegate.execute(MODE_SELF, abi.encode(calls));

        assertEq(token.balanceOf(recipient), 0);
    }

    function test_selfPathAllowsSelfTarget() public {
        BitmapNonceDelegate.Call[] memory calls = _one(
            BitmapNonceDelegate.Call({
                to: delegatedEOA, value: 0, data: abi.encodeCall(BitmapNonceDelegate.supportsExecutionMode, (MODE_SELF))
            })
        );

        vm.prank(delegatedEOA);
        delegate.execute(MODE_SELF, abi.encode(calls));
    }

    // --------------------------------------------------------------------------
    // All-or-nothing batch
    // --------------------------------------------------------------------------

    function test_batchRevertsAtomically() public {
        // Second call over-spends the token balance; the whole batch must unwind,
        // including the first (valid) transfer and the nonce write.
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 10_000_000e18);
        bytes memory ed = _prep(_batch(9), calls);

        vm.prank(relayer);
        vm.expectRevert();
        delegate.execute(MODE_OPDATA, ed);

        assertEq(token.balanceOf(recipient), 0);
        assertFalse(delegate.isNonceUsed(9));
        assertFalse(delegate.isNonceUsed(10));
    }

    function test_oversizedReturnDataBoundedOnAtomicFailure() public {
        ReturnBomb bomb = new ReturnBomb();
        BitmapNonceDelegate.Call[] memory calls =
            _one(BitmapNonceDelegate.Call({to: address(bomb), value: 0, data: hex"deadbeef"}));
        bytes memory ed = _prep(_batch(10), calls);

        vm.prank(relayer);
        (bool ok, bytes memory returnData) =
            address(delegate).call(abi.encodeWithSelector(delegate.execute.selector, MODE_OPDATA, ed));

        assertFalse(ok);
        assertEq(
            returnData,
            abi.encodeWithSelector(
                BitmapNonceDelegate.CallReverted.selector,
                10,
                abi.encodeWithSelector(BitmapNonceDelegate.ReturnDataTooLarge.selector)
            )
        );
        assertFalse(delegate.isNonceUsed(10));
    }

    function test_strictTargetCannotSpoofDelegateError() public {
        ReturnDataTarget target = new ReturnDataTarget();
        bytes memory spoof = abi.encodeWithSelector(BitmapNonceDelegate.NonceUsed.selector);
        BitmapNonceDelegate.Call[] memory calls = _one(
            BitmapNonceDelegate.Call({
                to: address(target), value: 0, data: abi.encodeCall(ReturnDataTarget.reply, (spoof, true))
            })
        );

        vm.prank(relayer);
        (bool ok, bytes memory returnData) = address(delegate).call(
            abi.encodeWithSelector(delegate.execute.selector, MODE_OPDATA, _prep(_batch(11), calls))
        );

        assertFalse(ok);
        assertEq(returnData, abi.encodeWithSelector(BitmapNonceDelegate.CallReverted.selector, 11, spoof));
        assertFalse(delegate.isNonceUsed(11));
    }

    function test_returnDataBoundedAcrossModes() public {
        bytes memory reply = new bytes(256);
        for (uint256 i; i < reply.length; ++i) reply[i] = bytes1(uint8(i));
        _checkReturnDataModes(reply, true, reply);
        _checkReturnDataModes(
            new bytes(257), true, abi.encodeWithSelector(BitmapNonceDelegate.ReturnDataTooLarge.selector)
        );
        reply = abi.encodeWithSignature("Error(string)", string(new bytes(192)));
        assertEq(reply.length, 260);
        _checkReturnDataModes(reply, true, abi.encodeWithSelector(BitmapNonceDelegate.ReturnDataTooLarge.selector));
        _checkReturnDataModes("", true, "");
        _checkReturnDataModes(new bytes(257), false, "");
        _checkReturnDataModes(new bytes(65_536), false, "");
    }

    function _checkReturnDataModes(bytes memory reply, bool fails, bytes memory expected) internal {
        uint256 snapshot = IBoundaryVm(address(vm)).snapshotState();
        ReturnDataTarget target = new ReturnDataTarget();
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call({
            to: address(target), value: 0, data: abi.encodeCall(ReturnDataTarget.reply, (reply, fails))
        });
        calls[1] = _erc20Call(recipient, 1e18);

        // Both failure policies, with two caps, followed by self execution.
        for (uint256 mode; mode < 5; ++mode) {
            uint256 nonce = 500 + mode * 2;
            bytes memory executionData = mode == 4
                ? abi.encode(calls)
                : _signedBatch(
                    _policy(mode % 2 == 0 ? _batch(nonce) : _batchContinueOnFailure(nonce)),
                    _intents(calls, nonce, mode < 2 ? 100_000 : 500_000)
                );
            bytes32 executionMode = mode == 4 ? MODE_SELF : MODE_OPDATA;
            uint256 balanceBefore = token.balanceOf(recipient);

            vm.recordLogs();
            vm.prank(mode == 4 ? delegatedEOA : relayer);
            (bool ok, bytes memory result) = address(delegate).call(
                abi.encodeCall(BitmapNonceDelegate.execute, (executionMode, executionData))
            );
            Vm.Log[] memory logs = vm.getRecordedLogs();

            if (fails && mode % 2 == 0) {
                assertFalse(ok);
                // Signed failures identify the nonce; self-mode batch failures identify the index.
                assertEq(
                    result,
                    mode == 4
                        ? abi.encodeWithSelector(BitmapNonceDelegate.ExecuteError.selector, 0, expected)
                        : abi.encodeWithSelector(BitmapNonceDelegate.CallReverted.selector, nonce, expected)
                );
                assertEq(token.balanceOf(recipient), balanceBefore);
            } else {
                assertTrue(ok);
                assertEq(token.balanceOf(recipient), balanceBefore + 1e18);
                _assertReturnDataFailureLogs(logs, fails, expected, nonce);
            }
            if (mode != 4) {
                assertEq(delegate.isNonceUsed(nonce), ok);
                assertEq(delegate.isNonceUsed(nonce + 1), ok);
            }
        }
        assertTrue(IBoundaryVm(address(vm)).revertToState(snapshot));
    }

    function _assertReturnDataFailureLogs(Vm.Log[] memory logs, bool fails, bytes memory expected, uint256 nonce)
        internal
        view
    {
        uint256 failures;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == delegatedEOA && logs[i].topics[0] == BitmapNonceDelegate.CallFailed.selector) {
                assertEq(logs[i].topics.length, 3);
                assertEq(uint256(logs[i].topics[2]), nonce);
                bytes memory returnData = abi.decode(logs[i].data, (bytes));
                assertEq(returnData, expected);
                ++failures;
            }
        }
        assertEq(failures, fails ? 1 : 0);
    }

    // --------------------------------------------------------------------------
    // Batch-level failure isolation (BatchMetadata.revertOnFailure)
    // --------------------------------------------------------------------------

    function test_tokenReturnValuesDoNotTriggerFailurePolicy() public {
        for (uint256 response; response < 3; ++response) {
            for (uint256 policy; policy < 2; ++policy) {
                TokenReturnTarget target = new TokenReturnTarget(delegatedEOA, response);
                uint256 nonce = 400 + response * 2 + policy;
                BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
                calls[0] = BitmapNonceDelegate.Call({
                    to: address(target), value: 0, data: abi.encodeCall(TokenReturnTarget.transfer, (recipient, 1))
                });
                calls[1] = _erc20Call(recipient, 1e18);
                BatchFixture memory fixture = _batch(nonce * 2);
                fixture.revertOnFailure = policy == 0;
                bytes memory encoded = _prep(fixture, calls);
                uint256 beforeBalance = token.balanceOf(recipient);

                vm.recordLogs();
                vm.prank(relayer);
                delegate.execute(MODE_OPDATA, encoded);

                _assertReturnDataFailureLogs(vm.getRecordedLogs(), false, "", fixture.firstNonce);
                assertEq(target.balanceOf(recipient), response == 0 ? 0 : 1);
                assertEq(target.balanceOf(delegatedEOA), response == 0 ? 10 : 9);
                assertEq(token.balanceOf(recipient), beforeBalance + 1e18);
                assertTrue(delegate.isNonceUsed(nonce * 2));
                assertTrue(delegate.isNonceUsed(nonce * 2 + 1));
            }
        }
    }

    function test_selfModeTokenReturnValuesDoNotRevert() public {
        for (uint256 response; response < 3; ++response) {
            TokenReturnTarget target = new TokenReturnTarget(delegatedEOA, response);
            BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
            calls[0] = BitmapNonceDelegate.Call({
                to: address(target), value: 0, data: abi.encodeCall(TokenReturnTarget.transfer, (recipient, 1))
            });
            calls[1] = _erc20Call(recipient, 1e18);
            uint256 beforeBalance = token.balanceOf(recipient);

            vm.recordLogs();
            vm.prank(delegatedEOA);
            delegate.execute(MODE_SELF, abi.encode(calls));

            _assertReturnDataFailureLogs(vm.getRecordedLogs(), false, "", 0);
            assertEq(target.balanceOf(recipient), response == 0 ? 0 : 1);
            assertEq(token.balanceOf(recipient), beforeBalance + 1e18);
        }
    }

    function test_batchIsolationSkipsFailingCall() public {
        // The batch tolerates call failure. Both attempted intent IDs are consumed.
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 10_000_000e18);
        bytes memory ed = _prep(_batchContinueOnFailure(30), calls);
        bytes32 digest = delegate.hashBatch(_policy(_batchContinueOnFailure(30)), _intents(calls, 30));

        vm.prank(relayer);
        vm.expectEmit(true, true, false, false, delegatedEOA);
        emit BitmapNonceDelegate.CallFailed(digest, 31, "");
        delegate.execute(MODE_OPDATA, ed);

        // The successful transfer landed; the failing one had no effect.
        assertEq(token.balanceOf(recipient), 1e18);
        // Both intent IDs are consumed, including the failed transfer's ID.
        assertTrue(delegate.isNonceUsed(30));
        assertTrue(delegate.isNonceUsed(31));
    }

    function test_returnDataBoundedOnIsolatedFailure() public {
        // A malicious recipient reverting with 64 KiB of data must not blow up the batch: the
        // return data copied into CallFailed is capped, so it cannot OOG the batch and defeat
        // revertOnFailure = false isolation of the other calls.
        ReturnBomb bomb = new ReturnBomb();
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = BitmapNonceDelegate.Call({to: address(bomb), value: 0, data: hex"deadbeef"});
        bytes memory ed = _prep(_batchContinueOnFailure(31), calls);

        vm.recordLogs();
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        // The good call still landed; the bomb was isolated.
        assertEq(token.balanceOf(recipient), 1e18);
        assertTrue(delegate.isNonceUsed(31));

        // CallFailed carries the sentinel instead of an oversized reply.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BitmapNonceDelegate.CallFailed.selector) {
                assertEq(uint256(logs[i].topics[2]), 32);
                bytes memory returnData = abi.decode(logs[i].data, (bytes));
                assertEq(returnData, abi.encodeWithSelector(BitmapNonceDelegate.ReturnDataTooLarge.selector));
                found = true;
            }
        }
        assertTrue(found);
    }

    function test_multipleFailuresEmitEachNonce() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](3);
        calls[0] = _erc20Call(recipient, 10_000_000e18);
        calls[1] = _erc20Call(recipient, 1e18);
        calls[2] = _erc20Call(recipient, 10_000_000e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 32);
        intents[0].nonce = type(uint256).max;
        intents[2].nonce = 0;
        BitmapNonceDelegate.BatchMetadata memory metadata = _policy(_batchContinueOnFailure(32));
        bytes32 digest = delegate.hashBatch(metadata, intents);
        bytes memory ed = _signedBatch(metadata, intents);

        vm.recordLogs();
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 failures;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BitmapNonceDelegate.CallFailed.selector) {
                assertEq(logs[i].topics.length, 3);
                assertEq(logs[i].topics[1], digest);
                assertEq(uint256(logs[i].topics[2]), failures == 0 ? type(uint256).max : 0);
                failures++;
            }
        }
        assertEq(failures, 2);
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_nestedFailuresIdentifyTheirBatchAndNonce() public {
        ReturnDataTarget target = new ReturnDataTarget();
        ReentrantTarget callback = new ReentrantTarget();
        BitmapNonceDelegate.Call[] memory inner = new BitmapNonceDelegate.Call[](2);
        inner[0] = _nativeCall(recipient, 0);
        inner[1] = BitmapNonceDelegate.Call({
            to: address(target), value: 0, data: abi.encodeCall(ReturnDataTarget.reply, (hex"deadbeef", true))
        });
        callback.configure(address(delegate), MODE_OPDATA, _prep(_batchContinueOnFailure(200), inner));
        BitmapNonceDelegate.Call[] memory outer = new BitmapNonceDelegate.Call[](2);
        outer[0] = BitmapNonceDelegate.Call({
            to: address(callback), value: 0, data: abi.encodeCall(ReentrantTarget.reenter, ())
        });
        outer[1] = inner[1];
        bytes memory payload = _prep(_batchContinueOnFailure(100), outer, _NESTED_CAP);
        bytes32 innerDigest = delegate.hashBatch(_policy(_batchContinueOnFailure(200)), _intents(inner, 200));
        bytes32 outerDigest =
            delegate.hashBatch(_policy(_batchContinueOnFailure(100)), _intents(outer, 100, _NESTED_CAP));

        vm.recordLogs();
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, payload);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(callback.reentrySucceeded());
        assertEq(logs.length, 4);
        assertEq(logs[0].topics[0], BitmapNonceDelegate.BatchExecuted.selector);
        assertEq(logs[0].topics[1], outerDigest);
        assertEq(logs[1].topics[0], BitmapNonceDelegate.BatchExecuted.selector);
        assertEq(logs[1].topics[1], innerDigest);
        // Both failures are at position one with identical replies; event order cannot identify the batch.
        for (uint256 i = 2; i < logs.length; ++i) {
            assertEq(logs[i].emitter, delegatedEOA);
            assertEq(logs[i].topics.length, 3);
            assertEq(logs[i].topics[0], BitmapNonceDelegate.CallFailed.selector);
            assertEq(logs[i].topics[1], i == 2 ? innerDigest : outerDigest);
            assertEq(uint256(logs[i].topics[2]), i == 2 ? 201 : 101);
            assertEq(abi.decode(logs[i].data, (bytes)), hex"deadbeef");
        }
        assertTrue(delegate.isNonceUsed(101));
        assertTrue(delegate.isNonceUsed(201));
    }

    function test_nativeFailureIsolated() public {
        ReturnBomb bomb = new ReturnBomb();
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _nativeCall(address(bomb), 1 ether);
        calls[1] = _erc20Call(recipient, 1e18);
        bytes memory ed = _prep(_batchContinueOnFailure(33), calls);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, ed);

        assertEq(address(bomb).balance, 0);
        assertEq(token.balanceOf(recipient), 1e18);
        assertTrue(delegate.isNonceUsed(33));
    }

    function test_emptySignedBatchRejected() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](0);
        bytes memory ed = _prep(_batch(34), calls);

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidIntent.selector);
        delegate.execute(MODE_OPDATA, ed);

        assertFalse(delegate.isNonceUsed(34));
    }

    // --------------------------------------------------------------------------
    // Non-payable entrypoint
    // --------------------------------------------------------------------------

    function test_executeRejectsValue() public {
        // execute is non-payable: any msg.value reverts before the batch runs.
        // Native value in calls is drawn from the account's own balance, not msg.value.
        bytes memory ed = _prep(_batch(40), _one(_erc20Call(recipient, 1e18)));

        vm.prank(relayer);
        vm.expectRevert();
        (bool ok,) =
            address(delegate).call{value: 1}(abi.encodeWithSelector(delegate.execute.selector, MODE_OPDATA, ed));
        // Silence the unused-return warning; expectRevert asserts the failure.
        ok;
    }
    function _signedBatch(BitmapNonceDelegate.BatchMetadata memory batch, BitmapNonceDelegate.PackedIntent[] memory intents)
        internal view returns (bytes memory)
    {
        bytes32 digest = delegate.hashBatch(batch, intents);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        return abi.encode(intents, abi.encode(batch, abi.encodePacked(r, s, v)));
    }

    function test_perIntent_replayRejectedAfterRegrouping() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _nativeCall(recipient, 1 ether);
        bytes memory original = _prep(_batch(80), calls);
        delegate.execute(MODE_OPDATA, original);
        assertTrue(delegate.isNonceUsed(80));
        assertTrue(delegate.isNonceUsed(81));
        bytes memory regrouped = _prep(_batch(81), _one(calls[1]));
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.execute(MODE_OPDATA, regrouped);
        assertEq(recipient.balance, 1 ether);
    }

    function test_perIntent_duplicateIdRevertsInBothPolicies() public {
        for (uint256 policy; policy < 2; ++policy) {
            BatchFixture memory fixture = _batch(90);
            fixture.revertOnFailure = policy == 0;
            BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
            calls[0] = _erc20Call(recipient, 1e18);
            calls[1] = _erc20Call(recipient, 1e18);
            BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, fixture.firstNonce);
            intents[1].nonce = intents[0].nonce;
            bytes memory encoded = _signedBatch(_policy(fixture), intents);
            vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
            delegate.execute(MODE_OPDATA, encoded);
            assertFalse(delegate.isNonceUsed(90));
            assertEq(token.balanceOf(recipient), 0);
        }
    }

    function test_perIntent_cancelledLaterIdRejectsBeforeAnyAttempt() public {
        bytes memory cancelSig = _prepCancel(101);
        delegate.cancelAuthorization(101, cancelSig);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 2e18);
        bytes memory encoded = _prep(_batchContinueOnFailure(100), calls);
        vm.expectCall(address(token), calls[0].data, uint64(0));
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.execute(MODE_OPDATA, encoded);
        assertFalse(delegate.isNonceUsed(100));
        assertTrue(delegate.isNonceUsed(101));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_perIntent_batchCrossesBitmapWords() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 2e18);
        delegate.execute(MODE_OPDATA, _prep(_batch(255), calls));
        assertTrue(delegate.isNonceUsed(255));
        assertTrue(delegate.isNonceUsed(256));
        assertFalse(delegate.isNonceUsed(254));
        assertFalse(delegate.isNonceUsed(257));
        assertEq(token.balanceOf(recipient), 3e18);
    }

    function test_perIntent_signatureBindsOrderAndMembership() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 2e18);
        bytes memory encoded = _prep(_batch(110), calls);
        (BitmapNonceDelegate.PackedIntent[] memory intents, bytes memory opData) =
            abi.decode(encoded, (BitmapNonceDelegate.PackedIntent[], bytes));
        BitmapNonceDelegate.PackedIntent memory first = intents[0];
        intents[0] = intents[1];
        intents[1] = first;
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.execute(MODE_OPDATA, abi.encode(intents, opData));
        BitmapNonceDelegate.PackedIntent[] memory subset = new BitmapNonceDelegate.PackedIntent[](1);
        subset[0] = first;
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        delegate.execute(MODE_OPDATA, abi.encode(subset, opData));
        assertFalse(delegate.isNonceUsed(110));
        assertFalse(delegate.isNonceUsed(111));
    }

    function test_perIntent_sparseIdsAndMaximumNonce() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](3);
        for (uint256 i; i < calls.length; ++i) calls[i] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 120);
        intents[1].nonce = 1 << 200;
        intents[2].nonce = type(uint256).max;
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(120)), intents));
        for (uint256 i; i < intents.length; ++i) assertTrue(delegate.isNonceUsed(intents[i].nonce));
        assertEq(token.balanceOf(recipient), 3e18);
    }

    function test_perIntent_reentryPreservesSiblingNonceBits() public {
        ReentrantTarget target = new ReentrantTarget();
        bytes memory inner = _prep(_batch(201), _one(_erc20Call(recipient, 1e18)));
        target.configure(address(delegate), MODE_OPDATA, inner);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(address(target), 0, abi.encodeCall(ReentrantTarget.reenter, ()));
        calls[1] = _erc20Call(recipient, 2e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 200, _NESTED_CAP);
        intents[1].nonce = 202;
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(200)), intents));
        assertTrue(target.reentrySucceeded());
        assertTrue(delegate.isNonceUsed(200));
        assertTrue(delegate.isNonceUsed(201));
        assertTrue(delegate.isNonceUsed(202));
        assertEq(token.balanceOf(recipient), 3e18);
    }

    function test_perIntent_reentryCannotConsumeReservedLaterId() public {
        ReentrantTarget target = new ReentrantTarget();
        bytes memory inner = _prep(_batch(211), _one(_erc20Call(recipient, 1e18)));
        target.configure(address(delegate), MODE_OPDATA, inner);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(address(target), 0, abi.encodeCall(ReentrantTarget.reenter, ()));
        calls[1] = _erc20Call(recipient, 2e18);
        bytes memory encoded = _prep(_batchContinueOnFailure(210), calls);
        delegate.execute(MODE_OPDATA, encoded);
        assertTrue(delegate.isNonceUsed(210));
        assertTrue(delegate.isNonceUsed(211));
        assertEq(token.balanceOf(recipient), 2e18);
        assertFalse(target.reentrySucceeded());
        assertEq(target.reentryError(), BitmapNonceDelegate.NonceUsed.selector);
    }

    function test_batchReservation_allWordsVisibleDuringFirstCall() public {
        BatchNonceObserver observer = new BatchNonceObserver();
        uint256[] memory ids = new uint256[](3);
        ids[0] = 230;
        ids[1] = 256;
        ids[2] = type(uint256).max;
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](3);
        intents[0] = BitmapNonceDelegate.PackedIntent(_pack(address(observer), _CAP), 0, abi.encodeCall(BatchNonceObserver.observe, (delegate, ids)), ids[0]);
        intents[1] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 1e18).data, ids[1]);
        intents[2] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 2e18).data, ids[2]);
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(230)), intents));
        assertTrue(observer.allReserved());
        assertEq(token.balanceOf(recipient), 3e18);
    }

    function test_batchReservation_revisitedWordPreservesBitsAndOrder() public {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](4);
        uint256[4] memory ids = [uint256(253), 256, 255, 257];
        for (uint256 i; i < intents.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 1e18).data, ids[i]);
        }
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(253)), intents));
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(delegate.isNonceUsed(ids[i]));
        }
        assertFalse(delegate.isNonceUsed(254));
        assertFalse(delegate.isNonceUsed(258));
        assertEq(token.balanceOf(recipient), 4e18);
    }

    function test_batchReservation_duplicateAcrossRunsRejectsBeforeCalls() public {
        vm.expectCall(address(token), _erc20Call(recipient, 1e18).data, uint64(0));
        for (uint256 policy; policy < 2; ++policy) {
            BitmapNonceDelegate.BatchMetadata memory batch = _policy(_batch(240));
            batch.revertOnFailure = policy == 0;
            BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](3);
            uint256[3] memory ids = [uint256(240), 512, 240];
            for (uint256 i; i < intents.length; ++i) {
                intents[i] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 1e18).data, ids[i]);
            }
            bytes memory encoded = _signedBatch(batch, intents);
            vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
            delegate.execute(MODE_OPDATA, encoded);
            assertFalse(delegate.isNonceUsed(240));
            assertFalse(delegate.isNonceUsed(512));
        }
    }

    function test_batchReservation_laterSelfTargetRejectsBeforeCalls() public {
        BitmapNonceDelegate.Call[] memory nestedCalls = _one(_erc20Call(recipient, 3e18));
        bytes memory nestedData = abi.encodeCall(BitmapNonceDelegate.execute, (MODE_SELF, abi.encode(nestedCalls)));
        vm.expectCall(address(token), nestedCalls[0].data, uint64(0));
        vm.expectCall(address(token), _erc20Call(recipient, 1e18).data, uint64(0));
        for (uint256 policy; policy < 2; ++policy) {
            BitmapNonceDelegate.BatchMetadata memory batch = _policy(_batch(270));
            batch.revertOnFailure = policy == 0;
            BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](3);
            intents[0] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 1e18).data, 270);
            intents[1] = BitmapNonceDelegate.PackedIntent(_pack(address(token), _CAP), 0, _erc20Call(recipient, 2e18).data, 512);
            intents[2] = BitmapNonceDelegate.PackedIntent(_pack(delegatedEOA, 100_000), 1, nestedData, 1024);
            bytes memory encoded = _signedBatch(batch, intents);
            vm.expectRevert(BitmapNonceDelegate.SelfCallForbidden.selector);
            delegate.execute(MODE_OPDATA, encoded);
            assertFalse(delegate.isNonceUsed(270));
            assertFalse(delegate.isNonceUsed(512));
            assertFalse(delegate.isNonceUsed(1024));
        }
    }

    function test_batchReservation_fullBitmapWord() public {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](256);
        for (uint256 i; i < intents.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(_pack(recipient, _CAP), 0, "", 255 - i);
        }
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(0)), intents));
        for (uint256 i; i < intents.length; ++i) {
            assertTrue(delegate.isNonceUsed(i));
        }
        assertFalse(delegate.isNonceUsed(256));
        bytes memory encoded = _prep(_batch(0), _one(_nativeCall(recipient, 0)));
        vm.expectRevert(BitmapNonceDelegate.NonceUsed.selector);
        delegate.execute(MODE_OPDATA, encoded);
    }

    function test_batchReservation_oneWritePerAdjacentWordRun() public {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](7);
        uint256[7] memory ids = [uint256(1), 9, 3, 256, 257, 2, 10];
        for (uint256 i; i < intents.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(_pack(recipient, _CAP), 0, "", ids[i]);
        }
        bytes memory encoded = _signedBatch(_policy(_batch(1)), intents);
        vm.startStateDiffRecording();
        delegate.execute(MODE_OPDATA, encoded);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 writes;
        for (uint256 i; i < accesses.length; ++i) {
            for (uint256 j; j < accesses[i].storageAccesses.length; ++j) {
                Vm.StorageAccess memory access = accesses[i].storageAccesses[j];
                if (access.account == delegatedEOA && access.isWrite) ++writes;
            }
        }
        assertEq(writes, 3);
        for (uint256 i; i < ids.length; ++i) {
            assertTrue(delegate.isNonceUsed(ids[i]));
        }
    }

    function test_batchReservation_cancelLaterIdDuringCallbackIsRejected() public {
        BatchNonceObserver observer = new BatchNonceObserver();
        bytes memory cancelSig = _prepCancel(246);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(
            address(observer), 0, abi.encodeCall(BatchNonceObserver.cancel, (delegate, 246, cancelSig))
        );
        calls[1] = _erc20Call(recipient, 1e18);
        delegate.execute(MODE_OPDATA, _prep(_batchContinueOnFailure(245), calls));
        assertFalse(observer.cancellationSucceeded());
        assertEq(observer.cancellationError(), BitmapNonceDelegate.NonceUsed.selector);
        assertTrue(delegate.isNonceUsed(245));
        assertTrue(delegate.isNonceUsed(246));
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_batchReservation_callbackCancellationOfUnrelatedBitIsPreserved() public {
        BatchNonceObserver observer = new BatchNonceObserver();
        bytes memory cancelSig = _prepCancel(251);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(
            address(observer), 0, abi.encodeCall(BatchNonceObserver.cancel, (delegate, 251, cancelSig))
        );
        calls[1] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 250);
        intents[1].nonce = 252;
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(250)), intents));
        assertTrue(observer.cancellationSucceeded());
        assertTrue(delegate.isNonceUsed(250));
        assertTrue(delegate.isNonceUsed(251));
        assertTrue(delegate.isNonceUsed(252));
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_batchReservation_strictFailureRollsBackEveryWord() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](3);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 10_000_000e18);
        calls[2] = _erc20Call(recipient, 2e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 254);
        intents[2].nonce = 512;
        bytes memory encoded = _signedBatch(_policy(_batch(254)), intents);
        vm.expectRevert();
        delegate.execute(MODE_OPDATA, encoded);
        for (uint256 i; i < intents.length; ++i) {
            assertFalse(delegate.isNonceUsed(intents[i].nonce));
        }
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_batchReservation_callOrderIsUnchanged() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        // First exhaust the balance; the later transfer fails only if execution stays in order.
        calls[0] = _erc20Call(recipient, token.balanceOf(delegatedEOA));
        calls[1] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 512);
        intents[1].nonce = 1;
        bytes memory encoded = _signedBatch(_policy(_batchContinueOnFailure(512)), intents);
        delegate.execute(MODE_OPDATA, encoded);
        assertEq(token.balanceOf(recipient), 1_000_000e18);
        assertEq(token.balanceOf(delegatedEOA), 0);
        assertTrue(delegate.isNonceUsed(512));
        assertTrue(delegate.isNonceUsed(1));
    }

    function testFuzz_batchReservation_shuffledBits(uint256 wordPosition, uint8 start, uint8 count_) public {
        wordPosition >>= 8;
        uint256 count = bound(count_, 1, 32);
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](count);
        for (uint256 i; i < count; ++i) {
            uint256 bit = (uint256(start) + i * 17) & 255;
            intents[i] = BitmapNonceDelegate.PackedIntent(_pack(recipient, _CAP), 0, "", (wordPosition << 8) | bit);
        }
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batch(0)), intents));
        for (uint256 i; i < intents.length; ++i) {
            assertTrue(delegate.isNonceUsed(intents[i].nonce));
        }
        uint256 otherBit = (uint256(start) + count * 17) & 255;
        assertFalse(delegate.isNonceUsed((wordPosition << 8) | otherBit));
    }

    function test_standardSignedCallModeNotAdvertised() public {
        bytes32 oldMode = 0x0100000000007821000100000000000000000000000000000000000000000000;
        assertFalse(delegate.supportsExecutionMode(oldMode));
        vm.expectRevert(BitmapNonceDelegate.UnsupportedExecutionMode.selector);
        delegate.execute(oldMode, "");
    }

    function test_hashBatchMatchesIndependentTypedDataHash() public {
        // Golden EIP-712 digest computed independently with ABI encoding and keccak256, domain v1,
        // chain 31337, and the authority address derived from delegatedEOAPk.
        vm.chainId(31337);
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](2);
        intents[0] = BitmapNonceDelegate.PackedIntent(_pack(address(0xCAFE), 100_000), 1, hex"1234", 255);
        intents[1] = BitmapNonceDelegate.PackedIntent(_pack(address(0xBEEF), 200_000), 0, "", 256);
        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata(500, 2000, false, 40_000);
        assertEq(delegate.hashBatch(batch, intents),
            0x13b95eddd0399b5b7d48ecc9ddfb9d21e0a389de3112ba25944236a23fbaef9a);
    }

    function test_reservedPackedBitsRevertBeforeNonce() public {
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(_one(_erc20Call(recipient, 1e18)), 301);
        bytes memory encoded = _signedBatch(_policy(_batch(301)), intents);
        (, bytes memory opData) = abi.decode(encoded, (BitmapNonceDelegate.PackedIntent[], bytes));
        intents[0].targetAndGasLimit |= uint256(1) << 224;

        vm.expectRevert(BitmapNonceDelegate.InvalidIntent.selector);
        delegate.execute(MODE_OPDATA, abi.encode(intents, opData));
        assertFalse(delegate.isNonceUsed(301));
    }

    function testFuzz_hashBindsPackedTargetAndGas(uint256 targetAndGasLimit, bytes memory data) public view {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](1);
        targetAndGasLimit &= type(uint224).max;
        intents[0] = BitmapNonceDelegate.PackedIntent(targetAndGasLimit, 7, data, 9);
        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata(0, 2000, false, 40_000);
        bytes32 intentHash = keccak256(abi.encode(
            keccak256("Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)"),
            address(uint160(targetAndGasLimit)), uint64(targetAndGasLimit >> 160), uint256(7), keccak256(data), uint256(9)
        ));
        bytes32 batchHash = keccak256(abi.encode(
            keccak256("Batch(Intent[] intents,uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)"),
            keccak256(abi.encodePacked(intentHash)), uint256(0), uint256(2000), false, uint64(40_000)
        ));
        assertEq(delegate.hashBatch(batch, intents), keccak256(abi.encodePacked(hex"1901", delegate.domainSeparator(), batchHash)));
    }

    function testFuzz_hashBatchMatchesAbiEncoding(uint256[4] memory words, bytes memory data) public view {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](words.length);
        bytes32[] memory hashes = new bytes32[](words.length);
        bytes32 typeHash = keccak256("Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)");
        for (uint256 i; i < words.length; ++i) {
            uint256 packed = words[i] & type(uint224).max;
            bytes memory input = abi.encode(data, i);
            intents[i] = BitmapNonceDelegate.PackedIntent(packed, words[i], input, i);
            hashes[i] = keccak256(abi.encode(typeHash, address(uint160(packed)), uint64(packed >> 160), words[i], keccak256(input), i));
        }
        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata(1, 2000, false, 40_000);
        bytes32 batchHash = keccak256(abi.encode(
            keccak256("Batch(Intent[] intents,uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)Intent(address to,uint64 gasLimit,uint256 value,bytes data,uint256 nonce)"),
            keccak256(abi.encodePacked(hashes)), batch.validAfter, batch.validBefore, batch.revertOnFailure, batch.gasReserve
        ));
        assertEq(delegate.hashBatch(batch, intents), keccak256(abi.encodePacked(hex"1901", delegate.domainSeparator(), batchHash)));
    }

    function test_failureBuffersPreserveLaterInputsAndLogs() public {
        ReturnDataTarget failing = new ReturnDataTarget();
        CallInputTarget next = new CallInputTarget();
        bytes memory first = new bytes(256);
        for (uint256 i; i < first.length; ++i) first[i] = bytes1(uint8(i));
        bytes memory second = hex"12345678";
        bytes memory input = abi.encode(first, second);
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](3);
        calls[0] = BitmapNonceDelegate.Call(address(failing), 0, abi.encodeCall(ReturnDataTarget.reply, (first, true)));
        calls[1] = BitmapNonceDelegate.Call(address(failing), 0, abi.encodeCall(ReturnDataTarget.reply, (second, true)));
        calls[2] = BitmapNonceDelegate.Call(address(next), 0, input);
        bytes memory payload = _signedBatch(_policy(_batchContinueOnFailure(700)), _intents(calls, 700));
        vm.recordLogs();
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, payload);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[1].topics[0], BitmapNonceDelegate.CallFailed.selector);
        assertEq(logs[2].topics[0], BitmapNonceDelegate.CallFailed.selector);
        assertEq(uint256(logs[1].topics[2]), 700);
        assertEq(uint256(logs[2].topics[2]), 701);
        assertEq(abi.decode(logs[1].data, (bytes)), first);
        assertEq(abi.decode(logs[2].data, (bytes)), second);
        assertEq(next.dataHash(), keccak256(input));
        assertEq(next.sender(), address(delegate));
        for (uint256 i = 700; i < 703; ++i) assertTrue(delegate.isNonceUsed(i));
    }

    function test_maxGasReserveRejectsBeforeNonceConsumption() public {
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(_one(_erc20Call(recipient, 1e18)), 321, 100_000);
        BitmapNonceDelegate.BatchMetadata memory batch = _policy(_batch(321));
        batch.gasReserve = type(uint64).max;
        bytes memory encoded = _signedBatch(batch, intents);
        vm.expectRevert(BitmapNonceDelegate.InsufficientGas.selector);
        delegate.execute(MODE_OPDATA, encoded);
        assertFalse(delegate.isNonceUsed(321));
    }

    function test_zeroGasReserveIsAllowed() public {
        GasChecker target = new GasChecker(100_000, 1_000);
        BitmapNonceDelegate.PackedIntent[] memory intents =
            _intents(_one(BitmapNonceDelegate.Call(address(target), 1, "")), 321, 100_000);
        BitmapNonceDelegate.BatchMetadata memory batch = _policy(_batch(321));
        batch.gasReserve = 0;
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, _signedBatch(batch, intents));
        assertTrue(delegate.isNonceUsed(321));
        assertEq(uint256(vm.load(address(target), bytes32(0))), 1);
    }

    function test_cappedBurnContinuesTolerantBatch() public {
        GasBurner burner = new GasBurner();
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(address(burner), 0, "");
        calls[1] = _erc20Call(recipient, 1e18);
        BatchFixture memory fixture = _batchContinueOnFailure(302);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, fixture.firstNonce, 100_000);
        bytes memory encoded = _signedBatch(_policy(fixture), intents);

        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, encoded);
        assertTrue(delegate.isNonceUsed(302));
        assertTrue(delegate.isNonceUsed(303));
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_cappedBurnRollsBackAtomicBatch() public {
        GasBurner burner = new GasBurner();
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = BitmapNonceDelegate.Call(address(burner), 0, "");
        calls[1] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 304, 100_000);
        bytes memory encoded = _signedBatch(_policy(_batch(304)), intents);

        vm.prank(relayer);
        vm.expectRevert();
        delegate.execute(MODE_OPDATA, encoded);
        assertFalse(delegate.isNonceUsed(304));
        assertFalse(delegate.isNonceUsed(305));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_underfundedCappedCallRollsBackEarlierIntent() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _erc20Call(recipient, 1e18);
        calls[1] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 306);
        intents[1].targetAndGasLimit = _pack(address(token), type(uint64).max);
        bytes memory encoded = _signedBatch(_policy(_batch(306)), intents);

        vm.prank(relayer);
        (bool ok, bytes memory ret) = address(delegate).call{gas: 500_000}(
            abi.encodeWithSelector(delegate.execute.selector, MODE_OPDATA, encoded)
        );
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(BitmapNonceDelegate.InsufficientGas.selector));
        assertFalse(delegate.isNonceUsed(306));
        assertFalse(delegate.isNonceUsed(307));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_zeroGasLimitForwardsOnlyTheStipend() public {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](2);
        calls[0] = _nativeCall(address(0xA11CE), 1);
        calls[1] = _erc20Call(recipient, 1e18);
        BitmapNonceDelegate.PackedIntent[] memory intents = _intents(calls, 308, 0);

        vm.recordLogs();
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, _signedBatch(_policy(_batchContinueOnFailure(308)), intents));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The ETH send runs on the stipend; the ERC-20 call gets no gas and fails.
        assertEq(address(0xA11CE).balance, 1);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(logs.length, 2);
        assertEq(logs[1].topics[0], BitmapNonceDelegate.CallFailed.selector);
        assertEq(uint256(logs[1].topics[2]), 309);
        assertTrue(delegate.isNonceUsed(308));
        assertTrue(delegate.isNonceUsed(309));
    }

    function test_unknownSelectorAcceptedWithOrWithoutEth() public {
        bytes memory frame = abi.encodePacked(bytes4(0), recipient, uint256(1), bytes(""));
        uint256 balanceBefore = recipient.balance;
        uint256 walletBalance = delegatedEOA.balance;
        vm.prank(relayer);
        (bool ok, bytes memory reason) = address(delegate).call(frame);
        assertTrue(ok);
        assertEq(reason.length, 0);
        vm.deal(relayer, 1);
        vm.prank(relayer);
        (ok, reason) = address(delegate).call{value: 1}(frame);
        assertTrue(ok);
        assertEq(reason.length, 0);
        assertEq(delegatedEOA.balance, walletBalance + 1);
        assertEq(recipient.balance, balanceBefore);
    }

    function testFuzz_cappedCallPreservesPayload(bytes memory input, uint96 value) public {
        vm.assume(input.length <= 4096);
        _checkCallPayload(input, value);
    }

    function test_cappedCallPreservesLargePayload() public {
        bytes memory input = new bytes(65_536);
        for (uint256 i; i < input.length; ++i) input[i] = bytes1(uint8(i));
        _checkCallPayload(input, 7);
    }

    function _checkCallPayload(bytes memory input, uint96 value) internal {
        CallInputTarget target = new CallInputTarget();
        vm.deal(delegatedEOA, value);
        BitmapNonceDelegate.PackedIntent[] memory intents =
            _intents(_one(BitmapNonceDelegate.Call(address(target), value, input)), 320, 500_000);
        bytes memory encoded = _signedBatch(_policy(_batch(320)), intents);
        vm.prank(relayer);
        delegate.execute(MODE_OPDATA, encoded);
        assertEq(target.dataHash(), keccak256(input));
        assertEq(target.sender(), delegatedEOA);
        assertEq(address(target).balance, value);
        assertTrue(delegate.isNonceUsed(320));
    }

    function test_fundingBoundaryTargetsReceiveFullCap() public {
        uint256 snapshot = IBoundaryVm(address(vm)).snapshotState();
        for (uint256 value; value < 2; ++value) {
            for (uint256 largeInput; largeInput < 2; ++largeInput) {
                assertTrue(IBoundaryVm(address(vm)).revertToState(snapshot));
                _checkTargetAtFundingBoundary(value, largeInput == 0 ? 0 : 65_536, false);
            }
        }
    }

    function test_fundingBoundaryColdEmptyAccount() public {
        assertEq(vm.getNonce(emptyAccount), 0);
        _checkFundingBoundary(emptyAccount, 1, new bytes(65_536), false, 0);
        assertEq(emptyAccount.balance, 1);
        assertEq(emptyAccount.code.length, 0);
    }

    function test_fundingBoundaryInsufficientBalanceToColdEmptyAccount() public {
        vm.deal(delegatedEOA, 0);
        _checkFundingBoundary(emptyAccount, 1, new bytes(65_536), true, 0);
        assertEq(emptyAccount.balance, 0);
    }

    function test_fundingBoundaryGasBurnerWithLargeInput() public {
        uint256 snapshot = IBoundaryVm(address(vm)).snapshotState();
        for (uint256 value; value < 2; ++value) {
            assertTrue(IBoundaryVm(address(vm)).revertToState(snapshot));
            _checkFundingBoundary(fundingBurner, value, new bytes(65_536), true, 0);
        }
    }

    function test_fundingBoundaryOversizedRevertWithLargeInput() public {
        uint256 snapshot = IBoundaryVm(address(vm)).snapshotState();
        for (uint256 value; value < 2; ++value) {
            assertTrue(IBoundaryVm(address(vm)).revertToState(snapshot));
            _checkFundingBoundary(fundingReturnBomb, value, new bytes(65_536), true, 4);
        }
    }

    // Griefing window: gas at which the target's work is done minus gas at which `execute` succeeds.
    // Zero means no submitter can make `execute` succeed while the target's work is left undone.

    function test_griefWindowCappedSwallowedInnerFailureIsClosed() public {
        assertEq(_griefWindow(address(griefForwarder), address(griefWorker), 1_100_000, true), 0);
    }

    function test_griefWindowCappedGasCheckingTargetIsClosed() public {
        assertEq(_griefWindow(address(griefChecker), address(griefChecker), 320_000, false), 0);
    }

    function _griefWindow(address target, address worker, uint64 gasLimit, bool strict)
        internal returns (uint256)
    {
        bytes memory payload = _griefPayload(target, gasLimit, strict);
        uint256 executes = _minimumGriefBudget(target, worker, payload, false);
        uint256 works = _minimumGriefBudget(target, worker, payload, true);
        return works - executes;
    }

    function _griefPayload(address target, uint64 gasLimit, bool strict)
        internal view returns (bytes memory)
    {
        uint256 nonce = 500;
        BitmapNonceDelegate.BatchMetadata memory batch = _policy(strict ? _batch(nonce) : _batchContinueOnFailure(nonce));
        return abi.encodeWithSelector(
            delegate.execute.selector,
            MODE_OPDATA,
            _signedBatch(batch, _intents(_one(BitmapNonceDelegate.Call(target, 0, "")), nonce, gasLimit))
        );
    }

    /// @dev Smallest transaction gas at which `execute` succeeds or, with `needsWork`, the worker also finished.
    function _minimumGriefBudget(address target, address worker, bytes memory payload, bool needsWork)
        internal returns (uint256 high)
    {
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        uint256 low;
        high = 5_000_000;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            assertTrue(boundaryVm.revertToState(snapshot));
            vm.prank(relayer);
            (bool ok,) = address(delegate).call{gas: mid}(payload);
            if (ok && (!needsWork || vm.load(worker, bytes32(0)) != 0)) high = mid;
            else low = mid;
        }
        assertTrue(boundaryVm.revertToState(snapshot));
    }

    // Reserve boundary, 100 intents. Guard-to-CALL instructions plus CALL charges keep each target's
    // full cap; cleanup must also fit, so a tight budget finishes or reverts with `InsufficientGas`
    // rather than running out of gas. The measured minimum is checked against the documented allowance.

    uint256 internal constant _BOUNDARY_INTENTS = 100;
    // Guard-to-CALL instructions plus a cold CALL, measured on this bytecode.
    uint64 internal constant _CALL_RESERVE = 48 + 2_600;
    // The documented allowance: `_CALL_RESERVE` plus the measured 100-intent cleanup.
    uint64 internal constant _CLEANUP_RESERVE = _CALL_RESERVE + 5_038;

    function test_reserveBoundaryTargetsReceiveFullCap() public {
        assertEq(_shortTargets(recorders, _CALL_RESERVE), 0);
        // One gas less shorts the last target, which runs at the tightest accepted budget.
        assertEq(_shortTargets(recorders, _CALL_RESERVE - 1), 1);
    }

    function test_reserveBoundaryCleanupFinishesOrRejectsCleanly() public {
        address[] memory targets = replyBurners;
        assertTrue(_cleanAtBoundaries(targets, _CLEANUP_RESERVE));
        assertFalse(_cleanAtBoundaries(targets, _CALL_RESERVE));

        uint64 low = _CALL_RESERVE;
        uint64 high = _CLEANUP_RESERVE;
        while (low + 1 < high) {
            uint64 mid = (low + high) / 2;
            if (_cleanAtBoundaries(targets, mid)) high = mid;
            else low = mid;
        }
        // Measured minimum for this batch: it passes, one gas less fails. The retained 1/64 and the
        // burner's unspent gas put it below the documented allowance.
        assertLe(high, _CLEANUP_RESERVE);
        assertTrue(_cleanAtBoundaries(targets, high));
        assertFalse(_cleanAtBoundaries(targets, high - 1));
    }

    /// @dev Runs at the budget where the last target is first called and counts targets below their cap.
    function _shortTargets(address[] memory targets, uint64 reserve) internal returns (uint256 short) {
        uint64 gasLimit = 50_000;
        bytes memory payload = _reserveBatch(targets, gasLimit, reserve);
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        uint256 budget = _boundaryBudget(targets, payload, targets.length - 1);
        (bool ok,) = _boundaryRun(payload, budget);
        assertTrue(ok);
        for (uint256 i; i < targets.length; ++i) {
            if (uint256(vm.load(targets[i], bytes32(0))) < gasLimit - 2) ++short;
        }
        assertTrue(boundaryVm.revertToState(snapshot));
    }

    /// @dev At the tightest budget for the first, middle and last target, the batch must finish
    ///      with every failure logged or reject the next intent with `InsufficientGas`.
    function _cleanAtBoundaries(address[] memory targets, uint64 reserve) internal returns (bool) {
        bytes memory payload = _reserveBatch(targets, 20_000, reserve);
        uint256 last = targets.length - 1;
        uint256[3] memory positions = [uint256(0), last / 2, last];
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        for (uint256 p; p < positions.length; ++p) {
            uint256 budget = _boundaryBudget(targets, payload, positions[p]);
            vm.recordLogs();
            (bool ok, bytes memory ret) = _boundaryRun(payload, budget);
            bool clean = positions[p] == last
                ? ok && _replyFailures(vm.getRecordedLogs()) == targets.length
                : !ok && keccak256(ret) == keccak256(abi.encodeWithSelector(BitmapNonceDelegate.InsufficientGas.selector))
                    && !delegate.isNonceUsed(600);
            assertTrue(boundaryVm.revertToState(snapshot));
            if (!clean) return false;
        }
        return true;
    }

    function _reserveBatch(address[] memory targets, uint64 gasLimit, uint64 reserve)
        internal view returns (bytes memory)
    {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(_pack(targets[i], gasLimit), 0, "", 600 + i);
        }
        BitmapNonceDelegate.BatchMetadata memory batch =
            BitmapNonceDelegate.BatchMetadata(0, block.timestamp + 1 hours, false, reserve);
        return abi.encodeWithSelector(delegate.execute.selector, MODE_OPDATA, _signedBatch(batch, intents));
    }

    /// @dev Smallest budget at which the wallet calls `targets[position]`, counting calls a later revert undoes.
    function _boundaryBudget(address[] memory targets, bytes memory payload, uint256 position)
        internal returns (uint256 high)
    {
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        uint256 low;
        high = 3_000_000;
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            assertTrue(boundaryVm.revertToState(snapshot));
            if (this.reachesTarget(payload, mid, targets[position])) high = mid;
            else low = mid;
        }
        assertTrue(boundaryVm.revertToState(snapshot));
    }

    /// @dev Callers revert to a snapshot taken before any target was reached, so each CALL is cold.
    function _boundaryRun(bytes memory payload, uint256 budget) internal returns (bool, bytes memory) {
        vm.prank(relayer);
        return address(delegate).call{gas: budget}(payload);
    }

    /// @dev External so each recorded state diff is freed with this call's memory.
    function reachesTarget(bytes calldata payload, uint256 budget, address target)
        external returns (bool)
    {
        vm.startStateDiffRecording();
        _boundaryRun(payload, budget);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Call && accesses[i].account == target) return true;
        }
        return false;
    }

    function _replyFailures(Vm.Log[] memory logs) internal view returns (uint256 failures) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == delegatedEOA && logs[i].topics[0] == BitmapNonceDelegate.CallFailed.selector) {
                if (abi.decode(logs[i].data, (bytes)).length == 256) ++failures;
            }
        }
    }

    function test_delegatedAccountAcceptsSafeNftTransfers() public {
        assertGt(delegatedEOA.code.length, 0);

        TransferableERC721 nft = new TransferableERC721();
        nft.initialize("Probe", "PRB");
        nft.mint(address(this), 1);
        nft.safeTransferFrom(address(this), delegatedEOA, 1);
        assertEq(nft.ownerOf(1), delegatedEOA);

        MinimalERC1155 multi = new MinimalERC1155();
        multi.safeTransfer(address(this), delegatedEOA, 7, 1);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = 7;
        amounts[0] = 1;
        multi.safeBatchTransfer(address(this), delegatedEOA, ids, amounts);
    }

    function test_supportsReceiverAndSignatureInterfaces() public view {
        BitmapNonceDelegate account = BitmapNonceDelegate(payable(delegatedEOA));
        assertTrue(account.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(account.supportsInterface(0x150b7a02)); // ERC-721 receiver
        assertTrue(account.supportsInterface(0x4e2312e0)); // ERC-1155 receiver
        assertTrue(account.supportsInterface(0x1626ba7e)); // ERC-1271
        assertFalse(account.supportsInterface(0xffffffff));
    }

    function test_isValidSignatureAcceptsOnlyTheAccountKey() public {
        BitmapNonceDelegate account = BitmapNonceDelegate(payable(delegatedEOA));
        bytes32 hash = keccak256("permit2 message");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));

        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        account.isValidSignature(hash, new bytes(64));
        vm.expectRevert();
        account.isValidSignature(hash, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));

        (v, r, s) = vm.sign(0xB0B, hash);
        assertEq(account.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    function _checkTargetAtFundingBoundary(uint256 value, uint256 inputSize, bool warm) internal {
        _checkFundingBoundary(fundingRecorder, value, new bytes(inputSize), false, 0, warm);
        uint256 targetGas = uint256(vm.load(fundingRecorder, bytes32(0)));
        assertEq(targetGas, 100_000 + (value == 0 ? 0 : 2_300) - 2);
    }

    function _checkFundingBoundary(
        address target, uint256 value, bytes memory input, bool fails, uint256 returnSize
    ) internal {
        _checkFundingBoundary(target, value, input, fails, returnSize, false);
    }

    function _checkFundingBoundary(
        address target,
        uint256 value,
        bytes memory input,
        bool fails,
        uint256 returnSize,
        bool warm
    ) internal {
        _runFundingBoundary(
            target, fails, returnSize, _fundingPayload(target, value, input, 400), warm
        );
    }

    function _runFundingBoundary(
        address target, bool fails, uint256 returnSize, bytes memory payload, bool warm
    ) internal {
        uint256 nonce = 400;
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        uint256 high = _minimumFundingBudget(target, nonce, payload, warm);
        assertTrue(boundaryVm.revertToState(snapshot));
        (bool rejected, bytes memory reason) = _boundaryExecute(target, nonce, payload, high - 1, warm);
        assertFalse(rejected);
        assertEq(reason, abi.encodeWithSelector(BitmapNonceDelegate.InsufficientGas.selector));
        assertFalse(delegate.isNonceUsed(nonce));

        assertTrue(boundaryVm.revertToState(snapshot));
        vm.recordLogs();
        (bool accepted, bytes memory result) = _boundaryExecute(target, nonce, payload, high, warm);
        assertTrue(accepted, "threshold must permit CALL and cleanup");
        assertEq(result.length, 0);
        assertTrue(delegate.isNonceUsed(nonce));
        _assertBoundaryFailureLog(fails, returnSize);
    }

    function _fundingPayload(
        address target, uint256 value, bytes memory input, uint256 nonce
    ) internal view returns (bytes memory) {
        BitmapNonceDelegate.BatchMetadata memory batch = _policy(_batchContinueOnFailure(nonce));
        return abi.encodeWithSelector(
            delegate.execute.selector,
            MODE_OPDATA,
            _signedBatch(batch, _intents(_one(BitmapNonceDelegate.Call(target, value, input)), nonce, 100_000))
        );
    }

    function _assertBoundaryFailureLog(bool fails, uint256 returnSize) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 failures;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == delegatedEOA && logs[i].topics[0] == BitmapNonceDelegate.CallFailed.selector) {
                assertEq(uint256(logs[i].topics[2]), 400);
                bytes memory returnData = abi.decode(logs[i].data, (bytes));
                assertEq(returnData.length, returnSize);
                ++failures;
            }
        }
        assertEq(failures, fails ? 1 : 0);
    }

    function _minimumFundingBudget(address target, uint256 nonce, bytes memory payload)
        internal returns (uint256 high)
    {
        return _minimumFundingBudget(target, nonce, payload, false);
    }

    function _minimumFundingBudget(address target, uint256 nonce, bytes memory payload, bool warm)
        internal returns (uint256 high)
    {
        IBoundaryVm boundaryVm = IBoundaryVm(address(vm));
        uint256 snapshot = boundaryVm.snapshotState();
        uint256 low;
        high = 3_000_000;
        // Find the first execute budget accepted by the real guard, keeping state/access identical.
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            assertTrue(boundaryVm.revertToState(snapshot));
            (bool ok,) = _boundaryExecute(target, nonce, payload, mid, warm);
            if (ok) high = mid;
            else low = mid;
        }
        assertTrue(boundaryVm.revertToState(snapshot));
    }

    function _boundaryExecute(address target, uint256 nonce, bytes memory payload, uint256 budget)
        internal returns (bool, bytes memory)
    {
        return _boundaryExecute(target, nonce, payload, budget, false);
    }

    function _boundaryExecute(address target, uint256 nonce, bytes memory payload, uint256 budget, bool warm)
        internal returns (bool, bytes memory)
    {
        // Warm the delegate/nonce slot consistently. Callers revert to a snapshot taken before the
        // recipient was reached, so it starts cold.
        assertFalse(delegate.isNonceUsed(nonce));
        if (warm) {
            // EXTCODESIZE adds the account to this transaction's access list.
            assembly {
                pop(extcodesize(target))
            }
        }
        vm.prank(relayer);
        return address(delegate).call{gas: budget}(payload);
    }

}
