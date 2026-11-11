// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "lib/forge-std/src/Test.sol";
import {console2} from "lib/forge-std/src/console2.sol";
import {MockERC20} from "lib/forge-std/src/mocks/MockERC20.sol";
import {BitmapNonceDelegate} from "../../contracts/delegates/BitmapNonceDelegate.sol";

/// @dev Binding for the EIP-7702 cheatcode missing from the pinned forge-std version.
interface IVm7702 {
    function signAndAttachDelegation(address implementation, uint256 privateKey) external;
}

/// @notice Measures the marginal gas of `execute` across batch sizes for native and
///         ERC-20 multi-out, computes the all-in per-withdrawal cost by folding in
///         the 21,000 intrinsic per-transaction fee, and asserts amortization holds
///         and a break-even batch size exists versus not using a contract at all.
///
/// @dev Methodology:
///        - Recipients are funded in setUp — a separate transaction — so each is
///          cold but non-zero on first touch inside the measured call.
///        - A throwaway op (`_warm`) inside the measured transaction warms the
///          delegate code, token contract, and nonce word, and leaves the delegated
///          EOA's token-balance slot dirty.
///        - Each batch size uses a disjoint set of fresh recipients so no
///          recipient is warmed by an earlier row.
///
///      MEASURED "total gas" is the marginal cost of the `execute` call: it
///      EXCLUDES the 21,000 intrinsic per-transaction fee (there is no outer
///      transaction here).
///
///      BREAK-EVEN needs the all-in per-withdrawal cost, which is where the
///      intrinsic fee matters. Direct transfers are one transaction each, so each
///      pays 21,000 intrinsic. A batch pays 21,000 ONCE and splits it across N:
///
///        direct, per withdrawal      = 21,000 + (marginal transfer work)
///        batched, per withdrawal (N) = (21,000 + measured_total(N)) / N
///
///      So the contract wins once (21,000 + measured_total(N)) / N drops below the
///      direct per-withdrawal cost. Absolute numbers vary with solc/EVM; the ratios
///      and break-even are the robust signal.
contract BitmapNonceDelegateGasTest is Test {
    IVm7702 internal constant vm7702 = IVm7702(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    BitmapNonceDelegate internal impl;
    BitmapNonceDelegate internal delegate;
    MockERC20 internal token;

    uint256 internal delegatedEOAPk = 0x0117B115;
    address internal delegatedEOA;
    address internal relayer = address(0xBEEF);

    uint256 internal constant INTRINSIC = 21_000; // transaction intrinsic gas
    uint256 internal constant POOL = 400;
    uint256 internal constant RECIPIENT_BASE = 0x100000;
    uint256 internal nextRecipient; // hands out disjoint fresh recipients
    uint256 internal nonceCounter; // sequential nonces, all in one bitmap word
    bytes32 internal MODE_OPDATA; // cached so it is not called inside the measured region
    bytes32 internal MODE_SELF; // pure-batching path: no signature, no nonce

    function setUp() public {
        delegatedEOA = vm.addr(delegatedEOAPk);

        impl = new BitmapNonceDelegate();
        MODE_OPDATA = impl.MODE_SIGNED_BATCH();
        MODE_SELF = impl.MODE_BATCH();

        vm7702.signAndAttachDelegation(address(impl), delegatedEOAPk);
        delegate = BitmapNonceDelegate(payable(delegatedEOA));

        token = new MockERC20();
        token.initialize("Mock", "MOCK", 18);
        deal(address(token), delegatedEOA, 1e30);
        vm.deal(delegatedEOA, 1e24);

        // Fund the test contract here (separate tx) so the direct-transfer baseline
        // is measured cold — token contract, sender slot, and recipient all cold on
        // first touch.
        deal(address(token), address(this), 1e24);

        // Pre-fund the recipient pool here (separate tx) so recipients are non-zero
        // yet cold when first touched in a measured call.
        for (uint256 i = 1; i <= POOL; ++i) {
            address to = address(uint160(RECIPIENT_BASE + i));
            deal(address(token), to, 1);
            vm.deal(to, 1);
        }
    }

    // --------------------------------------------------------------------------
    // Tables
    // --------------------------------------------------------------------------

    function test_gasTable_erc20MultiOut() public {
        // Cold, standalone direct transfer (this fn, before any warming) is the
        // no-contract baseline; add the intrinsic fee it would pay as its own tx.
        uint256 directAllIn = INTRINSIC + _measureDirectToken();

        console2.log("=== Case A: ERC-20 multi-out vs direct transfers ===");
        console2.log(string.concat("direct (no contract), per withdrawal: ", vm.toString(directAllIn), " gas"));
        _runTable(false, directAllIn);
    }

    function test_gasTable_nativeMultiOut() public {
        // A direct native send is just the 21,000 intrinsic — the cheapest tx on
        // the chain, and the hardest baseline to beat.
        uint256 directAllIn = INTRINSIC;

        console2.log("=== Case B: native ETH multi-out vs direct sends ===");
        console2.log(string.concat("direct (no contract), per withdrawal: ", vm.toString(directAllIn), " gas"));
        _runTable(true, directAllIn);
    }

    /// @notice What the signed-batch path costs over the pure-batching self path
    ///         (no signature, no bitmap nonce). The delta is the price of the
    ///         signature verification and nonce bookkeeping.
    function test_gasTable_authOverhead() public {
        nextRecipient = 100;
        nonceCounter = 0x700000;
        _warm();

        uint256[6] memory sizes = [uint256(1), 2, 5, 10, 50, 100];
        console2.log("=== Cost of signed-intent vs pure-batching (ERC-20, warm) ===");
        console2.log("N | signed per-item | pure per-item | overhead/item | overhead %");
        for (uint256 k; k < sizes.length; ++k) {
            uint256 n = sizes[k];
            uint256 pure_ = _measureSelf(n) / n;
            uint256 signed_ = _measure(n, false) / n;
            uint256 over = signed_ - pure_;
            console2.log(
                string.concat(
                    vm.toString(n),
                    " | ",
                    vm.toString(signed_),
                    " | ",
                    vm.toString(pure_),
                    " | ",
                    vm.toString(over),
                    " | ",
                    vm.toString((over * 100) / pure_),
                    "%"
                )
            );
        }
    }

    function test_gasBaselines() public {
        address to = address(uint160(RECIPIENT_BASE + 1));
        uint256 g = gasleft();
        token.transfer(to, 1);
        uint256 usedDirectToken = g - gasleft();

        console2.log("=== Baselines (marginal, excl. 21k intrinsic) ===");
        console2.log(string.concat("direct ERC-20 transfer, marginal: ", vm.toString(usedDirectToken)));
        console2.log(string.concat("direct ERC-20 transfer, all-in:   ", vm.toString(INTRINSIC + usedDirectToken)));
        console2.log("direct native send, all-in: 21000 (protocol floor)");
    }

    // --------------------------------------------------------------------------
    // Machinery
    // --------------------------------------------------------------------------

    function _runTable(bool native, uint256 directAllIn) internal {
        nextRecipient = 100; // leave 1..99 for baselines/warmup
        nonceCounter = 0x700000;
        _warm();

        uint256[9] memory sizes = [uint256(1), 2, 3, 4, 5, 10, 25, 50, 100];
        console2.log("N | per-item (marginal) | all-in per withdrawal | vs direct");

        uint256 firstPerItem;
        uint256 lastPerItem;
        uint256 breakEven; // first N whose all-in per withdrawal beats direct
        for (uint256 k; k < sizes.length; ++k) {
            uint256 n = sizes[k];
            uint256 used = _measure(n, native);
            uint256 perItem = used / n;
            uint256 allIn = (INTRINSIC + used) / n;
            _row(n, perItem, allIn, directAllIn);
            if (breakEven == 0 && allIn <= directAllIn) breakEven = n;
            if (k == 0) firstPerItem = perItem;
            lastPerItem = perItem;
        }

        if (breakEven == 0) {
            console2.log("break-even: none within tested sizes");
        } else {
            console2.log(string.concat("break-even batch size: ", vm.toString(breakEven)));
        }

        // Amortization holds and the contract eventually beats direct.
        assertLt(lastPerItem, firstPerItem);
        assertGt(breakEven, 0);
    }

    /// @dev Emit one row: sizes, all-in per withdrawal, and a signed % vs direct.
    function _row(uint256 n, uint256 perItem, uint256 allIn, uint256 directAllIn) internal view {
        string memory delta = allIn <= directAllIn
            ? string.concat("-", vm.toString(((directAllIn - allIn) * 100) / directAllIn), "%")
            : string.concat("+", vm.toString(((allIn - directAllIn) * 100) / directAllIn), "%");
        console2.log(
            string.concat(vm.toString(n), " | ", vm.toString(perItem), " | ", vm.toString(allIn), " | ", delta)
        );
    }

    /// @dev Warm shared state and dirty the delegated EOA's token slot.
    function _warm() internal {
        _measure(1, false);
    }

    /// @dev Cold, standalone direct ERC-20 transfer from an EOA holding the token.
    function _measureDirectToken() internal returns (uint256 used) {
        address to = address(uint160(RECIPIENT_BASE + (nextRecipient == 0 ? 1 : nextRecipient)));
        uint256 g = gasleft();
        token.transfer(to, 1);
        used = g - gasleft();
    }

    /// @dev Build, sign, and execute an `n`-item batch; return gas consumed by the
    ///      `execute` call only.
    function _measure(uint256 n, bool native) internal returns (uint256 used) {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](n);
        for (uint256 i; i < n; ++i) {
            address to = address(uint160(RECIPIENT_BASE + (nextRecipient++)));
            if (native) {
                calls[i] = BitmapNonceDelegate.Call({to: to, value: 1, data: ""});
            } else {
                calls[i] = BitmapNonceDelegate.Call({
                    to: address(token), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", to, 1)
                });
            }
        }

        bytes memory ed = _prep(calls); // reads delegate.hashBatch — before prank

        vm.prank(relayer);
        uint256 g = gasleft();
        delegate.execute(MODE_OPDATA, ed);
        used = g - gasleft();
    }

    /// @dev Execute an `n`-item ERC-20 batch through the pure-batching self path —
    ///      no signature, no nonce. Caller must be the account itself.
    function _measureSelf(uint256 n) internal returns (uint256 used) {
        BitmapNonceDelegate.Call[] memory calls = new BitmapNonceDelegate.Call[](n);
        for (uint256 i; i < n; ++i) {
            address to = address(uint160(RECIPIENT_BASE + (nextRecipient++)));
            calls[i] = BitmapNonceDelegate.Call({
                to: address(token), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", to, 1)
            });
        }
        bytes memory ed = abi.encode(calls);

        vm.prank(delegatedEOA);
        uint256 g = gasleft();
        delegate.execute(MODE_SELF, ed);
        used = g - gasleft();
    }

    function _prep(BitmapNonceDelegate.Call[] memory calls) internal returns (bytes memory) {
        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            intents[i] = BitmapNonceDelegate.PackedIntent(_packed(calls[i].to), calls[i].value, calls[i].data, nonceCounter++);
        }
        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata({
            validAfter: 0, validBefore: block.timestamp + 1 hours, revertOnFailure: true, gasReserve: 40_000
        });
        bytes32 digest = delegate.hashBatch(batch, intents);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        return abi.encode(intents, abi.encode(batch, abi.encodePacked(r, s, v)));
    }

    // A 500,000-gas cap.
    function _packed(address to) internal pure returns (uint256) {
        return uint256(uint160(to)) | (uint256(500_000) << 160);
    }
}
