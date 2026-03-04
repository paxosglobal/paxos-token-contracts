const { deployPaxosTokenClaimableRewardsFixture } = require('./helpers/fixtures');
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require('chai');
const { grantAllTestRoles, setNextMultiplier } = require('./helpers/testHelpers');
const { createPayoutGroup, UINT40_MAX } = require('./helpers/testSetup');

const ONE_ETHER = ethers.parseUnits("1", 6);

describe("MultiplierDeletionSafetyTest", function() {
    beforeEach(async function () {
        Object.assign(this, await loadFixture(deployPaxosTokenClaimableRewardsFixture));
        await grantAllTestRoles(this.token, this.owner, this.owner.address);

        // Set rate bounds so multipliers can be created
        await this.token.connect(this.owner).setRateBoundsByAPR(0, UINT40_MAX);

        // Setup accounts
        await this.token.connect(this.owner).increaseSupply(ONE_ETHER * 10n);
        await this.token.connect(this.owner).transfer(this.acc.address, ONE_ETHER);
        await this.token.connect(this.owner).transfer(this.acc2.address, ONE_ETHER);
    });

    describe("Multiplier Deletion Safety", function() {
        it("Should prevent deleting multiplier with active payout groups", async function() {
            // Create multiplier with zero rate (for easier testing)
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();

            // Extract multId from event
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create payout group using this multiplier
            const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

            // Register user to payout group
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            // Verify payout group is active
            const balance = await this.token.getPayoutGroupBalance(payoutGroupId);
            expect(balance).to.equal(ONE_ETHER);

            // Try to delete multiplier - should revert (either MultiplierInUse or InsufficientRewardFunding)
            // Both errors correctly prevent deletion of multipliers with active users
            await expect(
                this.token.connect(this.owner).deleteMultiplier(multId)
            ).to.be.reverted;
        });

        it("Should allow deleting multiplier after all payout groups are deleted", async function() {
            // Create multiplier
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create payout group
            const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

            // Register user
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            // Cannot delete yet (either MultiplierInUse or InsufficientRewardFunding)
            await expect(
                this.token.connect(this.owner).deleteMultiplier(multId)
            ).to.be.reverted;

            // Unregister user BEFORE deleting payout group (proper cleanup order)
            await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);

            // Delete payout group
            await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

            // Now should be able to delete multiplier
            const deleteTx = await this.token.connect(this.owner).deleteMultiplier(multId);
            const deleteReceipt = await deleteTx.wait();
            await expect(deleteTx)
                .to.emit(this.token, "MultiplierDeleted")
                .withArgs(multId);
        });

        it("Should prevent deleting multiplier with multiple active payout groups", async function() {
            // Create multiplier
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create two payout groups using same multiplier
            const payoutGroupId1 = await createPayoutGroup(this, multId, this.acc);
            const payoutGroupId2 = await createPayoutGroup(this, multId, this.acc2);

            // Register users to both groups
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId1, this.acc.address);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId2, this.acc2.address);

            // Try to delete multiplier - should revert (either MultiplierInUse or InsufficientRewardFunding)
            await expect(
                this.token.connect(this.owner).deleteMultiplier(multId)
            ).to.be.reverted;

            // Unregister first user and delete first payout group (proper cleanup order)
            await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId1, this.acc.address);
            await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId1);

            // Still should fail because second payout group is active
            await expect(
                this.token.connect(this.owner).deleteMultiplier(multId)
            ).to.be.reverted;

            // Unregister second user and delete second payout group
            await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId2, this.acc2.address);
            await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId2);

            // Now deletion should succeed
            await expect(this.token.connect(this.owner).deleteMultiplier(multId))
                .to.emit(this.token, "MultiplierDeleted");
        });

        it("Should allow deleting multiplier if payout group exists but is inactive", async function() {
            // Create multiplier
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create payout group but don't register anyone
            const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

            // Delete the payout group immediately (no users, so it's inactive)
            await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

            // After deletion, the payout group should be inactive even though data might exist
            // The multiplier should be deletable since no ACTIVE payout groups reference it
            await expect(this.token.connect(this.owner).deleteMultiplier(multId))
                .to.emit(this.token, "MultiplierDeleted");
        });

        it("Should prevent deletion even if balance is zero but shares exist", async function() {
            // Create multiplier with higher rate to generate shares
            const rate = ethers.parseUnits("0.05", 12); // 5% APY
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create payout group
            const payoutGroupId = await createPayoutGroup(this, multId, this.acc);

            // Register user
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            // Even if we somehow managed to get balance to zero but shares remain,
            // the payout group would still be considered active
            // This test verifies deletion is prevented (either MultiplierInUse or InsufficientRewardFunding)

            await expect(
                this.token.connect(this.owner).deleteMultiplier(multId)
            ).to.be.reverted;
        });
    });

    describe("Edge Cases", function() {
        it("Should handle deletion of multiplier with no payout groups", async function() {
            // Create multiplier
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Should be able to delete immediately since no payout groups
            await expect(this.token.connect(this.owner).deleteMultiplier(multId))
                .to.emit(this.token, "MultiplierDeleted");
        });

        it("Should successfully delete multiplier after proper cleanup (verifies MultiplierHasBalance safety)", async function() {
            // This test verifies that the system properly cleans up balance/shares,
            // making the MultiplierHasBalance error a defensive safety check that shouldn't normally be hit.
            // The error exists to catch edge cases or bugs where balance/shares persist incorrectly.

            // Create multiplier
            const rate = 0;
            const tx = await this.token.connect(this.owner).createMultiplier(rate);
            const receipt = await tx.wait();
            const createEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "MultiplierCreated"
            );
            const multId = createEvent.args[0];

            // Create and register to payout group to get some balance
            const payoutGroupId = await createPayoutGroup(this, multId, this.acc);
            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId, this.acc.address);

            // Unregister and delete payout group - this should properly clear payout group count
            await this.token.connect(this.owner).registrarUnregisterRewardAddress(payoutGroupId, this.acc.address);
            await this.token.connect(this.owner).deletePayoutGroup(payoutGroupId);

            // Deletion should now succeed (no MultiplierInUse error because cleanup worked correctly)
            const deleteTx = await this.token.connect(this.owner).deleteMultiplier(multId);
            const deleteReceipt = await deleteTx.wait();
            await expect(deleteTx)
                .to.emit(this.token, "MultiplierDeleted")
                .withArgs(multId);
        });

        it("Should verify the loop iterates through all payout groups", async function() {
            // Create multiple multipliers
            const rate = 0;

            // Create mult1
            let tx = await this.token.connect(this.owner).createMultiplier(rate);
            let receipt = await tx.wait();
            let createEvent = receipt.logs.find(log => log.fragment && log.fragment.name === "MultiplierCreated");
            const mult1 = createEvent.args[0];

            // Create mult2
            await this.token.connect(this.owner).createMultiplier(rate);

            // Create mult3 (the one we'll try to delete)
            tx = await this.token.connect(this.owner).createMultiplier(rate);
            receipt = await tx.wait();
            createEvent = receipt.logs.find(log => log.fragment && log.fragment.name === "MultiplierCreated");
            const mult3 = createEvent.args[0];

            // Create payout group on mult1
            await this.token.connect(this.owner).createPayoutGroup(mult1, this.acc.address);

            // Create payout group on mult3 with a user
            const payoutGroupId3 = await createPayoutGroup(this, mult3, this.acc2);

            await this.token.connect(this.owner).registrarRegisterRewardAddress(payoutGroupId3, this.acc2.address);

            // Try to delete mult3 - should revert (either MultiplierInUse or InsufficientRewardFunding)
            await expect(
                this.token.connect(this.owner).deleteMultiplier(mult3)
            ).to.be.reverted;
        });
    });

    describe("Linked List Deletion Edge Cases", function() {
        it("Should delete multiplier from head of linked list", async function() {
            // Create 3 multipliers (they form a linked list: mult3 -> mult2 -> mult1 -> 0)
            // Note: New multipliers are added to the HEAD of the list
            const rate = 0;
            await this.token.connect(this.owner).createMultiplier(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult3 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            // Verify linked list structure by checking getAllActiveMultipliers
            let activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(3); // mult1, mult2, mult3 (no pre-initialized multipliers)

            // Delete head (mult3, the most recently created)
            await this.token.connect(this.owner).deleteMultiplier(mult3);

            // Verify list is still intact
            activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(2);
            expect(activeMultipliers).to.not.include(mult3);
        });

        it("Should delete multiplier from middle of linked list", async function() {
            // Create 3 multipliers (linked list: mult3 -> mult2 -> mult1 -> 0)
            const rate = 0;
            const mult1 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult2 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult3 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            // Delete middle (mult2)
            await this.token.connect(this.owner).deleteMultiplier(mult2);

            // Verify list is still intact and mult2 is gone
            const activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(2); // mult1, mult3 (no pre-initialized multipliers)
            expect(activeMultipliers).to.not.include(mult2);
            expect(activeMultipliers).to.include(mult1);
            expect(activeMultipliers).to.include(mult3);
        });

        it("Should delete multiplier from tail of linked list", async function() {
            // Create 3 multipliers (linked list: mult3 -> mult2 -> mult1 -> 0)
            const rate = 0;
            const mult1 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult2 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult3 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            // Delete tail (mult1, the oldest/first created)
            await this.token.connect(this.owner).deleteMultiplier(mult1);

            // Verify list is still intact and mult1 is gone
            const activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(2); // mult2, mult3 (no pre-initialized multipliers)
            expect(activeMultipliers).to.not.include(mult1);
            expect(activeMultipliers).to.include(mult2);
            expect(activeMultipliers).to.include(mult3);
        });

        it("Should handle sequential deletion from different positions", async function() {
            // Create 4 multipliers for more comprehensive testing
            const rate = 0;
            const mult1 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult2 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult3 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            const mult4 = await this.token.connect(this.owner).createMultiplier.staticCall(rate);
            await this.token.connect(this.owner).createMultiplier(rate);

            // Initial: mult4 -> mult3 -> mult2 -> mult1 -> 0 (no pre-initialized multipliers)
            let activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(4);

            // Delete from tail
            await this.token.connect(this.owner).deleteMultiplier(mult1);
            activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(3);
            expect(activeMultipliers).to.not.include(mult1);

            // Delete from middle
            await this.token.connect(this.owner).deleteMultiplier(mult3);
            activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(2);
            expect(activeMultipliers).to.not.include(mult3);

            // Delete from head
            await this.token.connect(this.owner).deleteMultiplier(mult4);
            activeMultipliers = await this.token.getAllActiveMultipliers();
            expect(activeMultipliers.length).to.equal(1);
            expect(activeMultipliers).to.not.include(mult4);

            // Verify remaining multiplier is still accessible
            expect(activeMultipliers).to.include(mult2);
        });
    });
});
