// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "lib/forge-std/src/Test.sol";
import {MockERC20} from "lib/forge-std/src/mocks/MockERC20.sol";
import {BitmapNonceDelegate} from "../../contracts/delegates/BitmapNonceDelegate.sol";

/// @dev Binding for the EIP-7702 cheatcode missing from the pinned forge-std version.
interface IVm7702 {
    function signAndAttachDelegation(address implementation, uint256 privateKey) external;
}

/// @notice End-to-end exercise of the delegate running in an EIP-7702-delegated EOA.
contract BitmapNonceDelegate7702E2ETest is Test {
    IVm7702 internal constant vm7702 = IVm7702(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    BitmapNonceDelegate internal impl;
    MockERC20 internal token;

    uint256 internal delegatedEOAPk = 0x0117B115;
    address internal delegatedEOA;
    address internal relayer = address(0xBEEF);
    address internal recipient = address(0xCAFE);

    bytes32 internal MODE_OPDATA;

    function setUp() public {
        delegatedEOA = vm.addr(delegatedEOAPk);

        impl = new BitmapNonceDelegate();
        MODE_OPDATA = impl.MODE_SIGNED_BATCH();

        token = new MockERC20();
        token.initialize("Mock", "MOCK", 18);
        deal(address(token), delegatedEOA, 1_000_000e18);
        vm.deal(delegatedEOA, 100 ether);
    }

    function test_e2e_delegatedEOAExecutesSignedBatch() public {
        vm7702.signAndAttachDelegation(address(impl), delegatedEOAPk);
        assertEq(delegatedEOA.code.length, 23);

        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](2);
        intents[0] = BitmapNonceDelegate.PackedIntent({
            targetAndGasLimit: _packed(address(token)), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 250e18), nonce: 1});
        intents[1] = BitmapNonceDelegate.PackedIntent({targetAndGasLimit: _packed(recipient), value: 2 ether, data: "", nonce: 2});

        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata({
            validAfter: 0, validBefore: block.timestamp + 1 hours, revertOnFailure: true, gasReserve: 40_000
        });

        bytes32 digest = BitmapNonceDelegate(payable(delegatedEOA)).hashBatch(batch, intents);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        bytes memory ed = abi.encode(intents, abi.encode(batch, abi.encodePacked(r, s, v)));

        uint256 delegatedEOATokenBefore = token.balanceOf(delegatedEOA);
        uint256 delegatedEOAEthBefore = delegatedEOA.balance;

        vm.prank(relayer);
        BitmapNonceDelegate(payable(delegatedEOA)).execute(MODE_OPDATA, ed);

        assertEq(token.balanceOf(recipient), 250e18);
        assertEq(recipient.balance, 2 ether);
        assertEq(token.balanceOf(delegatedEOA), delegatedEOATokenBefore - 250e18);
        assertEq(delegatedEOA.balance, delegatedEOAEthBefore - 2 ether);
        assertTrue(BitmapNonceDelegate(payable(delegatedEOA)).isNonceUsed(1));
        assertTrue(BitmapNonceDelegate(payable(delegatedEOA)).isNonceUsed(2));
    }

    function test_e2e_replayAcrossAccountsRejected() public {
        vm7702.signAndAttachDelegation(address(impl), delegatedEOAPk);

        uint256 otherPk = 0x0227B225;
        address other = vm.addr(otherPk);
        deal(address(token), other, 1_000_000e18);
        vm7702.signAndAttachDelegation(address(impl), otherPk);

        BitmapNonceDelegate.PackedIntent[] memory intents = new BitmapNonceDelegate.PackedIntent[](1);
        intents[0] = BitmapNonceDelegate.PackedIntent({
            targetAndGasLimit: _packed(address(token)), value: 0, data: abi.encodeWithSignature("transfer(address,uint256)", recipient, 1e18), nonce: 1});
        BitmapNonceDelegate.BatchMetadata memory batch = BitmapNonceDelegate.BatchMetadata({
            validAfter: 0, validBefore: block.timestamp + 1 hours, revertOnFailure: true, gasReserve: 40_000
        });

        bytes32 digest = BitmapNonceDelegate(payable(delegatedEOA)).hashBatch(batch, intents);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(delegatedEOAPk, digest);
        bytes memory ed = abi.encode(intents, abi.encode(batch, abi.encodePacked(r, s, v)));

        vm.prank(relayer);
        vm.expectRevert(BitmapNonceDelegate.InvalidSigner.selector);
        BitmapNonceDelegate(payable(other)).execute(MODE_OPDATA, ed);
    }

    // A 500,000-gas cap.
    function _packed(address to) internal pure returns (uint256) {
        return uint256(uint160(to)) | (uint256(500_000) << 160);
    }
}
