const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PaxosTokenV2 EIP712", function () {
    const name = "PaxosToken USD";
    const version = "1";

    describe("Domain Separator Initialization", function () {
        it("should initialize DOMAIN_SEPARATOR when calling initializeDomainSeparator()", async function () {
            // Deploy without initializing
            PaxosTokenV2 = await ethers.getContractFactory("PaxosTokenV2");
            token = await PaxosTokenV2.deploy();
            await token.waitForDeployment();
            const tokenAddress = await token.getAddress();

            // Call initializeDomainSeparator
            await token.initializeDomainSeparator();

            // Get the domain separator
            const domainSeparator = await token.DOMAIN_SEPARATOR();

            // Calculate expected domain separator
            const domain = {
                name: name,
                version: version,
                chainId: await ethers.provider.getNetwork().then(n => n.chainId),
                verifyingContract: tokenAddress
            };

            // Create the domain separator hash using ethers.js v6
            const domainSeparatorHash = ethers.TypedDataEncoder.hashDomain(domain);
            
            // Verify the domain separator matches
            expect(domainSeparator).to.equal(domainSeparatorHash);
        });
    });
});