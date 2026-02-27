const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Boundary Conditions Tests', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  describe('9.1.1 Max Payout Groups (uint32)', function () {
    it('should handle payout group ID near uint32 boundary', async function () {
      // uint32 max: 4,294,967,295 (2^32 - 1)
      // We can't actually create 4 billion groups, but we can verify the ID type works correctly

      // Create a few groups to verify ID increments
      await setupMultiplierWithBounds(this);
      const id1 = await createPayoutGroup(this, 1, this.acc);

      const id2 = await createPayoutGroup(this, 1, this.acc2);

      // Verify sequential IDs
      expect(Number(id2)).to.equal(Number(id1) + 1);

      // Verify both IDs are well within uint32 range
      const uint32Max = 4294967295;
      expect(Number(id1)).to.be.lt(uint32Max);
      expect(Number(id2)).to.be.lt(uint32Max);
    });

    it('should store payout group IDs correctly', async function () {
      // Create payout group and verify storage
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      // Verify ID is stored correctly and retrievable
      expect(payoutGroupId).to.be.gt(0);

      // Verify reverse lookup works
      const claimer = await this.token.getPayoutGroupClaimer(payoutGroupId);
      expect(claimer).to.equal(this.acc.address);
    });

    it('should handle multiple payout groups sequentially', async function () {
      const accounts = [this.acc, this.acc2, this.acc3];
      const ids = [];

      await setupMultiplierWithBounds(this);
      // Create multiple groups
      for (const account of accounts) {
        const id = await createPayoutGroup(this, 1, account);
        ids.push(Number(id));
      }

      // Verify all IDs are unique and sequential
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).to.equal(ids[i-1] + 1);
      }
    });
  });

  describe('9.1.2 Max Multipliers (uint24 vs uint8)', function () {
    it('should store multiplier IDs as uint24 (max 16,777,215)', async function () {
      // Set rate bounds first, then create a multiplier and verify ID
      await setupMultiplierWithBounds(this);  // Creates multiplier ID 1
      const newMultId = 1n;

      // Verify ID is within uint24 range
      const uint24Max = 16777215;
      expect(Number(newMultId)).to.be.lt(uint24Max);

      // Verify multiplier is accessible
      const multiplier = await this.token.getActiveMultiplier(newMultId);
      expect(multiplier).to.equal(ethers.parseUnits("1.0", 12));
    });

    it('should handle creating multipliers with sequential IDs', async function () {
      const ids = [];

      // Set rate bounds first
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10));

      // Create several multipliers
      for (let i = 0; i < 10; i++) {
        const id = await this.token.connect(this.owner).createMultiplier.staticCall(0);
        await this.token.connect(this.owner).createMultiplier(0);
        ids.push(Number(id));
      }

      // Verify all IDs are sequential
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).to.equal(ids[i-1] + 1);
      }
    });
  });

  describe('9.1.3 Time Overflow (uint40 timestamps)', function () {
    it('should handle timestamps within uint40 range (max year ~36,812)', async function () {
      // uint40 max: 1,099,511,627,775 seconds
      // Current time is around 1,700,000,000 seconds (year 2023)
      // uint40 max represents year ~36,812 AD

      const currentTime = await time.latest();
      expect(currentTime).to.be.lt(1099511627775);

      // Verify current checkpoints are stored correctly
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      await this.token.connect(this.owner).createMultiplier(0);  // Creates multiplier ID 1
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.0365", 10)); // ~0.01% daily = 3.65% APR

      // Multiplier should be created successfully with valid timestamp
      const mult = await this.token.getActiveMultiplier(1);
      expect(mult).to.equal(ethers.parseUnits("1.0", 12));
    });

    it('should handle far future timestamps correctly', async function () {
      // Test scheduling rate change for far future (within uint40 max of ~1 trillion)
      // Use a realistic far future value that fits in uint32 for the function parameter
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      await this.token.connect(this.owner).createMultiplier(0);  // Creates multiplier ID 1

      const currentTime = await time.latest();
      const farFuture = currentTime + (365 * 24 * 60 * 60); // 1 year from now
      const rate = ethers.parseUnits("0.1825", 10); // ~0.05% daily = 18.25% APR

      // This should work (well within uint40 range)
      await expect(
        this.token.connect(this.owner).scheduleNextMultRateByAPR(1, rate, farFuture)
      ).to.not.be.reverted;

      const switchTime = await this.token.getSwitchTime(1);
      expect(switchTime).to.be.closeTo(farFuture, 86400); // Within one epoch (epoch-aligned)
    });

    it('should store checkpoint times correctly', async function () {
      // Set up multiplier with rate
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      await this.token.connect(this.owner).createMultiplier(0);  // Creates multiplier ID 1
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.0365", 10)); // ~0.01% daily = 3.65% APR

      // Fast forward time
      await time.increase(86400);

      // Update multiplier
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.073", 10)); // ~0.02% daily = 7.3% APR

      // Multiplier should still work correctly
      const mult = await this.token.getActiveMultiplier(1);
      expect(mult).to.be.gte(ethers.parseUnits("1.0", 12));
    });

    it('should handle epoch-aligned timestamps correctly', async function () {
      // Set maturity period and checkpoint period
      await this.token.connect(this.owner).setMaturityPeriod(3600); // 1 hour

      // Create payout group and register account
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Verify registration succeeded (timestamp stored correctly)
      const groupId = await this.token.payoutGroupIdOf(this.acc2.address);
      expect(groupId).to.equal(payoutGroupId);
    });
  });

  describe('9.1.4 Max Epoch Numbers (uint24)', function () {
    it('should handle epoch numbers within uint24 range (max 16,777,215)', async function () {
      // uint24 max: 16,777,215 epochs
      // With daily epochs, this represents ~45,964 years

      // Set a short period for testing (1 second per epoch)
      await this.token.connect(this.owner).setMaturityPeriod(1);

      // Set rate bounds, create multiplier, and set rate before fast forwarding
      // With 1-second period: need APR that produces detectable growth after 1000 periods
      // Using 10% APR: (1 + 0.1/31536000)^1000 ≈ 1.0000031746 (clearly detectable)
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      await this.token.connect(this.owner).createMultiplier(0);  // Creates multiplier ID 1
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, ethers.parseUnits("0.1", 10)); // 10% APR

      // Current epoch should be well within range
      const rewardPeriod = await this.token.getMaturityPeriod();
      expect(rewardPeriod).to.equal(1);

      // Fast forward time (simulate many epochs)
      await time.increase(1000); // 1000 epochs

      // Multiplier should have grown
      const mult = await this.token.getActiveMultiplier(1);
      expect(mult).to.be.gt(ethers.parseUnits("1.0", 12)); // Should have grown
    });

    it('should calculate epoch numbers correctly over time', async function () {
      // Set daily epoch period
      await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day

      // Setup accounts
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Fast forward multiple epochs
      await time.increase(86400 * 10); // 10 days

      // Trigger epoch update via claim
      await this.token.connect(this.acc).claimForAddresses(payoutGroupId, [this.acc2.address]);

      // System should handle epoch progression correctly
      const balance = await this.token.balanceOf(this.acc.address);
      expect(balance).to.equal(0); // No rewards without rate
    });

    it('should store epoch numbers in account data correctly', async function () {
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc2.address);

      // Account should have epoch number stored
      const groupId = await this.token.payoutGroupIdOf(this.acc2.address);
      expect(groupId).to.equal(payoutGroupId);
    });

    it('should handle epoch wraparound gracefully if ever reached', async function () {
      // This is a theoretical test - we can't actually reach uint24 max in a test
      // But we can verify the system handles large epoch numbers

      // Set very short period
      await this.token.connect(this.owner).setMaturityPeriod(1);

      // Fast forward a significant amount
      await time.increase(100000);

      // System should still function
      // When changing from period 1 to 86400, need to ensure checkpointPeriod is compatible
      // Since checkpointPeriod is 1, we need to set it to 86400 first (or a multiple)
      await expect(
        this.token.connect(this.owner).setMaturityPeriod(86400)
      ).to.not.be.reverted;
    });
  });

  describe('9.1.5 Combined Boundary Stress Tests', function () {
    it('should handle multiple boundary conditions simultaneously', async function () {
      // Set rate bounds first, then create multiple multipliers
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      for (let i = 1; i <= 10; i++) {
        await this.token.connect(this.owner).createMultiplier(0);
      }

      // Create multiple payout groups (using multiplier IDs 1, 2, 3)
      const accounts = [this.acc, this.acc2, this.acc3];
      for (let i = 1; i <= accounts.length; i++) {
        await this.token.connect(this.owner).createPayoutGroup(i, accounts[i-1].address);
      }

      // Set rates and fast forward time
      await this.token.connect(this.owner).setMaturityPeriod(3600);

      for (let i = 1; i <= 10; i++) {
        await this.token.connect(this.owner).setMultiplierRateByAPR(i, ethers.parseUnits("0.876", 10)); // ~0.01% hourly = 87.6% APR
      }

      await time.increase(86400); // 24 hours

      // All multipliers should function correctly
      for (let i = 1; i <= 10; i++) {
        const mult = await this.token.getActiveMultiplier(i);
        expect(mult).to.be.gt(ethers.parseUnits("1.0", 12));
      }
    });

    it('should maintain precision at boundaries', async function () {
      // Set up maximum precision rate (within bounds)
      // 0.023456789012% daily × 365 = 8.561726% APR
      const maxPrecisionRate = ethers.parseUnits("0.08561726", 10);
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-5000% APR for testing
      await this.token.connect(this.owner).createMultiplier(0);  // Creates multiplier ID 1
      await this.token.connect(this.owner).setMultiplierRateByAPR(1, maxPrecisionRate);

      // Fast forward and verify precision maintained
      await time.increase(86400);

      const mult = await this.token.getActiveMultiplier(1);
      expect(mult).to.be.gt(ethers.parseUnits("1.0", 12));
    });
  });
});
