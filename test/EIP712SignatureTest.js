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

async function getEIP712Domain(token, chainIdOverride) {
  const chainId = chainIdOverride !== undefined ? chainIdOverride : (await ethers.provider.getNetwork()).chainId;
  return {
    name: FACET_EIP712_NAME,
    version: '1',
    chainId: chainId,
    verifyingContract: await token.getAddress()
  };
}

async function signRegistration(signer, token, account, payoutGroupId, nonce, deadline, domainOverride) {
  const domain = domainOverride || await getEIP712Domain(token);

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

describe('EIP-712 Signature Testing', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Get additional signers
    const signers = await ethers.getSigners();
    this.acc4 = signers[8];
    this.acc5 = signers[9];

    // Setup accounts
    await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
    await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
    await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);

    // Create multiplier and payout group with acc as claimer
    await setupMultiplierWithBounds(this); // creates mult 1
    this.payoutGroupId = await createPayoutGroup(this, 1, this.acc);

    // Enable partner signed registrations
    await this.token.connect(this.owner).setPartnerSignedRegistrationsEnabled(true);
  });

  describe('14.1 Domain Separator', function () {
    it('should include correct chainId in domain separator', async function () {
      const domain = await getEIP712Domain(this.token);
      const network = await ethers.provider.getNetwork();

      expect(domain.chainId).to.equal(network.chainId);
      expect(domain.chainId).to.be.greaterThan(0);
    });

    it('should have consistent domain separator during normal operation', async function () {
      const domainSeparator1 = await this.token.DOMAIN_SEPARATOR();

      // Perform some operations
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
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        accountToRegister,
        nonce,
        deadline,
        signature
      );

      // Domain separator should remain the same
      const domainSeparator2 = await this.token.DOMAIN_SEPARATOR();
      expect(domainSeparator1).to.equal(domainSeparator2);
    });

    it('should include contract address in domain separator', async function () {
      const domain = await getEIP712Domain(this.token);
      const tokenAddress = await this.token.getAddress();

      expect(domain.verifyingContract).to.equal(tokenAddress);
      expect(domain.verifyingContract).to.not.equal(ZeroAddress);
    });
  });

  describe('14.2 Type Hashes', function () {
    it('should have correct REGISTER_REWARD_ADDRESS_TYPEHASH', async function () {
      const expectedTypeHash = ethers.keccak256(
        ethers.toUtf8Bytes('RegisterRewardAddress(address account,uint32 payoutGroupId,bytes32 nonce,uint256 deadline)')
      );

      const actualTypeHash = await this.token.REGISTER_REWARD_ADDRESS_TYPEHASH();

      expect(actualTypeHash).to.equal(expectedTypeHash);
    });

    it('should encode signature data correctly according to EIP-712 spec', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create signature
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Should succeed with proper encoding
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

    it('should include nonce in signed message', async function () {
      const accountToRegister = this.acc3.address;
      const nonce1 = ethers.randomBytes(32);
      const nonce2 = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create signature with nonce1
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce1,
        deadline
      );

      // Try to use signature with different nonce2 - should fail
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce2, // Different nonce
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should include deadline in signed message', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline1 = (await time.latest()) + 3600;
      const deadline2 = (await time.latest()) + 7200;

      // Create signature with deadline1
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline1
      );

      // Try to use signature with different deadline2 - should fail
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline2, // Different deadline
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should include account in signed message', async function () {
      const account1 = this.acc3.address;
      const account2 = this.acc4.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create signature for account1
      const sig = await signRegistration(
        this.acc3,
        this.token,
        account1,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Try to use signature for different account2 - should fail
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          account2, // Different account
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });

    it('should include payoutGroupId in signed message', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create second payout group
      const signers = await ethers.getSigners();
      const otherClaimer = signers[7];
      const otherPayoutGroupId = await createPayoutGroup(this, 1, otherClaimer);

      // Create signature for this.payoutGroupId
      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline
      );

      // Try to use signature with different payoutGroupId - should fail
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
      await expect(
        this.token.connect(otherClaimer).registerRewardAddress(
          otherPayoutGroupId, // Different payout group
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.revertedWithCustomError(this.token, 'InvalidSignature');
    });
  });

  describe('14.3 Signature Recovery', function () {
    it('should recover correct signer from valid signature', async function () {
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

      // Should succeed because signature recovers to acc3
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
    });

    it('should fail with signature from wrong signer', async function () {
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

    it('should fail with signature from wrong domain separator (different contract)', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create domain with wrong contract address
      const wrongDomain = {
        name: await this.token.name(),
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: this.acc4.address // Wrong contract address
      };

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline,
        wrongDomain
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

    it('should fail with signature from wrong domain separator (different chain ID)', async function () {
      const accountToRegister = this.acc3.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Create domain with wrong chain ID
      const wrongDomain = await getEIP712Domain(this.token, 999); // Wrong chain ID

      const sig = await signRegistration(
        this.acc3,
        this.token,
        accountToRegister,
        this.payoutGroupId,
        nonce,
        deadline,
        wrongDomain
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

    it('should fail with invalid v value', async function () {
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

      // Use invalid v value (valid v is 27 or 28)
      // This should fail with InvalidECRecoverSignature from ECRecover library
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, 25]); // Invalid v
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.reverted; // ECRecover will reject this
    });

    it('should fail with zero r value', async function () {
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

      // Use zero r value (invalid)
      // This should fail with InvalidECRecoverSignature from ECRecover library
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [ethers.ZeroHash, sig.s, sig.v]); // Zero r
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.reverted; // ECRecover will reject this
    });

    it('should fail with zero s value', async function () {
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

      // Use zero s value (invalid)
      // This should fail with InvalidECRecoverSignature from ECRecover library
      const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, ethers.ZeroHash, sig.v]); // Zero s
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          accountToRegister,
          nonce,
          deadline,
          signature
        )
      ).to.be.reverted; // ECRecover will reject this
    });

    it('should enforce replay protection via nonce tracking', async function () {
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

      // Unregister to allow re-registration
      await this.token.connect(this.owner).registrarUnregisterRewardAddress(
        this.payoutGroupId,
        accountToRegister
      );

      // Second call with same nonce should fail (replay attack)
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

    it('should have account-specific nonces (no cross-account replay)', async function () {
      const account1 = this.acc3.address;
      const account2 = this.acc4.address;
      const nonce = ethers.randomBytes(32);
      const deadline = (await time.latest()) + 3600;

      // Sign and register for account1
      const sig1 = await signRegistration(
        this.acc3,
        this.token,
        account1,
        this.payoutGroupId,
        nonce,
        deadline
      );

      const signature1 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig1.r, sig1.s, sig1.v]);
      await this.token.connect(this.acc).registerRewardAddress(
        this.payoutGroupId,
        account1,
        nonce,
        deadline,
        signature1
      );

      // Sign and register for account2 with same nonce value (but signed by acc4)
      // This should succeed because nonces are per-account
      const sig2 = await signRegistration(
        this.acc4,
        this.token,
        account2,
        this.payoutGroupId,
        nonce, // Same nonce value
        deadline
      );

      const signature2 = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig2.r, sig2.s, sig2.v]);
      await expect(
        this.token.connect(this.acc).registerRewardAddress(
          this.payoutGroupId,
          account2,
          nonce,
          deadline,
          signature2
        )
      ).to.emit(this.token, 'AccountRegistered')
        .withArgs(account2, this.payoutGroupId, this.acc.address);
    });

    it('should handle deadline boundary correctly (equal to deadline)', async function () {
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

      // Advance to exactly deadline
      await time.increaseTo(deadline);

      // Should succeed because check is `block.timestamp > deadline` (not >=)
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

    it('should reject signature one second past deadline', async function () {
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

      // Advance to deadline + 1 second
      await time.increaseTo(deadline + 1);

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

    it('should not consume nonce when signature validation fails', async function () {
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

      // Should succeed - the nonce was NOT consumed because the transaction reverted
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
  });
});
