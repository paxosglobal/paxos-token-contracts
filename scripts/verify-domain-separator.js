const { ethers } = require("hardhat");

// Set to true to test against mainnet, false to test locally deployed USDG
const TEST_MAINNET = process.env.TEST_MAINNET === "true";

async function main() {
  let usdg, facet, CHAIN_ID, USDG_ADDRESS;

  if (TEST_MAINNET) {
    USDG_ADDRESS = "0xe343167631d89B6Ffc58B88d6b7fB0228795491D";
    CHAIN_ID = 1;
    usdg = await ethers.getContractAt("USDG", USDG_ADDRESS);
    facet = await ethers.getContractAt("TokenExtensionsFacet", USDG_ADDRESS);
  } else {
    // Deploy fresh USDG locally with facets
    console.log("Deploying fresh USDG locally...");
    const { deployStableCoinFixtureUSDG } = require("../test/helpers/fixtures");
    const result = await deployStableCoinFixtureUSDG();
    USDG_ADDRESS = await result.token.getAddress();
    CHAIN_ID = 31337; // Hardhat local chainId
    usdg = result.token;
    facet = await ethers.getContractAt("TokenExtensionsFacet", USDG_ADDRESS);
    console.log("USDG deployed at:", USDG_ADDRESS);
  }

  // EIP712 Domain Typehash
  const EIP712_DOMAIN_TYPEHASH = "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
  const PERMIT_TYPEHASH = "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9";

  const actualName = await usdg.name();
  console.log("\n=== Token Name Check ===");
  console.log("name() returns:", actualName);

  // Compute both domain separators
  const domainSeparatorGlobalDollar = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        EIP712_DOMAIN_TYPEHASH,
        ethers.keccak256(ethers.toUtf8Bytes("Global Dollar")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        CHAIN_ID,
        USDG_ADDRESS
      ]
    )
  );

  const domainSeparatorPaxosToken = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        EIP712_DOMAIN_TYPEHASH,
        ethers.keccak256(ethers.toUtf8Bytes("PaxosToken USD")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        CHAIN_ID,
        USDG_ADDRESS
      ]
    )
  );

  const actualDomainSeparator = await usdg.DOMAIN_SEPARATOR();

  console.log("\n=== DOMAIN_SEPARATOR Comparison ===");
  console.log("On-chain DOMAIN_SEPARATOR:", actualDomainSeparator);
  console.log("Computed (Global Dollar): ", domainSeparatorGlobalDollar);
  console.log("Computed (PaxosToken USD):", domainSeparatorPaxosToken);
  console.log("");
  console.log("Matches 'Global Dollar':", actualDomainSeparator === domainSeparatorGlobalDollar);
  console.log("Matches 'PaxosToken USD':", actualDomainSeparator === domainSeparatorPaxosToken);

  // Now let's test which domain separator permit() actually validates against
  console.log("\n=== Simulating Permit Validation ===");

  // Create a test wallet
  const testWallet = ethers.Wallet.createRandom();
  const owner = testWallet.address;
  const spender = "0x0000000000000000000000000000000000000001";
  const value = 1000000n;
  const nonce = 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

  // Helper to sign permit
  function signPermitWithDomain(domainSeparator, privateKey) {
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

  // Sign with both domain separators
  const sigGlobalDollar = signPermitWithDomain(domainSeparatorGlobalDollar, testWallet.privateKey);
  const sigPaxosToken = signPermitWithDomain(domainSeparatorPaxosToken, testWallet.privateKey);

  // Try permit with Global Dollar signature
  console.log("\nTrying permit() with 'Global Dollar' signature...");
  try {
    await facet.permit.staticCall(
      owner, spender, value, deadline,
      sigGlobalDollar.v, sigGlobalDollar.r, sigGlobalDollar.s
    );
    console.log("✓ SUCCESS: 'Global Dollar' signature is VALID");
  } catch (e) {
    const reason = e.reason || e.message;
    console.log("✗ FAILED:", reason.includes("InvalidSignature") ? "InvalidSignature" : reason);
  }

  // Try permit with PaxosToken USD signature
  console.log("\nTrying permit() with 'PaxosToken USD' signature...");
  try {
    await facet.permit.staticCall(
      owner, spender, value, deadline,
      sigPaxosToken.v, sigPaxosToken.r, sigPaxosToken.s
    );
    console.log("✓ SUCCESS: 'PaxosToken USD' signature is VALID");
  } catch (e) {
    const reason = e.reason || e.message;
    console.log("✗ FAILED:", reason.includes("InvalidSignature") ? "InvalidSignature" : reason);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
