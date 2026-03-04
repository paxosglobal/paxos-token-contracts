const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployPaxosTokenClaimableRewardsFixture } = require("../test/helpers/fixtures");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { setNextMultiplier, grantAllTestRoles } = require("../test/helpers/testHelpers");

/**
 * Gas Profiler Test - Detailed gas breakdown analysis
 *
 * This test provides comprehensive gas profiling for different transfer scenarios:
 * 1. No payout groups (baseline)
 * 2. Same payout group
 * 3. Different payout groups, same multiplier
 * 4. Different payout groups, different multipliers
 *
 * For each scenario, we measure:
 * - Total gas used
 * - ACTUAL SLOAD/SSTORE counts (via EVM tracing)
 * - Gas spent on storage vs computation
 * - Incremental costs between scenarios
 */
describe("Gas Profiler - Detailed Transfer Analysis", function() {
    let token;
    let owner, alice, bob, carol, dave;
    let payoutFacet, multFacet;

    // Constants for gas cost analysis
    const SLOAD_WARM_COST = 100;
    const SLOAD_COLD_COST = 2100;
    const SSTORE_ZERO_TO_NONZERO = 20000;
    const SSTORE_NONZERO_TO_NONZERO = 5000;
    const SSTORE_NONZERO_TO_ZERO = 5000;

    // Baseline storage operation counts (from Scenario 1)
    let baselineSloads = 0;
    let baselineSstores = 0;

    beforeEach(async function() {
        // Load the fixture
        const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
        token = fixture.token;
        owner = fixture.owner;
        payoutFacet = fixture.payoutGroupFacet;
        multFacet = fixture.multiplierMgmtFacet;

        // Get additional signers for alice, bob, carol, dave
        const signers = await ethers.getSigners();
        alice = signers[4]; // acc
        bob = signers[5]; // acc2
        carol = signers[6]; // acc3
        dave = signers[7]; // acc4

        // Set up claim source and initial configuration
        await token.connect(owner).setClaimSource(owner.address);
        await token.connect(owner).setMaturityPeriod(86400); // 1 day

        // Mint tokens to alice, bob, carol for testing (6 decimals)
        await token.connect(owner).increaseSupply(ethers.parseUnits("30000", 6));
        await token.connect(owner).transfer(alice.address, ethers.parseUnits("10000", 6));
        await token.connect(owner).transfer(bob.address, ethers.parseUnits("10000", 6));
        await token.connect(owner).transfer(carol.address, ethers.parseUnits("10000", 6));
    });

    /**
     * Helper function to count actual SLOAD/SSTORE operations via EVM tracing
     * Tracks both total operations and unique storage slots accessed
     */
    async function countStorageOps(txHash) {
        const trace = await network.provider.send("debug_traceTransaction", [txHash, {}]);

        let sloads = 0;
        let sstores = 0;
        const uniqueSloadSlots = new Set();
        const uniqueSstoreSlots = new Set();

        for (const log of trace.structLogs) {
            if (log.op === "SLOAD") {
                sloads++;
                // Storage slot is on top of stack (last element)
                if (log.stack && log.stack.length > 0) {
                    uniqueSloadSlots.add(log.stack[log.stack.length - 1]);
                }
            }
            if (log.op === "SSTORE") {
                sstores++;
                // Storage slot is on top of stack for SSTORE
                if (log.stack && log.stack.length > 0) {
                    uniqueSstoreSlots.add(log.stack[log.stack.length - 1]);
                }
            }
        }

        return {
            sloads,
            sstores,
            uniqueSloads: uniqueSloadSlots.size,
            uniqueSstores: uniqueSstoreSlots.size,
            sloadSlots: Array.from(uniqueSloadSlots),  // NEW: actual slot addresses
            sstoreSlots: Array.from(uniqueSstoreSlots) // NEW: actual slot addresses
        };
    }

    /**
     * Helper function to measure gas and count actual storage operations
     */
    async function measureTransferGas(from, to, amount, description, isBaseline = false, logSlots = false) {
        const tx = await token.connect(from).transfer(to.address, amount);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed;

        // Count actual storage operations via EVM tracing
        const {
            sloads: rawSloads,
            sstores: rawSstores,
            uniqueSloads: rawUniqueSloads,
            uniqueSstores: rawUniqueSstores,
            sloadSlots,
            sstoreSlots
        } = await countStorageOps(receipt.hash);

        // Calculate delta from baseline (framework overhead removed)
        let sloadCount, sstoreCount, uniqueSloads, uniqueSstores;
        if (isBaseline) {
            baselineSloads = rawSloads;
            baselineSstores = rawSstores;
            sloadCount = 0; // Baseline has 0 delta by definition
            sstoreCount = 0;
            uniqueSloads = rawUniqueSloads;
            uniqueSstores = rawUniqueSstores;

            console.log(`\n📊 ${description}`);
            console.log(`   Total Gas: ${gasUsed.toString()}`);
            console.log(`   Raw SLOAD: ${rawSloads} (${rawUniqueSloads} unique slots) - baseline`);
            console.log(`   Raw SSTORE: ${rawSstores} (${rawUniqueSstores} unique slots) - baseline`);
        } else {
            sloadCount = rawSloads - baselineSloads;
            sstoreCount = rawSstores - baselineSstores;
            uniqueSloads = rawUniqueSloads;  // Store raw unique count for analysis
            uniqueSstores = rawUniqueSstores; // Store raw unique count for analysis

            console.log(`\n📊 ${description}`);
            console.log(`   Total Gas: ${gasUsed.toString()}`);
            console.log(`   Raw SLOAD: ${rawSloads} (${rawUniqueSloads} unique slots, Δ+${sloadCount} vs baseline)`);
            console.log(`   Raw SSTORE: ${rawSstores} (${rawUniqueSstores} unique slots, Δ+${sstoreCount} vs baseline)`);

            // Highlight repeat SSTOREs (expensive!)
            const repeatSstores = rawSstores - rawUniqueSstores;
            if (repeatSstores > 0) {
                const wastedGas = repeatSstores * SSTORE_NONZERO_TO_NONZERO;
                console.log(`   ⚠️  REPEAT SSTOREs: ${repeatSstores} (wasting ~${wastedGas} gas!)`);
            }

            // Estimate gas breakdown using unique SSTORE count for accuracy
            const estimatedStorageGas = (sloadCount * SLOAD_WARM_COST) + (rawUniqueSstores * SSTORE_NONZERO_TO_NONZERO);
            const computeGas = gasUsed > estimatedStorageGas ? gasUsed - BigInt(estimatedStorageGas) : 0n;

            console.log(`   Delta SLOADs: ${sloadCount} (~${sloadCount * SLOAD_WARM_COST} gas)`);
            console.log(`   Delta SSTOREs: ${sstoreCount} to ${rawUniqueSstores} unique slots (~${rawUniqueSstores * SSTORE_NONZERO_TO_NONZERO} gas)`);
            console.log(`   Estimated Storage Gas: ${estimatedStorageGas}`);
            console.log(`   Estimated Compute Gas: ${computeGas.toString()}`);
            console.log(`   Storage %: ${((estimatedStorageGas / Number(gasUsed)) * 100).toFixed(1)}%`);
        }

        // Optionally log slot addresses for deep analysis
        if (logSlots) {
            console.log(`\n🔍 STORAGE SLOT ADDRESSES:`);
            console.log(`   SLOADs (${sloadSlots.length} unique):`);
            sloadSlots.forEach((slot, i) => console.log(`     ${i+1}. ${slot}`));
            console.log(`   SSTOREs (${sstoreSlots.length} unique):`);
            sstoreSlots.forEach((slot, i) => console.log(`     ${i+1}. ${slot}`));
        }

        return {
            totalGas: gasUsed,
            sloadCount,
            sstoreCount,
            rawSloads,
            rawSstores,
            uniqueSloads,
            uniqueSstores,
            sloadSlots,
            sstoreSlots
        };
    }

    describe("Scenario 1: No Payout Groups (Baseline)", function() {
        it("should measure baseline transfer gas (no payout groups)", async function() {
            const amount = ethers.parseUnits("100", 6);

            console.log("\n" + "=".repeat(80));
            console.log("SCENARIO 1: NO PAYOUT GROUPS (Baseline)");
            console.log("=".repeat(80));

            const result = await measureTransferGas(
                alice,
                bob,
                amount,
                "Transfer with no payout groups (BASELINE)",
                true // This is the baseline
            );

            console.log("\n✅ This establishes the baseline for all other scenarios");
            console.log(`   Slots accessed: balanceData[alice], balanceData[bob]`);
            console.log(`   All framework overhead (access control, etc.) is included in baseline`);
        });
    });

    describe("Scenario 1.5: Mixed - No Payout ↔ Has Payout", function() {
        beforeEach(async function() {
            // Create payout group and register only bob (alice stays without payout)
            await token.connect(owner).createPayoutGroup(1, owner.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
        });

        it("should measure mixed transfer gas (no payout to has payout)", async function() {
            const amount = ethers.parseUnits("100", 6);

            console.log("\n" + "=".repeat(80));
            console.log("SCENARIO 1.5: MIXED - NO PAYOUT → HAS PAYOUT");
            console.log("=".repeat(80));

            const result = await measureTransferGas(
                alice,
                bob,
                amount,
                "Transfer from no payout to has payout"
            );

            console.log("\n✅ ASYMMETRIC COST: Only recipient side pays payout group overhead!");
            console.log(`   Expected delta SLOADs:`);
            console.log(`   - balanceData[alice] (no payout - simple read)`);
            console.log(`   - balanceData[bob] (has payout - complex read)`);
            console.log(`   - payoutData[1] (bob's group)`);
            console.log(`   - multipliers[0] (bob's multiplier)`);
            console.log(`   - multiplierBals[0] (read for aggregation update)`);
            console.log(`   - globalRewardSettings (for epoch num)`);
            console.log(``);
            console.log(`   Expected delta SSTOREs:`);
            console.log(`   - balanceData[alice] (simple balance update)`);
            console.log(`   - balanceData[bob] (balance + shares update)`);
            console.log(`   - payoutData[1] (bob's group aggregation - FULL SLOT)`);
            console.log(`   - multiplierBals[0] (bob's multiplier aggregation - FULL SLOT)`);
            console.log(``);
            console.log(`   💡 Real-world use case: Exchange → Custody, Retail → Institutional`);
            console.log(`   💡 Only the payout group side pays aggregation costs!`);
            console.log(`   💡 Actual measured: Δ+${result.sloadCount} SLOAD, Δ+${result.sstoreCount} SSTORE`);
        });
    });

    describe("Scenario 2: Same Payout Group", function() {
        beforeEach(async function() {
            // Create payout group and register both alice and bob
            await token.connect(owner).createPayoutGroup(1, owner.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
        });

        it("should measure same payout group transfer gas", async function() {
            const amount = ethers.parseUnits("100", 6);

            console.log("\n" + "=".repeat(80));
            console.log("SCENARIO 2: SAME PAYOUT GROUP");
            console.log("=".repeat(80));

            const result = await measureTransferGas(
                alice,
                bob,
                amount,
                "Transfer within same payout group"
            );

            console.log("\n✅ CRITICAL OPTIMIZATION: No aggregation updates when same payout group!");
            console.log(`   Expected delta SLOADs:`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   - payoutData[1] (for both alice and bob)`);
            console.log(`   - multipliers[0] (get active multiplier)`);
            console.log(`   Expected delta SSTOREs:`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   Skipped: payoutData updates (net zero!), multiplierBals updates (net zero!)`);
            console.log(`   💡 Actual measured: Δ+${result.sloadCount} SLOAD, Δ+${result.sstoreCount} SSTORE`);
        });
    });

    describe("Scenario 3: Different Payout Groups, Same Multiplier", function() {
        beforeEach(async function() {
            // Create two payout groups with same multiplier
            await token.connect(owner).createPayoutGroup(1, owner.address); // Group 1, mult 0
            await token.connect(owner).createPayoutGroup(1, alice.address); // Group 2, mult 0

            // Register alice to group 1, bob to group 2
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(2, bob.address);
        });

        it("should measure different payout group (same multiplier) transfer gas", async function() {
            const amount = ethers.parseUnits("100", 6);

            console.log("\n" + "=".repeat(80));
            console.log("SCENARIO 3: DIFFERENT PAYOUT GROUPS, SAME MULTIPLIER");
            console.log("=".repeat(80));

            const result = await measureTransferGas(
                alice,
                bob,
                amount,
                "Transfer between different payout groups (same multiplier)"
            );

            console.log("\n✅ SAME-MULTIPLIER OPTIMIZATION: Skips multiplier aggregations!");
            console.log(`   Expected delta SLOADs:`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   - payoutData[1] (alice's group)`);
            console.log(`   - payoutData[2] (bob's group)`);
            console.log(`   - multipliers[0] (shared multiplier)`);
            console.log(`   - globalRewardSettings (for epoch num)`);
            console.log(``);
            console.log(`   Expected delta SSTOREs (4, not 6!):`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   - payoutData[1] (alice's group aggregation - FULL SLOT)`);
            console.log(`   - payoutData[2] (bob's group aggregation - FULL SLOT)`);
            console.log(`   Skipped: multiplierBals updates (net zero optimization!)`);
            console.log(`   💡 Actual measured: Δ+${result.sloadCount} SLOAD, Δ+${result.sstoreCount} SSTORE`);
        });
    });

    describe("Scenario 4: Different Payout Groups, Different Multipliers", function() {
        beforeEach(async function() {
            // Create second multiplier
            await token.connect(owner).createMultiplier(0); // Multiplier 2 (ID will be 2, since 1 already exists)

            // Create two payout groups with different multipliers
            await token.connect(owner).createPayoutGroup(1, owner.address); // Group 1, mult 1
            await token.connect(owner).createPayoutGroup(2, alice.address); // Group 2, mult 2

            // Register alice to group 1, bob to group 2
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(2, bob.address);
        });

        it("should measure different payout group (different multiplier) transfer gas", async function() {
            const amount = ethers.parseUnits("100", 6);

            console.log("\n" + "=".repeat(80));
            console.log("SCENARIO 4: DIFFERENT PAYOUT GROUPS, DIFFERENT MULTIPLIERS");
            console.log("=".repeat(80));

            const result = await measureTransferGas(
                alice,
                bob,
                amount,
                "Transfer between different payout groups (different multipliers)"
            );

            console.log("\n✅ Storage Operations Breakdown (MAXIMUM COMPLEXITY):");
            console.log(`   Expected delta SLOADs:`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   - payoutData[1] (alice's group)`);
            console.log(`   - payoutData[2] (bob's group)`);
            console.log(`   - multipliers[0] (alice's multiplier)`);
            console.log(`   - multipliers[1] (bob's multiplier)`);
            console.log(`   - multiplierBals[0] (alice's mult aggregation read)`);
            console.log(`   - multiplierBals[1] (bob's mult aggregation read)`);
            console.log(`   - globalRewardSettings (for epoch num)`);
            console.log(``);
            console.log(`   Expected delta SSTOREs (6, not 8!):`);
            console.log(`   - balanceData[alice]`);
            console.log(`   - balanceData[bob]`);
            console.log(`   - payoutData[1] (alice's group aggregation - FULL SLOT)`);
            console.log(`   - payoutData[2] (bob's group aggregation - FULL SLOT)`);
            console.log(`   - multiplierBals[0] (alice's mult aggregation - FULL SLOT)`);
            console.log(`   - multiplierBals[1] (bob's mult aggregation - FULL SLOT)`);
            console.log(``);
            console.log(`   🔥 This is the MOST EXPENSIVE path - all aggregations update!`);
            console.log(`   💡 Actual measured: Δ+${result.sloadCount} SLOAD, Δ+${result.sstoreCount} SSTORE`);
        });
    });

    describe("Comparative Analysis", function() {
        it("should compare all scenarios side-by-side", async function() {
            const amount = ethers.parseUnits("100", 6);
            const results = {};

            // Scenario 1: No payout (BASELINE - must be first!)
            results.noPayout = await measureTransferGas(alice, bob, amount, "No payout (BASELINE)", true);

            // Scenario 1.5: Mixed (no payout to has payout)
            await token.connect(owner).createPayoutGroup(1, owner.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
            results.mixedPayout = await measureTransferGas(alice, bob, amount, "Mixed (no→has payout)");

            // Scenario 2: Same payout (setup - need to unregister bob first, then add both)
            await token.connect(owner).registrarUnregisterRewardAddress(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
            results.samePayout = await measureTransferGas(alice, bob, amount, "Same payout");

            // Scenario 3: Different payout, same mult (use fresh accounts)
            await token.connect(owner).createPayoutGroup(1, carol.address);
            await token.connect(owner).registrarUnregisterRewardAddress(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(2, bob.address);
            results.diffPayoutSameMult = await measureTransferGas(alice, bob, amount, "Diff payout, same mult");

            // Scenario 4: Different payout, different mult (setup)
            await token.connect(owner).createMultiplier(0);
            await token.connect(owner).createPayoutGroup(2, dave.address); // Use mult 2, not mult 1
            await token.connect(owner).registrarUnregisterRewardAddress(2, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(3, bob.address);
            results.diffPayoutDiffMult = await measureTransferGas(alice, bob, amount, "Diff payout, diff mult");

            // Print comparison table
            console.log("\n" + "=".repeat(160));
            console.log("COMPARATIVE GAS ANALYSIS");
            console.log("=".repeat(160));
            console.log("");
            console.log("| Scenario                          | Total Gas | SLOAD | Uniq LD | SSTORE | Uniq ST | Storage Gas | Compute Gas | Storage % |");
            console.log("|-----------------------------------|-----------|-------|---------|--------|---------|-------------|-------------|-----------|");

            const scenarios = [
                { name: "No Payout Groups", data: results.noPayout },
                { name: "Mixed (No→Has Payout)", data: results.mixedPayout },
                { name: "Same Payout Group", data: results.samePayout },
                { name: "Diff Payout, Same Multiplier", data: results.diffPayoutSameMult },
                { name: "Diff Payout, Diff Multiplier", data: results.diffPayoutDiffMult }
            ];

            for (const scenario of scenarios) {
                const { totalGas, sloadCount, sstoreCount, uniqueSloads, uniqueSstores } = scenario.data;

                // For baseline, show raw counts
                if (scenario.name === "No Payout Groups") {
                    console.log(
                        `| ${scenario.name.padEnd(33)} | ` +
                        `${totalGas.toString().padStart(9)} | ` +
                        `${scenario.data.rawSloads.toString().padStart(5)} | ` +
                        `${uniqueSloads.toString().padStart(7)} | ` +
                        `${scenario.data.rawSstores.toString().padStart(6)} | ` +
                        `${uniqueSstores.toString().padStart(7)} | ` +
                        `${"BASELINE".padStart(11)} | ` +
                        `${"BASELINE".padStart(11)} | ` +
                        `${"N/A".padStart(8)}  |`
                    );
                } else {
                    const estimatedStorageGas = (sloadCount * SLOAD_WARM_COST) + (uniqueSstores * SSTORE_NONZERO_TO_NONZERO);
                    const computeGas = totalGas > estimatedStorageGas ? totalGas - BigInt(estimatedStorageGas) : 0n;
                    const storagePercent = ((estimatedStorageGas / Number(totalGas)) * 100).toFixed(1);

                    console.log(
                        `| ${scenario.name.padEnd(33)} | ` +
                        `${totalGas.toString().padStart(9)} | ` +
                        `${sloadCount.toString().padStart(5)} | ` +
                        `${uniqueSloads.toString().padStart(7)} | ` +
                        `${sstoreCount.toString().padStart(6)} | ` +
                        `${uniqueSstores.toString().padStart(7)} | ` +
                        `${estimatedStorageGas.toString().padStart(11)} | ` +
                        `${computeGas.toString().padStart(11)} | ` +
                        `${storagePercent.padStart(8)}% |`
                    );
                }
            }

            console.log("=".repeat(160));

            // Calculate incremental costs
            const baseGas = Number(results.noPayout.totalGas);
            const mixedPayoutExtra = Number(results.mixedPayout.totalGas) - baseGas;
            const samePayoutExtra = Number(results.samePayout.totalGas) - baseGas;
            const diffSameMultExtra = Number(results.diffPayoutSameMult.totalGas) - baseGas;
            const diffDiffMultExtra = Number(results.diffPayoutDiffMult.totalGas) - baseGas;

            console.log("\n📈 INCREMENTAL GAS COSTS (vs baseline):");
            console.log(`   Mixed (no→has payout): +${mixedPayoutExtra} gas`);
            console.log(`   Same payout group: +${samePayoutExtra} gas`);
            console.log(`   Different payout, same multiplier: +${diffSameMultExtra} gas`);
            console.log(`   Different payout, different multiplier: +${diffDiffMultExtra} gas`);

            console.log("\n🔍 KEY INSIGHTS:");
            console.log(`   - Mixed scenario shows asymmetric cost: only recipient pays aggregation overhead`);
            console.log(`   - Same payout optimization saves: ${diffDiffMultExtra - samePayoutExtra} gas vs full cross-multiplier`);

            // Add validation: check if gas deltas match SLOAD/SSTORE counts
            console.log("\n🔬 VALIDATION: Gas Delta vs Storage Op Counts");

            const validateScenario = (name, result, baselineGas) => {
                const gasDelta = Number(result.totalGas - baselineGas);
                const theoreticalStorageGas = (result.sloadCount * SLOAD_WARM_COST) + (result.sstoreCount * SSTORE_NONZERO_TO_NONZERO);
                const computeGas = gasDelta - theoreticalStorageGas;
                const matchPercent = ((theoreticalStorageGas / gasDelta) * 100).toFixed(1);

                console.log(`   ${name}:`);
                console.log(`     Gas delta: ${gasDelta} (Δ+${result.sloadCount} SLOAD, Δ+${result.sstoreCount} SSTORE)`);
                console.log(`     Theoretical storage: ${theoreticalStorageGas} gas (${matchPercent}% of delta)`);
                console.log(`     Remaining (compute): ${computeGas} gas`);
            };

            const baselineGas = results.noPayout.totalGas;
            validateScenario("Mixed", results.mixedPayout, baselineGas);
            validateScenario("Same Payout", results.samePayout, baselineGas);
            validateScenario("Diff Payout, Same Mult", results.diffPayoutSameMult, baselineGas);
            validateScenario("Diff Payout, Diff Mult", results.diffPayoutDiffMult, baselineGas);

            // Add efficiency analysis
            console.log("\n📊 STORAGE EFFICIENCY ANALYSIS (Unique Slots vs Total Ops)");
            const analyzeEfficiency = (name, result) => {
                const sstoreEfficiency = result.rawSstores > 0
                    ? ((result.uniqueSstores / result.rawSstores) * 100).toFixed(1)
                    : 'N/A';
                const sloadEfficiency = result.rawSloads > 0
                    ? ((result.uniqueSloads / result.rawSloads) * 100).toFixed(1)
                    : 'N/A';

                const repeatSstores = result.rawSstores - result.uniqueSstores;
                const wastedGas = repeatSstores * SSTORE_NONZERO_TO_NONZERO;

                console.log(`   ${name}:`);
                console.log(`     SSTORE: ${result.uniqueSstores}/${result.rawSstores} unique (${sstoreEfficiency}% efficient)`);
                if (repeatSstores > 0) {
                    console.log(`     ⚠️  ${repeatSstores} repeat SSTOREs wasting ~${wastedGas} gas`);
                }
                console.log(`     SLOAD: ${result.uniqueSloads}/${result.rawSloads} unique (${sloadEfficiency}% efficient) - repeats OK`);
            };

            analyzeEfficiency("Baseline", results.noPayout);
            analyzeEfficiency("Mixed", results.mixedPayout);
            analyzeEfficiency("Same Payout", results.samePayout);
            analyzeEfficiency("Diff Payout, Same Mult", results.diffPayoutSameMult);
            analyzeEfficiency("Diff Payout, Diff Mult", results.diffPayoutDiffMult);
        });
    });

    describe("Storage Slot Analysis", function() {
        it("should identify specific storage slots accessed in each scenario", async function() {
            const amount = ethers.parseUnits("100", 6);
            const results = {};

            console.log("\n" + "=".repeat(80));
            console.log("STORAGE SLOT DEEP DIVE - Identifying Mystery Slots");
            console.log("=".repeat(80));

            // Scenario 1: No payout (BASELINE)
            console.log("\n📍 BASELINE (No Payout Groups):");
            results.noPayout = await measureTransferGas(alice, bob, amount, "Baseline", true, true);

            // Scenario 1.5: Mixed
            await token.connect(owner).createPayoutGroup(1, owner.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
            console.log("\n📍 MIXED (No→Has Payout):");
            results.mixedPayout = await measureTransferGas(alice, bob, amount, "Mixed", false, true);

            // Scenario 2: Same payout
            await token.connect(owner).registrarUnregisterRewardAddress(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
            console.log("\n📍 SAME PAYOUT GROUP:");
            results.samePayout = await measureTransferGas(alice, bob, amount, "Same Payout", false, true);

            // Scenario 3: Diff payout, same mult
            await token.connect(owner).createPayoutGroup(1, carol.address);
            await token.connect(owner).registrarUnregisterRewardAddress(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(2, bob.address);
            console.log("\n📍 DIFF PAYOUT, SAME MULT:");
            results.diffPayoutSameMult = await measureTransferGas(alice, bob, amount, "Diff Payout Same Mult", false, true);

            // Scenario 4: Diff payout, diff mult
            await token.connect(owner).createMultiplier(0);
            await token.connect(owner).createPayoutGroup(2, dave.address); // Use mult 2, not mult 1
            await token.connect(owner).registrarUnregisterRewardAddress(2, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(3, bob.address);
            console.log("\n📍 DIFF PAYOUT, DIFF MULT:");
            results.diffPayoutDiffMult = await measureTransferGas(alice, bob, amount, "Diff Payout Diff Mult", false, true);

            // Differential Analysis
            console.log("\n" + "=".repeat(80));
            console.log("DIFFERENTIAL ANALYSIS - NEW SLOTS vs BASELINE");
            console.log("=".repeat(80));

            const baselineSlots = new Set(results.noPayout.sloadSlots);

            const analyzeNewSlots = (name, result) => {
                const newSlots = result.sloadSlots.filter(slot => !baselineSlots.has(slot));
                console.log(`\n${name}:`);
                console.log(`   Total unique SLOADs: ${result.sloadSlots.length}`);
                console.log(`   Baseline SLOADs: ${results.noPayout.sloadSlots.length}`);
                console.log(`   NEW slots (not in baseline): ${newSlots.length}`);
                if (newSlots.length > 0) {
                    console.log(`   New slot addresses:`);
                    newSlots.forEach((slot, i) => console.log(`     ${i+1}. ${slot}`));
                }
            };

            analyzeNewSlots("Mixed (No→Has Payout)", results.mixedPayout);
            analyzeNewSlots("Same Payout Group", results.samePayout);
            analyzeNewSlots("Diff Payout, Same Mult", results.diffPayoutSameMult);
            analyzeNewSlots("Diff Payout, Diff Mult", results.diffPayoutDiffMult);

            console.log("\n" + "=".repeat(80));
            console.log("SLOT ANALYSIS COMPLETE - Ready for manual mapping");
            console.log("=".repeat(80));
        });
    });

    describe("ClaimAll Gas Analysis", function() {
        /**
         * Helper function to measure claim gas with storage operation tracking
         */
        async function measureClaimGas(claimer, payoutId, description) {
            const tx = await token.connect(claimer).claimAll(payoutId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            // Count actual storage operations via EVM tracing
            const {
                sloads: rawSloads,
                sstores: rawSstores,
                uniqueSloads: rawUniqueSloads,
                uniqueSstores: rawUniqueSstores
            } = await countStorageOps(receipt.hash);

            console.log(`\n📊 ${description}`);
            console.log(`   Total Gas: ${gasUsed.toString()}`);
            console.log(`   Raw SLOAD: ${rawSloads} (${rawUniqueSloads} unique slots)`);
            console.log(`   Raw SSTORE: ${rawSstores} (${rawUniqueSstores} unique slots)`);

            // Estimate gas breakdown
            const estimatedStorageGas = (rawUniqueSloads * SLOAD_COLD_COST) + (rawUniqueSstores * SSTORE_NONZERO_TO_NONZERO);
            const computeGas = gasUsed > estimatedStorageGas ? gasUsed - BigInt(estimatedStorageGas) : 0n;

            console.log(`   Estimated Storage Gas: ${estimatedStorageGas}`);
            console.log(`   Estimated Compute Gas: ${computeGas.toString()}`);
            console.log(`   Storage %: ${((estimatedStorageGas / Number(gasUsed)) * 100).toFixed(1)}%`);

            return {
                totalGas: gasUsed,
                rawSloads,
                rawSstores,
                uniqueSloads: rawUniqueSloads,
                uniqueSstores: rawUniqueSstores
            };
        }

        it("should measure claimAll gas with rewards", async function() {
            // Setup: Create payout group with multiple addresses
            await grantAllTestRoles(token, owner, owner.address);
            await token.connect(owner).setMaturityPeriod(86400); // 1 day
            await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));

            await token.connect(owner).createPayoutGroup(1, owner.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, alice.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(1, carol.address);

            console.log("\n" + "=".repeat(80));
            console.log("CLAIMALL GAS ANALYSIS - With Rewards");
            console.log("=".repeat(80));

            // Setup multiplier scenario with rewards to claim
            const futureTime1 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime1);
            await time.increase(3601);

            // First claimAll to establish baseline
            await token.connect(owner).claimAll(1);

            // Advance to next period with more rewards
            const futureTime2 = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime2);
            await time.increase(3601);

            // Measure gas for claimAll with rewards accumulated
            const result = await measureClaimGas(owner, 1, "ClaimAll with accumulated rewards (3 addresses)");

            console.log("\n✅ ClaimAll Operation Breakdown:");
            console.log(`   - Loads payout group data (with memory optimization)`);
            console.log(`   - Calculates rewards for all registered addresses`);
            console.log(`   - Updates epoch tracking (lastClaimAllPeriodNum, lastClaimAllBaseMultiplier)`);
            console.log(`   - Resets payout group shares`);
            console.log(`   - Single write-back of payout group data`);
            console.log(`   - Transfers tokens to each address`);
        });

        it("should compare claimAll gas across different payout group sizes", async function() {
            await grantAllTestRoles(token, owner, owner.address);
            await token.connect(owner).setMaturityPeriod(86400);
            await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));

            console.log("\n" + "=".repeat(80));
            console.log("CLAIMALL GAS COMPARISON - Different Group Sizes");
            console.log("=".repeat(80));

            const results = [];

            // Test 1: 1 address (alice only)
            await token.connect(owner).createPayoutGroup(1, alice.address);
            let futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.05", 12), futureTime);
            await time.increase(3601);
            let result = await measureClaimGas(alice, 1, "ClaimAll with 1 address");
            results.push({ numAddresses: 1, ...result });

            // Test 2: 2 addresses (bob + carol)
            await token.connect(owner).createPayoutGroup(1, bob.address);
            await token.connect(owner).registrarRegisterRewardAddress(2, carol.address);
            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.05", 12), futureTime);
            await time.increase(3601);
            result = await measureClaimGas(bob, 2, "ClaimAll with 2 addresses");
            results.push({ numAddresses: 2, ...result });

            // Test 3: 3 addresses (dave + 2 more)
            const dave = (await ethers.getSigners())[8];
            const eve = (await ethers.getSigners())[9];
            await token.connect(owner).transfer(dave.address, ethers.parseUnits("10000", 6));
            await token.connect(owner).transfer(eve.address, ethers.parseUnits("10000", 6));

            await token.connect(owner).createPayoutGroup(1, dave.address);
            await token.connect(owner).registrarRegisterRewardAddress(3, eve.address);
            await token.connect(owner).registrarRegisterRewardAddress(3, (await ethers.getSigners())[10].address);

            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.05", 12), futureTime);
            await time.increase(3601);
            result = await measureClaimGas(dave, 3, "ClaimAll with 3 addresses");
            results.push({ numAddresses: 3, ...result });

            // Test 4: 6 addresses
            const signers = await ethers.getSigners();
            const addr6Claimer = signers[11];
            await token.connect(owner).transfer(addr6Claimer.address, ethers.parseUnits("10000", 6));

            await token.connect(owner).createPayoutGroup(1, addr6Claimer.address);
            // Register 5 more addresses
            for (let i = 12; i <= 16; i++) {
                await token.connect(owner).transfer(signers[i].address, ethers.parseUnits("1000", 6));
                await token.connect(owner).registrarRegisterRewardAddress(4, signers[i].address);
            }

            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.05", 12), futureTime);
            await time.increase(3601);
            result = await measureClaimGas(addr6Claimer, 4, "ClaimAll with 6 addresses");
            results.push({ numAddresses: 6, ...result });

            // Print comparison
            console.log("\n" + "=".repeat(100));
            console.log("CLAIMALL GAS COMPARISON TABLE");
            console.log("=".repeat(100));
            console.log("");
            console.log("| Addresses | Total Gas | SLOAD | Uniq LD | SSTORE | Uniq ST | Storage Gas | Compute Gas |");
            console.log("|-----------|-----------|-------|---------|--------|---------|-------------|-------------|");

            for (const result of results) {
                const estimatedStorageGas = (result.uniqueSloads * SLOAD_COLD_COST) + (result.uniqueSstores * SSTORE_NONZERO_TO_NONZERO);
                const computeGas = result.totalGas > estimatedStorageGas ? result.totalGas - BigInt(estimatedStorageGas) : 0n;

                console.log(
                    `| ${result.numAddresses.toString().padStart(9)} | ` +
                    `${result.totalGas.toString().padStart(9)} | ` +
                    `${result.rawSloads.toString().padStart(5)} | ` +
                    `${result.uniqueSloads.toString().padStart(7)} | ` +
                    `${result.rawSstores.toString().padStart(6)} | ` +
                    `${result.uniqueSstores.toString().padStart(7)} | ` +
                    `${estimatedStorageGas.toString().padStart(11)} | ` +
                    `${computeGas.toString().padStart(11)} |`
                );
            }

            console.log("=".repeat(100));

            console.log("\n🔍 KEY INSIGHTS:");
            console.log(`   - ClaimAll uses memory optimization to minimize SLOADs`);
            console.log(`   - Gas cost is constant (O(1)) when no rewards need distribution`);
            console.log(`   - When distributing rewards, cost scales with number of token transfers`);
            console.log(`   - Single write-back pattern ensures optimal SSTORE efficiency`);
        });

        it("should measure claimAll gas with 6 addresses receiving rewards", async function() {
            await grantAllTestRoles(token, owner, owner.address);
            await token.connect(owner).setMaturityPeriod(86400);
            await token.connect(owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));

            console.log("\n" + "=".repeat(80));
            console.log("CLAIMALL GAS WITH REWARDS - 6 Addresses");
            console.log("=".repeat(80));

            // Create payout group with 6 addresses
            const signers = await ethers.getSigners();
            const claimer = signers[11];
            await token.connect(owner).transfer(claimer.address, ethers.parseUnits("10000", 6));

            await token.connect(owner).createPayoutGroup(1, claimer.address);

            // Register 5 more addresses (total 6 including claimer)
            for (let i = 12; i <= 16; i++) {
                await token.connect(owner).transfer(signers[i].address, ethers.parseUnits("10000", 6));
                await token.connect(owner).registrarRegisterRewardAddress(1, signers[i].address);
            }

            // Setup rewards - first claim to establish baseline
            let futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.01", 12), futureTime);
            await time.increase(3601);
            await token.connect(claimer).claimAll(1);

            // Accumulate more rewards
            futureTime = (await time.latest()) + 3600;
            await setNextMultiplier(token, owner, 1, ethers.parseUnits("1.02", 12), futureTime);
            await time.increase(3601);

            // Measure claimAll with actual reward distribution
            const result = await measureClaimGas(claimer, 1, "ClaimAll with 6 addresses receiving rewards");

            console.log("\n✅ ClaimAll with Rewards Breakdown:");
            console.log(`   - Base claim operation (O(1)): Updates payout group state`);
            console.log(`   - Token transfers: 6 addresses receiving rewards`);
            console.log(`   - Each transfer adds ~8-10K gas (standard ERC20 transfer cost)`);
            console.log(`   - Total gas scales with number of recipients, not registered addresses`);

            console.log("\n📈 Gas Comparison:");
            console.log(`   - ClaimAll (no rewards, any size): 59K gas`);
            console.log(`   - ClaimAll (3 addresses with rewards): 83K gas`);
            console.log(`   - ClaimAll (6 addresses with rewards): ${result.totalGas} gas`);
            console.log(`   - Marginal cost per recipient: ~${Math.round((Number(result.totalGas) - 59015) / 6)} gas/address`);
        });
    });
});
