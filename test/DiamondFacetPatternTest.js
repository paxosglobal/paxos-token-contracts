const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles } = require('./helpers/testHelpers');

describe('Diamond Facet Pattern Tests', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
    await grantAllTestRoles(this.token, this.owner, this.owner.address);

    // Deploy MockFacet for testing
    const mockFacetFactory = await ethers.getContractFactory("MockFacet");
    this.mockFacet = await mockFacetFactory.deploy();
    await this.mockFacet.waitForDeployment();
    this.mockFacetAddress = await this.mockFacet.getAddress();

    // Get function selectors for MockFacet
    this.setTestValueSelector = this.mockFacet.interface.getFunction("setTestValue").selector;
    this.getTestValueSelector = this.mockFacet.interface.getFunction("getTestValue").selector;
    this.calculateSumSelector = this.mockFacet.interface.getFunction("calculateSum").selector;
    this.maybeRevertSelector = this.mockFacet.interface.getFunction("maybeRevert").selector;
    this.requireCheckSelector = this.mockFacet.interface.getFunction("requireCheck").selector;
    this.multipleReturnsSelector = this.mockFacet.interface.getFunction("multipleReturns").selector;
  });

  describe('16.1 Facet Registration', function () {
    describe('16.1.1 setFacet() adds function selector', function () {
      it('should successfully register a single function selector', async function () {
        // Register setTestValue selector
        await expect(
          this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress)
        ).to.emit(this.token, 'FacetUpdate')
          .withArgs(this.setTestValueSelector, this.mockFacetAddress);

        // Verify facet was registered
        const registeredFacet = await this.token.getFacet(this.setTestValueSelector);
        expect(registeredFacet).to.equal(this.mockFacetAddress);
      });

      it('should emit FacetUpdate event when adding facet', async function () {
        await expect(
          this.token.connect(this.owner).setFacet(this.calculateSumSelector, this.mockFacetAddress)
        ).to.emit(this.token, 'FacetUpdate')
          .withArgs(this.calculateSumSelector, this.mockFacetAddress);
      });

      it('should require admin role to set facet', async function () {
        // Try with non-admin account
        await expect(
          this.token.connect(this.acc).setFacet(this.setTestValueSelector, this.mockFacetAddress)
        ).to.be.reverted; // Will revert with AccessControl error
      });
    });

    describe('16.1.2 batchSetFacet() adds multiple selectors', function () {
      it('should successfully register multiple selectors at once', async function () {
        const selectors = [
          this.setTestValueSelector,
          this.getTestValueSelector,
          this.calculateSumSelector
        ];
        const facetCuts = [{ facet: this.mockFacetAddress, selectors }];

        const tx = await this.token.connect(this.owner).batchSetFacet(facetCuts);

        // Should emit event for each selector
        await expect(tx)
          .to.emit(this.token, 'FacetUpdate')
          .withArgs(this.setTestValueSelector, this.mockFacetAddress);

        // Verify all selectors were registered
        for (const selector of selectors) {
          const registeredFacet = await this.token.getFacet(selector);
          expect(registeredFacet).to.equal(this.mockFacetAddress);
        }
      });

      it('should handle empty facetCuts array', async function () {
        // Empty facetCuts should succeed without doing anything
        await expect(
          this.token.connect(this.owner).batchSetFacet([])
        ).to.not.be.reverted;
      });

      it('should emit events for all selectors in batch', async function () {
        const selectors = [this.setTestValueSelector, this.getTestValueSelector];
        const facetCuts = [{ facet: this.mockFacetAddress, selectors }];

        const tx = await this.token.connect(this.owner).batchSetFacet(facetCuts);

        const receipt = await tx.wait();
        const events = receipt.logs.filter(log =>
          log.topics[0] === this.token.interface.getEvent('FacetUpdate').topicHash
        );

        expect(events.length).to.equal(2);
      });

      it('should require admin role for batch set', async function () {
        const selectors = [this.setTestValueSelector, this.getTestValueSelector];
        const facetCuts = [{ facet: this.mockFacetAddress, selectors }];

        await expect(
          this.token.connect(this.acc).batchSetFacet(facetCuts)
        ).to.be.reverted;
      });

      it('should register multiple facet cuts in one call', async function () {
        // Deploy a second mock facet
        const mockFacet2Factory = await ethers.getContractFactory("MockFacet");
        const mockFacet2 = await mockFacet2Factory.deploy();
        await mockFacet2.waitForDeployment();
        const mockFacet2Address = await mockFacet2.getAddress();

        // First cut: mockFacet gets setTestValue + getTestValue; second cut: mockFacet2 gets calculateSum
        const facetCuts = [
          { facet: this.mockFacetAddress, selectors: [this.setTestValueSelector, this.getTestValueSelector] },
          { facet: mockFacet2Address, selectors: [this.calculateSumSelector] }
        ];

        const tx = await this.token.connect(this.owner).batchSetFacet(facetCuts);

        await expect(tx).to.emit(this.token, 'FacetUpdate').withArgs(this.setTestValueSelector, this.mockFacetAddress);
        await expect(tx).to.emit(this.token, 'FacetUpdate').withArgs(this.getTestValueSelector, this.mockFacetAddress);
        await expect(tx).to.emit(this.token, 'FacetUpdate').withArgs(this.calculateSumSelector, mockFacet2Address);

        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);
        expect(await this.token.getFacet(this.getTestValueSelector)).to.equal(this.mockFacetAddress);
        expect(await this.token.getFacet(this.calculateSumSelector)).to.equal(mockFacet2Address);
      });
    });

    describe('16.1.3 getFacet() retrieves correct address', function () {
      it('should return registered facet address', async function () {
        // Register facet
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);

        // Retrieve and verify
        const facetAddress = await this.token.getFacet(this.setTestValueSelector);
        expect(facetAddress).to.equal(this.mockFacetAddress);
      });

      it('should return zero address for unregistered selector', async function () {
        const randomSelector = "0x12345678";
        const facetAddress = await this.token.getFacet(randomSelector);
        expect(facetAddress).to.equal(ethers.ZeroAddress);
      });

      it('should return correct address after batch registration', async function () {
        const selectors = [this.setTestValueSelector, this.calculateSumSelector];
        const facetCuts = [{ facet: this.mockFacetAddress, selectors }];
        await this.token.connect(this.owner).batchSetFacet(facetCuts);

        // Both should return the same facet address
        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);
        expect(await this.token.getFacet(this.calculateSumSelector)).to.equal(this.mockFacetAddress);
      });
    });

    describe('16.1.4 Update existing facet', function () {
      it('should allow updating an existing facet mapping', async function () {
        // Register with first facet
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);

        // Verify initial registration
        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);

        // Deploy a second mock facet
        const mockFacet2Factory = await ethers.getContractFactory("MockFacet");
        const mockFacet2 = await mockFacet2Factory.deploy();
        await mockFacet2.waitForDeployment();
        const mockFacet2Address = await mockFacet2.getAddress();

        // Update to second facet
        await expect(
          this.token.connect(this.owner).setFacet(this.setTestValueSelector, mockFacet2Address)
        ).to.emit(this.token, 'FacetUpdate')
          .withArgs(this.setTestValueSelector, mockFacet2Address);

        // Verify update
        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(mockFacet2Address);
      });

      it('should allow updating facet to same address', async function () {
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);

        // Update to same address (idempotent)
        await expect(
          this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress)
        ).to.emit(this.token, 'FacetUpdate')
          .withArgs(this.setTestValueSelector, this.mockFacetAddress);
      });
    });

    describe('16.1.5 Remove facet (set to zero address)', function () {
      it('should remove facet by setting to zero address', async function () {
        // First register the facet
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);
        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);

        // Remove by setting to zero address
        await expect(
          this.token.connect(this.owner).setFacet(this.setTestValueSelector, ethers.ZeroAddress)
        ).to.emit(this.token, 'FacetUpdate')
          .withArgs(this.setTestValueSelector, ethers.ZeroAddress);

        // Verify removal
        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(ethers.ZeroAddress);
      });

      it('should fail delegation after facet removal', async function () {
        // Register and then remove facet
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, ethers.ZeroAddress);

        // Try to call the function - should fail
        const mockInterface = new ethers.Interface(["function setTestValue(uint256 value)"]);
        const calldata = mockInterface.encodeFunctionData("setTestValue", [42]);

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: calldata
          })
        ).to.be.revertedWithCustomError(this.token, "FacetNotFound");
      });

      it('should allow re-registering after removal', async function () {
        // Register, remove, re-register
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, ethers.ZeroAddress);
        await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);

        expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);
      });
    });
  });

  describe('16.2 Facet Delegation', function () {
    beforeEach(async function () {
      // Register all MockFacet functions for delegation tests
      const selectors = [
        this.setTestValueSelector,
        this.getTestValueSelector,
        this.calculateSumSelector,
        this.maybeRevertSelector,
        this.requireCheckSelector,
        this.multipleReturnsSelector
      ];
      const facetCuts = [{ facet: this.mockFacetAddress, selectors }];
      await this.token.connect(this.owner).batchSetFacet(facetCuts);
    });

    describe('16.2.1 Fallback delegates to correct facet', function () {
      it('should route call to registered facet', async function () {
        // Create interface for calling the function
        const mockInterface = new ethers.Interface(["function calculateSum(uint256 a, uint256 b) view returns (uint256)"]);

        // Call via main contract (will hit fallback)
        const calldata = mockInterface.encodeFunctionData("calculateSum", [10, 20]);
        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: calldata
        });

        // Decode result
        const decoded = mockInterface.decodeFunctionResult("calculateSum", result);
        expect(decoded[0]).to.equal(30);
      });

      it('should work with view functions', async function () {
        // First set a value
        const setInterface = new ethers.Interface(["function setTestValue(uint256 value)"]);
        const setCalldata = setInterface.encodeFunctionData("setTestValue", [12345]);
        await this.owner.sendTransaction({
          to: await this.token.getAddress(),
          data: setCalldata
        });

        // Then read it back via view function
        const getInterface = new ethers.Interface(["function getTestValue() view returns (uint256)"]);
        const getCalldata = getInterface.encodeFunctionData("getTestValue");
        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: getCalldata
        });

        const decoded = getInterface.decodeFunctionResult("getTestValue", result);
        expect(decoded[0]).to.equal(12345);
      });
    });

    describe('16.2.2 Delegatecall preserves storage context', function () {
      it('should modify main contract storage, not facet storage', async function () {
        const testValue = 99999;

        // Call setTestValue via fallback (delegatecall)
        const setInterface = new ethers.Interface(["function setTestValue(uint256 value)"]);
        const calldata = setInterface.encodeFunctionData("setTestValue", [testValue]);

        await this.owner.sendTransaction({
          to: await this.token.getAddress(),
          data: calldata
        });

        // Verify the value was set in main contract's storage (totalSupply_)
        // We can read it via getTestValue
        const getInterface = new ethers.Interface(["function getTestValue() view returns (uint256)"]);
        const getCalldata = getInterface.encodeFunctionData("getTestValue");
        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: getCalldata
        });

        const decoded = getInterface.decodeFunctionResult("getTestValue", result);
        expect(decoded[0]).to.equal(testValue);

        // Also verify via totalSupply() since we're modifying totalSupply_
        expect(await this.token.totalSupply()).to.equal(testValue);
      });

      it('should access main contract state variables', async function () {
        // Set initial supply
        const initialSupply = 123456;
        const setInterface = new ethers.Interface(["function setTestValue(uint256 value)"]);
        await this.owner.sendTransaction({
          to: await this.token.getAddress(),
          data: setInterface.encodeFunctionData("setTestValue", [initialSupply])
        });

        // Change it again to verify we're working with same storage
        const newSupply = 654321;
        await this.owner.sendTransaction({
          to: await this.token.getAddress(),
          data: setInterface.encodeFunctionData("setTestValue", [newSupply])
        });

        // Verify final value
        expect(await this.token.totalSupply()).to.equal(newSupply);
      });
    });

    describe('16.2.3 Return data forwarded correctly', function () {
      it('should forward simple return values', async function () {
        const calcInterface = new ethers.Interface(["function calculateSum(uint256 a, uint256 b) view returns (uint256)"]);
        const calldata = calcInterface.encodeFunctionData("calculateSum", [100, 250]);

        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: calldata
        });

        const decoded = calcInterface.decodeFunctionResult("calculateSum", result);
        expect(decoded[0]).to.equal(350);
      });

      it('should forward multiple return values', async function () {
        const multiInterface = new ethers.Interface([
          "function multipleReturns(uint256 value) view returns (uint256 doubled, uint256 tripled, string message)"
        ]);

        const calldata = multiInterface.encodeFunctionData("multipleReturns", [10]);
        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: calldata
        });

        const decoded = multiInterface.decodeFunctionResult("multipleReturns", result);
        expect(decoded.doubled).to.equal(20);
        expect(decoded.tripled).to.equal(30);
        expect(decoded.message).to.equal("Success");
      });

      it('should forward complex data structures', async function () {
        // Test with string return (complex type)
        const multiInterface = new ethers.Interface([
          "function multipleReturns(uint256 value) view returns (uint256, uint256, string)"
        ]);

        const result = await this.owner.call({
          to: await this.token.getAddress(),
          data: multiInterface.encodeFunctionData("multipleReturns", [5])
        });

        const decoded = multiInterface.decodeFunctionResult("multipleReturns", result);
        expect(decoded[2]).to.equal("Success"); // String at index 2
      });
    });

    describe('16.2.4 Revert data forwarded correctly', function () {
      it('should forward custom error reverts', async function () {
        const revertInterface = new ethers.Interface(["function maybeRevert(bool shouldRevert)"]);
        const calldata = revertInterface.encodeFunctionData("maybeRevert", [true]);

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: calldata
          })
        ).to.be.revertedWithCustomError(this.mockFacet, "MockFacetError")
          .withArgs("Test revert message");
      });

      it('should forward require error messages', async function () {
        const requireInterface = new ethers.Interface(["function requireCheck(bool condition)"]);
        const calldata = requireInterface.encodeFunctionData("requireCheck", [false]);

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: calldata
          })
        ).to.be.revertedWith("Require failed in facet");
      });

      it('should not revert when condition is met', async function () {
        const revertInterface = new ethers.Interface(["function maybeRevert(bool shouldRevert)"]);
        const calldata = revertInterface.encodeFunctionData("maybeRevert", [false]);

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: calldata
          })
        ).to.not.be.reverted;
      });
    });

    describe('16.2.5 Non-existent function selector fails correctly', function () {
      it('should revert with "Function not found" for unregistered selector', async function () {
        // Create a function selector that's not registered
        const fakeInterface = new ethers.Interface(["function nonExistentFunction()"]);
        const calldata = fakeInterface.encodeFunctionData("nonExistentFunction");

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: calldata
          })
        ).to.be.revertedWithCustomError(this.token, "FacetNotFound");
      });

      it('should revert for random calldata', async function () {
        // Random calldata that doesn't match any selector
        const randomCalldata = "0x12345678";

        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: randomCalldata
          })
        ).to.be.revertedWithCustomError(this.token, "FacetNotFound");
      });

      it('should work correctly after registering previously unknown selector', async function () {
        // Try to call an unregistered function
        const newInterface = new ethers.Interface(["function setTestValue(uint256 value)"]);
        const newSelector = newInterface.getFunction("setTestValue").selector;

        // Unregister it first to ensure it's not registered
        await this.token.connect(this.owner).setFacet(newSelector, ethers.ZeroAddress);

        // Should fail
        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: newInterface.encodeFunctionData("setTestValue", [42])
          })
        ).to.be.revertedWithCustomError(this.token, "FacetNotFound");

        // Now register it
        await this.token.connect(this.owner).setFacet(newSelector, this.mockFacetAddress);

        // Should succeed
        await expect(
          this.owner.sendTransaction({
            to: await this.token.getAddress(),
            data: newInterface.encodeFunctionData("setTestValue", [42])
          })
        ).to.not.be.reverted;
      });
    });
  });

  describe('16.3 Edge Cases and Additional Tests', function () {
    it('should handle duplicate selectors in batch registration', async function () {
      const duplicateSelectors = [
        this.setTestValueSelector,
        this.setTestValueSelector,
        this.getTestValueSelector
      ];
      const facetCuts = [{ facet: this.mockFacetAddress, selectors: duplicateSelectors }];

      // Should succeed - last registration wins
      await expect(
        this.token.connect(this.owner).batchSetFacet(facetCuts)
      ).to.not.be.reverted;

      // All should be registered
      expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(this.mockFacetAddress);
      expect(await this.token.getFacet(this.getTestValueSelector)).to.equal(this.mockFacetAddress);
    });

    it('should maintain facet mappings across multiple operations', async function () {
      // Register multiple facets
      await this.token.connect(this.owner).setFacet(this.setTestValueSelector, this.mockFacetAddress);
      await this.token.connect(this.owner).setFacet(this.calculateSumSelector, this.mockFacetAddress);

      // Update one
      const newFacetFactory = await ethers.getContractFactory("MockFacet");
      const newFacet = await newFacetFactory.deploy();
      const newFacetAddress = await newFacet.getAddress();

      await this.token.connect(this.owner).setFacet(this.setTestValueSelector, newFacetAddress);

      // Verify both mappings are correct
      expect(await this.token.getFacet(this.setTestValueSelector)).to.equal(newFacetAddress);
      expect(await this.token.getFacet(this.calculateSumSelector)).to.equal(this.mockFacetAddress);
    });

    it('should prevent ETH transfers via receive function', async function () {
      await expect(
        this.owner.sendTransaction({
          to: await this.token.getAddress(),
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWith("Not expecting ether");
    });
  });
});
