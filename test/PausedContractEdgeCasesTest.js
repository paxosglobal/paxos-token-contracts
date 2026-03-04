const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles, setNextMultiplier } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

describe('Paused Contract Edge Cases', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
    await this.token.connect(this.owner).setClaimSource(this.owner.address);
    await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("10000", 6));

    // Configure periods for rewards accumulation
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10)); // 0-10000% APR
  });

  describe('Transfer operations when paused', function() {
    it('should revert transfer when paused', async function() {
      // Give balance first
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // Pause the contract
      await this.token.connect(this.owner).pause();

      // Transfer should revert
      await expect(
        this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6))
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('should revert transferFrom when paused', async function() {
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.acc).approve(this.acc2.address, ethers.parseUnits("50", 6));

      // Pause
      await this.token.connect(this.owner).pause();

      // transferFrom should revert
      await expect(
        this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc3.address, ethers.parseUnits("10", 6))
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('should allow transfer after unpause', async function() {
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      // Pause and unpause
      await this.token.connect(this.owner).pause();
      await this.token.connect(this.owner).unpause();

      // Transfer should work
      await expect(
        this.token.connect(this.acc).transfer(this.acc2.address, ethers.parseUnits("10", 6))
      ).to.not.be.reverted;

      expect(await this.token.balanceOf(this.acc2.address)).to.equal(ethers.parseUnits("10", 6));
    });
  });

  describe('Claim operations when paused', function() {
    it('should revert claimOne when paused', async function() {
      // Setup multiplier with bounds before creating payout group
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Accrue rewards
      await time.increase(86400);

      // Pause
      await this.token.connect(this.owner).pause();

      // Claim should revert
      await expect(
        this.token.connect(this.owner).claimForAddresses(payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('should revert claimAll when paused', async function() {
      // Setup multiplier with bounds before creating payout group
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      await time.increase(86400);

      // Pause
      await this.token.connect(this.owner).pause();

      // claimAll should revert
      await expect(
        this.token.connect(this.owner).claimAll(payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('should revert claimBatch when paused', async function() {
      // Setup multiplier with bounds before creating payout group
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 3, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      await time.increase(86400);

      // Pause
      await this.token.connect(this.owner).pause();

      // claimBatch should revert
      await expect(
        this.token.connect(this.owner).claimForAddresses(payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });
  });

  describe('View functions when paused', function() {
    it('should allow balanceOf when paused', async function() {
      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));

      await this.token.connect(this.owner).pause();

      // View functions should still work
      const balance = await this.token.balanceOf(this.acc.address);
      expect(balance).to.equal(ethers.parseUnits("100", 6));
    });

    it('should allow availableRewardsOf when paused', async function() {
      // Setup multiplier with bounds before creating payout group
      await setupMultiplierWithBounds(this);
      const payoutGroupId = await createPayoutGroup(this, 1, this.acc);

      await this.token.connect(this.owner).transfer(this.acc.address, ethers.parseUnits("100", 6));
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

      // Trigger earn cycle by scheduling a rate change
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
      await time.increase(3601);

      await this.token.connect(this.owner).pause();

      // View should still work
      const rewards = await this.token.availableRewardsOf(this.acc.address);
      expect(rewards).to.be.greaterThan(0);
    });
  });
});
