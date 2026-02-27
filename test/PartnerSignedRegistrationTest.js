const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { setNextMultiplier, grantAllTestRoles } = require('./helpers/testHelpers');
const { createPayoutGroup, setupMultiplierWithBounds } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);
const MULTIPLIER_BASE = ethers.parseUnits("1", 12);

// EIP-712 helpers
// Facets hardcode "Global Dollar" as the EIP-712 domain name for DOMAIN_SEPARATOR
const FACET_EIP712_NAME = "Global Dollar";

async function getEIP712Domain(token) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return {
    name: FACET_EIP712_NAME,
    version: '1',
    chainId: chainId,
    verifyingContract: await token.getAddress()
  };
}

async function signRegistration(signer, token, account, payoutGroupId, nonce, deadline) {
  const domain = await getEIP712Domain(token);

  const types = {
    RegisterRewardAddress: [
      { name: 'account', type: 'address' },
      { name: 'payoutGroupId', type: 'uint32' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'deadline', type: 'uint256' }
    ]
  };

  const value = {
    account: account,
    payoutGroupId: payoutGroupId,
    nonce: nonce,
    deadline: deadline
  };

  const signature = await signer.signTypedData(domain, types, value);
  return ethers.Signature.from(signature);
}

describe('Partner Signed Registration', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Setup accounts
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

    // Setup multiplier before creating payout group
    await setupMultiplierWithBounds(this);

    // Create payout group with acc as claimer
    this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);

    // Set acc2 as manager
    await this.token.connect(this.owner).adminSetPayoutGroupManager(this.payoutGroupId, this.acc2.address);

    // Enable partner signed registrations
    await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(true);
  });

  describe('Feature Flag', function () {
    it('should allow registration when feature is enabled', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered')
        .withArgs(accountToRegister, this.payoutGroupId, this.acc.address);

      // Verify account is registered
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);
    });

    it('should reject registration when feature is disabled', async function () {
      // Disable feature
      await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(false);

      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'PartnerSignedRegistrationsDisabled');
    });

    it('should emit event when feature flag is toggled', async function () {
      await expect(
        this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(false)
      ).to.emit(this.token, 'PartnerSignedRegistrationsEnabledSet')
        .withArgs(false);

      await expect(
        this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(true)
      ).to.emit(this.token, 'PartnerSignedRegistrationsEnabledSet')
        .withArgs(true);
    });
  });

  describe('Claimer-Initiated Registration', function () {
    it('should allow claimer to register account with valid signature', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered');
    });

    it('should reject when called by non-claimer/non-manager', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Random account tries to call (not claimer or manager)
      // Use acc3 since we know it's not claimer (acc) or manager (acc2)
      const randomAccount = this.acc3;

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(randomAccount).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });
  });

  describe('Manager-Initiated Registration', function () {
    it('should allow manager to register account with valid signature', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc2).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered');
    });
  });

  describe('Signature Validation', function () {
    it('should reject expired signature', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Fast forward past deadline
      await time.increase(3601);

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'SignatureExpired');
    });

    it('should reject signature from wrong signer', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // acc2 signs instead of acc3
      const sig = await signRegistration(
        this.acc2,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should reject signature with wrong payout group ID', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Sign for different payout group
      const wrongPayoutGroupId = 999;
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        wrongPayoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should reject malformed signature', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create a valid signature but for wrong data
      const wrongNonce = ethers.randomBytes(32);
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        wrongNonce, // Wrong nonce
        deadline
      );

      // Use the signature with the correct nonce (signature won't match)
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce, // Different nonce than what was signed
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });
  });

  describe('Nonce Management - CRITICAL BUG TEST', function () {
    it('should NOT consume nonce when signature is invalid (transaction reverts)', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // First attempt: Invalid signature (signed by wrong account)
      const invalidSig = await signRegistration(
        this.acc2, // Wrong signer
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const invalidSignature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [invalidSig.r, invalidSig.s, invalidSig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          invalidSignature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');

      // Second attempt: Use the SAME nonce with VALID signature
      const validSig = await signRegistration(
        this.acc3, // Correct signer
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Nonce was not consumed because the transaction reverted
      const validSignature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [validSig.r, validSig.s, validSig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          validSignature
        )
      ).to.emit(this.token, 'AccountRegistered');
    });

    it('should consume nonce on successful registration', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // First call succeeds
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      // Second call with same nonce should fail
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'AuthorizationAlreadyUsed');
    });

    it('should allow different nonces for same account', async function () {
      const accountToRegister = this.acc3.address;
      const deadline = (await time.latest()) + 3600;

      // First registration with nonce1
      const nonce1 = ethers.randomBytes(32);
      const sig1 = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce1,
        deadline
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig1.r, sig1.s, sig1.v]);
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        accountToRegister,
        nonce1,
        deadline,
        signature1
      );

      // Unregister
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(
        this.payoutGroupId,
        accountToRegister
      );

      // Second registration with different nonce
      const nonce2 = ethers.randomBytes(32);
      const sig2 = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce2,
        deadline
      );

      const signature2 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig2.r, sig2.s, sig2.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce2,
          deadline,
          signature2
        )
      ).to.emit(this.token, 'AccountRegistered');
    });
  });

  describe('Deadline Enforcement', function () {
    it('should succeed when called before deadline', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const currentTime = await time.latest();
      const deadline = currentTime + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Advance time but stay before deadline
      await time.increase(1800); // 30 minutes

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered');
    });

    it('should succeed when called exactly at deadline', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const currentTime = await time.latest();
      const deadline = currentTime + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Advance to deadline - 1 to ensure transaction mines at or before deadline
      // (time.increaseTo sets next block time, but tx could mine 1 second later)
      await time.increaseTo(deadline - 1);

      // Should succeed because check is `block.timestamp > deadline` (not >=)
      // Transaction will be mined at deadline or deadline-1, both valid
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered');
    });

    it('should reject when called after deadline', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      await time.increase(7200); // 2 hours

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'SignatureExpired');
    });
  });

  describe('Idempotency', function () {
    it('should be idempotent when account already registered to same group', async function () {
      const accountToRegister = this.acc3.address;

      // First registration via registrar
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        this.payoutGroupId,
        accountToRegister
      );

      // Second registration via signature (should be no-op)
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Should succeed without error (idempotent)
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.not.be.reverted;

      // Verify still registered to same group
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);
    });

    it('should auto-unregister when account already registered to different group', async function () {
      // Create second payout group (reuses same multiplier)
      const signers = await ethers.getSigners();
      const otherClaimer = signers[7];
      const otherPayoutGroupId = await createPayoutGroup(this, 1, otherClaimer);

      const accountToRegister = this.acc3.address;

      // Register to first group
      await this.token.connect(this.owner).registrarRegisterRewardAddress(
        this.payoutGroupId,
        accountToRegister
      );

      // Verify registered to first group
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);

      // Register to second group via signature - should auto-unregister from first
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        otherPayoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      const tx = await this.token.connect(otherClaimer).registerRewardAddress(
        otherPayoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      // Should emit AccountDeregistered for first group and AccountRegistered for second
      await expect(tx).to.emit(this.token, 'AccountDeregistered')
        .withArgs(accountToRegister, this.payoutGroupId, this.acc.address);
      await expect(tx).to.emit(this.token, 'AccountRegistered')
        .withArgs(accountToRegister, otherPayoutGroupId, otherClaimer.address);

      // Verify now registered to second group
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(otherPayoutGroupId);
    });
  });

  describe('Registration State Verification', function () {
    it('should properly initialize shares and epoch for registered account', async function () {
      const accountToRegister = this.acc3.address;
      await this.token.connect(this.owner).transfer(accountToRegister, ONE_ETHER);

      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      // Verify registration
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);

      // Balance should be preserved
      expect(await this.token.balanceOf(accountToRegister)).to.equal(ONE_ETHER);

      // Should start with zero rewards
      expect(await this.token.availableRewardsOf(accountToRegister)).to.equal(0);
    });

    it('should update payout group balance when registering account with balance', async function () {
      const accountToRegister = this.acc3.address;
      await this.token.connect(this.owner).transfer(accountToRegister, ONE_ETHER);

      const groupBalanceBefore = await this.token.getPayoutGroupBalance(this.payoutGroupId);

      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      const groupBalanceAfter = await this.token.getPayoutGroupBalance(this.payoutGroupId);

      expect(groupBalanceAfter - groupBalanceBefore).to.equal(ONE_ETHER);
    });
  });

  describe('Edge Cases', function () {
    it('should reject registration to non-existent payout group', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;
      const fakePayoutGroupId = 999;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        fakePayoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          fakePayoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'NotAccountClaimer');
    });

    it('should handle registration with zero balance', async function () {
      const accountToRegister = this.acc3.address;

      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.emit(this.token, 'AccountRegistered');

      expect(await this.token.balanceOf(accountToRegister)).to.equal(0);
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);
    });
  });

  describe('EIP-712 Domain Separator', function () {
    it('should use correct domain separator components', async function () {
      const domain = await getEIP712Domain(this.token);

      expect(domain.name).to.not.be.empty;
      expect(domain.version).to.equal('1');
      expect(domain.chainId).to.be.greaterThan(0);
      expect(domain.verifyingContract).to.not.equal(ZeroAddress);
    });

    it('should include verifying contract address in domain separator', async function () {
      const domain = await getEIP712Domain(this.token);
      const tokenAddress = await this.token.getAddress();

      expect(domain.verifyingContract).to.equal(tokenAddress);
      expect(domain.verifyingContract).to.not.equal(ZeroAddress);
    });
  });

  describe('Claim Source Registration Prohibition', function () {
    it('should prohibit claim source registration via registrarRegisterRewardAddress', async function () {
      // owner is the claim source (set in fixture)
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);

      // Attempt to register claim source should revert
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.owner.address)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');
    });

    it('should prohibit claim source registration via signature-based registration', async function () {
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);

      // Sign registration for claim source
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;
      const sig = await signRegistration(
        this.owner,
        this.token,
        this.owner.address,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Attempt to register via signature should revert (called by acc who is the claimer)
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          this.owner.address,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');
    });

    it('should prohibit claim source registration via propose-accept flow', async function () {
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);

      // Attempt to propose claim source registration should revert
      await expect(
        this.token.connect(this.owner).proposeRegisterRewardAddress(this.payoutGroupId, this.owner.address)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');
    });

    it('should allow registering non-claim-source addresses normally', async function () {
      // Verify other addresses can still be registered (use acc2 who already has balance)
      // Should succeed for non-claim-source address
      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddress(this.payoutGroupId, this.acc2.address)
      ).to.not.be.reverted;

      // Verify registration succeeded
      expect(await this.token.payoutGroupIdOf(this.acc2.address)).to.equal(this.payoutGroupId);
    });

    it('should prohibit claim source in batch registration', async function () {
      const claimSource = await this.token.getClaimSource();
      expect(claimSource).to.equal(this.owner.address);

      // Attempt batch registration including claim source should revert
      const addresses = [this.acc.address, this.owner.address, this.acc2.address];

      await expect(
        this.token.connect(this.owner).registrarRegisterRewardAddressBatch(this.payoutGroupId, addresses)
      ).to.be.revertedWithCustomError(this.token, 'ClaimSourceCannotBeRegistered');
    });
  });

  describe('Bytes Signature Support', function () {
    it('should allow registration with valid bytes signature', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create the signature using the existing signRegistration helper
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Convert v,r,s to bytes signature format
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);

      // Register using bytes signature overload
      await expect(
        this.token.connect(this.acc)['registerRewardAddress(uint32,address,bytes32,uint256,bytes)'](
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.not.be.reverted;

      // Verify registration succeeded
      expect(await this.token.payoutGroupIdOf(accountToRegister)).to.equal(this.payoutGroupId);
    });

    it('should reject bytes signature when signature is invalid', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create signature with wrong signer (acc2 instead of acc3)
      const sig = await signRegistration(
        this.acc2,  // Wrong signer
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);

      await expect(
        this.token.connect(this.acc)['registerRewardAddress(uint32,address,bytes32,uint256,bytes)'](
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should reject bytes signature when deadline is expired', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);

      // Advance time past deadline
      await time.increase(3700);

      await expect(
        this.token.connect(this.acc)['registerRewardAddress(uint32,address,bytes32,uint256,bytes)'](
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'SignatureExpired');
    });

    it('should reject bytes signature when nonce is already used', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);

      // First call should succeed
      await this.token.connect(this.acc)['registerRewardAddress(uint32,address,bytes32,uint256,bytes)'](
        this.payoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      // Second call with same nonce should fail
      await expect(
        this.token.connect(this.acc)['registerRewardAddress(uint32,address,bytes32,uint256,bytes)'](
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'AuthorizationAlreadyUsed');
    });
  });
});
