const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployPaxosTokenClaimableRewardsFixture } = require('../test/helpers/fixtures');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

describe('Bulk Registration Gas Benchmark', function () {
    let token, owner;

    beforeEach(async function () {
        // Load the fixture
        const fixture = await loadFixture(deployPaxosTokenClaimableRewardsFixture);
        token = fixture.token;
        owner = fixture.owner;

        // Set up claim source and initial configuration
        await token.connect(owner).setClaimSource(owner.address);
        await token.connect(owner).setMaturityPeriod(86400); // 1 day
    });

    describe('Single Address Registration', function () {
        it('should measure gas cost for single registration', async function () {
            // Setup
            const acc = ethers.Wallet.createRandom().address;
            await token.connect(owner).increaseSupply(ethers.parseUnits('1000', 6));
            await token.connect(owner).transfer(acc, ethers.parseUnits('100', 6));

            // Create payout group
            const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, owner.address);
            await token.connect(owner).createPayoutGroup(1, owner.address);

            // Measure single registration
            const tx = await token.connect(owner).registrarRegisterRewardAddress(payoutGroupId, acc);
            const receipt = await tx.wait();

            console.log('\n=== SINGLE ADDRESS REGISTRATION ===');
            console.log(`Gas used: ${receipt.gasUsed.toString()}`);
            console.log(`Per address: ${receipt.gasUsed.toString()}`);
        });
    });

    describe('Batch Registration - Variable Sizes', function () {
        const batchSizes = [1, 2, 5, 10, 20, 50];

        for (const batchSize of batchSizes) {
            it(`should measure gas cost for ${batchSize} addresses`, async function () {
                // Setup: create accounts and fund them
                const accounts = [];
                const fundAmount = ethers.parseUnits('100', 6);
                const totalSupply = fundAmount * BigInt(batchSize);

                await token.connect(owner).increaseSupply(totalSupply);

                for (let i = 0; i < batchSize; i++) {
                    const account = ethers.Wallet.createRandom().address;
                    accounts.push(account);
                    await token.connect(owner).transfer(account, fundAmount);
                }

                // Create payout group
                const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, owner.address);
                await token.connect(owner).createPayoutGroup(1, owner.address);

                // Measure batch registration
                const tx = await token.connect(owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
                const receipt = await tx.wait();

                const totalGas = Number(receipt.gasUsed);
                const perAddress = Math.round(totalGas / batchSize);

                console.log(`\n=== BATCH SIZE: ${batchSize} addresses ===`);
                console.log(`Total gas used: ${totalGas.toLocaleString()}`);
                console.log(`Per address: ${perAddress.toLocaleString()}`);

                if (batchSize > 1) {
                    // For batch > 1, show marginal cost (excluding first address overhead)
                    const firstAddressOverhead = 75500; // Estimated from analysis
                    const remainingGas = totalGas - firstAddressOverhead;
                    const marginalCost = Math.round(remainingGas / (batchSize - 1));
                    console.log(`Marginal cost (2nd+ addresses): ${marginalCost.toLocaleString()}`);
                }
            });
        }
    });

    describe('Comparative Analysis', function () {
        it('should show gas cost progression across batch sizes', async function () {
            const results = [];
            const signers = await ethers.getSigners();
            let claimerIndex = 1; // Start from signer[1], signer[0] is owner

            for (const batchSize of [1, 5, 10, 20, 50, 100]) {
                // Setup accounts
                const accounts = [];
                const fundAmount = ethers.parseUnits('100', 6);
                const totalSupply = fundAmount * BigInt(batchSize);

                await token.connect(owner).increaseSupply(totalSupply);

                for (let i = 0; i < batchSize; i++) {
                    const account = ethers.Wallet.createRandom().address;
                    accounts.push(account);
                    await token.connect(owner).transfer(account, fundAmount);
                }

                // Create payout group with unique claimer for each iteration
                const claimer = signers[claimerIndex++];
                const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, claimer.address);
                await token.connect(owner).createPayoutGroup(1, claimer.address);

                // Measure
                const tx = await token.connect(owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
                const receipt = await tx.wait();

                const totalGas = Number(receipt.gasUsed);
                const avgPerAddress = Math.round(totalGas / batchSize);
                const marginalCost = batchSize > 1
                    ? Math.round((totalGas - 75500) / (batchSize - 1))
                    : totalGas;

                results.push({
                    batchSize,
                    totalGas,
                    avgPerAddress,
                    marginalCost
                });
            }

            // Print comparison table
            console.log('\n' + '='.repeat(100));
            console.log('BULK REGISTRATION GAS COST ANALYSIS');
            console.log('='.repeat(100));
            console.log('');
            console.log('| Batch Size | Total Gas   | Avg/Address | Marginal Cost | Efficiency Gain |');
            console.log('|------------|-------------|-------------|---------------|-----------------|');

            const baselineCost = results[0].avgPerAddress;

            for (const result of results) {
                const efficiencyGain = result.batchSize === 1
                    ? '-'
                    : `${Math.round((1 - result.marginalCost / baselineCost) * 100)}%`;

                console.log(
                    `| ${String(result.batchSize).padEnd(10)} ` +
                    `| ${result.totalGas.toLocaleString().padEnd(11)} ` +
                    `| ${result.avgPerAddress.toLocaleString().padEnd(11)} ` +
                    `| ${result.marginalCost.toLocaleString().padEnd(13)} ` +
                    `| ${String(efficiencyGain).padEnd(15)} |`
                );
            }

            console.log('');
            console.log('Key Insights:');
            console.log(`- First address overhead: ~${results[0].totalGas.toLocaleString()} gas (includes cold SSTORE)`);
            console.log(`- Marginal cost (2nd+ addresses): ~${results[results.length - 1].marginalCost.toLocaleString()} gas`);
            console.log(`- Batch efficiency: ${Math.round((1 - results[results.length - 1].marginalCost / baselineCost) * 100)}% savings per address at scale`);
            console.log('');
            console.log('Storage Operations per Address:');
            console.log('- 5 SLOADs (1 cold for balanceData[account], 4 warm shared slots)');
            console.log('- 3 SSTOREs (1 cold for balanceData[account], 2 warm shared slots)');
            console.log('- Optimized hierarchical updates (single SSTORE per struct)');
        });
    });

    describe('Idempotent Batch (Already Registered)', function () {
        it('should measure gas cost for idempotent batch registration', async function () {
            // Setup
            const batchSize = 10;
            const accounts = [];
            const fundAmount = ethers.parseUnits('100', 6);
            const totalSupply = fundAmount * BigInt(batchSize);

            await token.connect(owner).increaseSupply(totalSupply);

            for (let i = 0; i < batchSize; i++) {
                const account = ethers.Wallet.createRandom().address;
                accounts.push(account);
                await token.connect(owner).transfer(account, fundAmount);
            }

            // Create payout group and register all
            const signers = await ethers.getSigners();
            const claimer = signers[1];
            const payoutGroupId = await token.connect(owner).createPayoutGroup.staticCall(1, claimer.address);
            await token.connect(owner).createPayoutGroup(1, claimer.address);

            const tx1 = await token.connect(owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
            const receipt1 = await tx1.wait();

            // Register again (idempotent - all already registered)
            const tx2 = await token.connect(owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
            const receipt2 = await tx2.wait();

            console.log('\n=== IDEMPOTENT BATCH (ALL ALREADY REGISTERED) ===');
            console.log(`First batch (${batchSize} addresses): ${Number(receipt1.gasUsed).toLocaleString()} gas`);
            console.log(`Idempotent batch (${batchSize} addresses): ${Number(receipt2.gasUsed).toLocaleString()} gas`);
            console.log(`Per address (idempotent): ${Math.round(Number(receipt2.gasUsed) / batchSize).toLocaleString()} gas`);
            console.log('');
            console.log('Note: Idempotent calls early-return after 1 SLOAD check (very gas efficient)');
        });
    });
});
