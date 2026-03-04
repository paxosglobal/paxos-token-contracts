const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe('View Functions Test', function () {

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);
  });

  describe('allowance', function () {
    it('should return zero for initial allowance', async function () {
      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(0);
    });

    it('should return correct allowance after approve', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER * 2n);

      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(ONE_ETHER * 2n);
    });

    it('should return updated allowance after increaseApproval', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.owner).increaseApproval(this.acc.address, ONE_ETHER);

      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(ONE_ETHER * 2n);
    });

    it('should return updated allowance after decreaseApproval', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER * 3n);
      await this.token.connect(this.owner).decreaseApproval(this.acc.address, ONE_ETHER);

      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(ONE_ETHER * 2n);
    });

    it('should return zero after transferFrom consumes allowance', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.acc).transferFrom(this.owner.address, this.acc2.address, ONE_ETHER);

      const allowance = await this.token.allowance(this.owner.address, this.acc.address);
      expect(allowance).to.equal(0);
    });

    it('should handle allowance for multiple spenders independently', async function () {
      await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 5n);
      await this.token.connect(this.owner).approve(this.acc.address, ONE_ETHER);
      await this.token.connect(this.owner).approve(this.acc2.address, ONE_ETHER * 2n);

      const allowance1 = await this.token.allowance(this.owner.address, this.acc.address);
      const allowance2 = await this.token.allowance(this.owner.address, this.acc2.address);

      expect(allowance1).to.equal(ONE_ETHER);
      expect(allowance2).to.equal(ONE_ETHER * 2n);
    });
  });
});
