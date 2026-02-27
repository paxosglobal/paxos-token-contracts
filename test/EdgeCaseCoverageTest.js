const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

describe('Edge Case Coverage - Uncovered Lines', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Set up rewards
    await this.token.connect(this.owner).setMaturityPeriod(86400); // 1 day
  });

  describe('ClaimableRewardsBase.sol:229 - Claim with no payout group', function() {
    it('should document that line 229 is unreachable with current guards', async function() {
      // LINE 229: `if (wallet.payoutGroupId == 0) { return false; }`
      // in _claimIndividualRewards() is defensive code that's unreachable because:
      //
      // All external claim functions in ClaimableRewardsFacet check:
      // 1. payoutGroupId must be active (line 78: _isPayoutGroupActive check)
      // 2. account.payoutGroupId must match payoutGroupId parameter (line 84 check)
      //
      // Since payoutGroupId=0 is never active (_isPayoutGroupActive returns false for 0),
      // the call reverts BEFORE reaching _claimIndividualRewards().
      //
      // This guard protects against:
      // - Future refactoring that removes the early checks
      // - Direct calls from other internal functions
      // - Contract-to-contract calls bypassing facet checks

      // Give account a balance but DO NOT register it to a payout group
      const mintAmount = ethers.parseUnits("1000", 6);
      await this.token.connect(this.owner).increaseSupply(mintAmount);
      await this.token.connect(this.owner).transfer(this.acc.address, mintAmount);

      // Verify account has balance but no payout group
      expect(await this.token.balanceOf(this.acc.address)).to.equal(mintAmount);
      expect(await this.token.payoutGroupIdOf(this.acc.address)).to.equal(0);

      // Create a multiplier and payout group for the owner (so we have authorization to call claimOne)
      await setupMultiplierWithBounds(this); // creates mult 1
      const ownerPayoutGroupId = await createPayoutGroup(this, 1, this.owner);

      // Try to claim for acc using payoutGroupId=0
      // This reverts at the InactivePayoutGroup check, never reaching line 229
      await expect(
        this.token.connect(this.owner).claimForAddresses(0, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'InactivePayoutGroup');

      // Try to claim for acc using a valid payoutGroupId (but acc isn't in that group)
      // This reverts at the PayoutGroupMismatch check, never reaching line 229
      await expect(
        this.token.connect(this.owner).claimForAddresses(ownerPayoutGroupId, [this.acc.address])
      ).to.be.revertedWithCustomError(this.token, 'PayoutGroupMismatch');

      // Conclusion: Line 229 is defensive code that can't be reached with current architecture
      // but provides safety against future code changes
    });
  });


  describe('PayoutGroupFacet.sol:80 - nextPayoutId initialization', function() {
    it('should document that line 80 is unreachable with proper initialization', async function() {
      // LINE 80: `if (nextPayoutId == 0) { nextPayoutId = 1; }`
      // in createPayoutGroup() is defensive code that's unreachable because:
      //
      // Normal initialization flow:
      // 1. Deploy proxy and implementation
      // 2. Call initializeV3() which sets nextPayoutId = 1
      // 3. All subsequent createPayoutGroup() calls see nextPayoutId > 0
      //
      // This guard only triggers if:
      // - Someone calls createPayoutGroup() before initializeV3()
      // - Storage is manually cleared/corrupted
      // - Diamond facet is added without proper initialization
      //
      // This is excellent upgrade safety - prevents assigning payoutId = 0
      // which is reserved as the "no payout group" sentinel value.
      //
      // This guard protects against:
      // - Missing initialization in upgrade scenarios
      // - Diamond facet deployment without storage initialization
      // - Manual storage manipulation
      // - Testing scenarios without full initialization

      // Verify payout IDs start at 1 (initializeV3 already ran in fixture)
      await setupMultiplierWithBounds(this); // creates mult 1
      const firstPayoutId = await createPayoutGroup(this, 1, this.acc);
      expect(firstPayoutId).to.equal(1);

      // Create another payout group to verify incrementing works
      const secondPayoutId = await createPayoutGroup(this, 1, this.acc2);
      expect(secondPayoutId).to.equal(2);

      // Create a third to demonstrate sequential assignment
      const thirdPayoutId = await createPayoutGroup(this, 1, this.acc3);
      expect(thirdPayoutId).to.equal(3);

      // Conclusion: Line 80 is defensive code that can't be reached with proper
      // initialization, but provides critical safety against initialization errors
    });
  });
});
