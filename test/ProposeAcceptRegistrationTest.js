const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ethers } = require("hardhat");
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

describe('Propose-Accept Registration Flow', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Get signers for testing
    const signers = await ethers.getSigners();
    this.claimer = signers[6];
    this.manager = signers[7];
    this.user1 = signers[8];
    this.user2 = signers[9];
    this.smartContract = signers[10]; // Simulates a smart contract address
    this.unauthorized = signers[11];

    // Set rate bounds and create a multiplier
    await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);
    this.multiplierId = await this.token.createMultiplier.staticCall(ethers.parseUnits("0.05", 12));
    await this.token.connect(this.owner).createMultiplier(ethers.parseUnits("0.05", 12));

    // Create a payout group with claimer
    this.payoutGroupId = await createPayoutGroup(
      this,
      this.multiplierId,
      this.claimer
    );

    // Set manager for the payout group
    await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.manager.address);

    // Grant registrar role to owner for testing
    const PAYOUT_GROUP_REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAYOUT_GROUP_REGISTRAR_ROLE"));
    await this.token.connect(this.owner).grantRole(PAYOUT_GROUP_REGISTRAR_ROLE, this.owner.address);
  });

  describe('1. Basic Happy Path', function () {
    it('should allow claimer to propose an address for registration', async function () {
      // Propose registration
      await expect(this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.smartContract.address))
        .to.emit(this.token, 'RegistrationProposed')
        .withArgs(this.smartContract.address, this.payoutGroupId, this.claimer.address);

      // Check pending registration
      const [pendingGroupId, proposer] = await this.token.getPendingRegistration(this.smartContract.address);
      expect(pendingGroupId).to.equal(this.payoutGroupId);
      expect(proposer).to.equal(this.claimer.address);

      // Accept registration
      await expect(this.token.connect(this.smartContract).acceptRegisterRewardAddress(this.payoutGroupId))
        .to.emit(this.token, 'RegistrationAccepted')
        .withArgs(this.smartContract.address, this.payoutGroupId)
        .to.emit(this.token, 'AccountRegistered')
        .withArgs(this.smartContract.address, this.payoutGroupId, this.claimer.address);

      // Verify registration completed
      expect(await this.token.payoutGroupIdOf(this.smartContract.address)).to.equal(this.payoutGroupId);

      // Verify proposal is deleted
      const [afterGroupId, afterProposer] = await this.token.getPendingRegistration(this.smartContract.address);
      expect(afterGroupId).to.equal(0);
      expect(afterProposer).to.equal(ethers.ZeroAddress);
    });
  });

  describe('2. Authorization Tests - Propose', function () {
    it('should allow claimer to propose', async function () {
      await expect(this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address))
        .to.emit(this.token, 'RegistrationProposed');
    });

    it('should allow manager to propose', async function () {
      await expect(this.token.connect(this.manager).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address))
        .to.emit(this.token, 'RegistrationProposed');
    });

    it('should allow registrar role to propose', async function () {
      await expect(this.token.connect(this.owner).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address))
        .to.emit(this.token, 'RegistrationProposed');
    });

    it('should reject unauthorized address proposing', async function () {
      await expect(
        this.token.connect(this.unauthorized).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address)
      ).to.be.revertedWithCustomError(this.token, 'UnauthorizedRegistration');
    });
  });

  describe('3. Validation Tests - Propose', function () {
    it('should reject proposal for zero address', async function () {
      await expect(
        this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(this.token, 'InvalidAccount');
    });

    it('should reject proposal for contract address', async function () {
      const contractAddress = await this.token.getAddress();
      await expect(
        this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, contractAddress)
      ).to.be.revertedWithCustomError(this.token, 'ContractCannotBeRegistered');
    });

    it('should reject proposal for non-existent payout group', async function () {
      const invalidGroupId = 999;
      // Use registrar role to bypass authorization check and reach PayoutGroupNotFound
      await expect(
        this.token.connect(this.owner).proposeRegisterRewardAddress(invalidGroupId, this.user1.address)
      ).to.be.revertedWithCustomError(this.token, 'PayoutGroupNotFound');
    });

    it('should allow proposal for already-registered address (auto-unregister at accept)', async function () {
      // Register user1 first
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Create second payout group
      const payoutGroupId2 = await createPayoutGroup(this, this.multiplierId, this.claimer);

      // Propose for same address to different group - should succeed
      // Auto-unregister will happen when user accepts
      await expect(
        this.token.connect(this.claimer).proposeRegisterRewardAddress(payoutGroupId2, this.user1.address)
      ).to.emit(this.token, 'RegistrationProposed')
        .withArgs(this.user1.address, payoutGroupId2, this.claimer.address);
    });

    it('should allow overwriting pending proposal with new proposal', async function () {
      // Create second payout group
      const payoutGroupId2 = await createPayoutGroup(this, this.multiplierId, this.claimer);

      // First proposal
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      let [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(this.payoutGroupId);

      // Second proposal overwrites first
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(payoutGroupId2, this.user1.address);

      [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(payoutGroupId2);
      expect(proposer).to.equal(this.claimer.address);
    });
  });

  describe('4. Validation Tests - Accept', function () {
    it('should reject accept when no proposal exists', async function () {
      await expect(
        this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'NoRegistrationProposal');
    });

    it('should reject accept with mismatched payout group ID', async function () {
      // Propose for payoutGroupId
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Create second payout group
      const payoutGroupId2 = await createPayoutGroup(this, this.multiplierId, this.claimer);

      // Try to accept with different group ID
      await expect(
        this.token.connect(this.user1).acceptRegisterRewardAddress(payoutGroupId2)
      ).to.be.revertedWithCustomError(this.token, 'PayoutGroupMismatch')
        .withArgs(this.payoutGroupId, payoutGroupId2);
    });

    it('should be idempotent when accepting for already-registered address in same group', async function () {
      // Create proposal for user2
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user2.address);

      // Now manually register user2 via registrar before they can accept
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.user2.address);

      // Try to accept - should succeed (idempotent, already in same group)
      await expect(
        this.token.connect(this.user2).acceptRegisterRewardAddress(this.payoutGroupId)
      ).to.emit(this.token, 'RegistrationAccepted')
        .withArgs(this.user2.address, this.payoutGroupId);

      // Verify still registered to same group
      expect(await this.token.payoutGroupIdOf(this.user2.address)).to.equal(this.payoutGroupId);
    });

    it('should only allow the proposed address to accept', async function () {
      // Propose for user1
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Try to accept as different address - should fail because no proposal exists for user2
      await expect(
        this.token.connect(this.user2).acceptRegisterRewardAddress(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'NoRegistrationProposal');

      // user1 can accept
      await expect(this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId))
        .to.not.be.reverted;
    });
  });

  describe('5. Cancellation Tests', function () {
    it('should allow proposer to cancel their own proposal', async function () {
      // Propose
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Cancel
      await expect(this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address))
        .to.emit(this.token, 'RegistrationProposalCancelled')
        .withArgs(this.user1.address, this.payoutGroupId, this.claimer.address);

      // Verify proposal is deleted
      const [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(0);
      expect(proposer).to.equal(ethers.ZeroAddress);
    });

    it('should reject non-proposer cancelling', async function () {
      // Propose by claimer
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Try to cancel by manager
      await expect(
        this.token.connect(this.manager).cancelRegistrationProposal(this.user1.address)
      ).to.be.revertedWithCustomError(this.token, 'NotProposer');
    });

    it('should reject cancelling non-existent proposal', async function () {
      await expect(
        this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address)
      ).to.be.revertedWithCustomError(this.token, 'NoRegistrationProposal');
    });

    it('should prevent acceptance after cancellation', async function () {
      // Propose
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Cancel
      await this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address);

      // Try to accept
      await expect(
        this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'NoRegistrationProposal');
    });
  });

  describe('6. View Function Tests', function () {
    it('should return correct pending registration', async function () {
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      const [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(this.payoutGroupId);
      expect(proposer).to.equal(this.claimer.address);
    });

    it('should return zeros when no proposal exists', async function () {
      const [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(0);
      expect(proposer).to.equal(ethers.ZeroAddress);
    });

    it('should update correctly after cancellation', async function () {
      // Propose
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Verify proposal exists
      let [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(this.payoutGroupId);

      // Cancel
      await this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address);

      // Verify proposal is cleared
      [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(groupId).to.equal(0);
      expect(proposer).to.equal(ethers.ZeroAddress);
    });
  });

  describe('7. Edge Cases', function () {
    it('should handle multiple proposals for same address (overwrites)', async function () {
      // First proposal by claimer
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      let [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(proposer).to.equal(this.claimer.address);

      // Second proposal by manager overwrites
      await this.token.connect(this.manager).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      [groupId, proposer] = await this.token.getPendingRegistration(this.user1.address);
      expect(proposer).to.equal(this.manager.address);
    });

    it('should work for smart contract addresses (main use case)', async function () {
      // This is the primary use case - smart contracts can't sign EIP712
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.smartContract.address);
      await this.token.connect(this.smartContract).acceptRegisterRewardAddress(this.payoutGroupId);

      expect(await this.token.payoutGroupIdOf(this.smartContract.address)).to.equal(this.payoutGroupId);
    });

    it('should complete full registration after accept', async function () {
      // Give user1 some tokens FIRST (before registration)
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.user1.address, ethers.parseUnits("1000", 6));

      // Propose and accept
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);
      await this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId);

      // Verify user is registered
      expect(await this.token.payoutGroupIdOf(this.user1.address)).to.equal(this.payoutGroupId);

      // Verify balance is tracked
      expect(await this.token.balanceOf(this.user1.address)).to.equal(ethers.parseUnits("1000", 6));

      // Advance time to accrue rewards
      await time.increase(86400); // 1 day

      // Should be able to query available rewards (may be 0 or > 0 depending on rate)
      const rewards = await this.token.availableRewardsOf(this.user1.address);
      // Just verify it doesn't revert - rewards depend on rate configuration
      expect(rewards).to.be.gte(0);
    });
  });

  describe('8. Integration with Existing Registration', function () {
    it('should coexist with signature-based registration', async function () {
      // Use propose-accept for user1
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);
      await this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId);

      // Use registrar registration for user2
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.user2.address);

      // Both should be registered
      expect(await this.token.payoutGroupIdOf(this.user1.address)).to.equal(this.payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.user2.address)).to.equal(this.payoutGroupId);
    });

    it('should allow proposal for registered address to enable group switching', async function () {
      // Register user1 to first group
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Create second payout group
      const payoutGroupId2 = await createPayoutGroup(this, this.multiplierId, this.claimer);

      // Propose for already-registered address to different group - should succeed
      await expect(
        this.token.connect(this.claimer).proposeRegisterRewardAddress(payoutGroupId2, this.user1.address)
      ).to.emit(this.token, 'RegistrationProposed');

      // User accepts and auto-unregisters from first group
      await expect(
        this.token.connect(this.user1).acceptRegisterRewardAddress(payoutGroupId2)
      ).to.emit(this.token, 'AccountDeregistered')
        .withArgs(this.user1.address, this.payoutGroupId, this.claimer.address)
        .and.to.emit(this.token, 'AccountRegistered')
        .withArgs(this.user1.address, payoutGroupId2, this.claimer.address);

      // Verify now in second group
      expect(await this.token.payoutGroupIdOf(this.user1.address)).to.equal(payoutGroupId2);
    });

    it('should behave identically after propose-accept vs signature registration', async function () {
      // Give both tokens FIRST
      await this.token.connect(this.owner).increaseSupply(ethers.parseUnits("2000", 6));
      await this.token.connect(this.owner).transfer(this.user1.address, ethers.parseUnits("1000", 6));
      await this.token.connect(this.owner).transfer(this.user2.address, ethers.parseUnits("1000", 6));

      // Register user1 via propose-accept
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);
      await this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId);

      // Register user2 via registrar
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.user2.address);

      // Both should be registered to same payout group
      expect(await this.token.payoutGroupIdOf(this.user1.address)).to.equal(this.payoutGroupId);
      expect(await this.token.payoutGroupIdOf(this.user2.address)).to.equal(this.payoutGroupId);

      // Both should have same balance
      expect(await this.token.balanceOf(this.user1.address)).to.equal(ethers.parseUnits("1000", 6));
      expect(await this.token.balanceOf(this.user2.address)).to.equal(ethers.parseUnits("1000", 6));

      // Both should be able to query rewards
      await time.increase(86400);
      const rewards1 = await this.token.availableRewardsOf(this.user1.address);
      const rewards2 = await this.token.availableRewardsOf(this.user2.address);

      // Both should return a value (may be 0 or > 0)
      expect(rewards1).to.be.gte(0);
      expect(rewards2).to.be.gte(0);
    });
  });

  describe('9. Event Emission', function () {
    it('should emit RegistrationProposed with correct parameters', async function () {
      await expect(this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address))
        .to.emit(this.token, 'RegistrationProposed')
        .withArgs(this.user1.address, this.payoutGroupId, this.claimer.address);
    });

    it('should emit RegistrationAccepted with correct parameters', async function () {
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      await expect(this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId))
        .to.emit(this.token, 'RegistrationAccepted')
        .withArgs(this.user1.address, this.payoutGroupId);
    });

    it('should emit AccountRegistered on accept', async function () {
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      await expect(this.token.connect(this.user1).acceptRegisterRewardAddress(this.payoutGroupId))
        .to.emit(this.token, 'AccountRegistered')
        .withArgs(this.user1.address, this.payoutGroupId, this.claimer.address);
    });

    it('should emit RegistrationProposalCancelled with correct parameters', async function () {
      await this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      await expect(this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address))
        .to.emit(this.token, 'RegistrationProposalCancelled')
        .withArgs(this.user1.address, this.payoutGroupId, this.claimer.address);
    });
  });

  describe('10. Multi-Role Scenarios', function () {
    it('should allow same address as claimer for group1 to propose for group2', async function () {
      // Create second payout group where user1 is claimer
      await this.token.connect(this.owner).createPayoutGroup(
        this.multiplierId,
        this.user1.address
      );

      // user1 is claimer for group2, proposes for group1
      await expect(this.token.connect(this.claimer).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address))
        .to.not.be.reverted;
    });

    it('should reject claimer cancelling manager proposal', async function () {
      // Manager proposes
      await this.token.connect(this.manager).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Claimer tries to cancel
      await expect(
        this.token.connect(this.claimer).cancelRegistrationProposal(this.user1.address)
      ).to.be.revertedWithCustomError(this.token, 'NotProposer');
    });

    it('should allow manager to cancel manager proposal', async function () {
      // Manager proposes
      await this.token.connect(this.manager).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Manager cancels
      await expect(this.token.connect(this.manager).cancelRegistrationProposal(this.user1.address))
        .to.emit(this.token, 'RegistrationProposalCancelled');
    });

    it('should allow registrar to propose and cancel', async function () {
      // Registrar proposes
      await this.token.connect(this.owner).proposeRegisterRewardAddress(this.payoutGroupId, this.user1.address);

      // Registrar cancels
      await expect(this.token.connect(this.owner).cancelRegistrationProposal(this.user1.address))
        .to.emit(this.token, 'RegistrationProposalCancelled');
    });
  });
});
