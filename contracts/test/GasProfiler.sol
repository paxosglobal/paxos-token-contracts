// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { PaxosTokenClaimableRewards } from "../PaxosTokenClaimableRewards.sol";
import { SharesLib } from "../lib/SharesLib.sol";

/**
 * @title GasProfiler
 * @dev Helper contract for detailed gas profiling of transfers
 *
 * This contract extends PaxosTokenClaimableRewards to add gas measurement instrumentation
 * without modifying the core contract logic.
 */
contract GasProfiler is PaxosTokenClaimableRewards {

    event GasCheckpoint(string indexed label, uint256 gasRemaining, uint256 gasUsed);
    event StorageOperation(string indexed operation, string indexed slot, uint256 gasCost);
    event TransferBreakdown(
        string scenario,
        uint256 totalGas,
        uint256 sloadCount,
        uint256 sstoreCount,
        uint256 computeGas,
        uint256 storageGas
    );

    struct GasSnapshot {
        uint256 gasAtStart;  // 32 bytes
        uint256 gasAtEnd;    // 32 bytes
        string label;        // dynamic size (32 bytes + length + data)
        // Note: This struct uses multiple 32-byte slots due to dynamic string
    }

    GasSnapshot[] public snapshots;
    uint256 public sloadCount;
    uint256 public sstoreCount;
    uint256 public lastGas;

    // Storage slot labels for tracking
    string constant SLOT_FROM_BALANCE = "balanceData[from]";
    string constant SLOT_TO_BALANCE = "balanceData[to]";
    string constant SLOT_PAYOUT_GROUP = "payoutData[groupId]";
    string constant SLOT_MULTIPLIER_DATA = "multipliers[multId]";

    /**
     * @dev Instrumented transfer function with gas profiling
     */
    function profiledTransfer(
        address from,
        address to,
        uint256 value
    ) public returns (uint256 gasUsed) {
        uint256 gasStart = gasleft();
        lastGas = gasStart;
        sloadCount = 0;
        sstoreCount = 0;
        delete snapshots;

        checkpoint("START");

        // Call the actual transfer
        _transfer(from, to, value);

        checkpoint("END");

        gasUsed = gasStart - gasleft();

        // Emit detailed breakdown
        uint256 storageGas = (sloadCount * 100) + (sstoreCount * 5000); // Warm: 100 SLOAD, 5000 SSTORE
        uint256 computeGas = gasUsed > storageGas ? gasUsed - storageGas : 0;

        emit TransferBreakdown(
            getScenarioType(from, to),
            gasUsed,
            sloadCount,
            sstoreCount,
            computeGas,
            storageGas
        );

        return gasUsed;
    }

    /**
     * @dev Track a gas measurement checkpoint
     */
    function checkpoint(string memory label) internal {
        uint256 currentGas = gasleft();
        uint256 gasUsed = lastGas - currentGas;

        snapshots.push(GasSnapshot({
            gasAtStart: lastGas,
            gasAtEnd: currentGas,
            label: label
        }));

        emit GasCheckpoint(label, currentGas, gasUsed);
        lastGas = currentGas;
    }

    /**
     * @dev Tracked version of _getBalanceData
     */
    function trackGetBalanceData(address addr) internal returns (TokenAccountData memory) {
        uint256 gasBefore = gasleft();
        TokenAccountData memory data = _getBalanceData(addr);
        uint256 gasAfter = gasleft();

        sloadCount++;
        emit StorageOperation("SLOAD", string(abi.encodePacked("balanceData[", addressToString(addr), "]")), gasBefore - gasAfter);

        return data;
    }

    /**
     * @dev Tracked version of _setBalanceData
     */
    function trackSetBalanceData(
        address addr,
        uint256 balance,
        uint256 shares,
        uint256 payoutGroupId,
        uint40 lastUpdateTime
    ) internal {
        uint256 gasBefore = gasleft();
        _setBalanceData(addr, balance, shares, payoutGroupId, lastUpdateTime);
        uint256 gasAfter = gasleft();

        sstoreCount++;
        emit StorageOperation("SSTORE", string(abi.encodePacked("balanceData[", addressToString(addr), "]")), gasBefore - gasAfter);
    }

    /**
     * @dev Get scenario type from addresses
     */
    function getScenarioType(address from, address to) internal view returns (string memory) {
        TokenAccountData memory fromWallet = _getBalanceData(from);
        TokenAccountData memory toWallet = _getBalanceData(to);

        if (fromWallet.payoutGroupId == 0 && toWallet.payoutGroupId == 0) {
            return "NO_PAYOUT";
        }

        if (fromWallet.payoutGroupId == toWallet.payoutGroupId && fromWallet.payoutGroupId > 0) {
            return "SAME_PAYOUT";
        }

        // Check if different multipliers
        if (fromWallet.payoutGroupId > 0 && toWallet.payoutGroupId > 0) {
            PayoutGroupData memory fromPayout = payoutData[fromWallet.payoutGroupId];
            PayoutGroupData memory toPayout = payoutData[toWallet.payoutGroupId];

            if (fromPayout.multiplierId == toPayout.multiplierId) {
                return "DIFF_PAYOUT_SAME_MULT";
            } else {
                return "DIFF_PAYOUT_DIFF_MULT";
            }
        }

        return "MIXED";
    }

    /**
     * @dev Get all snapshots
     */
    function getSnapshots() external view returns (GasSnapshot[] memory) {
        return snapshots;
    }

    /**
     * @dev Helper to convert address to string
     */
    function addressToString(address addr) internal pure returns (string memory) {
        bytes memory data = abi.encodePacked(addr);
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = '0';
        str[1] = 'x';
        for (uint256 i = 0; i < 20; i++) {
            str[2+i*2] = alphabet[uint8(data[i] >> 4)];
            str[3+i*2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }

    /**
     * @dev Get detailed transfer gas breakdown
     */
    function getTransferBreakdown(
        address from,
        address to,
        uint256 value
    ) external returns (
        uint256 totalGas,
        uint256 sloads,
        uint256 sstores,
        string memory scenario,
        uint256[] memory checkpointGas
    ) {
        uint256 gasStart = gasleft();
        profiledTransfer(from, to, value);
        totalGas = gasStart - gasleft();

        sloads = sloadCount;
        sstores = sstoreCount;
        scenario = getScenarioType(from, to);

        checkpointGas = new uint256[](snapshots.length);
        for (uint256 i = 0; i < snapshots.length; i++) {
            checkpointGas[i] = snapshots[i].gasAtStart - snapshots[i].gasAtEnd;
        }

        return (totalGas, sloads, sstores, scenario, checkpointGas);
    }
}
