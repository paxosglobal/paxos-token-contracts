const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12); // 1e12 = 1.0 multiplier

// Role constants
const CLAIM_OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CLAIM_OPERATOR_ROLE"));
const CLAIM_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CLAIM_ADMIN_ROLE"));
const PAYOUT_GROUP_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAYOUT_GROUP_ADMIN_ROLE"));

describe('PayoutGroupRolePermissions', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));

    // Grant necessary roles for testing
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Get additional signers
    const signers = await ethers.getSigners();

    // Set up separate addresses for different roles
    // acc = claimer, acc2 = manager, acc3 = destination
    this.claimer = this.acc;
    this.manager = this.acc2;
    this.destination = this.acc3;
    this.randomAddr = signers[7] || (await ethers.Wallet.createRandom().connect(ethers.provider));
    this.accountWithBalance = signers[8] || (await ethers.Wallet.createRandom().connect(ethers.provider));
    this.claimerSuper = signers[9] || (await ethers.Wallet.createRandom().connect(ethers.provider));
    this.claimManagerSuper = signers[10] || (await ethers.Wallet.createRandom().connect(ethers.provider));

    // Grant super roles
    await this.token.connect(this.owner).grantRole(CLAIM_OPERATOR_ROLE, this.claimerSuper.address);
    await this.token.connect(this.owner).grantRole(CLAIM_ADMIN_ROLE, this.claimManagerSuper.address);

    // Mint tokens to accountWithBalance
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
    await this.token.connect(this.owner).transfer(this.accountWithBalance.address, ONE_ETHER);

    // Setup multiplier with bounds before creating payout group
    await setupMultiplierWithBounds(this);

    // Create payout group with claimer
    this.payoutGroupId = await createPayoutGroup(this, 1, this.claimer);

    // Set manager and destination for the payout group
    await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.manager.address);
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.destination.address);

    // Register accountWithBalance to the payout group
    await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.accountWithBalance.address);

    // Configure multiplier and create rewards
    await this.token.connect(this.owner).setMaturityPeriod(86400);
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("100", 10)); // 0-10000% APR for testing
    const futureTime = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.001", 12), futureTime);
    await time.increase(3601);

  });

  describe('Claimer Role Permissions', function () {
    describe('CAN call claimer functions', function () {
      it('should allow claimer to call claimAll()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimer).claimAll(this.payoutGroupId))
          .to.emit(this.token, 'ClaimAllExecuted');

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });

      it('should allow claimer to call claimOne()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimer).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.emit(this.token, 'RewardsClaimed');

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });

      it('should allow claimer to call claimBatch()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimer).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.not.be.reverted;

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });
    });

    describe('CANNOT call manager functions', function () {
      it('should prevent claimer from calling claimAllTo()', async function () {
        await expect(this.token.connect(this.claimer).claimAllTo(this.payoutGroupId, this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should prevent claimer from calling claimOneTo()', async function () {
        await expect(this.token.connect(this.claimer).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should prevent claimer from calling claimBatchTo()', async function () {
        await expect(this.token.connect(this.claimer).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });
    });
  });

  describe('Manager Role Permissions', function () {
    describe('CAN call manager functions', function () {
      it('should allow manager to call claimAllTo()', async function () {
        // Use randomAddr as custom destination (not the claim source)
        const customDest = this.randomAddr.address;
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.manager).claimAllTo.staticCall(this.payoutGroupId, customDest);
        await expect(this.token.connect(this.manager).claimAllTo(this.payoutGroupId, customDest))
          .to.emit(this.token, 'ClaimAllExecuted');

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });

      it('should allow manager to call claimOneTo()', async function () {
        // Use randomAddr as custom destination (not the claim source)
        const customDest = this.randomAddr.address;
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.manager).claimForAddressesTo.staticCall(
          this.payoutGroupId, [this.accountWithBalance.address], customDest
        );
        await expect(this.token.connect(this.manager).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], customDest))
          .to.emit(this.token, 'RewardsClaimed')
          .to.emit(this.token, 'RewardsClaimedBatch')
          .withArgs(this.payoutGroupId, this.manager.address, customDest, returnedAmount, 1);

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });

      it('should allow manager to call claimBatchTo()', async function () {
        const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.manager).claimForAddressesTo.staticCall(
          this.payoutGroupId, [this.accountWithBalance.address], customDest
        );
        await expect(this.token.connect(this.manager).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], customDest))
          .to.emit(this.token, 'RewardsClaimedBatch')
          .withArgs(this.payoutGroupId, this.manager.address, customDest, returnedAmount, 1);

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });
    });

    describe('CANNOT call claimer functions', function () {
      it('should prevent manager from calling claimAll()', async function () {
        await expect(this.token.connect(this.manager).claimAll(this.payoutGroupId))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });

      it('should prevent manager from calling claimOne()', async function () {
        await expect(this.token.connect(this.manager).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });

      it('should prevent manager from calling claimBatch()', async function () {
        await expect(this.token.connect(this.manager).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });
    });
  });

  describe('Destination Role Permissions', function () {
    it('should prevent destination from calling claimAll()', async function () {
      await expect(this.token.connect(this.destination).claimAll(this.payoutGroupId))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent destination from calling claimOne()', async function () {
      await expect(this.token.connect(this.destination).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent destination from calling claimBatch()', async function () {
      await expect(this.token.connect(this.destination).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent destination from calling claimAllTo()', async function () {
      await expect(this.token.connect(this.destination).claimAllTo(this.payoutGroupId, this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should prevent destination from calling claimOneTo()', async function () {
      await expect(this.token.connect(this.destination).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should prevent destination from calling claimBatchTo()', async function () {
      await expect(this.token.connect(this.destination).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('Random Address Permissions', function () {
    it('should prevent random address from calling claimAll()', async function () {
      await expect(this.token.connect(this.randomAddr).claimAll(this.payoutGroupId))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent random address from calling claimOne()', async function () {
      await expect(this.token.connect(this.randomAddr).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent random address from calling claimBatch()', async function () {
      await expect(this.token.connect(this.randomAddr).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
        .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should prevent random address from calling claimAllTo()', async function () {
      await expect(this.token.connect(this.randomAddr).claimAllTo(this.payoutGroupId, this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should prevent random address from calling claimOneTo()', async function () {
      await expect(this.token.connect(this.randomAddr).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should prevent random address from calling claimBatchTo()', async function () {
      await expect(this.token.connect(this.randomAddr).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('CLAIM_OPERATOR_ROLE Role Permissions', function () {
    describe('CAN call claimer functions for any payout group', function () {
      it('should allow CLAIM_OPERATOR_ROLE to call claimAll()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimerSuper).claimAll(this.payoutGroupId))
          .to.emit(this.token, 'ClaimAllExecuted');

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });

      it('should allow CLAIM_OPERATOR_ROLE to call claimOne()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimerSuper).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.emit(this.token, 'RewardsClaimed');

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });

      it('should allow CLAIM_OPERATOR_ROLE to call claimBatch()', async function () {
        const destBalanceBefore = await this.token.balanceOf(this.destination.address);

        await expect(this.token.connect(this.claimerSuper).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.not.be.reverted;

        const destBalanceAfter = await this.token.balanceOf(this.destination.address);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
      });
    });

    describe('CANNOT call manager functions', function () {
      it('should prevent CLAIM_OPERATOR_ROLE from calling claimAllTo()', async function () {
        await expect(this.token.connect(this.claimerSuper).claimAllTo(this.payoutGroupId, this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should prevent CLAIM_OPERATOR_ROLE from calling claimOneTo()', async function () {
        await expect(this.token.connect(this.claimerSuper).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });

      it('should prevent CLAIM_OPERATOR_ROLE from calling claimBatchTo()', async function () {
        await expect(this.token.connect(this.claimerSuper).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], this.destination.address))
          .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
      });
    });
  });

  describe('CLAIM_ADMIN_ROLE Role Permissions', function () {
    describe('CAN call manager functions for any payout group', function () {
      it('should allow CLAIM_ADMIN_ROLE to call claimAllTo()', async function () {
        const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.claimManagerSuper).claimAllTo.staticCall(this.payoutGroupId, customDest);
        await expect(this.token.connect(this.claimManagerSuper).claimAllTo(this.payoutGroupId, customDest))
          .to.emit(this.token, 'ClaimAllExecuted');

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });

      it('should allow CLAIM_ADMIN_ROLE to call claimOneTo()', async function () {
        const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.claimManagerSuper).claimForAddressesTo.staticCall(
          this.payoutGroupId, [this.accountWithBalance.address], customDest
        );
        await expect(this.token.connect(this.claimManagerSuper).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], customDest))
          .to.emit(this.token, 'RewardsClaimed')
          .to.emit(this.token, 'RewardsClaimedBatch')
          .withArgs(this.payoutGroupId, this.claimManagerSuper.address, customDest, returnedAmount, 1);

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });

      it('should allow CLAIM_ADMIN_ROLE to call claimBatchTo()', async function () {
        const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
        const destBalanceBefore = await this.token.balanceOf(customDest);

        // Verify return value matches balance change
        const returnedAmount = await this.token.connect(this.claimManagerSuper).claimForAddressesTo.staticCall(
          this.payoutGroupId, [this.accountWithBalance.address], customDest
        );
        await expect(this.token.connect(this.claimManagerSuper).claimForAddressesTo(this.payoutGroupId, [this.accountWithBalance.address], customDest))
          .to.emit(this.token, 'RewardsClaimedBatch')
          .withArgs(this.payoutGroupId, this.claimManagerSuper.address, customDest, returnedAmount, 1);

        const destBalanceAfter = await this.token.balanceOf(customDest);
        expect(destBalanceAfter).to.be.gt(destBalanceBefore);
        expect(returnedAmount).to.equal(destBalanceAfter - destBalanceBefore);
      });
    });

    describe('CANNOT call claimer functions', function () {
      it('should prevent CLAIM_ADMIN_ROLE from calling claimAll()', async function () {
        await expect(this.token.connect(this.claimManagerSuper).claimAll(this.payoutGroupId))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });

      it('should prevent CLAIM_ADMIN_ROLE from calling claimOne()', async function () {
        await expect(this.token.connect(this.claimManagerSuper).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });

      it('should prevent CLAIM_ADMIN_ROLE from calling claimBatch()', async function () {
        await expect(this.token.connect(this.claimManagerSuper).claimForAddresses(this.payoutGroupId, [this.accountWithBalance.address]))
          .to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
      });
    });
  });

  describe('Edge Cases', function () {
    it('should work when claimer === manager === destination', async function () {
      // Create a new payout group where all roles are the same
      // Use randomAddr instead of owner to avoid self-transfer (owner is claim source)
      const unifiedAddr = this.randomAddr;
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER);
      await this.token.connect(this.owner).transfer(unifiedAddr.address, ONE_ETHER);

      // Note: multiplier 1 already exists from beforeEach setupMultiplierWithBounds
      const unifiedPayoutId = await createPayoutGroup(this, 1, unifiedAddr);

      // Manager and destination default to claimer, so they're already set
      await this.token.connect(this.owner).registrarRegisterRewardAddress(unifiedPayoutId, unifiedAddr.address);

      // Generate more rewards
      const futureTime2 = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime2);
      await time.increase(3601);

      const balanceBefore = await this.token.balanceOf(unifiedAddr.address);

      // Unified address should be able to call both claimer and manager functions
      await expect(this.token.connect(unifiedAddr).claimAll(unifiedPayoutId))
        .to.not.be.reverted;

      const balanceAfter = await this.token.balanceOf(unifiedAddr.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it('should verify destination receives rewards for claimer functions', async function () {
      const destBalanceBefore = await this.token.balanceOf(this.destination.address);

      await this.token.connect(this.claimer).claimAll(this.payoutGroupId);

      const destBalanceAfter = await this.token.balanceOf(this.destination.address);
      expect(destBalanceAfter).to.be.gt(destBalanceBefore);

      // Claimer should not have received rewards
      const claimerBalance = await this.token.balanceOf(this.claimer.address);
      expect(claimerBalance).to.equal(0);
    });

    it('should verify custom destination receives rewards for manager functions', async function () {
      const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
      const destBalanceBefore = await this.token.balanceOf(customDest);

      await this.token.connect(this.manager).claimAllTo(this.payoutGroupId, customDest);

      const destBalanceAfter = await this.token.balanceOf(customDest);
      expect(destBalanceAfter).to.be.gt(destBalanceBefore);

      // Manager should not have received rewards
      const managerBalance = await this.token.balanceOf(this.manager.address);
      expect(managerBalance).to.equal(0);
    });

    it('should allow claimer to also be manager and use both functions', async function () {
      // Set claimer as manager
      await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.claimer.address);

      // Claimer should now be able to call both claimer and manager functions
      await expect(this.token.connect(this.claimer).claimAll(this.payoutGroupId))
        .to.not.be.reverted;

      // Generate more rewards
      const futureTime3 = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime3);
      await time.increase(3601);

      await expect(this.token.connect(this.claimer).claimAllTo(this.payoutGroupId, this.owner.address))
        .to.not.be.reverted;
    });
  });

  describe('Admin Role Access Control', function () {
    // NOTE: PayoutGroupFacet uses InvalidClaimer for all role checks, which is semantically misleading
    // for admin functions. Consider using specific errors like UnauthorizedPayoutGroupAdminRole.
    it('reverts adminSetPayoutGroupManager when caller lacks PAYOUT_GROUP_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.randomAddr).adminSetPayoutGroupManager(this.payoutGroupId, this.acc2.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('reverts adminSetPayoutGroupDestination when caller lacks PAYOUT_GROUP_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.randomAddr).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc2.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('reverts setPartnerSignedRegistrationsEnabled when caller lacks PAYOUT_GROUP_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.randomAddr).setPartnerSignedRegistrationsEnabled(true))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('reverts registrarUnregisterRewardAddress when caller lacks PAYOUT_GROUP_REGISTRAR_ROLE', async function () {
      await expect(this.token.connect(this.randomAddr).registrarUnregisterRewardAddress(this.payoutGroupId, this.accountWithBalance.address))
        .to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('Registration Edge Cases', function () {
    it('reverts when trying to register the contract address itself', async function () {
      const contractAddress = await this.token.getAddress();
      await expect(this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, contractAddress))
        .to.be.revertedWithCustomError(this.token, 'ContractCannotBeRegistered');
    });
  });

  describe('Claim All Functions Comparison', function () {
    it('should demonstrate difference between claimAll and claimAllTo destinations', async function () {
      // claimAll sends to configured destination
      const configuredDest = this.destination.address;
      const configuredDestBalanceBefore = await this.token.balanceOf(configuredDest);

      await this.token.connect(this.claimer).claimAll(this.payoutGroupId);

      const configuredDestBalanceAfter = await this.token.balanceOf(configuredDest);
      const configuredDestReward = configuredDestBalanceAfter - configuredDestBalanceBefore;
      expect(configuredDestReward).to.be.gt(0);

      // Generate more rewards
      const futureTime4 = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.2", 12), futureTime4);
      await time.increase(3601);

      // claimAllTo sends to specified destination
      const customDest = this.randomAddr.address; // Use randomAddr instead of owner (claim source)
      const customDestBalanceBefore = await this.token.balanceOf(customDest);

      await this.token.connect(this.manager).claimAllTo(this.payoutGroupId, customDest);

      const customDestBalanceAfter = await this.token.balanceOf(customDest);
      const customDestReward = customDestBalanceAfter - customDestBalanceBefore;
      expect(customDestReward).to.be.gt(0);

      // Configured destination should not have received additional rewards from claimAllTo
      const configuredDestFinalBalance = await this.token.balanceOf(configuredDest);
      expect(configuredDestFinalBalance).to.equal(configuredDestBalanceAfter);
    });
  });
});
