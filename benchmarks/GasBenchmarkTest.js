const { deployPaxosTokenClaimableRewardsFixture } = require('../test/helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('../test/helpers/testHelpers');
const { createPayoutGroup } = require('../test/helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Definitive Gas Numbers Test', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

    // Grant necessary roles for testing
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  it('Should provide definitive gas numbers for README', async function () {
    // Setup tokens with consistent amounts - need more for additional test accounts
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 20n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER * 3n);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER * 3n);
    await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER * 3n);
    
    console.log('\\n📊 DEFINITIVE GAS NUMBERS FOR README');
    console.log('=====================================');
    
    // Test 1: No payout addresses (baseline)
    const noPayoutTx = await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER / 10n);
    const noPayoutReceipt = await noPayoutTx.wait();
    console.log(`1️⃣  No payout addresses: ${noPayoutReceipt.gasUsed} gas`);
    
    // Test 2: Zero value transfer
    const zeroTx = await this.token.connect(this.acc).transfer(this.acc3.address, 0n);
    const zeroReceipt = await zeroTx.wait();
    console.log(`2️⃣  Zero value transfer: ${zeroReceipt.gasUsed} gas`);
    
    // Test 3: Same payout group (early return)
    // Initialize multipliers and settings
    await this.token.connect(this.owner).setMaturityPeriod(86400);
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 12));
    await this.token.connect(this.owner).createMultiplier(0); // Create multiplier 1
    const payoutGroup1 = await createPayoutGroup(this, 1, this.acc);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1, this.acc.address);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1, this.acc2.address);
    
    const sameClaimerTx = await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER / 10n);
    const sameClaimerReceipt = await sameClaimerTx.wait();
    console.log(`3️⃣  Same payout group: ${sameClaimerReceipt.gasUsed} gas`);
    
    // Test 4: Different payout groups with different multipliers (full logic)
    // Initialize multiplier 2 first
    await this.token.connect(this.owner).createMultiplier(0);
    const payoutGroup2 = await createPayoutGroup(this, 2, this.acc2);

    // Unregister acc2 from the first group before registering to the new group
    const oldGroupId = await this.token.payoutGroupIdOf(this.acc2.address);
    await this.token.connect(this.owner).registrarUnregisterRewardAddress(oldGroupId, this.acc2.address);

    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup2, this.acc2.address);
    
    const diffClaimerTx = await this.token.connect(this.acc).transfer(this.acc2.address, ONE_ETHER / 10n);
    const diffClaimerReceipt = await diffClaimerTx.wait();
    console.log(`4️⃣  Different payout groups: ${diffClaimerReceipt.gasUsed} gas`);
    
    // Test 4b: Same multiplier indices (optimized case) - mirror SameMultiplierOptimizationTest setup
    const allSigners = await ethers.getSigners();
    const sameMultAddr1 = allSigners[7].address;
    const sameMultAddr2 = allSigners[8].address;
    
    // Setup addresses with tokens
    await this.token.connect(this.owner).transfer(sameMultAddr1, ONE_ETHER);
    await this.token.connect(this.owner).transfer(sameMultAddr2, ONE_ETHER);
    
    // Create payout groups - both with multiplier index 0
    const payoutGroupSameMult1 = await createPayoutGroup(this, 1, allSigners[7]);
    const payoutGroupSameMult2 = await createPayoutGroup(this, 1, allSigners[8]);

    // Register accounts to their payout groups
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupSameMult1, sameMultAddr1);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupSameMult2, sameMultAddr2);
    
    // Same multiplier transfer (0 -> 0)
    const sameMultiplierTx = await this.token.connect(allSigners[7]).transfer(sameMultAddr2, ONE_ETHER / 10n);
    const sameMultiplierReceipt = await sameMultiplierTx.wait();
    console.log(`4️⃣b Same multiplier indices: ${sameMultiplierReceipt.gasUsed} gas`);
    
    // Test 4c: Different multiplier indices (cross-jurisdiction transfer)
    const diffMultAddr1 = allSigners[9].address;
    const diffMultAddr2 = allSigners[10].address;
    
    // Setup addresses with tokens
    await this.token.connect(this.owner).transfer(diffMultAddr1, ONE_ETHER);
    await this.token.connect(this.owner).transfer(diffMultAddr2, ONE_ETHER);
    
    // Create payout groups with different multiplier indices
    const payoutGroupDiffMult1 = await createPayoutGroup(this, 1, allSigners[9]);
    const payoutGroupDiffMult2 = await createPayoutGroup(this, 2, allSigners[10]);

    // Register accounts to their payout addresses
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupDiffMult1, diffMultAddr1);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupDiffMult2, diffMultAddr2);
    
    // Different multiplier transfer (0 -> 1)
    const diffMultiplierTx = await this.token.connect(allSigners[9]).transfer(diffMultAddr2, ONE_ETHER / 10n);
    const diffMultiplierReceipt = await diffMultiplierTx.wait();
    console.log(`4️⃣c Different multiplier indices: ${diffMultiplierReceipt.gasUsed} gas`);

    // Test 5: Claims - create rewards and claim (warm storage measurement)
    // Add time advance and multiplier change to accumulate real rewards
    const claimFutureTime = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.01", 12), claimFutureTime);
    await time.increase(3601);

    // Do first claim to warm up storage
    await this.token.connect(this.acc).claimAll(payoutGroup1);

    // Accumulate more rewards with another multiplier change
    const claimFutureTime2 = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.02", 12), claimFutureTime2);
    await time.increase(3601);

    // Measure second claim (warm storage)
    const claimTx = await this.token.connect(this.acc).claimAll(payoutGroup1);
    const claimReceipt = await claimTx.wait();
    console.log(`5️⃣  Full claim (O(1), warm): ${claimReceipt.gasUsed} gas`);

    // Test 6: set account payout group operations
    const payoutGroup3 = await createPayoutGroup(this, 1, this.acc3);
    const setPayoutTx = await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup3, this.acc3.address);
    const setPayoutReceipt = await setPayoutTx.wait();
    console.log(`6️⃣  set account payout group: ${setPayoutReceipt.gasUsed} gas`);
    
    // Test 7: Optimized claim and payout creation gas measurements
    const allTestSigners = await ethers.getSigners();
    const [acc4, acc5, acc6, acc7, acc8] = allTestSigners.slice(11, 16); // Skip already-used signers
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
    await this.token.connect(this.owner).transfer(acc4.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(acc5.address, ONE_ETHER);  
    await this.token.connect(this.owner).transfer(acc6.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(acc7.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(acc8.address, ONE_ETHER);
    
    // Test adminCreatePayoutGroup optimization (target: 1 SLOAD, 5 SSTORE ~88K gas)
    const payoutGroup4 = await createPayoutGroup(this, 1, acc4);

    // Measure gas for creating another payout group
    const createPayoutTx = await this.token.connect(this.owner).createPayoutGroup(1, acc5.address);
    const createPayoutReceipt = await createPayoutTx.wait();
    const payoutGroup4b = createPayoutReceipt.logs
      .map(log => {
        try { return this.token.interface.parseLog(log); } catch { return null; }
      })
      .find(parsed => parsed && parsed.name === 'PayoutGroupCreated')?.args.payoutGroupId;
    console.log(`7️⃣  adminCreatePayoutGroup: ${createPayoutReceipt.gasUsed} gas`);

    // Setup for claim tests
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup4, acc4.address);
    const futureTime = (await time.latest()) + 3600;
        await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.03", 12), futureTime);
        await time.increase(3601);

    // Test individual account claim optimization (target: 5 SLOAD, 3 SSTORE ~53K gas)
    const walletClaimTx = await this.token.connect(acc4).claimForAddresses(payoutGroup4, [acc4.address]);
    const walletClaimReceipt = await walletClaimTx.wait();
    console.log(`8️⃣  Individual account claim: ${walletClaimReceipt.gasUsed} gas`);

    // Setup for batch claim measurement
    const payoutGroup5 = await createPayoutGroup(this, 1, acc6);
    const payoutGroup6 = await createPayoutGroup(this, 1, acc7);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup5, acc6.address);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup6, acc7.address);
    await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup6, acc8.address);
    const futureTime2 = (await time.latest()) + 3600;
        await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.04", 12), futureTime2);
        await time.increase(3601);
    
    // Test batch claim per-wallet cost in the limit of large X
    // Create fresh wallets to avoid existing payout address conflicts
    const freshWallets = [];
    for (let i = 0; i < 10; i++) {
      const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
      // Fund wallet with ETH for transactions
      await this.owner.sendTransaction({
        to: wallet.address,
        value: ethers.parseEther("0.1")
      });
      freshWallets.push(wallet);
    }
    
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);

    // Create a single payout group and register ALL fresh wallets to it
    // Use a fresh signer not used elsewhere in the test
    const [, , , , , , , , , , , batchController] = await ethers.getSigners();
    const sharedPayoutGroupId = await createPayoutGroup(this, 1, batchController);

    for (const wallet of freshWallets) {
      await this.token.connect(this.owner).transfer(wallet.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(sharedPayoutGroupId, wallet.address);
    }

    // Measure incremental cost from batch of 9 to batch of 10 (asymptotic cost)
    const largeAddresses9 = freshWallets.slice(0, 9).map(w => w.address);
    const largeAddresses10 = freshWallets.slice(0, 10).map(w => w.address);

    const futureTime3 = (await time.latest()) + 3600;
        await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.05", 12), futureTime3);
        await time.increase(3601);
    // Use the shared payout group for batch operations
    const batch9Tx = await this.token.connect(this.owner).claimForAddresses(sharedPayoutGroupId, largeAddresses9);
    const batch9Receipt = await batch9Tx.wait();

    const futureTime4 = (await time.latest()) + 3600;
        await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.06", 12), futureTime4);
        await time.increase(3601);
    const batch10Tx = await this.token.connect(this.owner).claimForAddresses(sharedPayoutGroupId, largeAddresses10);
    const batch10Receipt = await batch10Tx.wait();
    
    const batchClaimPerWallet = batch10Receipt.gasUsed - batch9Receipt.gasUsed;
    console.log(`9️⃣  Batch claim (9 wallets): ${batch9Receipt.gasUsed} gas`);
    console.log(`🔟 Batch claim (10 wallets): ${batch10Receipt.gasUsed} gas`);
    console.log(`➡️  Batch claim per wallet (asymptotic): ${batchClaimPerWallet} gas`);
    
    console.log('\\n📈 CALCULATIONS FOR README:');
    console.log('============================');
    const baselineGas = Number(noPayoutReceipt.gasUsed);
    const diffClaimerGas = Number(diffClaimerReceipt.gasUsed);
    const sameClaimerGas = Number(sameClaimerReceipt.gasUsed);
    const zeroGas = Number(zeroReceipt.gasUsed);
    const claimGas = Number(claimReceipt.gasUsed);
    const createPayoutGas = Number(createPayoutReceipt.gasUsed);
    const walletClaimGas = Number(walletClaimReceipt.gasUsed);
    const batchPerWalletGas = Number(batchClaimPerWallet);
    const sameMultiplierGas = Number(sameMultiplierReceipt.gasUsed);
    const diffMultiplierGas = Number(diffMultiplierReceipt.gasUsed);
    
    // Calculate savings
    const sameClaimerSavings = diffClaimerGas - sameClaimerGas;
    const zeroValueSavings = diffClaimerGas - zeroGas;
    const overheadVsBaseline = diffClaimerGas - baselineGas;
    const multiplierOptimizationSavings = diffMultiplierGas - sameMultiplierGas;
    
    console.log(`Transfer overhead vs basic ERC20: +${overheadVsBaseline} gas`);
    console.log(`Same payout group savings: -${sameClaimerSavings} gas`);
    console.log(`Zero value savings: -${zeroValueSavings} gas`);
    console.log(`Same-multiplier optimization savings: -${multiplierOptimizationSavings} gas`);
    console.log(`Create payout address: ${createPayoutGas} gas (target: ~88K)`);
    console.log(`Individual account claim: ${walletClaimGas} gas (target: ~53K)`);
    console.log(`Batch claim per wallet (asymptotic): ${batchClaimPerWallet} gas (target: ~24K)`);
    
    console.log('\\n✅ RECOMMENDED README VALUES:');
    console.log('==============================');
    console.log(`- No payoutGroups: ${Math.round(baselineGas/1000)}K gas`);
    console.log(`- Same payout group: ${Math.round(sameClaimerGas/1000)}K gas (${sameClaimerSavings} gas savings via early returns)`);
    console.log(`- Different payout groups: ${Math.round(diffClaimerGas/1000)}K gas (optimized with inlined multiplier calculation)`);
    console.log(`- Same multiplier indices: ${Math.round(Number(sameMultiplierReceipt.gasUsed)/1000)}K gas (16K+ gas savings from optimization)`);
    console.log(`- Different multiplier indices: ${Math.round(Number(diffMultiplierReceipt.gasUsed)/1000)}K gas (full cross-jurisdiction functionality)`);
    console.log(`- Zero value transfers: ${Math.round(zeroGas/1000)}K gas (${zeroValueSavings} gas savings via early returns)`);
    console.log(`- Full claim: ${Math.round(claimGas/1000)}K gas (O(1) optimized)`);
    console.log(`- Create payout address: ${Math.round(createPayoutGas/1000)}K gas (SLOAD/SSTORE optimized)`);
    console.log(`- Individual account claim: ${Math.round(walletClaimGas/1000)}K gas (SLOAD/SSTORE optimized)`);
    console.log(`- Batch claim per wallet: ${Math.round(Number(batchClaimPerWallet)/1000)}K gas (asymptotic cost)`);
    
    console.log('\\n🔒 GAS REGRESSION PROTECTION:');
    console.log('===============================');
    
    // Gas regression protection - fail if gas increases by more than 5K from current optimized levels
    const MAX_NO_CLAIMERS = 60405; // 55405 + 5000 (optimized to avoid unnecessary transient variable operations)
    const MAX_SAME_CLAIMER = 75000; // Increased due to proper payout aggregation tracking implementation
    const MAX_DIFFERENT_CLAIMERS = 140000; // Actual optimized: ~134K with cross-multiplier functionality + buffer
    const MAX_SAME_MULTIPLIER = 110000; // Actual optimized: ~105K with same-multiplier functionality + buffer
    const MAX_DIFFERENT_MULTIPLIER = 140000; // Actual optimized: ~134K with different multiplier functionality + buffer
    const MAX_ZERO_VALUE = 42934; // 37934 + 5000
    const MAX_INDIVIDUAL_CLAIM = 83000; // ~82K actual with real rewards + buffer (warm storage, second claim)
    const MAX_CREATE_PAYOUT = 125000; // Actual optimized: ~121K + buffer (1 SLOAD, 5 SSTORE + validation overhead)
    const MAX_WALLET_CLAIM = 100000; // Actual: ~98.7K + buffer (includes balance tracking for circular rewards fix)
    const MAX_BATCH_PER_WALLET = 30000; // Actual asymptotic: ~29K + buffer (stable pattern for large batches)
    
    expect(baselineGas).to.be.at.most(MAX_NO_CLAIMERS, 
      `No payoutGroups gas increased beyond acceptable limit: ${baselineGas} > ${MAX_NO_CLAIMERS}`);
    expect(sameClaimerGas).to.be.at.most(MAX_SAME_CLAIMER, 
      `Same payout group gas increased beyond acceptable limit: ${sameClaimerGas} > ${MAX_SAME_CLAIMER}`);
    expect(diffClaimerGas).to.be.at.most(MAX_DIFFERENT_CLAIMERS, 
      `Different payout groups gas increased beyond acceptable limit: ${diffClaimerGas} > ${MAX_DIFFERENT_CLAIMERS}`);
    expect(zeroGas).to.be.at.most(MAX_ZERO_VALUE, 
      `Zero value transfer gas increased beyond acceptable limit: ${zeroGas} > ${MAX_ZERO_VALUE}`);
    expect(claimGas).to.be.at.most(MAX_INDIVIDUAL_CLAIM, 
      `Individual claim gas increased beyond acceptable limit: ${claimGas} > ${MAX_INDIVIDUAL_CLAIM}`);
    expect(sameMultiplierGas).to.be.at.most(MAX_SAME_MULTIPLIER, 
      `Same multiplier gas increased beyond acceptable limit: ${sameMultiplierGas} > ${MAX_SAME_MULTIPLIER}`);
    expect(diffMultiplierGas).to.be.at.most(MAX_DIFFERENT_MULTIPLIER, 
      `Different multiplier gas increased beyond acceptable limit: ${diffMultiplierGas} > ${MAX_DIFFERENT_MULTIPLIER}`);
    expect(createPayoutGas).to.be.at.most(MAX_CREATE_PAYOUT,
      `Create payout address gas increased beyond acceptable limit: ${createPayoutGas} > ${MAX_CREATE_PAYOUT}`);
    expect(walletClaimGas).to.be.at.most(MAX_WALLET_CLAIM,
      `Individual account claim gas increased beyond acceptable limit: ${walletClaimGas} > ${MAX_WALLET_CLAIM}`);
    expect(batchClaimPerWallet).to.be.at.most(MAX_BATCH_PER_WALLET,
      `Batch claim per wallet gas increased beyond acceptable limit: ${batchClaimPerWallet} > ${MAX_BATCH_PER_WALLET}`);
    
    console.log('✅ All gas costs within acceptable limits!');
  });
});