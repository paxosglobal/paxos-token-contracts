const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Claims with Pause and Freeze', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Setup: Create tokens, payout group, and rewards
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

    // Create payout group with acc as claimer, acc2 as destination
    await setupMultiplierWithBounds(this);
    this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);
    await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, this.acc2.address);
    await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.acc3.address);

    // Register accounts
    await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);

    // Create rewards by increasing multiplier
    await this.token.connect(this.owner).setMaturityPeriod(86400);
    await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing (1.0 as fraction)
    const futureTime = (await time.latest()) + 3600;
    await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0002", 12), futureTime);
    await time.increase(3601);

    // Verify rewards exist
    const rewards = await this.token.availableRewardsOf(this.acc.address);
    expect(rewards).to.be.gt(0);
  });

  describe('Paused Contract - All Claim Functions Should Fail', function () {
    beforeEach(async function () {
      // Pause the contract
      await this.token.connect(this.owner).pause();
      const paused = await this.token.paused();
      expect(paused).to.be.true;
    });

    it('claimAll should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claimOne should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claimBatch should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claimAllTo should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc3).claimAllTo(this.payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claimOneTo should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claimBatchTo should revert when contract is paused', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claims with CLAIM_OPERATOR_ROLE role should also revert when paused', async function () {
      // Even super roles should respect pause
      await expect(
        this.token.connect(this.owner).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('claims should work after unpause', async function () {
      // Unpause the contract
      await this.token.connect(this.owner).unpause();
      const paused = await this.token.paused();
      expect(paused).to.be.false;

      // Now claim should work
      const balanceBefore = await this.token.balanceOf(this.acc2.address);
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.emit(this.token, 'ClaimAllExecuted');
      const balanceAfter = await this.token.balanceOf(this.acc2.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it('unregisterRewardAddress should revert when contract is paused', async function () {
      // Claimer trying to unregister should fail when paused
      await expect(
        this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('unregisterRewardAddress by manager should revert when contract is paused', async function () {
      // Manager trying to unregister should fail when paused
      await expect(
        this.token.connect(this.acc3).unregisterRewardAddress(this.payoutGroupId, this.acc.address)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });
  });

  describe('Frozen Claimer Address - Claim Functions Should Fail', function () {
    beforeEach(async function () {
      // Freeze the claimer address (acc)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.true;
    });

    it('claimAll should revert when claimer is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimOne should revert when claimer is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimBatch should revert when claimer is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claims should work after unfreeze', async function () {
      // Unfreeze the claimer
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc.address);
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.false;

      // Now claim should work
      const balanceBefore = await this.token.balanceOf(this.acc2.address);
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.not.be.reverted;
    });

    it('freeze should also freeze rewards', async function () {
      // Destination balance should be unchanged (rewards frozen, not claimed)
      const destBalance = await this.token.balanceOf(this.acc2.address);
      // The destination only has their initial balance, no claimed rewards
      expect(destBalance).to.equal(ethers.parseUnits("1", 6));
    });
  });

  describe('Frozen Manager Address - Manager Claim Functions Should Fail', function () {
    beforeEach(async function () {
      // Freeze the manager address (acc3)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);
      const frozen = await this.token.isFrozen(this.acc3.address);
      expect(frozen).to.be.true;
    });

    it('claimAllTo should revert when manager is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimAllTo(this.payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimOneTo should revert when manager is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimBatchTo should revert when manager is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });

  describe('Frozen Destination Address - Claim Functions Should Fail', function () {
    beforeEach(async function () {
      // Freeze the destination address (acc2)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
      const frozen = await this.token.isFrozen(this.acc2.address);
      expect(frozen).to.be.true;
    });

    it('claimAll should revert when destination is frozen', async function () {
      // Claims to configured destination (acc2) which is frozen
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimOne should revert when destination is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimBatch should revert when destination is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimAllTo should revert when specified destination is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimAllTo(this.payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimOneTo should revert when specified destination is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimBatchTo should revert when specified destination is frozen', async function () {
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claims should work with unfrozen destination', async function () {
      // Unfreeze destination
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

      // Claim should now work
      const balanceBefore = await this.token.balanceOf(this.acc2.address);
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.emit(this.token, 'ClaimAllExecuted');
      const balanceAfter = await this.token.balanceOf(this.acc2.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  describe('Frozen Account Being Claimed - Claim Functions Should Fail', function () {
    beforeEach(async function () {
      // Freeze the account being claimed (acc)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      const frozen = await this.token.isFrozen(this.acc.address);
      expect(frozen).to.be.true;
    });

    it('claimOne should revert when account being claimed is frozen', async function () {
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimBatch should revert when any account in batch is frozen', async function () {
      // Add another account to the payout group
      await this.token.connect(this.owner).transfer(this.acc3.address, ONE_ETHER);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc3.address);

      // Try to claim batch with one frozen account
      await expect(
        this.token.connect(this.acc).claimForAddresses(this.payoutGroupId, [this.acc.address, this.acc3.address])
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('claimOneTo should revert when account being claimed is frozen', async function () {
      // Frozen accounts are removed from payout group, so PayoutGroupMismatch is thrown
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'PayoutGroupMismatch');
    });

    it('claimBatchTo should revert when any account in batch is frozen', async function () {
      // Frozen accounts are removed from payout group, so PayoutGroupMismatch is thrown
      await expect(
        this.token.connect(this.acc3).claimForAddressesTo(this.payoutGroupId, [this.acc.address], this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'PayoutGroupMismatch');
    });
  });

  describe('Combined Pause and Freeze Scenarios', function () {
    it('should revert with ContractPaused error when both paused and frozen', async function () {
      // Freeze claimer
      await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);
      // Pause contract
      await this.token.connect(this.owner).pause();

      // Pause check should happen first (ContractPaused error)
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });

    it('should prioritize pause over freeze in error reporting', async function () {
      // Freeze destination
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
      // Pause contract
      await this.token.connect(this.owner).pause();

      // ContractPaused should be thrown before checking frozen destination
      await expect(
        this.token.connect(this.acc).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'ContractPaused');
    });
  });

  describe('Super Roles with Frozen Addresses', function () {
    it('CLAIM_OPERATOR_ROLE should also fail when trying to claim with frozen destination', async function () {
      // Freeze destination
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);

      // Even super role should respect frozen addresses
      await expect(
        this.token.connect(this.owner).claimAll(this.payoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });

    it('CLAIM_ADMIN_ROLE should also fail when specifying frozen destination', async function () {
      // Freeze a potential destination
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);

      // Even super role should respect frozen addresses
      await expect(
        this.token.connect(this.owner).claimAllTo(this.payoutGroupId, this.acc2.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
    });
  });

  describe('Frozen Account Registration - HAL-06', function () {
    let newPayoutGroupId;
    let frozenAccount;
    let normalAccount;

    beforeEach(async function () {
      // Get additional signers for testing
      const signers = await ethers.getSigners();
      frozenAccount = signers[10];
      normalAccount = signers[11];

      // Give accounts some balance
      await this.token.connect(this.owner).transfer(frozenAccount.address, ONE_ETHER);
      await this.token.connect(this.owner).transfer(normalAccount.address, ONE_ETHER);

      // Create a new payout group for registration tests
      newPayoutGroupId = await this.token.createPayoutGroup.staticCall(1, this.owner.address);
      await this.token.connect(this.owner).createPayoutGroup(1, this.owner.address);

      // Freeze the frozen account
      await this.token.connect(this.assetProtectionRole).freeze(frozenAccount.address);
      expect(await this.token.isFrozen(frozenAccount.address)).to.be.true;
    });

    it('registrarRegisterRewardAddress should revert for frozen account', async function () {
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(newPayoutGroupId, frozenAccount.address)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Verify account was not registered
      expect(await this.token.payoutGroupIdOf(frozenAccount.address)).to.equal(0);
    });

    it('registrarRegisterRewardAddressBatch should revert if any account is frozen', async function () {
      // Try to register batch with one frozen account
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddressBatch(
          newPayoutGroupId,
          [normalAccount.address, frozenAccount.address]
        )
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Verify neither account was registered (batch is atomic)
      expect(await this.token.payoutGroupIdOf(normalAccount.address)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(frozenAccount.address)).to.equal(0);
    });

    it('registerRewardAddress (signature-based) should revert for frozen account', async function () {
      // Enable partner-signed registrations
      await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(true);

      // Create signature for registration
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Get domain separator and create signature
      // Facets hardcode "Global Dollar" as the EIP-712 domain name
      const domain = {
        name: "Global Dollar",
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await this.token.getAddress()
      };

      const types = {
        RegisterRewardAddress: [
          { name: 'account', type: 'address' },
          { name: 'payoutGroupId', type: 'uint32' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'deadline', type: 'uint256' }
        ]
      };

      const value = {
        account: frozenAccount.address,
        payoutGroupId: newPayoutGroupId,
        nonce: nonce,
        deadline: deadline
      };

      const signature = await frozenAccount.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      const packedSignature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);

      // Attempt registration with signature
      await expect(
        this.token.connect(this.owner).registerRewardAddress(
          newPayoutGroupId,
          frozenAccount.address,
          nonce,
          deadline,
          packedSignature
        )
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Verify account was not registered
      expect(await this.token.payoutGroupIdOf(frozenAccount.address)).to.equal(0);
    });

    it('acceptRegisterRewardAddress should revert for frozen account', async function () {
      // First, propose registration from owner (before freezing)
      await this.token.connect(this.assetProtectionRole).unfreeze(frozenAccount.address);
      await this.token.connect(this.owner).proposeRegisterRewardAddress(newPayoutGroupId, frozenAccount.address);

      // Verify proposal exists
      const proposal = await this.token.getPendingRegistration(frozenAccount.address);
      expect(proposal.proposer).to.equal(this.owner.address);

      // Now freeze the account
      await this.token.connect(this.assetProtectionRole).freeze(frozenAccount.address);

      // Attempt to accept registration while frozen
      await expect(
        this.token.connect(frozenAccount).acceptRegisterRewardAddress(newPayoutGroupId)
      ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');

      // Verify account was not registered
      expect(await this.token.payoutGroupIdOf(frozenAccount.address)).to.equal(0);
    });

    it('should allow registration after account is unfrozen', async function () {
      // Unfreeze the account
      await this.token.connect(this.assetProtectionRole).unfreeze(frozenAccount.address);
      expect(await this.token.isFrozen(frozenAccount.address)).to.be.false;

      // Registration should now succeed
      await this.token.connect(this.owner).registrarRegisterRewardAddress(newPayoutGroupId, frozenAccount.address);

      // Verify account was registered successfully
      expect(await this.token.payoutGroupIdOf(frozenAccount.address)).to.equal(newPayoutGroupId);
    });

    it('should allow registration of non-frozen accounts', async function () {
      // Normal account registration should work
      await this.token.connect(this.owner).registrarRegisterRewardAddress(newPayoutGroupId, normalAccount.address);

      // Verify account was registered successfully
      expect(await this.token.payoutGroupIdOf(normalAccount.address)).to.equal(newPayoutGroupId);
    });
  });

  describe('Frozen Destination - Indirect Claims (Admin/Registrar)', function () {
    beforeEach(async function () {
      // Freeze the destination address (acc2)
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
      expect(await this.token.isFrozen(this.acc2.address)).to.be.true;
    });

    describe('deletePayoutGroup', function () {
      it('should revert when destination is frozen', async function () {
        await expect(
          this.token.connect(this.owner).deletePayoutGroup(this.payoutGroupId)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should revert when claimer (fallback destination) is frozen', async function () {
        // Unfreeze acc2, remove explicit destination, freeze claimer (acc)
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);
        await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, ethers.ZeroAddress);
        await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

        await expect(
          this.token.connect(this.owner).deletePayoutGroup(this.payoutGroupId)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should succeed when destination is not frozen', async function () {
        // Unfreeze destination
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

        await expect(
          this.token.connect(this.owner).deletePayoutGroup(this.payoutGroupId)
        ).to.emit(this.token, 'PayoutGroupDeleted');
      });
    });

    describe('adminSetPayoutGroupMultiplier', function () {
      beforeEach(async function () {
        // Create a second multiplier to switch to (ID auto-assigned, will be 2)
        await this.token.connect(this.owner).createMultiplier(0);
      });

      it('should revert when destination is frozen', async function () {
        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupMultiplier(this.payoutGroupId, 2)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should revert when claimer (fallback destination) is frozen', async function () {
        // Unfreeze acc2, remove explicit destination, freeze claimer (acc)
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);
        await this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, ethers.ZeroAddress);
        await this.token.connect(this.assetProtectionRole).freeze(this.acc.address);

        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupMultiplier(this.payoutGroupId, 2)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should succeed when destination is not frozen', async function () {
        // Unfreeze destination
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupMultiplier(this.payoutGroupId, 2)
        ).to.emit(this.token, 'PayoutGroupMultiplierUpdated');
      });
    });

    describe('registrarUnregisterRewardAddress', function () {
      it('should revert when destination is frozen', async function () {
        await expect(
          this.token.connect(this.owner).registrarUnregisterRewardAddress(this.payoutGroupId, this.acc.address)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should succeed when destination is not frozen', async function () {
        // Unfreeze destination
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

        await expect(
          this.token.connect(this.owner).registrarUnregisterRewardAddress(this.payoutGroupId, this.acc.address)
        ).to.emit(this.token, 'AccountDeregistered');
      });
    });

    describe('registrarUnregisterRewardAddressBatch', function () {
      beforeEach(async function () {
        // Register additional account for batch test
        const signers = await ethers.getSigners();
        this.batchAccount = signers[10];
        await this.token.connect(this.owner).transfer(this.batchAccount.address, ONE_ETHER);
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.batchAccount.address);
      });

      it('should revert when destination is frozen', async function () {
        await expect(
          this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(
            this.payoutGroupId,
            [this.acc.address, this.batchAccount.address]
          )
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should succeed when destination is not frozen', async function () {
        // Unfreeze destination
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

        await expect(
          this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(
            this.payoutGroupId,
            [this.acc.address, this.batchAccount.address]
          )
        ).to.emit(this.token, 'AccountDeregistered');
      });
    });

    describe('unregisterRewardAddress (claimer/manager initiated)', function () {
      it('should revert when destination is frozen', async function () {
        // Claimer-initiated unregistration
        await expect(
          this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc.address)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should revert when manager-initiated and destination is frozen', async function () {
        // Manager-initiated unregistration
        await expect(
          this.token.connect(this.acc3).unregisterRewardAddress(this.payoutGroupId, this.acc.address)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should succeed when destination is not frozen', async function () {
        // Unfreeze destination
        await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);

        await expect(
          this.token.connect(this.acc).unregisterRewardAddress(this.payoutGroupId, this.acc.address)
        ).to.emit(this.token, 'AccountDeregistered');
      });
    });
  });

  describe('Frozen Destination - Destination Setters', function () {
    let frozenDestination;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      frozenDestination = signers[10];

      // Freeze the potential destination
      await this.token.connect(this.assetProtectionRole).freeze(frozenDestination.address);
      expect(await this.token.isFrozen(frozenDestination.address)).to.be.true;
    });

    describe('adminSetPayoutGroupDestination', function () {
      it('should revert when newDestination is frozen', async function () {
        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, frozenDestination.address)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should allow setting destination to address(0)', async function () {
        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, ethers.ZeroAddress)
        ).to.emit(this.token, 'PayoutGroupDestinationSet');

        // Verify destination was set to zero (will fallback to claimer)
        const destination = await this.token.getPayoutGroupDestination(this.payoutGroupId);
        expect(destination).to.equal(this.acc.address); // Falls back to claimer
      });

      it('should succeed when newDestination is not frozen', async function () {
        const signers = await ethers.getSigners();
        const unfrozenDestination = signers[11];

        await expect(
          this.token.connect(this.owner).adminSetPayoutGroupDestination(this.payoutGroupId, unfrozenDestination.address)
        ).to.emit(this.token, 'PayoutGroupDestinationSet');
      });
    });

    describe('setPayoutGroupDestination (manager)', function () {
      it('should revert when newDestination is frozen', async function () {
        await expect(
          this.token.connect(this.acc3).setPayoutGroupDestination(this.payoutGroupId, frozenDestination.address)
        ).to.be.revertedWithCustomError(this.token, 'AddressFrozen');
      });

      it('should allow setting destination to address(0)', async function () {
        await expect(
          this.token.connect(this.acc3).setPayoutGroupDestination(this.payoutGroupId, ethers.ZeroAddress)
        ).to.emit(this.token, 'PayoutGroupDestinationSet');

        // Verify destination was set to zero (will fallback to claimer)
        const destination = await this.token.getPayoutGroupDestination(this.payoutGroupId);
        expect(destination).to.equal(this.acc.address); // Falls back to claimer
      });

      it('should succeed when newDestination is not frozen', async function () {
        const signers = await ethers.getSigners();
        const unfrozenDestination = signers[11];

        await expect(
          this.token.connect(this.acc3).setPayoutGroupDestination(this.payoutGroupId, unfrozenDestination.address)
        ).to.emit(this.token, 'PayoutGroupDestinationSet');
      });
    });
  });
});
