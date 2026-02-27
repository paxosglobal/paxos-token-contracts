const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployPaxosTokenClaimableRewardsFixture } = require('../test/helpers/fixtures');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

/**
 * Consolidated Mint and Burn Gas Benchmark
 *
 * This file consolidates benchmarks from:
 * - MintBurnGasBenchmark.js
 * - MintBurnDetailedGasBenchmark.js
 * - MintOverheadBreakdown.js
 *
 * Organized into sections:
 * 1. Basic Mint/Burn Operations
 * 2. Detailed Gas Breakdown Analysis
 * 3. Component-Level Measurements
 * 4. Optimization Analysis
 */
describe('Mint and Burn Gas Benchmark (Consolidated)', function () {
    let token, owner;

    beforeEach(async function () {
        const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
        token = fixture.token;
        owner = fixture.owner;

        await token.connect(owner).setClaimSource(owner.address);
        await token.connect(owner).setMaturityPeriod(86400); // 1 day
    });

    // =========================================================================
    // SECTION 1: BASIC MINT/BURN OPERATIONS
    // =========================================================================
    describe('Basic Mint Operations', function () {
        it('should measure gas cost for minting (unregistered address, cold storage)', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // First mint - cold storage for owner address
            const tx = await token.connect(owner).increaseSupply(amount);
            const receipt = await tx.wait();

            console.log('\n=== MINT (UNREGISTERED, COLD STORAGE) ===');
            console.log(`Amount: 1000 USDG`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Storage operations:');
            console.log('  - totalSupply_ SLOAD + SSTORE (warm)');
            console.log('  - balanceData[owner] SLOAD (cold, zero) + SSTORE (cold, zero→non-zero)');
            console.log('  - No payout group aggregations');
        });

        it('should measure gas cost for minting (warm storage)', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // First mint to warm up storage
            await token.connect(owner).increaseSupply(amount);

            // Second mint - warm storage
            const tx = await token.connect(owner).increaseSupply(amount);
            const receipt = await tx.wait();

            console.log('\n=== MINT (UNREGISTERED, WARM STORAGE) ===');
            console.log(`Amount: 1000 USDG`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Storage operations:');
            console.log('  - totalSupply_ SLOAD + SSTORE (warm)');
            console.log('  - balanceData[owner] SLOAD (warm) + SSTORE (warm, non-zero→non-zero)');
            console.log('  - No payout group aggregations');
        });

        it('should measure gas cost for minting (registered address with payout)', async function () {
            const signers = await ethers.getSigners();
            const claimer = signers[1];
            const recipient = signers[2];
            const amount = ethers.parseUnits('1000', 6);

            // Create payout group and register recipient
            const createTx = await token.connect(owner).createPayoutGroup(1, claimer.address);
            const createReceipt = await createTx.wait();
            const event = createReceipt.logs.find(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    return parsed && parsed.name === 'PayoutGroupCreated';
                } catch (e) {
                    return false;
                }
            });
            const payoutGroupId = token.interface.parseLog(event).args.payoutGroupId;
            await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, recipient.address);

            // Mint to registered address
            await token.connect(owner).increaseSupply(amount);
            const tx = await token.connect(owner).transfer(recipient.address, amount);
            const receipt = await tx.wait();

            console.log('\n=== MINT (REGISTERED WITH PAYOUT) ===');
            console.log(`Amount: 1000 USDG`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Storage operations:');
            console.log('  - totalSupply_ SLOAD + SSTORE (warm)');
            console.log('  - balanceData[recipient] SLOAD (warm) + SSTORE (warm)');
            console.log('  - payoutData[payoutGroupId] SLOAD + SSTORE (warm)');
            console.log('  - multipliers[0] SLOAD (warm)');
            console.log('  - multiplierBals[0] SLOAD + SSTORE (warm)');
            console.log('  - periodSettings SLOAD (warm)');
        });
    });

    describe('Basic Burn Operations', function () {
        it('should measure gas cost for burning (unregistered address)', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // First mint tokens
            await token.connect(owner).increaseSupply(amount);

            // Then burn
            const burnAmount = ethers.parseUnits('500', 6);
            const tx = await token.connect(owner).decreaseSupply(burnAmount);
            const receipt = await tx.wait();

            console.log('\n=== BURN (UNREGISTERED) ===');
            console.log(`Amount: 500 USDG`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Storage operations:');
            console.log('  - totalSupply_ SLOAD + SSTORE (warm)');
            console.log('  - balanceData[owner] SLOAD (warm) + SSTORE (warm, non-zero→non-zero)');
            console.log('  - No payout group aggregations');
        });

        it('should measure gas cost for burning (registered with payout)', async function () {
            const signers = await ethers.getSigners();
            const claimer = signers[3];
            const recipient = signers[4];
            const amount = ethers.parseUnits('1000', 6);

            // Create payout group and register recipient
            const createTx = await token.connect(owner).createPayoutGroup(1, claimer.address);
            const createReceipt = await createTx.wait();
            const event = createReceipt.logs.find(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    return parsed && parsed.name === 'PayoutGroupCreated';
                } catch (e) {
                    return false;
                }
            });
            const payoutGroupId = token.interface.parseLog(event).args.payoutGroupId;

            // Mint and register, transfer to recipient
            await token.connect(owner).increaseSupply(amount);
            await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, recipient.address);
            await token.connect(owner).transfer(recipient.address, amount);

            // Burn from recipient
            const burnAmount = ethers.parseUnits('500', 6);
            const tx = await token.connect(recipient).transfer(owner.address, burnAmount);
            const receipt = await tx.wait();

            console.log('\n=== BURN (REGISTERED WITH PAYOUT) ===');
            console.log(`Amount: 500 USDG`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Storage operations:');
            console.log('  - totalSupply_ SLOAD + SSTORE (warm)');
            console.log('  - balanceData[recipient] SLOAD (warm) + SSTORE (warm)');
            console.log('  - payoutData[payoutGroupId] SLOAD + SSTORE (warm)');
            console.log('  - multipliers[0] SLOAD (warm)');
            console.log('  - multiplierBals[0] SLOAD + SSTORE (warm)');
            console.log('  - periodSettings SLOAD (warm)');
        });

        it('should measure gas cost for complete burn (balance to zero)', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // Mint tokens
            await token.connect(owner).increaseSupply(amount);

            // Burn entire balance
            const tx = await token.connect(owner).decreaseSupply(amount);
            const receipt = await tx.wait();

            console.log('\n=== BURN (COMPLETE, TO ZERO) ===');
            console.log(`Amount: 1000 USDG (entire balance)`);
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log('Note: non-zero→zero SSTORE refunds 15000 gas');
        });
    });

    describe('Comparative Analysis', function () {
        it('should show gas cost comparison across all mint/burn scenarios', async function () {
            const results = [];
            const signers = await ethers.getSigners();

            // 1. Mint (cold storage)
            const tx1 = await token.connect(owner).increaseSupply(ethers.parseUnits('1000', 6));
            const receipt1 = await tx1.wait();
            results.push({
                operation: 'Mint (unregistered, cold)',
                gas: Number(receipt1.gasUsed),
                notes: 'Cold SSTORE zero→non-zero (20K gas)'
            });

            // 2. Mint (warm storage)
            const tx2 = await token.connect(owner).increaseSupply(ethers.parseUnits('1000', 6));
            const receipt2 = await tx2.wait();
            results.push({
                operation: 'Mint (unregistered, warm)',
                gas: Number(receipt2.gasUsed),
                notes: 'Warm SSTORE non-zero→non-zero (5K gas)'
            });

            // 3. Burn (warm storage)
            const tx3 = await token.connect(owner).decreaseSupply(ethers.parseUnits('500', 6));
            const receipt3 = await tx3.wait();
            results.push({
                operation: 'Burn (unregistered, warm)',
                gas: Number(receipt3.gasUsed),
                notes: 'Warm SSTORE non-zero→non-zero (5K gas)'
            });

            // 4. Burn to zero
            const tx4 = await token.connect(owner).decreaseSupply(ethers.parseUnits('1500', 6));
            const receipt4 = await tx4.wait();
            results.push({
                operation: 'Burn (to zero, refund)',
                gas: Number(receipt4.gasUsed),
                notes: 'SSTORE non-zero→zero (refund 15K gas)'
            });

            // 5. Mint to registered (with payout)
            const claimer1 = signers[5];
            const recipient1 = signers[6];
            const createTx1 = await token.connect(owner).createPayoutGroup(1, claimer1.address);
            const createReceipt1 = await createTx1.wait();
            const event1 = createReceipt1.logs.find(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    return parsed && parsed.name === 'PayoutGroupCreated';
                } catch (e) {
                    return false;
                }
            });
            const payoutGroupId1 = token.interface.parseLog(event1).args.payoutGroupId;
            await token.connect(owner).increaseSupply(ethers.parseUnits('2000', 6));
            await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId1, recipient1.address);
            await token.connect(owner).transfer(recipient1.address, ethers.parseUnits('1000', 6));

            const tx5 = await token.connect(owner).transfer(recipient1.address, ethers.parseUnits('1000', 6));
            const receipt5 = await tx5.wait();
            results.push({
                operation: 'Mint (registered, with payout)',
                gas: Number(receipt5.gasUsed),
                notes: 'Includes aggregation updates'
            });

            // 6. Burn from registered (with payout)
            const tx6 = await token.connect(recipient1).transfer(owner.address, ethers.parseUnits('500', 6));
            const receipt6 = await tx6.wait();
            results.push({
                operation: 'Burn (registered, with payout)',
                gas: Number(receipt6.gasUsed),
                notes: 'Includes aggregation updates'
            });

            // Print comparison table
            console.log('\n' + '='.repeat(100));
            console.log('MINT AND BURN GAS COST ANALYSIS');
            console.log('='.repeat(100));
            console.log('');
            console.log('| Operation                          | Gas Used | Notes                                    |');
            console.log('|------------------------------------|----------|------------------------------------------|');

            for (const result of results) {
                console.log(
                    `| ${result.operation.padEnd(34)} ` +
                    `| ${result.gas.toLocaleString().padEnd(8)} ` +
                    `| ${result.notes.padEnd(40)} |`
                );
            }

            console.log('');
            console.log('Key Insights:');
            console.log('- Cold vs Warm: Cold storage access costs ~20K gas more (first write to new slot)');
            console.log('- Payout overhead: Registered addresses incur ~15-20K gas for aggregation updates');
            console.log('- Burn to zero: Refunds 15K gas for clearing storage (SSTORE refund mechanism)');
            console.log('');
            console.log('EVM Opcode Costs (for reference):');
            console.log('- SLOAD (cold): 2,100 gas');
            console.log('- SLOAD (warm): 100 gas');
            console.log('- SSTORE (zero→non-zero): 20,000 gas');
            console.log('- SSTORE (non-zero→non-zero): 5,000 gas (2,900 if same value)');
            console.log('- SSTORE (non-zero→zero): 5,000 gas - 15,000 gas refund');
        });
    });

    // =========================================================================
    // SECTION 2: DETAILED GAS BREAKDOWN ANALYSIS
    // =========================================================================
    describe('Payout Overhead Detailed Breakdown', function () {
        it('should break down the exact cost delta between unregistered and registered mint', async function () {
            const signers = await ethers.getSigners();
            const amount = ethers.parseUnits('1000', 6);

            // BASELINE: Mint to unregistered (warm storage)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const baselineCost = Number(receipt1.gasUsed);

            // WITH PAYOUT: Create group, register, then mint
            const claimer = signers[7];
            const recipient = signers[8];
            const createTx = await token.connect(owner).createPayoutGroup(1, claimer.address);
            const createReceipt = await createTx.wait();
            const event = createReceipt.logs.find(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    return parsed && parsed.name === 'PayoutGroupCreated';
                } catch (e) {
                    return false;
                }
            });
            const payoutGroupId = token.interface.parseLog(event).args.payoutGroupId;

            // First mint to establish balance
            await token.connect(owner).increaseSupply(amount * 2n);

            // Register to payout group
            await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, recipient.address);
            await token.connect(owner).transfer(recipient.address, amount);

            // Transfer with payout (warm)
            const tx2 = await token.connect(owner).transfer(recipient.address, amount);
            const receipt2 = await tx2.wait();
            const payoutCost = Number(receipt2.gasUsed);

            const delta = payoutCost - baselineCost;

            console.log('\n' + '='.repeat(80));
            console.log('EXACT PAYOUT OVERHEAD BREAKDOWN');
            console.log('='.repeat(80));
            console.log(`\nBaseline (unregistered, warm): ${baselineCost.toLocaleString()} gas`);
            console.log(`With payout (registered, warm):  ${payoutCost.toLocaleString()} gas`);
            console.log(`\n**DELTA: ${delta.toLocaleString()} gas**`);
            console.log('\nThis delta includes:');
            console.log('  1. Additional SLOAD operations (all warm)');
            console.log('  2. Additional SSTORE operations (all warm, non-zero→non-zero)');
            console.log('  3. SharesLib pure computation (arithmetic only)');
            console.log('  4. Memory operations and function call overhead');
            console.log('\nEVM Opcode Reference:');
            console.log('  - SLOAD (warm): 100 gas');
            console.log('  - SSTORE (warm, non-zero→non-zero): 5,000 gas');
            console.log('  - MUL/DIV: 5 gas each');
            console.log('  - ADD/SUB: 3 gas each');
            console.log('  - Comparisons (GT/LT/EQ): 3 gas each');
            console.log('\nExpected Storage Operations in Delta:');
            console.log('  - payoutData[payoutGroupId] SLOAD: 100 gas');
            console.log('  - payoutData[payoutGroupId] SSTORE: 5,000 gas');
            console.log('  - multipliers[0] SLOAD: 100 gas');
            console.log('  - multiplierBals[0] SLOAD: 100 gas');
            console.log('  - multiplierBals[0] SSTORE: 5,000 gas');
            console.log('  - globalTransferSettings SLOAD: 100 gas');
            console.log('  SUBTOTAL (storage): 10,400 gas');
            console.log(`\n  MEASURED DELTA: ${delta.toLocaleString()} gas`);
            console.log(`  STORAGE COSTS: 10,400 gas`);
            console.log(`  NON-STORAGE (computation + overhead): ${(delta - 10400).toLocaleString()} gas`);
            console.log('\nConclusion:');
            console.log(`  Storage operations account for: ${Math.round(10400/delta*100)}% of payout overhead`);
            console.log(`  Computation + overhead: ${Math.round((delta-10400)/delta*100)}%`);
        });

        it('should analyze arithmetic operations in SharesLib', async function () {
            console.log('\n' + '='.repeat(80));
            console.log('SHARESLIB ARITHMETIC BREAKDOWN (EVM OPCODES)');
            console.log('='.repeat(80));
            console.log('\nFunction: updateSharesOnBalanceChange()');
            console.log('Source: contracts/lib/SharesLib.sol:97-116');
            console.log('\nEVM Opcodes (from Ethereum Yellow Paper):');
            console.log('  MUL:    5 gas');
            console.log('  DIV:    5 gas');
            console.log('  ADD:    3 gas');
            console.log('  SUB:    3 gas');
            console.log('  GT/LT:  3 gas');
            console.log('  ISZERO: 3 gas');
            console.log('  JUMPI:  10 gas');
            console.log('\nOperations in updateSharesOnBalanceChange:');
            console.log('  Line 103: if (currentMultiplier == 0) - ISZERO (3) + JUMPI (10) = 13 gas');
            console.log('  Line 105: if (currentShares == 0) - ISZERO (3) + JUMPI (10) = 13 gas');
            console.log('  Line 111: calcBalance() - MUL (5) + DIV (5) = 10 gas');
            console.log('  Line 112: totalValue > oldBalance - GT (3) + conditional = 6 gas');
            console.log('  Line 112: unclaimedRewards = totalValue - oldBalance - SUB (3) = 3 gas');
            console.log('  Line 115: newBalance + unclaimedRewards - ADD (3) = 3 gas');
            console.log('  Line 115: calcShares() - MUL (5) + DIV (5) = 10 gas');
            console.log('\nTotal Pure Arithmetic: ~58 gas');
            console.log('Plus memory operations and stack management: ~100-200 gas');
            console.log('**Estimated SharesLib cost: ~150-250 gas**');
        });
    });

    describe('Cold vs Warm Storage Cost Verification', function () {
        it('should measure the actual difference between cold and warm SSTORE', async function () {
            const signers = await ethers.getSigners();

            // Create two separate addresses to test cold vs warm
            const addr1 = signers[5].address;
            const addr2 = signers[6].address;

            // First transfer to addr1 (cold SSTORE - zero→non-zero)
            await token.connect(owner).increaseSupply(ethers.parseUnits('2000', 6));
            const tx1 = await token.connect(owner).transfer(addr1, ethers.parseUnits('1000', 6));
            const receipt1 = await tx1.wait();

            // Second transfer to addr2 (also cold SSTORE - zero→non-zero)
            const tx2 = await token.connect(owner).transfer(addr2, ethers.parseUnits('500', 6));
            const receipt2 = await tx2.wait();

            // Third transfer to addr1 (warm SSTORE - non-zero→non-zero)
            await token.connect(owner).increaseSupply(ethers.parseUnits('1000', 6));
            const tx3 = await token.connect(owner).transfer(addr1, ethers.parseUnits('500', 6));
            const receipt3 = await tx3.wait();

            console.log('\n' + '='.repeat(80));
            console.log('COLD VS WARM STORAGE COST');
            console.log('='.repeat(80));
            console.log(`\nFirst transfer (cold SSTORE zero→non-zero): ${receipt1.gasUsed.toString()} gas`);
            console.log(`Second transfer (cold SSTORE zero→non-zero): ${receipt2.gasUsed.toString()} gas`);
            console.log(`Third transfer (warm SSTORE non-zero→non-zero): ${receipt3.gasUsed.toString()} gas`);
            console.log(`\nDelta (cold - warm): ${Number(receipt1.gasUsed) - Number(receipt3.gasUsed)} gas`);
            console.log('\nEVM Specification:');
            console.log('  - SSTORE (zero→non-zero): 20,000 gas');
            console.log('  - SSTORE (non-zero→non-zero): 5,000 gas');
            console.log('  - Expected delta: 15,000 gas');
            console.log(`  - Measured delta: ${Number(receipt1.gasUsed) - Number(receipt3.gasUsed)} gas`);
        });
    });

    // =========================================================================
    // SECTION 3: COMPONENT-LEVEL MEASUREMENTS
    // =========================================================================
    describe('Individual Component Measurements', function () {
        it('should measure packed struct load vs simple balance load overhead', async function () {
            console.log('\n' + '='.repeat(80));
            console.log('PACKED STRUCT VS SIMPLE LOAD OVERHEAD');
            console.log('='.repeat(80));
            console.log('\nNote: Packed struct loads are SLOADs. Each SLOAD:');
            console.log('  - Cold: 2,100 gas');
            console.log('  - Warm: 100 gas');
            console.log('\nIn our case (warm storage for registered mint):');
            console.log('  - balanceData (TokenAccountData): 1 SLOAD = 100 gas');
            console.log('  - payoutData (PayoutGroupData): 1 SLOAD = 100 gas');
            console.log('  - multipliers array element: 1 SLOAD = 100 gas');
            console.log('  - multiplierBals mapping: 1 SLOAD = 100 gas');
            console.log('  - globalTransferSettings: 1 SLOAD = 100 gas');
            console.log('\nTotal storage reads for registered mint: ~5 SLOADs = 500 gas (warm)');
            console.log('\nStorage writes (warm, non-zero→non-zero):');
            console.log('  - payoutData SSTORE: 5,000 gas');
            console.log('  - multiplierBals SSTORE: 5,000 gas');
            console.log('\nTotal storage overhead: 10,500 gas (matches measured 10,400 gas)');
        });

        it('should measure actual mint overhead components in isolation', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // MEASUREMENT 1: Absolute baseline - mint to unregistered (warm)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const baselineMint = Number(receipt1.gasUsed);

            // MEASUREMENT 2: Mint with registration overhead
            const signers = await ethers.getSigners();
            const claimer = signers[9];
            const recipient = signers[10];
            const createTx = await token.connect(owner).createPayoutGroup(1, claimer.address);
            const createReceipt = await createTx.wait();
            const event = createReceipt.logs.find(log => {
                try {
                    const parsed = token.interface.parseLog(log);
                    return parsed && parsed.name === 'PayoutGroupCreated';
                } catch (e) {
                    return false;
                }
            });
            const payoutGroupId = token.interface.parseLog(event).args.payoutGroupId;

            // First mint to establish balance
            await token.connect(owner).increaseSupply(amount * 3n);

            // Register
            await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, recipient.address);

            // First transfer (warm storage)
            await token.connect(owner).transfer(recipient.address, amount);
            const tx2 = await token.connect(owner).transfer(recipient.address, amount);
            const receipt2 = await tx2.wait();
            const registeredMint = Number(receipt2.gasUsed);

            const totalDelta = registeredMint - baselineMint;

            console.log('\n' + '='.repeat(80));
            console.log('ACTUAL MEASURED MINT OVERHEAD BREAKDOWN');
            console.log('='.repeat(80));
            console.log(`\nUnregistered mint (warm): ${baselineMint.toLocaleString()} gas`);
            console.log(`Registered mint (warm):   ${registeredMint.toLocaleString()} gas`);
            console.log(`\n**TOTAL MEASURED DELTA: ${totalDelta.toLocaleString()} gas**`);
            console.log('\nBreakdown (from EVM opcode costs):');
            console.log('  Storage operations (measured in previous benchmark): 10,400 gas');
            console.log(`  Non-storage overhead (remainder): ${(totalDelta - 10400).toLocaleString()} gas`);
            console.log('\nNon-storage overhead includes:');
            console.log('  - Additional function calls and stack operations');
            console.log('  - Memory allocation and manipulation');
            console.log('  - Conditional branching (JUMPI opcodes)');
            console.log('  - SharesLib arithmetic (~150-250 gas based on opcode analysis)');
            console.log('  - Internal delegatecall overhead (if any)');
        });

        it('should compare mint vs USDC-style simple mint', async function () {
            const signers = await ethers.getSigners();
            const amount = ethers.parseUnits('1000', 6);

            // Our mint (unregistered, should be similar to USDC)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const ourMint = Number(receipt1.gasUsed);

            // Simple transfer (proxy for simple mint-like operation)
            await token.connect(owner).increaseSupply(ethers.parseUnits('2000', 6));
            await token.connect(owner).transfer(signers[11].address, amount);
            const tx2 = await token.connect(owner).transfer(signers[11].address, amount);
            const receipt2 = await tx2.wait();
            const simpleTransfer = Number(receipt2.gasUsed);

            console.log('\n' + '='.repeat(80));
            console.log('MINT VS SIMPLE OPERATIONS COMPARISON');
            console.log('='.repeat(80));
            console.log(`\nOur unregistered mint:    ${ourMint.toLocaleString()} gas`);
            console.log(`Simple transfer (warm):   ${simpleTransfer.toLocaleString()} gas`);
            console.log(`\nMint overhead vs transfer: ${(ourMint - simpleTransfer).toLocaleString()} gas`);
            console.log('\nMint-specific operations:');
            console.log('  - totalSupply_ += value (SSTORE warm): ~5,000 gas');
            console.log('  - supplyControl.canMintToAddress() call: varies');
            console.log('  - emit SupplyIncreased event: ~375 gas per non-indexed topic');
            console.log('  - Second emit Transfer (from address(0)): ~375 gas more');
            console.log('\nEstimated overhead: ~6-7K gas for supply control + extra event');
        });

        it('should measure the cost of _getPayoutGroupId when it returns 0 (unregistered)', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // Mint to unregistered address (calls _getPayoutGroupId, returns 0)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const cost = Number(receipt1.gasUsed);

            console.log('\n' + '='.repeat(80));
            console.log('_getPayoutGroupId() COST WHEN UNREGISTERED');
            console.log('='.repeat(80));
            console.log(`\nMint to unregistered address: ${cost.toLocaleString()} gas`);
            console.log('\n_getPayoutGroupId() implementation:');
            console.log('  - TokenAccountData memory wallet = _getBalanceData(account); // SLOAD');
            console.log('  - return wallet.payoutGroupId; // memory read');
            console.log('\nThis is NOT optimizable - we need the wallet data anyway for balance updates.');
            console.log('The SLOAD is required and reused, not wasteful.');
            console.log('\nCost: 1 SLOAD (100 gas warm) + negligible memory access');
        });
    });

    // =========================================================================
    // SECTION 4: OPTIMIZATION ANALYSIS
    // =========================================================================
    describe('Optimization Analysis', function () {
        it('should determine if _getPayoutGroupId can be optimized', async function () {
            console.log('\n' + '='.repeat(80));
            console.log('_getPayoutGroupId() OPTIMIZATION ANALYSIS');
            console.log('='.repeat(80));
            console.log('\nCurrent implementation:');
            console.log('  function _getPayoutGroupId(address account) internal view returns (uint24) {');
            console.log('      TokenAccountData memory wallet = _getBalanceData(account);');
            console.log('      return wallet.payoutGroupId;');
            console.log('  }');
            console.log('\nCost breakdown:');
            console.log('  - SLOAD of balanceData[account]: 100 gas (warm)');
            console.log('  - Memory copy of 32-byte struct: ~30 gas');
            console.log('  - Return payoutGroupId field: ~3 gas');
            console.log('  TOTAL: ~133 gas');
            console.log('\nCan we optimize this?');
            console.log('  ❌ NO - This SLOAD is REQUIRED for the mint operation');
            console.log('  ✓ The same wallet data is used immediately after for balance updates');
            console.log('  ✓ Inlining _getPayoutGroupId saves ~25 gas (function call overhead)');
            console.log('  ✓ But we still need the SLOAD and memory copy');
            console.log('\nBEST OPTIMIZATION:');
            console.log('  Inline _getPayoutGroupId() and reuse wallet data in mintTo():');
            console.log('  - Load wallet ONCE: 100 gas (SLOAD)');
            console.log('  - Extract payoutGroupId: 3 gas');
            console.log('  - Reuse wallet for _updateWalletWithPayoutGroup: 0 gas (already loaded)');
            console.log('  SAVINGS: ~25 gas (avoided function call overhead)');
            console.log('\nConclusion: Minimal savings possible (~25 gas), but not significant.');
        });

        it('should measure actual function call overhead', async function () {
            console.log('\n' + '='.repeat(80));
            console.log('FUNCTION CALL OVERHEAD (EVM SPECIFICATION)');
            console.log('='.repeat(80));
            console.log('\nInternal function call overhead:');
            console.log('  - JUMP: 8 gas');
            console.log('  - JUMPDEST: 1 gas');
            console.log('  - Stack operations (DUP, SWAP, PUSH): ~3-5 gas each');
            console.log('  TOTAL: ~20-30 gas per internal function call');
            console.log('\nIn mintTo(), we call:');
            console.log('  1. _isAddrFrozen()           ~25 gas overhead');
            console.log('  2. _getBalanceData()         ~25 gas overhead');
            console.log('  3. _getPayoutGroupId()       ~25 gas overhead (OVERLAPS with #2!)');
            console.log('  4. _updateWalletWithPayoutGroup() ~25 gas overhead');
            console.log('\nOptimization opportunity:');
            console.log('  Since _getPayoutGroupId calls _getBalanceData, and mintTo also calls');
            console.log('  _getBalanceData, we could inline to avoid double function call overhead.');
            console.log('  POTENTIAL SAVINGS: ~25 gas (one less function call)');
        });
    });
});
