const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

describe('Idempotent Batch Operations', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  describe('Idempotent Batch Registration', function () {
    it('should succeed when all addresses are already registered to the same payout group', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and payout group
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Register all accounts individually first
      for (const account of accounts) {
        await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, account);
      }

      // Verify all accounts are registered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(payoutGroupId);
      }

      // Batch register the SAME accounts again - should succeed (idempotent)
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts)
      ).to.not.be.reverted;

      // Verify all accounts are still registered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(payoutGroupId);
      }
    });

    it('should succeed when some addresses are already registered and some are not', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and payout group
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Register only first two accounts
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[0]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[1]);

      // Verify registration state before batch
      expect(await this.token.payoutGroupIdOf(accounts[0])).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(accounts[1])).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(accounts[2])).to.equal(0);

      // Batch register ALL accounts - should succeed (idempotent for first two, register third)
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts)
      ).to.emit(this.token, 'AccountRegistered'); // Only for the third account

      // Verify all accounts are now registered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(payoutGroupId);
      }
    });

    it('should auto-unregister when one address is registered to a different payout group', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and two payout groups
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroup1Id = await createPayoutGroup(this, 1, this.owner);
      const payoutGroup2Id = await createPayoutGroup(this, 1, this.acc);

      // Register acc2 to group 1, acc3 to group 2
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, accounts[1]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup2Id, accounts[2]);

      // Batch register all to group 1 - should auto-unregister acc3 from group 2
      const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(payoutGroup1Id, accounts);

      // Verify all accounts are now in group 1
      for (const account of accounts) {
        expect(await this.token.payoutGroupIdOf(account)).to.equal(payoutGroup1Id);
      }

      // Should have emitted AccountDeregistered for acc3 (from group 2)
      await expect(tx).to.emit(this.token, 'AccountDeregistered')
        .withArgs(accounts[2], payoutGroup2Id, this.acc.address);
    });

    it('should emit AccountRegistered only for newly registered accounts', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
      const accounts = [this.acc.address, this.acc2.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and payout group
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Register first account
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[0]);

      // Batch register both - should only emit event for second account
      const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
      const receipt = await tx.wait();

      // Count AccountRegistered events
      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountRegistered';
        } catch {
          return false;
        }
      });

      // Should have exactly 1 event for the newly registered account
      expect(events.length).to.equal(1);

      const parsedEvent = this.token.interface.parseLog(events[0]);
      expect(parsedEvent.args.account).to.equal(accounts[1]);
    });
  });

  describe('Idempotent Batch Unregistration', function () {
    it('should succeed when all addresses are already unregistered', async function () {
      // Setup accounts with balances but NOT registered
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and payout group
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Verify all accounts are NOT registered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(0);
      }

      // Batch unregister when already unregistered - should succeed (idempotent)
      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroupId, accounts)
      ).to.not.be.reverted;

      // Verify all accounts are still unregistered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(0);
      }
    });

    it('should succeed when some addresses are already unregistered', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier, payout group and register all
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      for (const account of accounts) {
        await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, account);
      }

      // Unregister only first account
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, accounts[0]);

      // Verify state before batch unregister
      expect(await this.token.payoutGroupIdOf(accounts[0])).to.equal(0); // Already unregistered
      expect(await this.token.payoutGroupIdOf(accounts[1])).to.equal(payoutGroupId);
      expect(await this.token.payoutGroupIdOf(accounts[2])).to.equal(payoutGroupId);

      // Batch unregister all - should succeed (idempotent for first, unregister others)
      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroupId, accounts)
      ).to.emit(this.token, 'AccountDeregistered'); // For second and third accounts

      // Verify all accounts are unregistered
      for (const account of accounts) {
        const groupId = await this.token.payoutGroupIdOf(account);
        expect(groupId).to.equal(0);
      }
    });

    it('should fail when one address is registered to a different payout group', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and two payout groups
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroup1Id = await createPayoutGroup(this, 1, this.owner);
      const payoutGroup2Id = await createPayoutGroup(this, 1, this.acc);

      // Register accounts to different groups
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, accounts[0]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup1Id, accounts[1]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroup2Id, accounts[2]);

      // Try to batch unregister from group 1 - should fail because acc3 is in group 2
      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroup1Id, accounts)
      ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should emit AccountDeregistered only for actually unregistered accounts', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
      const accounts = [this.acc.address, this.acc2.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier, payout group and register both
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      for (const account of accounts) {
        await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, account);
      }

      // Unregister first account
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, accounts[0]);

      // Batch unregister both - should only emit event for second account
      const tx = await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroupId, accounts);
      const receipt = await tx.wait();

      // Count AccountDeregistered events
      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountDeregistered';
        } catch {
          return false;
        }
      });

      // Should have exactly 1 event for the newly unregistered account
      expect(events.length).to.equal(1);

      const parsedEvent = this.token.interface.parseLog(events[0]);
      expect(parsedEvent.args.account).to.equal(accounts[1]);
    });

    it('should skip already unregistered accounts and process remaining accounts', async function () {
      // Setup accounts with balances
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      const accounts = [this.acc.address, this.acc2.address, this.acc3.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      // Create multiplier and payout group with a different destination to track rewards
      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Set acc as the destination (different from claimer)
      await this.token.connect(this.owner).adminSetPayoutGroupDestination(payoutGroupId, this.acc.address);

      // Register only second and third accounts (first account stays unregistered)
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[1]);
      await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, accounts[2]);

      // Create rewards
      await this.token.connect(this.owner).setMaturityPeriod(86400);
      await this.token.connect(this.owner).setRateBoundsByAPR(0, ethers.parseUnits("50", 10)); // 0-10000% APR for testing
      const futureTime = (await time.latest()) + 3600;
      await setNextMultiplier(this.token, this.owner, 1, ethers.parseUnits("1.0001", 12), futureTime);
      await time.increase(3601);

      // Verify registered accounts have rewards
      expect(await this.token.availableRewardsOf(accounts[1])).to.be.gt(0);
      expect(await this.token.availableRewardsOf(accounts[2])).to.be.gt(0);
      // First account should have no rewards (not registered)
      expect(await this.token.availableRewardsOf(accounts[0])).to.equal(0);

      const destinationBalanceBefore = await this.token.balanceOf(this.acc.address);

      // Batch unregister all three - first should be skipped (already unregistered), others should be processed
      await expect(
        this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroupId, accounts)
      ).to.emit(this.token, 'AccountDeregistered'); // For accounts[1] and accounts[2]

      const destinationBalanceAfter = await this.token.balanceOf(this.acc.address);

      // Verify destination received rewards from the two registered accounts
      expect(destinationBalanceAfter).to.be.gt(destinationBalanceBefore);

      // Verify all accounts are unregistered and have no rewards
      for (const account of accounts) {
        expect(await this.token.payoutGroupIdOf(account)).to.equal(0);
        expect(await this.token.availableRewardsOf(account)).to.equal(0);
      }
    });
  });

  describe('Combined Scenarios', function () {
    it('should handle register batch with all same state (all already registered)', async function () {
      // Setup
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
      const accounts = [this.acc.address, this.acc2.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Register all individually
      for (const account of accounts) {
        await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, account);
      }

      // Batch register - no events should be emitted (all already registered)
      const tx = await this.token.connect(this.owner).registrarRegisterRewardAddressBatch(payoutGroupId, accounts);
      const receipt = await tx.wait();

      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountRegistered';
        } catch {
          return false;
        }
      });

      expect(events.length).to.equal(0); // No new registrations
    });

    it('should handle unregister batch with all same state (all already unregistered)', async function () {
      // Setup accounts but don't register them
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 4n);
      const accounts = [this.acc.address, this.acc2.address];

      for (const account of accounts) {
        await this.token.connect(this.owner).transfer(account, ONE_ETHER);
      }

      await setupMultiplierWithBounds(this); // creates mult 1
      const payoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Batch unregister - no events should be emitted (all already unregistered)
      const tx = await this.token.connect(this.owner).registrarUnregisterRewardAddressBatch(payoutGroupId, accounts);
      const receipt = await tx.wait();

      const events = receipt.logs.filter(log => {
        try {
          const parsed = this.token.interface.parseLog(log);
          return parsed.name === 'AccountDeregistered';
        } catch {
          return false;
        }
      });

      expect(events.length).to.equal(0); // No unregistrations occurred
    });
  });
});
