// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "lib/forge-std/src/Test.sol";
import {console2} from "lib/forge-std/src/console2.sol";
import {MockERC20} from "lib/forge-std/src/mocks/MockERC20.sol";
import {BitmapNonceDelegate} from "../../contracts/delegates/BitmapNonceDelegate.sol";

interface IReplayBenchmarkVm {
    function signAndAttachDelegation(address implementation, uint256 privateKey) external;
    function cool(address target) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshot) external returns (bool);
}

contract BitmapNonceDelegateReplayGasTest is Test {
    struct PackedIntent { uint256 targetAndGasLimit; uint256 value; bytes data; uint256 nonce; }
    struct Batch { uint256 validAfter; uint256 validBefore; bool revertOnFailure; uint64 gasReserve; }

    IReplayBenchmarkVm constant vmReplay = IReplayBenchmarkVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    bytes32 constant SIGNED_MODE = 0x0100000000005041580100000000000000000000000000000000000000000000;
    uint256 constant AUTHORITY_KEY = 0x0117B115;
    // Example allowance for these small-input fixtures, not a contract default.
    uint64 constant BENCHMARK_RESERVE = 42_000;
    BitmapNonceDelegate delegate;
    MockERC20 token;
    uint64 cap;
    uint256 nextId;

    function setUp() public {
        BitmapNonceDelegate implementation = new BitmapNonceDelegate();
        address authority = vm.addr(AUTHORITY_KEY);
        vmReplay.signAndAttachDelegation(address(implementation), AUTHORITY_KEY);
        delegate = BitmapNonceDelegate(payable(authority));
        token = new MockERC20();
        token.initialize("Mock", "MOCK", 18);
        deal(address(token), authority, 1e30);
        vm.deal(authority, 1e24);
        for (uint256 i; i < 101; ++i) {
            address recipient = address(uint160(0x100000 + i));
            deal(address(token), recipient, 1);
            vm.deal(recipient, 1);
        }
    }

    function test_replayGas_erc20SeparateWords() public { _table(0, 256, 500_000); }
    function test_replayGas_nativeEmptyCapped() public { _table(2, 1, 500_000); }
    function test_replayGas_erc20Capped() public { _table(0, 1, 500_000); }
    function test_replayGas_nativeCapped() public { _table(1, 1, 500_000); }

    function _table(uint256 scenario, uint256 stride, uint64 gasLimit) internal {
        cap = gasLimit;
        nextId = 1;
        this.measure(1, 0, 1, 0); // warm implementation/token and dirty nonce word and sender balance
        uint256 snapshot = vmReplay.snapshotState();
        uint256[7] memory sizes = [uint256(1), 2, 5, 10, 25, 50, 100];
        for (uint256 i; i < sizes.length; ++i) {
            assertTrue(vmReplay.revertToState(snapshot));
            (uint256 execution, uint256 calldataGas) = this.measure(sizes[i], scenario, stride, 1);
            console2.log(string.concat(
                "ROW scenario=", vm.toString(scenario), " stride=", vm.toString(stride),
                " cap=", vm.toString(cap),
                " n=", vm.toString(sizes[i]), " execution=", vm.toString(execution),
                " calldata=", vm.toString(calldataGas), " total=", vm.toString(21000 + execution + calldataGas)
            ));
        }
    }

    function measure(uint256 n, uint256 scenario, uint256 stride, uint256 start)
        external returns (uint256 execution, uint256 calldataGas)
    {
        PackedIntent[] memory intents = new PackedIntent[](n);
        for (uint256 i; i < n; ++i) {
            address recipient = address(uint160((scenario == 2 ? 0x200000 : 0x100000) + start + i));
            vmReplay.cool(recipient);
            intents[i] = scenario == 0
                ? PackedIntent(
                    _targetAndGasLimit(address(token)), 0,
                    abi.encodeWithSignature("transfer(address,uint256)", recipient, 1), nextId + i * stride
                )
                : PackedIntent(_targetAndGasLimit(recipient), 1, "", nextId + i * stride);
        }
        bytes memory encoded = _encode(intents);
        calldataGas = _calldataCost(abi.encodeCall(delegate.execute, (SIGNED_MODE, encoded)));
        nextId += n * stride;
        vm.prank(address(0xBEEF));
        uint256 before = gasleft();
        delegate.execute(SIGNED_MODE, encoded);
        execution = before - gasleft();
        for (uint256 i; i < n; ++i) {
            assertTrue(delegate.isNonceUsed(intents[i].nonce));
            address recipient = address(uint160((scenario == 2 ? 0x200000 : 0x100000) + start + i));
            if (scenario == 0) assertEq(token.balanceOf(recipient), 2);
            else assertEq(recipient.balance, scenario == 2 ? 1 : 2);
        }
    }

    function _encode(PackedIntent[] memory intents) internal view returns (bytes memory) {
        Batch memory batch = Batch(0, block.timestamp + 1 hours, true, BENCHMARK_RESERVE);
        (bool hashed, bytes memory result) = address(delegate).staticcall(
            abi.encodeWithSelector(
                bytes4(keccak256("hashBatch((uint256,uint256,bool,uint64),(uint256,uint256,bytes,uint256)[])")),
                batch,
                intents
            )
        );
        require(hashed, "hash failed");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_KEY, abi.decode(result, (bytes32)));
        return abi.encode(intents, abi.encode(batch, abi.encodePacked(r, s, v)));
    }

    function _targetAndGasLimit(address to) internal view returns (uint256) {
        return uint256(uint160(to)) | (uint256(cap) << 160);
    }

    function _calldataCost(bytes memory data) internal pure returns (uint256 cost) {
        for (uint256 i; i < data.length; ++i) cost += data[i] == 0 ? 4 : 16;
    }
}
