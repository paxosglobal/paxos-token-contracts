const { deployTimelockControllerFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { timelockConfig } = require('./helpers/constants');

// Test that PaxosToken admin functions can be protected by OpenZeppelin's TimelockController
// for time-delayed execution of high-risk operations.
const MIN_DELAY = timelockConfig.MIN_DELAY;
const ZERO_BYTES32 = ethers.ZeroHash;

describe('TimelockController Integration', function () {
  beforeEach(async function () {
    Object.assign(this, await loadFixture(deployTimelockControllerFixture));

    // Deploy a new SupplyControl for testing setSupplyControl operations
    const SupplyControlFactory = await ethers.getContractFactory('SupplyControl');
    this.newSupplyControl = await SupplyControlFactory.deploy();
    await this.newSupplyControl.waitForDeployment();
    this.newSupplyControlAddress = await this.newSupplyControl.getAddress();

    // Deploy another SupplyControl for batch tests
    this.newSupplyControl2 = await SupplyControlFactory.deploy();
    await this.newSupplyControl2.waitForDeployment();
    this.newSupplyControl2Address = await this.newSupplyControl2.getAddress();

    // Pre-compute common test data
    this.tokenAddress = await this.token.getAddress();
    this.timelockAddress = await this.timelock.getAddress();

    // Encode common function calls
    this.setSupplyControlData = this.token.interface.encodeFunctionData(
      'setSupplyControl',
      [this.newSupplyControlAddress]
    );
    this.setSupplyControl2Data = this.token.interface.encodeFunctionData(
      'setSupplyControl',
      [this.newSupplyControl2Address]
    );
    this.setSupplyControlZeroData = this.token.interface.encodeFunctionData(
      'setSupplyControl',
      [ethers.ZeroAddress]
    );
    this.reclaimTokenData = this.token.interface.encodeFunctionData('reclaimToken', []);
  });

  describe('Schedule and Execute Flow', function () {
    it('should emit CallScheduled when scheduling an operation', async function () {
      const salt = ethers.id('test-salt-1');
      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );

      await expect(
        this.timelock.connect(this.proposer).schedule(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
        )
      ).to.emit(this.timelock, 'CallScheduled')
        .withArgs(operationId, 0, this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, MIN_DELAY);
    });

    it('should emit CallExecuted when executing an operation after delay', async function () {
      const salt = ethers.id('test-salt-2');
      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.executor).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.emit(this.timelock, 'CallExecuted')
        .withArgs(operationId, 0, this.tokenAddress, 0, this.setSupplyControlData);
    });

    it('should allow executing setSupplyControl through timelock', async function () {
      const salt = ethers.id('test-salt-3');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.executor).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.emit(this.token, 'SupplyControlSet')
        .withArgs(this.newSupplyControlAddress);
    });
  });

  describe('Cancel Operation', function () {
    it('should allow canceller to cancel pending operation', async function () {
      const salt = ethers.id('test-salt-cancel');
      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      expect(await this.timelock.isOperationPending(operationId)).to.be.true;

      await expect(this.timelock.connect(this.canceller).cancel(operationId))
        .to.emit(this.timelock, 'Cancelled')
        .withArgs(operationId);

      expect(await this.timelock.isOperationPending(operationId)).to.be.false;
    });

    it('should revert execution after cancellation', async function () {
      const salt = ethers.id('test-salt-cancel-exec');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );

      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );
      await this.timelock.connect(this.canceller).cancel(operationId);
      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.executor).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.be.revertedWithCustomError(this.timelock, 'TimelockUnexpectedOperationState');
    });

    it('should revert when non-canceller tries to cancel', async function () {
      const salt = ethers.id('test-salt-non-canceller');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );

      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );

      await expect(
        this.timelock.connect(this.executor).cancel(operationId)
      ).to.be.reverted;
    });
  });

  describe('Delay Enforcement', function () {
    it('should revert execution before delay has passed', async function () {
      const salt = ethers.id('test-salt-early');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );

      await expect(
        this.timelock.connect(this.executor).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.be.revertedWithCustomError(this.timelock, 'TimelockUnexpectedOperationState');
    });

    it('should allow execution exactly at the delay', async function () {
      const salt = ethers.id('test-salt-exact');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      await time.increase(MIN_DELAY);

      await expect(
        this.timelock.connect(this.executor).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.emit(this.timelock, 'CallExecuted');
    });

    it('should revert scheduling with delay less than minimum', async function () {
      const salt = ethers.id('test-salt-short-delay');
      const insufficientDelay = MIN_DELAY - 1;

      await expect(
        this.timelock.connect(this.proposer).schedule(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, insufficientDelay
        )
      ).to.be.revertedWithCustomError(this.timelock, 'TimelockInsufficientDelay')
        .withArgs(insufficientDelay, MIN_DELAY);
    });

    it('should track operation states correctly (pending/ready/done)', async function () {
      const salt = ethers.id('test-salt-states');
      const operationId = await this.timelock.hashOperation(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );

      // Before scheduling
      expect(await this.timelock.isOperationPending(operationId)).to.be.false;
      expect(await this.timelock.isOperationReady(operationId)).to.be.false;
      expect(await this.timelock.isOperationDone(operationId)).to.be.false;

      // After scheduling
      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      expect(await this.timelock.isOperationPending(operationId)).to.be.true;
      expect(await this.timelock.isOperationReady(operationId)).to.be.false;
      expect(await this.timelock.isOperationDone(operationId)).to.be.false;

      // After delay
      await time.increase(MIN_DELAY + 1);
      expect(await this.timelock.isOperationPending(operationId)).to.be.true;
      expect(await this.timelock.isOperationReady(operationId)).to.be.true;
      expect(await this.timelock.isOperationDone(operationId)).to.be.false;

      // After execution
      await this.timelock.connect(this.executor).execute(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
      );
      expect(await this.timelock.isOperationPending(operationId)).to.be.false;
      expect(await this.timelock.isOperationReady(operationId)).to.be.false;
      expect(await this.timelock.isOperationDone(operationId)).to.be.true;
    });
  });

  describe('Batch Operations', function () {
    it('should schedule and execute batch operations', async function () {
      const salt = ethers.id('test-salt-batch');
      const targets = [this.tokenAddress, this.tokenAddress];
      const values = [0, 0];
      const payloads = [this.setSupplyControlData, this.setSupplyControl2Data];

      await expect(
        this.timelock.connect(this.proposer).scheduleBatch(
          targets, values, payloads, ZERO_BYTES32, salt, MIN_DELAY
        )
      ).to.emit(this.timelock, 'CallScheduled');

      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.executor).executeBatch(
          targets, values, payloads, ZERO_BYTES32, salt
        )
      ).to.emit(this.timelock, 'CallExecuted');
    });

    it('should revert batch if one operation fails', async function () {
      const salt = ethers.id('test-salt-batch-fail');
      const targets = [this.tokenAddress, this.tokenAddress];
      const values = [0, 0];
      // Second operation sets zero address which will fail
      const payloads = [this.setSupplyControlData, this.setSupplyControlZeroData];

      await this.timelock.connect(this.proposer).scheduleBatch(
        targets, values, payloads, ZERO_BYTES32, salt, MIN_DELAY
      );
      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.executor).executeBatch(
          targets, values, payloads, ZERO_BYTES32, salt
        )
      ).to.be.reverted;
    });
  });

  describe('DEFAULT_ADMIN_ROLE Functions', function () {
    describe('upgradeToAndCall', function () {
      it('should verify timelock has DEFAULT_ADMIN_ROLE required for upgrades', async function () {
        const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

        expect(await this.token.hasRole(DEFAULT_ADMIN_ROLE, this.timelockAddress)).to.be.true;
        expect(await this.token.defaultAdmin()).to.equal(this.timelockAddress);
      });

      it('should schedule upgrade operations via timelock', async function () {
        const USDGFactory = await ethers.getContractFactory('USDG');
        const newImplAddress = await upgrades.deployImplementation(USDGFactory, {
          kind: 'uups',
          unsafeAllow: ['missing-initializer']
        });

        const salt = ethers.id('test-salt-upgrade');
        const data = this.token.interface.encodeFunctionData('upgradeToAndCall', [newImplAddress, '0x']);

        await expect(
          this.timelock.connect(this.proposer).schedule(
            this.tokenAddress, 0, data, ZERO_BYTES32, salt, MIN_DELAY
          )
        ).to.emit(this.timelock, 'CallScheduled');

        const operationId = await this.timelock.hashOperation(this.tokenAddress, 0, data, ZERO_BYTES32, salt);
        expect(await this.timelock.isOperationPending(operationId)).to.be.true;
      });

      it('should reject direct upgrade without timelock', async function () {
        const USDGFactory = await ethers.getContractFactory('USDG');
        const newImplAddress = await upgrades.deployImplementation(USDGFactory, {
          kind: 'uups',
          unsafeAllow: ['missing-initializer']
        });

        await expect(
          this.token.connect(this.acc).upgradeToAndCall(newImplAddress, '0x')
        ).to.be.reverted;
      });
    });

    describe('setSupplyControl', function () {
      it('should execute setSupplyControl through timelock', async function () {
        const salt = ethers.id('test-salt-supply-control');

        await this.timelock.connect(this.proposer).schedule(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
        );
        await time.increase(MIN_DELAY + 1);

        await expect(
          this.timelock.connect(this.executor).execute(
            this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
          )
        ).to.emit(this.token, 'SupplyControlSet')
          .withArgs(this.newSupplyControlAddress);
      });
    });

    describe('reclaimToken', function () {
      it('should execute reclaimToken through timelock', async function () {
        // Send tokens to the contract
        await this.token.connect(this.owner).increaseSupply(ethers.parseUnits('1000', 6));
        await this.token.connect(this.owner).transfer(this.tokenAddress, ethers.parseUnits('100', 6));

        const contractBalanceBefore = await this.token.balanceOf(this.tokenAddress);
        expect(contractBalanceBefore).to.equal(ethers.parseUnits('100', 6));

        const salt = ethers.id('test-salt-reclaim');

        await this.timelock.connect(this.proposer).schedule(
          this.tokenAddress, 0, this.reclaimTokenData, ZERO_BYTES32, salt, MIN_DELAY
        );
        await time.increase(MIN_DELAY + 1);

        const timelockBalanceBefore = await this.token.balanceOf(this.timelockAddress);

        await expect(
          this.timelock.connect(this.executor).execute(
            this.tokenAddress, 0, this.reclaimTokenData, ZERO_BYTES32, salt
          )
        ).to.emit(this.token, 'Transfer');

        // Contract balance should be zero
        expect(await this.token.balanceOf(this.tokenAddress)).to.equal(0);
        // Tokens should have been transferred to the timelock
        expect(await this.token.balanceOf(this.timelockAddress)).to.equal(
          timelockBalanceBefore + contractBalanceBefore
        );
      });
    });
  });

  describe('Access Control', function () {
    it('should reject scheduling from non-proposer', async function () {
      const salt = ethers.id('test-salt-non-proposer');

      await expect(
        this.timelock.connect(this.executor).schedule(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
        )
      ).to.be.reverted;
    });

    it('should reject execution from non-executor', async function () {
      const salt = ethers.id('test-salt-non-executor');

      await this.timelock.connect(this.proposer).schedule(
        this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt, MIN_DELAY
      );
      await time.increase(MIN_DELAY + 1);

      await expect(
        this.timelock.connect(this.proposer).execute(
          this.tokenAddress, 0, this.setSupplyControlData, ZERO_BYTES32, salt
        )
      ).to.be.reverted;
    });
  });
});
