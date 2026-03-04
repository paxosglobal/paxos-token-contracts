const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ethers } = require("hardhat");
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup } = require('./helpers/testSetup');

describe('Multiple Payout Groups Per Claimer/Manager', function () {
  beforeEach(async function () {
    // Use the standard fixture pattern
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Get additional signers for testing multiple groups
    const signers = await ethers.getSigners();
    this.claimer = signers[6];
    this.manager = signers[7];
    this.user1 = signers[8];
    this.user2 = signers[9];
    this.user3 = signers[10];

    // Increase supply and distribute to users
    const supply = ethers.parseUnits("10000", 6);
    await this.token.connect(this.owner).increaseSupply(supply);
    await this.token.connect(this.owner).transfer(this.user1.address, ethers.parseUnits("1000", 6));
    await this.token.connect(this.owner).transfer(this.user2.address, ethers.parseUnits("1000", 6));
    await this.token.connect(this.owner).transfer(this.user3.address, ethers.parseUnits("1000", 6));

    // Set claim source with sufficient balance
    await this.token.connect(this.owner).setClaimSource(this.owner.address);

    // Configure reward period and rate bounds
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("1", 10)); // 0-100% APR

    // Create two multipliers with different rates
    const tx1 = await this.token.connect(this.owner).createMultiplier(0); // Start at base
    const receipt1 = await tx1.wait();
    const event1 = receipt1.logs.find(log => {
      try { return this.token.interface.parseLog(log).name === 'MultiplierCreated'; } catch { return false; }
    });
    this.multiplierId1 = event1 ? this.token.interface.parseLog(event1).args.multiplierId : 1;

    // Explicitly set the rate to ensure it's active (50% APR)
    await this.token.connect(this.owner).setMultiplierRateByAPR(this.multiplierId1, ethers.parseUnits("0.5", 10));

    const tx2 = await this.token.connect(this.owner).createMultiplier(0); // Start at base
    const receipt2 = await tx2.wait();
    const event2 = receipt2.logs.find(log => {
      try { return this.token.interface.parseLog(log).name === 'MultiplierCreated'; } catch { return false; }
    });
    this.multiplierId2 = event2 ? this.token.interface.parseLog(event2).args.multiplierId : 2;

    // Explicitly set the rate to ensure it's active (100% APR)
    await this.token.connect(this.owner).setMultiplierRateByAPR(this.multiplierId2, ethers.parseUnits("1", 10));
  });

  describe('Same Claimer, Different Groups', function () {
    it('should allow creating multiple payout groups with same claimer', async function () {
      // Create first payout group with claimer
      const payoutGroupId1 = await createPayoutGroup(
        this,
        this.multiplierId1,
        this.claimer
      );

      // Create second payout group with same claimer but different multiplier
      const payoutGroupId2 = await createPayoutGroup(
        this,
        this.multiplierId2,
        this.claimer  // Same claimer
      );

      // Verify both groups exist with same claimer
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId1)).to.equal(this.claimer.address);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId2)).to.equal(this.claimer.address);

      // Verify groups have different multipliers
      expect(await this.token.getPayoutGroupMultId(payoutGroupId1)).to.equal(this.multiplierId1);
      expect(await this.token.getPayoutGroupMultId(payoutGroupId2)).to.equal(this.multiplierId2);
    });

    it('should allow same claimer to claim from different groups independently', async function () {
      // Create two groups with same claimer
      const payoutGroupId1 = await createPayoutGroup(
        this,
        this.multiplierId1,
        this.claimer
      );

      const payoutGroupId2 = await createPayoutGroup(
        this,
        this.multiplierId2,
        this.claimer
      );

      // Register users in different groups
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId1, this.user1.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId2, this.user2.address);

      // Advance time to accrue rewards (need multiple days for rewards to accrue)
      await time.increase(86400 * 3); // 3 days

      // Verify rewards accrued before claiming
      const rewards1 = await this.token.availableRewardsOf(this.user1.address);
      expect(rewards1).to.be.gt(0, "User1 should have rewards after 3 days");

      // Claimer claims from first group
      const balanceBefore1 = await this.token.balanceOf(this.claimer.address);
      await this.token.connect(this.claimer).claimAll(payoutGroupId1);
      const balanceAfter1 = await this.token.balanceOf(this.claimer.address);
      expect(balanceAfter1).to.be.gt(balanceBefore1);

      // Claimer claims from second group
      const balanceBefore2 = await this.token.balanceOf(this.claimer.address);
      await this.token.connect(this.claimer).claimAll(payoutGroupId2);
      const balanceAfter2 = await this.token.balanceOf(this.claimer.address);
      expect(balanceAfter2).to.be.gt(balanceBefore2);
    });
  });

  describe('Same Manager, Different Groups', function () {
    it('should allow creating multiple payout groups with same manager', async function () {
      // Create first payout group with manager
      const payoutGroupId1 = await createPayoutGroup(
        this,
        this.multiplierId1,
        this.user1
      );

      // Set manager for first group
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId1, this.manager.address);

      // Create second payout group with same manager but different claimer
      const payoutGroupId2 = await createPayoutGroup(
        this,
        this.multiplierId2,
        this.user2
      );

      // Set manager for second group (same manager)
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId2, this.manager.address);

      // Verify both groups have same manager
      expect(await this.token.getPayoutGroupManager(payoutGroupId1)).to.equal(this.manager.address);
      expect(await this.token.getPayoutGroupManager(payoutGroupId2)).to.equal(this.manager.address);

      // Verify groups have different claimers
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId1)).to.equal(this.user1.address);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId2)).to.equal(this.user2.address);
    });

    it('should allow same manager to manage different groups independently', async function () {
      // Create two groups with same manager
      const payoutGroupId1 = await createPayoutGroup(
        this,
        this.multiplierId1,
        this.user1
      );

      // Set manager for first group
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId1, this.manager.address);

      const payoutGroupId2 = await createPayoutGroup(
        this,
        this.multiplierId2,
        this.user2
      );

      // Set manager for second group (same manager)
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId2, this.manager.address);

      // Register accounts in different groups (use different accounts - can't register same account to multiple groups)
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId1, this.acc.address);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId2, this.acc2.address);

      // Advance time to accrue rewards
      await time.increase(86400); // 1 day

      // Manager can change claimer for first group
      await this.token.connect(this.manager).setPayoutGroupClaimer(payoutGroupId1, this.claimer.address);
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId1)).to.equal(this.claimer.address);

      // Manager can set destination for second group
      await this.token.connect(this.manager).setPayoutGroupDestination(payoutGroupId2, this.owner.address);
      expect(await this.token.getPayoutGroupDestination(payoutGroupId2)).to.equal(this.owner.address);
    });
  });

  describe('Same Address as Both Claimer and Manager', function () {
    it('should allow same address to be both claimer and manager for different groups', async function () {
      // Create group 1: claimer is the shared address
      const payoutGroupId1 = await createPayoutGroup(
        this,
        this.multiplierId1,
        this.claimer
      );

      // Set manager for group 1
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId1, this.user1.address);

      // Create group 2: manager is the shared address (claimer from group 1)
      const payoutGroupId2 = await createPayoutGroup(
        this,
        this.multiplierId2,
        this.user2
      );

      // Set manager for group 2 to be the same as group 1 claimer
      await this.token.connect(this.owner).adminSetPayoutGroupManager(payoutGroupId2, this.claimer.address);

      // Verify roles
      expect(await this.token.getPayoutGroupClaimer(payoutGroupId1)).to.equal(this.claimer.address);
      expect(await this.token.getPayoutGroupManager(payoutGroupId2)).to.equal(this.claimer.address);

      // Verify claimer can claim from group 1
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId1, this.acc3.address);
      await time.increase(86400);
      await expect(this.token.connect(this.claimer).claimAll(payoutGroupId1)).to.not.be.reverted;

      // Verify claimer can manage group 2 (as manager)
      await expect(
        this.token.connect(this.claimer).setPayoutGroupDestination(payoutGroupId2, this.owner.address)
      ).to.not.be.reverted;
    });
  });
});
