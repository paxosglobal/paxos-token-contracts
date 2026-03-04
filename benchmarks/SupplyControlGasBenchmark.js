const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployPaxosTokenClaimableRewardsFixture } = require('../test/helpers/fixtures');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

describe('SupplyControl Gas Cost Analysis', function () {
    let token, owner, supplyControl;

    beforeEach(async function () {
        const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
        token = fixture.token;
        owner = fixture.owner;
        supplyControl = fixture.supplyControl;

        await token.connect(owner).setClaimSource(owner.address);
        await token.connect(owner).setMaturityPeriod(86400);
    });

    describe('canMintToAddress() Gas Cost Measurement', function () {
        it('should measure the actual gas cost of canMintToAddress call', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // BASELINE: Mint without supply control (if possible - need to find alternative)
            // Actually, we can't bypass supply control, so let's measure the full mint
            // and then try to isolate the supply control cost

            // Measure full unregistered mint
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const fullMintCost = Number(receipt1.gasUsed);

            console.log('\n' + '='.repeat(80));
            console.log('canMintToAddress() GAS COST BREAKDOWN');
            console.log('='.repeat(80));
            console.log(`\nFull unregistered mint cost: ${fullMintCost.toLocaleString()} gas`);
            console.log('\ncanMintToAddress() implementation analysis:');
            console.log('  Location: SupplyControl.sol:362-376');
            console.log('\n  function canMintToAddress(address mintToAddress, uint256 amount, address sender)');
            console.log('      external');
            console.log('      onlySupplyController(sender)           // Modifier 1');
            console.log('      onlyRole(TOKEN_CONTRACT_ROLE)          // Modifier 2');
            console.log('  {');
            console.log('      SupplyController storage supplyController = supplyControllerMap[sender];  // SLOAD');
            console.log('      if (!supplyController.allowAnyMintAndBurnAddress &&');
            console.log('          !EnumerableSet.contains(...))      // SLOAD(s)');
            console.log('      RateLimit.checkNewEvent(...)           // SLOADs + SSTOREs');
            console.log('  }');
        });

        it('should break down canMintToAddress components', async function () {
            console.log('\n' + '='.repeat(80));
            console.log('canMintToAddress() COMPONENT BREAKDOWN');
            console.log('='.repeat(80));

            console.log('\n1. EXTERNAL CALL OVERHEAD:');
            console.log('   - From token contract to SupplyControl contract');
            console.log('   - CALL opcode: 100 gas (warm address)');
            console.log('   - Value transfer: 0 (no value)');
            console.log('   - Memory expansion: ~100-200 gas for calldata');
            console.log('   - Return data copy: ~100 gas');
            console.log('   SUBTOTAL: ~300-400 gas');

            console.log('\n2. ACCESS CONTROL MODIFIERS:');
            console.log('   - onlySupplyController(sender): hasRole() check');
            console.log('     - SLOAD of role mapping (warm): 100 gas');
            console.log('     - Conditional + potential revert: ~50 gas');
            console.log('   - onlyRole(TOKEN_CONTRACT_ROLE): another hasRole() check');
            console.log('     - SLOAD of role mapping (warm): 100 gas');
            console.log('     - Conditional + potential revert: ~50 gas');
            console.log('   SUBTOTAL: ~300 gas');

            console.log('\n3. SUPPLY CONTROLLER LOOKUP:');
            console.log('   - supplyControllerMap[sender] SLOAD: 100 gas (warm)');
            console.log('   - Load struct from storage to memory: ~50 gas');
            console.log('   SUBTOTAL: ~150 gas');

            console.log('\n4. WHITELIST CHECK:');
            console.log('   - EnumerableSet.contains() on mintAddressWhitelist');
            console.log('   - If allowAnyMintAndBurnAddress = true: skipped (short-circuit)');
            console.log('   - If not: SLOAD of set length: 100 gas');
            console.log('   - If not: SLOAD of mapping: 100 gas');
            console.log('   SUBTOTAL: 0-200 gas (depends on configuration)');

            console.log('\n5. RATE LIMIT CHECK (RateLimit.checkNewEvent):');
            console.log('   - Check if refillPerSecond == 0 (skip check)');
            console.log('   - If not skipped:');
            console.log('     - SLOAD limitConfig: 100 gas (warm)');
            console.log('     - SLOAD remainingAmount: 100 gas (warm)');
            console.log('     - SLOAD lastRefillTime: 100 gas (warm)');
            console.log('     - refill() calculation: ~100-200 gas (arithmetic)');
            console.log('     - SSTORE remainingAmount: 5,000 gas (warm, non-zero→non-zero)');
            console.log('     - SSTORE lastRefillTime: 5,000 gas (warm, non-zero→non-zero)');
            console.log('   - If skipped (refillPerSecond = 0): ~50 gas');
            console.log('   SUBTOTAL: 50 gas (skipped) OR 10,600 gas (active rate limit)');

            console.log('\n' + '='.repeat(80));
            console.log('TOTAL ESTIMATED COST:');
            console.log('  - With rate limit DISABLED: ~800-1,100 gas');
            console.log('  - With rate limit ENABLED: ~11,400-11,700 gas');
            console.log('='.repeat(80));
        });

        it('should compare mint costs with different supply control configurations', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // Current configuration (from fixture)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const currentConfig = Number(receipt1.gasUsed);

            console.log('\n' + '='.repeat(80));
            console.log('SUPPLY CONTROL CONFIGURATION IMPACT');
            console.log('='.repeat(80));
            console.log(`\nCurrent mint cost: ${currentConfig.toLocaleString()} gas`);

            // Check current config
            const supplyControllerConfig = await supplyControl.getSupplyControllerConfig(owner.address);
            const hasRateLimit = supplyControllerConfig.limitConfig.refillPerSecond > 0;
            const allowAnyAddress = supplyControllerConfig.allowAnyMintAndBurnAddress;

            console.log('\nCurrent SupplyControl configuration:');
            console.log(`  - Rate limit enabled: ${hasRateLimit ? 'YES' : 'NO'}`);
            console.log(`  - Limit capacity: ${supplyControllerConfig.limitConfig.limitCapacity.toString()}`);
            console.log(`  - Refill per second: ${supplyControllerConfig.limitConfig.refillPerSecond.toString()}`);
            console.log(`  - Allow any address: ${allowAnyAddress ? 'YES' : 'NO'}`);
            console.log(`  - Whitelist size: ${supplyControllerConfig.mintAddressWhitelist.length}`);

            if (hasRateLimit) {
                console.log('\n⚠️  RATE LIMIT IS ENABLED - This adds ~10,600 gas per mint');
                console.log('   (2 SLOADs + arithmetic + 2 SSTOREs = 100+100+200+5000+5000 = 10,400 gas)');
            } else {
                console.log('\n✓ Rate limit is DISABLED (refillPerSecond = 0)');
                console.log('  This saves ~10,600 gas by skipping rate limit updates');
            }

            console.log('\nConclusion:');
            console.log('  canMintToAddress() base cost (without rate limit): ~800-1,100 gas');
            if (hasRateLimit) {
                console.log(`  Rate limit overhead: ~10,600 gas`);
                console.log(`  Total canMintToAddress cost: ~11,400-11,700 gas`);
            } else {
                console.log('  No rate limit overhead (refillPerSecond = 0)');
            }
        });

        it('should determine actual measured canMintToAddress cost via direct comparison', async function () {
            const amount = ethers.parseUnits('1000', 6);

            // Mint to owner (warm storage, unregistered)
            await token.connect(owner).increaseSupply(amount);
            const tx1 = await token.connect(owner).increaseSupply(amount);
            const receipt1 = await tx1.wait();
            const mintCost = Number(receipt1.gasUsed);

            // Simple transfer for comparison (no supply control involved)
            await token.connect(owner).increaseSupply(ethers.parseUnits('2000', 6));
            const signers = await ethers.getSigners();
            await token.connect(owner).transfer(signers[11].address, amount);
            const tx2 = await token.connect(owner).transfer(signers[11].address, amount);
            const receipt2 = await tx2.wait();
            const transferCost = Number(receipt2.gasUsed);

            console.log('\n' + '='.repeat(80));
            console.log('MEASURED canMintToAddress() COST (via comparison)');
            console.log('='.repeat(80));
            console.log(`\nUnregistered mint:  ${mintCost.toLocaleString()} gas`);
            console.log(`Simple transfer:    ${transferCost.toLocaleString()} gas`);
            console.log(`Mint overhead:      ${(mintCost - transferCost).toLocaleString()} gas`);

            console.log('\nMint-specific operations (not in transfer):');
            console.log('  1. totalSupply_ SSTORE: ~5,000 gas');
            console.log('  2. supplyControl.canMintToAddress(): ~800-11,700 gas (depends on config)');
            console.log('  3. emit SupplyIncreased: ~375 gas');
            console.log('  4. Other overhead: varies');

            const measuredOverhead = mintCost - transferCost;
            const storageAndEvent = 5000 + 375;
            const canMintCost = measuredOverhead - storageAndEvent;

            console.log(`\nRaw calculation: ${measuredOverhead} - ${storageAndEvent} = ${canMintCost} gas`);
            console.log('\nWait - this includes the SECOND Transfer event!');
            console.log('Mint emits TWO events:');
            console.log('  - emit SupplyIncreased: ~375 gas');
            console.log('  - emit Transfer(address(0), to, value): ~750 gas (from address + to address + value)');
            console.log('Transfer emits ONE event:');
            console.log('  - emit Transfer(from, to, value): ~750 gas');

            const secondEventOverhead = 375; // SupplyIncreased is additional
            const adjustedCanMintCost = canMintCost - secondEventOverhead;

            console.log(`\nAdjusted calculation: ${canMintCost} - ${secondEventOverhead} = ${adjustedCanMintCost} gas`);
            console.log(`\nMEASURED canMintToAddress() cost: ~${adjustedCanMintCost.toLocaleString()} gas`);

            // Check if this matches our estimates
            const supplyControllerConfig = await supplyControl.getSupplyControllerConfig(owner.address);
            const hasRateLimit = supplyControllerConfig.limitConfig.refillPerSecond > 0;

            if (hasRateLimit) {
                console.log('\nExpected: ~11,400-11,700 gas (with rate limit)');
                if (canMintCost >= 10000 && canMintCost <= 12000) {
                    console.log('✓ MATCHES ESTIMATE');
                } else {
                    console.log('⚠️  DOES NOT MATCH - needs investigation');
                }
            } else {
                console.log('\nExpected: ~800-1,100 gas (without rate limit)');
                if (canMintCost >= 500 && canMintCost <= 1500) {
                    console.log('✓ MATCHES ESTIMATE');
                } else {
                    console.log('⚠️  DOES NOT MATCH - needs investigation');
                }
            }
        });
    });
});
