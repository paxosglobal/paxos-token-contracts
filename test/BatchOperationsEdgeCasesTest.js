const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('Batch Operations Edge Cases', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Create a payout group for testing
    await setupMultiplierWithBounds(this);
    this.payoutGroupId = await createPayoutGroup(this, 1, this.owner);
  });

  describe('Empty Array Handling', function () {
    describe('registrarRegisterRewardAddressBatch', function () {
      it('should succeed with empty array without reverting', async function () {
        const emptyArray = [];

        // Should not revert
        await expect(
          this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, emptyArray)
        ).to.not.be.reverted;
      });

      it('should not emit any events with empty array', async function () {
        const emptyArray = [];

        const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, emptyArray);
        const receipt = await tx.wait();

        // Filter for AccountRegistered events
        const events = receipt.logs.filter(log => {
          try {
            const parsed = this.token.interface.parseLog(log);
            return parsed.name === 'AccountRegistered';
          } catch {
            return false;
          }
        });

        // Should have no events
        expect(events.length).to.equal(0);
      });

      it('should not change payout group balance with empty array', async function () {
        const balanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);

        const emptyArray = [];
        await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, emptyArray);

        const balanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);

        // Balance should remain unchanged
        expect(balanceAfter).to.equal(balanceBefore);
      });

      it('should be gas-efficient with empty array', async function () {
        const emptyArray = [];

        const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, emptyArray);
        const receipt = await tx.wait();

        // Gas used should be minimal (just the function call overhead)
        // This is more of a sanity check than a strict requirement
        expect(receipt.gasUsed).to.be.lt(100000n); // Should be much less than 100k gas
      });
    });

    describe('registrarUnregisterRewardAddressBatch', function () {
      it('should succeed with empty array without reverting', async function () {
        const emptyArray = [];

        // Should not revert
        await expect(
          this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, emptyArray)
        ).to.not.be.reverted;
      });

      it('should not emit any events with empty array', async function () {
        const emptyArray = [];

        const tx = await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, emptyArray);
        const receipt = await tx.wait();

        // Filter for AccountDeregistered events
        const events = receipt.logs.filter(log => {
          try {
            const parsed = this.token.interface.parseLog(log);
            return parsed.name === 'AccountDeregistered';
          } catch {
            return false;
          }
        });

        // Should have no events
        expect(events.length).to.equal(0);
      });

      it('should not change payout group balance with empty array', async function () {
        // First register and setup some accounts so the group has a balance
        await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
        await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
        await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);

        const balanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);

        const emptyArray = [];
        await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, emptyArray);

        const balanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);

        // Balance should remain unchanged
        expect(balanceAfter).to.equal(balanceBefore);
      });

      it('should be gas-efficient with empty array', async function () {
        const emptyArray = [];

        const tx = await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, emptyArray);
        const receipt = await tx.wait();

        // Gas used should be minimal (just the function call overhead)
        // This is more of a sanity check than a strict requirement
        expect(receipt.gasUsed).to.be.lt(100000n); // Should be much less than 100k gas
      });
    });
  });

  describe('Single Element Array', function () {
    it('should work correctly with single element in register batch', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      const singleAccountArray = [this.acc.address];

      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, singleAccountArray)
      ).to.emit(this.token, 'AccountRegistered')
        .withArgs(this.acc.address, this.payoutGroupId, this.owner.address);

      // Verify registration
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(this.payoutGroupId);
    });

    it('should work correctly with single element in unregister batch', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Register first
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);

      const singleAccountArray = [this.acc.address];

      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, singleAccountArray)
      ).to.emit(this.token, 'AccountDeregistered')
        .withArgs(this.acc.address, this.payoutGroupId, this.owner.address);

      // Verify unregistration
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
    });
  });

  describe('Authorization with Empty Array', function () {
    it('should still require PAYOUT_GROUP_REGISTRAR_ROLE for empty register batch', async function () {
      const emptyArray = [];

      // Try to call with non-registrar account
      await expect(
        this.token.connect(this.acc).registrarRegisterRewardAddressBatch(this.payoutGroupId, emptyArray)
      ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });

    it('should still require PAYOUT_GROUP_REGISTRAR_ROLE for empty unregister batch', async function () {
      const emptyArray = [];

      // Try to call with non-registrar account
      await expect(
        this.token.connect(this.acc).registrarUnregisterRewardAddressBatch(this.payoutGroupId, emptyArray)
      ).to.be.revertedWithCustomError(this.token, 'InvalidClaimer');
    });
  });

  describe('Duplicate Addresses in Batch', function () {
    it('should handle duplicate addresses in register batch idempotently', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Array with duplicate addresses
      const duplicateArray = [this.acc.address, this.acc.address, this.acc.address];

      const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, duplicateArray);
      const receipt = await tx.wait();

      // Filter for AccountRegistered events
      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountRegistered';
        } catch {
          return false;
        }
      });

      // Should only emit one event (first registration), subsequent are idempotent
      expect(events.length).to.equal(1);

      // Verify account is registered only once
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(this.payoutGroupId);
    });

    it('should handle duplicate addresses in unregister batch idempotently', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 2n);
      await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);

      // Register first
      await this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc.address);

      // Array with duplicate addresses
      const duplicateArray = [this.acc.address, this.acc.address, this.acc.address];

      const tx = await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(this.payoutGroupId, duplicateArray);
      const receipt = await tx.wait();

      // Filter for AccountDeregistered events
      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountDeregistered';
        } catch {
          return false;
        }
      });

      // Should only emit one event (first unregistration), subsequent are idempotent
      expect(events.length).to.equal(1);

      // Verify account is unregistered
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);
    });
  });
});
