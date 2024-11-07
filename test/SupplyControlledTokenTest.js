const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { assert, expect } = require('chai');
const hre = require("hardhat");
const { roles, limits } = require('./helpers/constants');
const { ZeroAddress, MaxUint256 } = require("hardhat").ethers;
const SMALL_AMOUNT = 100;
const SMALL_LIMIT = 2000;

// Tests that PaxosToken token supply control mechanisms operate correctly.
describe('PaxosToken', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
  });

  describe('as a supply-controlled token', function () {
    describe('Create supply control contract', function () {
      it('Can call initialize with two supply controllers', async function () {
        const scInitializationConfig = 
          [
            [this.owner.address, [MaxUint256, 0], [this.owner.address], false], 
            [this.acc2.address, [limits.LIMIT_CAPACITY, limits.REFILL_PER_SECOND], [this.acc2.address], false]
          ]
        const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
        const supplyControl = await upgrades.deployProxy(supplyControlFactory, [this.owner.address, this.owner.address, this.owner.address, scInitializationConfig], {
          initializer: "initialize",
        })

        await supplyControl.waitForDeployment();

        const scConfigOwner = (await supplyControl.getSupplyControllerConfig(this.owner.address))
        const scConfigAcc2 = (await supplyControl.getSupplyControllerConfig(this.acc2.address))

        const limitConfigOwner = scConfigOwner.limitConfig
        const limitConfigAcc2 = scConfigAcc2.limitConfig

        assert.equal(limitConfigOwner.limitCapacity, MaxUint256)
        assert.equal(limitConfigOwner.refillPerSecond, 0)
        assert.isFalse(scConfigOwner.allowAnyMintAndBurnAddress)
        assert.equal(scConfigOwner.mintAddressWhitelist.length, 1)
        assert.equal(scConfigOwner.mintAddressWhitelist[0], this.owner.address)

        assert.equal(limitConfigAcc2.limitCapacity, limits.LIMIT_CAPACITY)
        assert.equal(limitConfigAcc2.refillPerSecond, limits.REFILL_PER_SECOND)
        assert.isFalse(scConfigAcc2.allowAnyMintAndBurnAddress)
        assert.equal(scConfigAcc2.mintAddressWhitelist.length, 1)
        assert.equal(scConfigAcc2.mintAddressWhitelist[0], this.acc2.address)

        const remainingLimit = await supplyControl.getRemainingMintAmount(this.owner.address, 100);
        assert.equal(remainingLimit, MaxUint256);

        const remainingLimit2 = await supplyControl.getRemainingMintAmount(this.acc2.address, 100);
        assert.equal(remainingLimit2, limits.LIMIT_CAPACITY);
      })

      it('Cannot create supplyControl contract with 0 address', async function () {
        const scInitializationConfig = [[this.owner.address, [MaxUint256, limits.REFILL_PER_SECOND], [this.owner.address], false]]
        const supplyControlFactory = await ethers.getContractFactory("SupplyControl");
        await expect(upgrades.deployProxy(supplyControlFactory, [this.owner.address, ZeroAddress, this.owner.address, scInitializationConfig], {
          initializer: "initialize",
        })).to.be.revertedWithCustomError(this.supplyControl, "ZeroAddress")
        await expect(upgrades.deployProxy(supplyControlFactory, [this.owner.address, this.owner.address, ZeroAddress, scInitializationConfig], {
          initializer: "initialize",
        })).to.be.revertedWithCustomError(this.supplyControl, "ZeroAddress")
      })

      it('Cannot call initialize after already initialized', async function () {
        const scInitializationConfig = [[this.owner.address, [MaxUint256, limits.REFILL_PER_SECOND], [this.owner.address], false]]
        await expect(this.supplyControl.initialize(this.owner.address, this.owner.address, this.owner.address, scInitializationConfig)).to.be.revertedWith("Initializable: contract is already initialized")
      })
    })

    describe('after token creation', function () {
      it('sender should be token owner', async function () {
        const tokenOwner = await this.token.owner();
        assert.equal(tokenOwner, this.owner.address);
      });

      it('total supply should be zero', async function () {
        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, 0);
      });

      it('balances should be zero', async function () {
        const ownerBalance = await this.token.balanceOf(this.owner.address);
        assert.equal(ownerBalance, 0);
        const otherBalance = await this.token.balanceOf(this.acc.address);
        assert.equal(otherBalance, 0);
      });
    });

    describe('increaseSupply', function () {
      let amount;
      beforeEach(async function () {
        amount = 100;
      });

      it('reverts when sender is not supply controller', async function () {
        await expect(this.token.connect(this.acc).increaseSupply(amount)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
      });

      it('adds the requested amount', async function () {
        await this.token.increaseSupply(amount);

        const balance = await this.token.balanceOf(this.owner.address);
        assert.equal(balance, amount, 'supply controller balance matches');

        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, amount, 'total supply matches')
      });
    });

    describe('increaseSupplyToAddress', function () {
      let amount;
      beforeEach(async function () {
        amount = 100;
      });

      it('reverts when sender is not supply controller', async function () {
        await expect(this.token.connect(this.acc).increaseSupplyToAddress(amount, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
      });


      it('reverts if mintAddress is frozen', async function () {
        await this.token.connect(this.assetProtectionRole).freeze(this.acc.address)
        await this.supplyControl.addMintAddressToWhitelist(this.owner.address, this.acc.address)
        await expect(this.token.increaseSupplyToAddress(amount, this.acc.address)).to.be.revertedWith("mintToAddress frozen");
      });

      it('adds the requested amount', async function () {
        await this.token.increaseSupplyToAddress(amount, this.owner.address);

        const balance = await this.token.balanceOf(this.owner.address);
        assert.equal(balance, amount, 'supply controller balance matches');

        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, amount, 'total supply matches')
      });

      it('adds the requested amount using mint wrapper', async function () {
        await this.token.mint(this.owner.address, amount);

        const balance = await this.token.balanceOf(this.owner.address);
        assert.equal(balance, amount, 'supply controller balance matches');

        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, amount, 'total supply matches')
      });

      it('adds the requested amount when supply controller can mint to any address', async function () {
        await this.supplyControl.addSupplyController(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [], true)
        await this.token.connect(this.acc).increaseSupplyToAddress(amount, this.acc2.address)

        const balance = await this.token.balanceOf(this.acc2.address);
        assert.equal(balance, amount, 'supply controller balance matches');

        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, amount, 'total supply matches')
      });

      it('emits a SupplyIncreased and a Transfer event', async function () {
        await expect(this.token.increaseSupplyToAddress(amount, this.owner.address))
        .to.emit(this.token, "SupplyIncreased")
        .withArgs(this.owner.address, amount)
        .and.to.emit(this.token, "Transfer")
        .withArgs(ZeroAddress, this.owner.address, amount)
      });

      it('cannot increaseSupplyToAddress resulting in positive overflow of the totalSupply', async function () {
        // issue a big amount - more than half of what is possible
        await this.supplyControl.updateLimitConfig(this.owner.address, MaxUint256, MaxUint256)
        let bigAmount = MaxUint256;
        await this.token.increaseSupplyToAddress(bigAmount, this.owner.address);
        let balance = await this.token.balanceOf(this.owner.address);
        assert.equal(bigAmount.toString(), balance.toString());
        // send it to another address
        await this.token.transfer(this.acc.address, bigAmount);
        balance = await this.token.balanceOf(this.owner.address);
        assert.equal(0, BigInt(balance));
        // try to issue more than is possible for a uint256 totalSupply
        await expect(this.token.increaseSupplyToAddress(bigAmount, this.owner.address)).to.be.revertedWithPanic(0x11)
        balance = await this.token.balanceOf(this.owner.address);
        assert.equal(0, BigInt(balance));
      });
    });

    describe('decreaseSupply', function () {
      const initialAmount = 500;
      const decreaseAmount = 100;
      const finalAmount = initialAmount - decreaseAmount;

      describe('when the supply controller has insufficient tokens', function () {
        it('reverts', async function () {
          await expect(this.token.decreaseSupply(decreaseAmount)).to.be.revertedWithCustomError(this.token, "InsufficientFunds");
        });
      });

      describe('when the supply controller has sufficient tokens', function () {
        // Issue some tokens to start.
        beforeEach(async function () {
          await this.token.increaseSupplyToAddress(initialAmount, this.owner.address)
        });

        it('reverts when sender is not supply controller', async function () {
          await expect(this.token.connect(this.acc).decreaseSupply(decreaseAmount)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
        });

        it('removes the requested amount', async function () {
          await this.token.decreaseSupply(decreaseAmount);

          const balance = await this.token.balanceOf(this.owner.address);
          assert.equal(balance, finalAmount, 'supply controller balance matches');

          const totalSupply = await this.token.totalSupply();
          assert.equal(totalSupply, finalAmount, 'total supply matches')
        });

        it('removes the requested amount using burn wrapper', async function () {
          await this.token.burn(decreaseAmount);

          const balance = await this.token.balanceOf(this.owner.address);
          assert.equal(balance, finalAmount, 'supply controller balance matches');

          const totalSupply = await this.token.totalSupply();
          assert.equal(totalSupply, finalAmount, 'total supply matches')
        });
      });
    });

    describe('decreaseSupplyFromAddress', function () {
      const initialAmount = 500;
      const decreaseAmount = 100;
      const finalAmount = initialAmount - decreaseAmount;

      describe('when the supply controller has insufficient tokens', function () {
        it('reverts', async function () {
          await expect(this.token.decreaseSupplyFromAddress(decreaseAmount, this.owner.address)).to.be.revertedWithCustomError(this.token, "InsufficientFunds");
        });
      });

      describe('when the supply controller has sufficient tokens', function () {
        // Issue some tokens to start.
        beforeEach(async function () {
          await this.token.increaseSupplyToAddress(initialAmount, this.owner.address)
        });

        it('reverts when sender is not supply controller', async function () {
          await expect(this.token.connect(this.acc).decreaseSupplyFromAddress(decreaseAmount, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
        });

        it('reverts when burn from address is not in the whitelist', async function () {
          await expect(this.token.decreaseSupplyFromAddress(decreaseAmount, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "CannotBurnFromAddress");
        });

        it('removes the requested amount', async function () {
          await this.token.decreaseSupplyFromAddress(decreaseAmount, this.owner.address);

          const balance = await this.token.balanceOf(this.owner.address);
          assert.equal(balance, finalAmount, 'supply controller balance matches');

          const totalSupply = await this.token.totalSupply();
          assert.equal(totalSupply, finalAmount, 'total supply matches')
        });

        it('removes the requested amount when supply controller can burn from any address', async function () {
          await this.supplyControl.addSupplyController(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [], true)
          await this.token.connect(this.acc).increaseSupplyToAddress(initialAmount, this.acc2.address)
          await this.token.connect(this.acc).decreaseSupplyFromAddress(decreaseAmount, this.acc2.address);

          const balance = await this.token.balanceOf(this.acc2.address);
          assert.equal(balance, finalAmount, 'supply controller balance matches');
        });

        it('reverts if burnAddress is frozen', async function () {
          await this.token.connect(this.assetProtectionRole).freeze(this.acc.address)
          await expect(this.token.decreaseSupplyFromAddress(decreaseAmount, this.acc.address)).to.be.revertedWith("burnFromAddress frozen");
        });

        it('emits a SupplyDecreased and a Transfer event', async function () {
          await expect(this.token.decreaseSupplyFromAddress(decreaseAmount, this.owner.address))
          .to.emit(this.token, "SupplyDecreased")
          .withArgs(this.owner.address, decreaseAmount)
          .and.to.emit(this.token, "Transfer")
          .withArgs(this.owner.address, ZeroAddress, decreaseAmount)
        });
      });
    });

    describe('Add supply controller', function () {
      const amount = 100;

      it('cannot add zero address supply controller', async function () {
        await expect(this.supplyControl.addSupplyController(ZeroAddress, MaxUint256, limits.REFILL_PER_SECOND, [this.owner.address], false)).to.be.revertedWithCustomError(this.supplyControl, "ZeroAddress");
      });

      it('cannot add supply controller if already assigned', async function () {
        await expect(this.supplyControl.addSupplyController(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [this.acc.address], false))
        await expect(this.supplyControl.addSupplyController(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [this.owner.address], false)).to.be.revertedWithCustomError(this.supplyControl, "AccountAlreadyHasSupplyControllerRole");
      });

      it('can increase supply after adding additional supply controller', async function () {
        await expect(this.supplyControl.addSupplyController(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [this.acc.address], false))
        .to.emit(this.supplyControl, "SupplyControllerAdded")
        .withArgs(this.acc.address, MaxUint256, limits.REFILL_PER_SECOND, [this.acc.address], false)
        await this.token.connect(this.acc).increaseSupplyToAddress(amount, this.acc.address);

        const balance = await this.token.balanceOf(this.acc.address);
        assert.equal(balance, amount, 'supply controller balance matches');

        const totalSupply = await this.token.totalSupply();
        assert.equal(totalSupply, amount, 'total supply matches')

        const supplyControllerAddresses = await this.supplyControl.getAllSupplyControllerAddresses()
        assert.equal(2, supplyControllerAddresses.length)
        assert.isTrue(supplyControllerAddresses.includes(this.owner.address))
        assert.isTrue(supplyControllerAddresses.includes(this.acc.address))
      });
    });

    describe('Remove supply controller', function () {
      const amount = 100;

      it('cannot remove non existant supply controller', async function () {
        await expect(this.supplyControl.removeSupplyController(this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
      });

      it('cannot remove supply controller twice', async function () {
        await this.supplyControl.removeSupplyController(this.owner.address)
        await expect(this.supplyControl.removeSupplyController(this.owner.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
      });

      it('reverts when increasingSupply after supply controller is removed', async function () {
        let initialMintAddresses = (await this.supplyControl.getSupplyControllerConfig(this.owner.address)).mintAddressWhitelist;

        assert.equal(initialMintAddresses.length, 1)

        await expect(this.supplyControl.removeSupplyController(this.owner.address))
        .to.emit(this.supplyControl, "SupplyControllerRemoved")
        .withArgs(this.owner.address)
        await expect(this.token.increaseSupplyToAddress(amount, this.owner.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole");
        let supplyControllerAddresses = await this.supplyControl.getAllSupplyControllerAddresses()

        assert.equal(supplyControllerAddresses.length, 0)
      });
    });

    describe('updateLimitConfig', function () {
      it('Can updateLimitConfig successfully', async function () {
        let newLimitCapacity = 100
        let newLimitTimePeriod = 1000
        await this.token.increaseSupplyToAddress(newLimitCapacity + 1, this.owner.address)
        let oldLimitConfig = (await this.supplyControl.getSupplyControllerConfig(this.owner.address)).limitConfig
        await expect(this.supplyControl.updateLimitConfig(this.owner.address,  newLimitCapacity, newLimitTimePeriod))
        .to.emit(this.supplyControl, "LimitConfigUpdated")
        .withArgs(
          this.owner.address,
          [newLimitCapacity, newLimitTimePeriod],
          oldLimitConfig
        )
        let limitConfig = (await this.supplyControl.getSupplyControllerConfig(this.owner.address)).limitConfig

        await expect(this.token.increaseSupplyToAddress(newLimitCapacity + 1, this.owner.address)).to.be.reverted
        assert.equal(limitConfig.limitCapacity, newLimitCapacity)
        assert.equal(limitConfig.refillPerSecond, newLimitTimePeriod)
      });

      it('reverts when calling updateLimitConfig with incorrect SupplyController', async function () {
        await expect(this.supplyControl.updateLimitConfig(this.acc.address, SMALL_LIMIT, limits.REFILL_PER_SECOND)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole")
      });
    });

    describe('updateAllowAnyMintAndBurnAddress', function () {
      it('Can updateAllowAnyMintAndBurnAddress successfully', async function () {
        await expect(this.supplyControl.updateAllowAnyMintAndBurnAddress(this.owner.address, [true]))
        .to.emit(this.supplyControl, "AllowAnyMintAndBurnAddressUpdated")
        .withArgs(
          this.owner.address,
          true,
          false
        )

        const supplyController = await this.supplyControl.getSupplyControllerConfig(this.owner.address);
        assert.isTrue(supplyController.allowAnyMintAndBurnAddress);
      });

      it('reverts when calling updateAllowAnyMintAndBurnAddress with incorrect SupplyController', async function () {
        await expect(this.supplyControl.updateAllowAnyMintAndBurnAddress(this.acc.address, true)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole")
      });
    });

    describe('update mintAndBurn addresses', function () {
      it('Can addMintAddressToWhitelist successfully', async function () {
        await expect(this.token.increaseSupplyToAddress(SMALL_AMOUNT, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "CannotMintToAddress")
        await expect(this.supplyControl.addMintAddressToWhitelist(this.owner.address, this.acc.address))
        .to.emit(this.supplyControl, "MintAddressAddedToWhitelist")
        .withArgs(this.owner.address, this.acc.address)
        
        await this.token.increaseSupplyToAddress(SMALL_AMOUNT, this.acc.address)
        await this.token.increaseSupplyToAddress(SMALL_AMOUNT, this.owner.address) //Owner still in mintAndBurn whitelist as well
        let balance = await this.token.balanceOf(this.acc.address)
        let balanceOwner = await this.token.balanceOf(this.owner.address)

        assert.equal(balance, SMALL_AMOUNT)
        assert.equal(balanceOwner, SMALL_AMOUNT)

        let mintAndBurnAddresses = (await this.supplyControl.getSupplyControllerConfig(this.owner.address)).mintAddressWhitelist;
        assert.equal(mintAndBurnAddresses.length, 2)
        assert.isTrue(mintAndBurnAddresses.includes(this.acc.address))
      });

      it('reverts when calling addMintAddressToWhitelist with incorrect SupplyController', async function () {
        await expect(this.supplyControl.addMintAddressToWhitelist(this.acc.address, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole")
      });

      it('reverts when calling addMintAddressToWhitelist with duplicate address', async function () {
        await this.supplyControl.addMintAddressToWhitelist(this.owner.address, this.acc.address)
        await expect(this.supplyControl.addMintAddressToWhitelist(this.owner.address, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "CannotAddDuplicateAddress")
      });

      it('Can removeMintAddressFromWhitelist successfully', async function () {
        this.token.increaseSupplyToAddress(SMALL_AMOUNT, this.owner.address)
        await expect(this.supplyControl.removeMintAddressFromWhitelist(this.owner.address, this.owner.address))
        .to.emit(this.supplyControl, "MintAddressRemovedFromWhitelist")
        .withArgs(this.owner.address, this.owner.address)
        await expect(this.token.increaseSupplyToAddress(SMALL_AMOUNT, this.owner.address)).to.be.revertedWithCustomError(this.supplyControl, "CannotMintToAddress")
      });

      it('reverts when calling removeMintAddressFromWhitelist with incorrect SupplyController', async function () {
        await expect(this.supplyControl.removeMintAddressFromWhitelist(this.acc.address, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "AccountMissingSupplyControllerRole")
      });

      it('reverts when calling removeMintAddressFromWhitelist with non existant address', async function () {
        await expect(this.supplyControl.removeMintAddressFromWhitelist(this.owner.address, this.acc.address)).to.be.revertedWithCustomError(this.supplyControl, "CannotRemoveNonExistantAddress")
      });
    });

    describe("default admin role", function () {
      it("can upgrade with admin role", async function () {
        const newContract = await ethers.deployContract("SupplyControl");
  
        await expect(this.supplyControl.upgradeTo(newContract)).to.not.be.reverted;
      });
  
      it("cannot upgrade without admin role", async function () {
        const newContract = await ethers.deployContract("SupplyControl");
        await expect(this.supplyControl.connect(this.acc2).upgradeTo(newContract)
        ).to.be.revertedWith(
          `AccessControl: account ${this.acc2.address.toLowerCase()} is missing role ${
            roles.DEFAULT_ADMIN_ROLE
          }`
        );
      });
    });

    describe('Only token contract role for canMintAndBurnAddress', function () {
      it('reverts when calling canMintToAddress when not TOKEN_CONTRACT_ROLE', async function () {
        await expect(this.supplyControl.connect(this.owner).canMintToAddress(this.owner.address, 0, this.owner.address)).to.be.revertedWith(
          `AccessControl: account ${this.owner.address.toLowerCase()} is missing role ${
            roles.TOKEN_CONTRACT_ROLE
          }`
        )
      });
    })

    describe('Only SupplyController role', function () {
      it('reverts when calling getRemainingMintAmount when not SUPPLY_CONTROLLER_ROLE', async function () {
        await expect(this.supplyControl.connect(this.owner).getRemainingMintAmount(this.acc2.address, 100)).to.be.revertedWithCustomError(this.supplyControl, 'AccountMissingSupplyControllerRole')
      });

      it('reverts when calling getSupplyControllerConfig when not SUPPLY_CONTROLLER_ROLE', async function () {
        await expect(this.supplyControl.connect(this.owner).getSupplyControllerConfig(this.acc2.address)).to.be.revertedWithCustomError(this.supplyControl, 'AccountMissingSupplyControllerRole')
      });
    })

    describe('Only SupplyControllerManager for SupplyControl functions', function () {
      it('reverts when calling addSupplyController when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).addSupplyController(this.acc2.address, MaxUint256, limits.REFILL_PER_SECOND, [this.owner.address], false)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });

      it('reverts when calling removeSupplyController when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).removeSupplyController(this.owner.address)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });

      it('reverts when calling updatelimitCapacity when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).updateLimitConfig(this.owner.address, SMALL_LIMIT, limits.REFILL_PER_SECOND)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });

      it('reverts when calling updateAllowAnyMintAndBurnAddress when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).updateAllowAnyMintAndBurnAddress(this.owner.address, true)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });

      it('reverts when calling addMintAddressToWhitelist when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).addMintAddressToWhitelist(this.owner.address, this.acc.address)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });

      it('reverts when calling removeMintAddressFromWhitelist when not SUPPLY_CONTROLLER_MANAGER', async function () {
        await expect(this.supplyControl.connect(this.acc).removeMintAddressFromWhitelist(this.owner.address, this.acc.address)).to.be.revertedWith(
          `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
            roles.SUPPLY_CONTROLLER_MANAGER_ROLE
          }`
        );
      });
    });
  });
});