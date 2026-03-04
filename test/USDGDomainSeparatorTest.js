const { deployStableCoinFixtureUSDG } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ethers } = require("hardhat");

/**
 * Tests that USDG's DOMAIN_SEPARATOR and permit() use "Global Dollar" as the token name,
 * not the default "PaxosToken USD" from PaxosBaseAbstract.
 *
 * This is critical for EIP-712 signature compatibility - users query DOMAIN_SEPARATOR()
 * to know how to sign permits, so permit() must validate against the same domain.
 */
describe("USDG Domain Separator", function () {
  const EIP712_DOMAIN_TYPEHASH = "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
  const PERMIT_TYPEHASH = "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9";

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployStableCoinFixtureUSDG));
    this.chainId = (await ethers.provider.getNetwork()).chainId;
    this.tokenAddress = await this.token.getAddress();

    // Create a test signer
    this.testWallet = ethers.Wallet.createRandom().connect(ethers.provider);
  });

  function computeDomainSeparator(name, chainId, tokenAddress) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          EIP712_DOMAIN_TYPEHASH,
          ethers.keccak256(ethers.toUtf8Bytes(name)),
          ethers.keccak256(ethers.toUtf8Bytes("1")),
          chainId,
          tokenAddress
        ]
      )
    );
  }

  function signPermit(owner, spender, value, nonce, deadline, domainSeparator, privateKey) {
    const structHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "address", "uint256", "uint256", "uint256"],
        [PERMIT_TYPEHASH, owner, spender, value, nonce, deadline]
      )
    );

    const digest = ethers.keccak256(
      ethers.solidityPacked(
        ["string", "bytes32", "bytes32"],
        ["\x19\x01", domainSeparator, structHash]
      )
    );

    const signingKey = new ethers.SigningKey(privateKey);
    const sig = signingKey.sign(digest);
    return { v: sig.v, r: sig.r, s: sig.s };
  }

  describe("name() returns correct value", function () {
    it("should return 'Global Dollar' not 'PaxosToken USD'", async function () {
      const name = await this.token.name();
      expect(name).to.equal("Global Dollar");
      expect(name).to.not.equal("PaxosToken USD");
    });
  });

  describe("DOMAIN_SEPARATOR() uses 'Global Dollar'", function () {
    it("should match domain separator computed with 'Global Dollar'", async function () {
      const actualDomainSeparator = await this.token.DOMAIN_SEPARATOR();
      const expectedGlobalDollar = computeDomainSeparator("Global Dollar", this.chainId, this.tokenAddress);
      const expectedPaxosToken = computeDomainSeparator("PaxosToken USD", this.chainId, this.tokenAddress);

      expect(actualDomainSeparator).to.equal(expectedGlobalDollar);
      expect(actualDomainSeparator).to.not.equal(expectedPaxosToken);
    });

    it("should return same value when called via TokenExtensionsFacet interface", async function () {
      const facet = await ethers.getContractAt("TokenExtensionsFacet", this.tokenAddress);
      const mainDomainSeparator = await this.token.DOMAIN_SEPARATOR();
      const facetDomainSeparator = await facet.DOMAIN_SEPARATOR();

      expect(facetDomainSeparator).to.equal(mainDomainSeparator);
    });
  });

  describe("permit() validates signatures using 'Global Dollar'", function () {
    const value = 1000000n;
    const nonce = 0n;

    beforeEach(async function () {
      this.deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      this.spender = this.acc2.address;
      this.owner = this.testWallet.address;

      this.domainSeparatorGlobalDollar = computeDomainSeparator("Global Dollar", this.chainId, this.tokenAddress);
      this.domainSeparatorPaxosToken = computeDomainSeparator("PaxosToken USD", this.chainId, this.tokenAddress);
    });

    it("should accept permit signed with 'Global Dollar' domain", async function () {
      const { v, r, s } = signPermit(
        this.owner,
        this.spender,
        value,
        nonce,
        this.deadline,
        this.domainSeparatorGlobalDollar,
        this.testWallet.privateKey
      );

      const facet = await ethers.getContractAt("TokenExtensionsFacet", this.tokenAddress);

      // Should succeed
      await expect(
        facet.permit(this.owner, this.spender, value, this.deadline, v, r, s)
      ).to.not.be.reverted;

      // Verify allowance was set
      expect(await this.token.allowance(this.owner, this.spender)).to.equal(value);
    });

    it("should reject permit signed with 'PaxosToken USD' domain", async function () {
      const { v, r, s } = signPermit(
        this.owner,
        this.spender,
        value,
        nonce,
        this.deadline,
        this.domainSeparatorPaxosToken,
        this.testWallet.privateKey
      );

      const facet = await ethers.getContractAt("TokenExtensionsFacet", this.tokenAddress);

      // Should fail with InvalidSignature
      await expect(
        facet.permit(this.owner, this.spender, value, this.deadline, v, r, s)
      ).to.be.revertedWithCustomError(facet, "InvalidSignature");
    });
  });

  describe("PayoutGroupFacet DOMAIN_SEPARATOR also uses 'Global Dollar'", function () {
    it("should return same domain separator as main contract", async function () {
      const payoutFacet = await ethers.getContractAt("PayoutGroupFacet", this.tokenAddress);
      const mainDomainSeparator = await this.token.DOMAIN_SEPARATOR();
      const payoutFacetDomainSeparator = await payoutFacet.DOMAIN_SEPARATOR();

      expect(payoutFacetDomainSeparator).to.equal(mainDomainSeparator);

      // Verify it matches "Global Dollar" computation
      const expectedGlobalDollar = computeDomainSeparator("Global Dollar", this.chainId, this.tokenAddress);
      expect(payoutFacetDomainSeparator).to.equal(expectedGlobalDollar);
    });
  });
});
