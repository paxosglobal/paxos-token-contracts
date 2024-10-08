const { deployRateLimitTest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {assert, expect} = require('chai');
const { limits } = require('./helpers/constants');
const { MaxUint256 } = require("hardhat").ethers;

describe('Rate Limit', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployRateLimitTest));
  });

  describe('initialization', function () {
    it('is initialized properly', async function () {
      const limitConfig = await this.rateLimit.getLimitConfig();
      const remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(limitConfig.limitCapacity, limits.LIMIT_CAPACITY);
      assert.equal(limitConfig.refillPerSecond, limits.REFILL_PER_SECOND);
      assert.equal(remainingAmount, 0);
    });
  });

  describe('basic checking', function () {
    it('can checkNewMintEvent with no prior events', async function () {
        await this.rateLimit.checkNewEvent(100, 1000);
        const limitConfig = await this.rateLimit.getLimitConfig();
        const remainingAmount = await this.rateLimit.remainingAmount();
        assert.equal(limitConfig.limitCapacity, limits.LIMIT_CAPACITY);
        assert.equal(limitConfig.refillPerSecond, limits.REFILL_PER_SECOND);
        assert.equal(remainingAmount, 1000);

        const remainingLimit2 = await this.rateLimit.getRemainingAmount(110);
        assert.equal(remainingLimit2, 1500);
    });

    it('can checkNewMintEvent with prior events', async function () {
        await this.rateLimit.checkNewEvent(100, 1000);
        await this.rateLimit.checkNewEvent(105, 500);
        const remainingAmount = await this.rateLimit.remainingAmount();
        assert.equal(remainingAmount, 750);

        const remainingLimit = await this.rateLimit.getRemainingAmount(110);
        assert.equal(remainingLimit, 1000);
    });

    it('Can getRemainingAmount with various timestamps', async function () {
      await this.rateLimit.checkNewEvent(200, 500);

      const remainingLimit2 = await this.rateLimit.getRemainingAmount(200);
      assert.equal(remainingLimit2, (limits.LIMIT_CAPACITY - 500));

      const remainingLimit3 = await this.rateLimit.getRemainingAmount(208); //8*50 = 400 more
      assert.equal(remainingLimit3, 1900);

      const remainingLimit4 = await this.rateLimit.getRemainingAmount(250); //50*50 = 2500 more, use lower LIMIT_CAPACITY instead
      assert.equal(remainingLimit4, limits.LIMIT_CAPACITY);
    });

    it('Cannot getRemainingAmount with old timestamp', async function () {
      await this.rateLimit.checkNewEvent(200, 500);
      await expect(this.rateLimit.getRemainingAmount(150)).to.be.revertedWithCustomError(this.rateLimit, "OldTimestamp");
    });

    it('Cannot checkNewEvent with old timestamp', async function () {
      await this.rateLimit.checkNewEvent(200, 500);
      await expect(this.rateLimit.checkNewEvent(150, 500)).to.be.revertedWithCustomError(this.rateLimit, "OldTimestamp");
    });

    it('Rejects mints over limitCapacity', async function () {
        await this.rateLimit.checkNewEvent(100, 1000);
        await this.rateLimit.checkNewEvent(105, 500);
        //remainingAmount = 750.  1000 extra puts it over the limit
        await expect(this.rateLimit.checkNewEvent(106, 1000)).to.be.revertedWithCustomError(this.rateLimit, "RateLimitExceeded");
    });

    it('Accepts mint if remaining amount completely refilled', async function () {
        await this.rateLimit.checkNewEvent(100, 1000);
        await this.rateLimit.checkNewEvent(105, 500);
        await this.rateLimit.checkNewEvent(300, 1000);
        const remainingAmount = await this.rateLimit.remainingAmount();
        assert.equal(remainingAmount, 1000);

        const remainingLimit = await this.rateLimit.getRemainingAmount(300);
        assert.equal(remainingLimit, 1000);
    });

    it('Returns if refill per second is set to 0', async function () {
      await this.rateLimit.updateLimitConfig([limits.LIMIT_CAPACITY, 0]);
      await this.rateLimit.checkNewEvent(100, 1000);
      const limitConfig = await this.rateLimit.getLimitConfig();
      const remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(limitConfig.limitCapacity, limits.LIMIT_CAPACITY);
      assert.equal(limitConfig.refillPerSecond, 0);
      assert.equal(remainingAmount, 0); //Returns immediately so remainingAmount is not updated

      const remainingLimit = await this.rateLimit.getRemainingAmount(150);
      assert.equal(remainingLimit, MaxUint256);
    });
  });

  describe('Complex test cases', function () {
    it('Handles adding and removing multiple elements', async function () {
      for (let i = 0; i < 10; i++) {
        await this.rateLimit.checkNewEvent(100 + i, 100); //Each second 100 gets added but 50 is removed (besides last second) = 450
      }
      let limitConfig = await this.rateLimit.getLimitConfig();
      let remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(limitConfig.limitCapacity, limits.LIMIT_CAPACITY);
      assert.equal(limitConfig.refillPerSecond, limits.REFILL_PER_SECOND);
      assert.equal(remainingAmount, 1450);

      await this.rateLimit.checkNewEvent(115, 200); //6 seconds more than previous element 1450 + 300 - 200 = 1550

      remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(remainingAmount, 1550); 

      await this.rateLimit.checkNewEvent(300, 150); //Remaining amount is refilled
      remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(remainingAmount, 1850);
    });
  });

  describe('Overflows', function () {
    it('Handles adding and removing multiple elements', async function () {
      await this.rateLimit.updateLimitConfig([1000, MaxUint256 - BigInt(1)])
      await this.rateLimit.checkNewEvent(100, 100); //Overflows multiplication operation
      let remainingAmount = await this.rateLimit.remainingAmount();
      assert.equal(remainingAmount, 900);

      const remainingLimit = await this.rateLimit.getRemainingAmount(101); //Overflows add operation
      assert.equal(remainingLimit, 1000);

      const remainingLimit2 = await this.rateLimit.getRemainingAmount(150); //Overflow multiplication operation
      assert.equal(remainingLimit2, 1000);

      await this.rateLimit.checkNewEvent(101, 100); //Overflows add operation
      let remainingAmount2 = await this.rateLimit.remainingAmount();
      assert.equal(remainingAmount2, 900);
    });

  });
});
