const { deployPaxosTokenFixtureLatest } = require('./helpers/fixtures');
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const hre = require("hardhat");
const { assert, expect } = require('chai');
const { ZeroAddress } = require("hardhat").ethers;
const { roles } = require('./helpers/constants');

describe('ERC20 PaxosToken', function () {
  let spender;
  let amount;
  let recipientSigner

  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployPaxosTokenFixtureLatest));
    spender = this.recipient.address;
    recipientSigner = this.recipient;
    amount = 100;
    await this.token.increaseSupplyToAddress(100, this.owner.address);
  });

  describe('approve', function () {
    describe('when the spender is not the zero address', function () {

      describe('when the sender has enough balance', function () {

        it('emits an approval event', async function () {
          await expect(this.token.approve(spender, amount))
            .to.emit(this.token, "Approval")
            .withArgs(this.owner.address, spender, amount);
        });

        describe('when there was no approved amount before', function () {
          it('approves the requested amount', async function () {
            await this.token.approve(spender, amount);

            const allowance = await this.token.allowance(this.owner.address, spender);
            assert.equal(allowance, amount);
          });
        });

        describe('when the spender had an approved amount', function () {
          beforeEach(async function () {
            await this.token.approve(spender, 1);
          });

          it('approves the requested amount and replaces the previous one', async function () {
            await this.token.approve(spender, amount);

            const allowance = await this.token.allowance(this.owner.address, spender);
            assert.equal(allowance, amount);
          });
        });
      });

      describe('when the sender does not have enough balance', function () {
        const amount = 101;

        it('emits an approval event', async function () {
          await expect(this.token.approve(spender, amount))
          .to.emit(this.token, "Approval")
          .withArgs(this.owner.address, spender, amount);
        });

        describe('when there was no approved amount before', function () {
          it('approves the requested amount', async function () {
            await this.token.approve(spender, amount);

            const allowance = await this.token.allowance(this.owner.address, spender);
            assert.equal(allowance, amount);
          });
        });

        describe('when the spender had an approved amount', function () {
          beforeEach(async function () {
            await this.token.approve(spender, 1);
          });

          it('approves the requested amount and replaces the previous one', async function () {
            await this.token.approve(spender, amount);

            const allowance = await this.token.allowance(this.owner.address, spender);
            assert.equal(allowance, amount);
          });
        });
      });
    });

    describe('when the spender is the zero address', function () {

      beforeEach(async function () {
        amount = 100;
        spender = ZeroAddress;
      });

      it('approves the requested amount', async function () {
        await this.token.approve(spender, amount);

        const allowance = await this.token.allowance(this.owner.address, spender);
        assert.equal(allowance, amount);
      });

      it('emits an approval event', async function () {
        await expect(this.token.approve(spender, amount))
        .to.emit(this.token, "Approval")
        .withArgs(this.owner.address, spender, amount);
      });
    });
  });

  describe('increase approval', function () {

    it('reverts when value to increase is zero', async function () {
      await expect(this.token.increaseApproval(spender, 0)).to.be.revertedWithCustomError(this.token, "ZeroValue");
    });

    it('emits an approval event', async function () {
      await expect(this.token.increaseApproval(spender, amount))
      .to.emit(this.token, "Approval")
      .withArgs(this.owner.address, spender, amount);
    });

    describe('when there was no approved amount before', function () {
      it('approves the requested amount', async function () {
        await this.token.increaseApproval(spender, amount);

        const allowance = await this.token.allowance(this.owner.address, spender);
        assert.equal(allowance, amount);
      });
    });

    describe('when the spender had an approved amount', function () {
      let approvedAmount;
      beforeEach(async function () {
        approvedAmount = 1;
        await this.token.approve(spender, approvedAmount);
      });

      it('increases the spender allowance adding the requested amount', async function () {
        await this.token.increaseApproval(spender, amount);

        const allowance = await this.token.allowance(this.owner.address, spender);
        assert.equal(allowance, approvedAmount + amount);
      });
    });
  });

  describe('decrease approval', function () {
    it('reverts when value to decrease is zero', async function () {
      await expect(this.token.decreaseApproval(spender, 0)).to.be.revertedWithCustomError(this.token, "ZeroValue");
    });    

    describe('when the subtracted value is greater than the current allowance', function () {
      it('emits an approval event with a zero value', async function () {
        await expect(this.token.decreaseApproval(spender, amount))
          .to.emit(this.token, "Approval")
          .withArgs(this.owner.address, spender, 0);
      });
    });

    describe('when the subtracted value is less than or equal to the current allowance.', function () {
      let approvedAmount = 101;

      beforeEach(async function () {
        approvedAmount = 101;
        await this.token.approve(spender, approvedAmount);
      });

      it('emits an approval event', async function () {
        await expect(this.token.decreaseApproval(spender, amount))
        .to.emit(this.token, "Approval")
        .withArgs(this.owner.address, spender, approvedAmount - amount);
      });
    });
  });

  describe('transfer from', function () {

    describe('when the recipient is not the zero address', function () {

      describe('when the spender has enough approved balance', function () {

        describe('when the owner has enough balance', function () {

          it('transfers the requested amount', async function () {
            let to = this.acc.address;
            await this.token.approve(recipientSigner.address, 100);
            await this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount);

            const senderBalance = await this.token.balanceOf(this.owner.address);
            assert.equal(senderBalance, 0);

            const recipientBalance = await this.token.balanceOf(to);
            assert.equal(recipientBalance, amount);
          });

          it('decreases the spender allowance', async function () {
            let to = this.acc.address;
            await this.token.approve(recipientSigner.address, 100);
            await this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount);

            const allowance = await this.token.allowance(this.owner.address, spender);
            assert.equal(allowance, 0);
          });

          it('emits a transfer event', async function () {
            let to = this.acc.address;
            await this.token.approve(recipientSigner.address, 100);
            await expect(this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount))
            .to.emit(this.token, "Transfer")
            .withArgs(this.owner.address, to, amount); 
          });
        });

        describe('when the owner does not have enough balance', function () {

          it('reverts', async function () {
            amount = 101;
            let to = this.acc.address;
            await this.token.approve(recipientSigner.address, 100);
            await expect(this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount)).to.be.revertedWithCustomError(this.token, "InsufficientAllowance");
          });
        });
      });

      describe('when the spender does not have enough approved balance', function () {
        beforeEach(async function () {
          await this.token.approve(spender, 99);
        });

        describe('when the owner has enough balance', function () {

          it('reverts', async function () {
            let to = this.acc.address;
            await expect(this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount)).to.be.revertedWithCustomError(this.token, "InsufficientAllowance");
          });
        });

        describe('when the owner does not have enough balance', function () {

          it('reverts', async function () {
            let to = this.acc.address;
            amount = 101;
            await expect(this.token.connect(recipientSigner).transferFrom(this.owner.address, to, amount)).to.be.revertedWithCustomError(this.token, "InsufficientAllowance");
          });
        });
      });

      describe('transfer from batch', function () {
        beforeEach(async function () {
          await this.token.approve(recipientSigner.address, 100);
        });

        it('success case', async function () {
          let to = this.acc.address;
          batch = 10
          amount = 1
          let owners = Array(batch).fill(this.owner.address)
          let tos = Array(batch).fill(to)
          let amounts = Array(batch).fill(amount)
          let tx = await this.token.connect(recipientSigner).transferFromBatch(owners, tos, amounts)
          const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
          const interface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
          assert.equal(receipt.logs.length, batch);
          for (let i = 0 ; i < batch; i++) {
            const data = receipt.logs[i].data;
            const topics = receipt.logs[i].topics;
            const event = interface.decodeEventLog("Transfer", data, topics);
            assert.equal(event.from, this.owner.address);
            assert.equal(event.to, to);
            assert.equal(event.value, amount);
          }
          

          // Validate Balance.
          assert.equal(await this.token.balanceOf(this.owner.address), 90);
          assert.equal(await this.token.balanceOf(to), 10);
        });

        it('insufficient funds', async function() {
          let to = this.acc.address;
          batch = 10
          amount = 100
          let owners = Array(batch).fill(this.owner.address)
          let tos = Array(batch).fill(to)
          let amounts = Array(batch).fill(amount)
          await expect(this.token.connect(recipientSigner).transferFromBatch(owners, tos, amounts), "insufficient allowance").to.be.revertedWithCustomError(this.token, "InsufficientAllowance");
        });

        it('reverts in case of bad parameters', async function() {
          let to = this.acc.address;
          batch = 10
          amount = 10
          let owners = Array(batch).fill(this.owner.address)
          let tos = Array(batch).fill(to)
          let amounts = Array(batch).fill(amount)

          // All test case validation is done in single test to avoid setup overhead.
          allParams = [owners, tos, amounts]
          assert(allParams.length==3, "incomplete check for the number of arguments to transfersFromBatch")
          for (let i = 0 ; i < allParams.length; i++) {
            const currentParam = allParams[i];
            val = currentParam.pop()
            await expect(this.token.connect(recipientSigner).transferFromBatch(owners, tos, amounts), "argument's length mismatch").to.be.revertedWithCustomError(this.token, "ArgumentLengthMismatch");
            currentParam.push(val)
          }
        });

      });

    });

    describe('when address is zero address', function () {
      beforeEach(async function () {
        await this.token.approve(spender, amount);
      });

      it('reverts transferFrom when to adress is zero', async function () {
        await expect(this.token.connect(recipientSigner).transferFrom(this.owner.address, ZeroAddress, amount)).to.be.revertedWithCustomError(this.token, "ZeroAddress");
      });
    });
  });

  describe('as an initializable token', function () {
    it('you should not be able to initialize a second time', async function () {
        await expect(this.token.initialize(0, this.acc.address, this.acc.address, this.acc.address)).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it('you should not be able to initialize with a zero address', async function () {
      const contract = await hre.ethers.deployContract("PaxosTokenV2")
      let ContractFactory = await hre.ethers.getContractFactory("AdminUpgradeabilityProxy");
      const proxy = await ContractFactory.connect(this.admin).deploy(await contract.getAddress())
      await proxy.waitForDeployment()
      const proxiedPaxosToken = contract.attach(await proxy.getAddress())

      await expect(proxiedPaxosToken.initialize(0, this.owner.address, ZeroAddress, this.assetProtectionRole.address)).to.be.revertedWithCustomError(this.token, "ZeroAddress");  
      await expect(proxiedPaxosToken.initialize(0, this.owner.address, this.owner.address, ZeroAddress)).to.be.revertedWithCustomError(this.token, "ZeroAddress");  
    });
  });

  describe('Only owner for setSupplyControl functions', function () {
    it('can call setSupplyControl when DEFAULT_ADMIN_ROLE', async function () {
      await this.token.connect(this.owner).setSupplyControl(this.acc2.address)
      const supplyControl = await this.token.supplyControl()
      assert.equal(supplyControl, this.acc2.address);
    });

    it('reverts when calling setSupplyControl when not DEFAULT_ADMIN_ROLE', async function () {
      await expect(this.token.connect(this.acc).setSupplyControl(this.acc2.address)).to.be.revertedWith(
        `AccessControl: account ${this.acc.address.toLowerCase()} is missing role ${
          roles.DEFAULT_ADMIN_ROLE
        }`
      );
    });

    it('reverts when calling setSupplyControl with zero address', async function () {
      await expect(this.token.connect(this.owner).setSupplyControl(ZeroAddress)).to.be.revertedWithCustomError(this.token, "ZeroAddress");
    });
  })
  
  describe('when addr is frozen', function () {
    beforeEach(async function () {
      approvalAmount = 40;
      // give acc2 some tokens
      await this.token.increaseSupplyToAddress(amount, this.owner.address);
      await this.token.transfer(this.acc2.address, amount);

      // approve acc address to take some of those tokens from acc2
      await this.token.connect(this.acc2).approve(this.acc.address, approvalAmount);

      // approve acc2 address to take some of those tokens from otherAddress
      await this.token.connect(this.acc).approve(this.acc2.address, approvalAmount);

      // freeze acc2
      await this.token.connect(this.assetProtectionRole).freeze(this.acc2.address);
    });

    it('reverts when transfer is from frozen address', async function () {
      await expect(this.token.connect(this.acc2).transfer(this.acc.address, amount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when transfer is to frozen address', async function () {
      await expect(this.token.connect(this.acc).transfer(this.acc2.address, amount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when transferFrom is by frozen address', async function () {
      await expect(this.token.connect(this.acc2).transferFrom(this.acc.address, this.acc.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when transferFrom is from frozen address', async function () {
      await expect(this.token.connect(this.acc).transferFrom(this.acc2.address, this.acc.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when transferFrom is to frozen address', async function () {
      // freeze acc3 to test this scenario.
      await this.token.connect(this.assetProtectionRole).freeze(this.acc3.address);
      await expect(this.token.connect(this.acc).transferFrom(this.acc2.address, this.acc3.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when approve is from the frozen address', async function () {
      await expect(this.token.connect(this.acc2).approve(this.acc.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when approve spender is the frozen address', async function () {
      await expect(this.token.connect(this.acc).approve(this.acc2.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when increase approval is from the frozen address', async function () {
      await expect(this.token.connect(this.acc2).increaseApproval(this.acc.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when increase approve spender is the frozen address', async function () {
      await expect(this.token.connect(this.acc).increaseApproval(this.acc2.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when decrease approval is from the frozen address', async function () {
      await expect(this.token.connect(this.acc2).decreaseApproval(this.acc.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('reverts when decrease approval spender is the frozen address', async function () {
      await expect(this.token.connect(this.acc).decreaseApproval(this.acc2.address, approvalAmount)).to.be.revertedWithCustomError(this.token, "AddressFrozen");
    });

    it('unfrozen address can transfer again', async function () {
      // unfreeze address
      await this.token.connect(this.assetProtectionRole).unfreeze(this.acc2.address);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(amount);

      await this.token.connect(this.acc2).transfer(this.owner.address, amount);
      expect(await this.token.balanceOf(this.acc2.address)).to.equal(0);
    });

  });
});
