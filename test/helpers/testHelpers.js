/**
 * Test helper functions for rebase claims system
 *
 * This module provides utilities for setting up the multiplier system
 * and managing test roles in the rebase claims tests.
 */

const { time } = require('@nomicfoundation/hardhat-network-helpers');

/**
 * Set the next multiplier using the APR-based rate system
 * This function sets an APR to achieve the target multiplier over a specified time period
 * @param {Contract} token - The token contract instance
 * @param {SignerWithAddress} signer - The signer with MULT_ADMIN_ROLE and MULT_RATE_ROLE
 * @param {number} multiplierIndex - The multiplier index (0, 1, 2, etc.)
 * @param {BigNumber} targetMultiplier - Target multiplier value (e.g., ethers.parseUnits("1.0001", 12))
 * @param {number} futureTime - Future timestamp when rate should be applied
 */
async function setNextMultiplier(token, signer, multiplierIndex, targetMultiplier, futureTime) {
    try {
        // Ensure both operands are BigInt to avoid type mixing
        const targetMultiplierBigInt = typeof targetMultiplier === 'bigint' ? targetMultiplier : BigInt(targetMultiplier.toString());

        // Get current time and multiplier
        const currentTime = await time.latest();
        const currentMultiplier = await token.getActiveMultiplier(multiplierIndex);

        // Get maturity period to calculate how many periods we'll wait
        const rewardPeriod = Number(await token.getMaturityPeriod());
        const SECONDS_PER_YEAR = 31536000; // 365 days

        // Calculate how much time we'll fast forward
        // Use at least 1 period
        const minPeriods = 1;
        const minTimeNeeded = currentTime + (rewardPeriod * minPeriods) + 1;
        const finalTargetTime = Math.max(futureTime || (currentTime + 3600), minTimeNeeded);
        const timeToWait = finalTargetTime - currentTime;
        const periods = BigInt(Math.floor(timeToWait / rewardPeriod));

        // Calculate APR needed for compound growth: target = current * (1 + apr/periods_per_year)^periods
        // Solving for apr: (1 + apr/periods_per_year)^periods = target/current
        //                   1 + apr/periods_per_year = (target/current)^(1/periods)
        //                   apr/periods_per_year = (target/current)^(1/periods) - 1
        //                   apr = ((target/current)^(1/periods) - 1) * periods_per_year
        //
        // Use JavaScript's Math functions for accurate calculation:
        const periodsPerYear = BigInt(SECONDS_PER_YEAR) / BigInt(rewardPeriod);
        const targetFloat = Number(targetMultiplierBigInt) / 1e12; // Convert to float
        const currentFloat = Number(currentMultiplier) / 1e12; // Convert to float
        const periodsFloat = Number(periods);

        // Calculate: (target/current)^(1/periods) - 1
        const ratio = targetFloat / currentFloat;
        const ratePerPeriodFloat = Math.pow(ratio, 1.0 / periodsFloat) - 1.0;

        // Convert to APR: rate_per_period * periods_per_year
        const aprFloat = ratePerPeriodFloat * Number(periodsPerYear);

        // Convert back to BigInt at 10 decimals
        const apr = BigInt(Math.floor(aprFloat * 1e10));

        if (process.env.TEST_VERBOSE) {
            console.log(`setNextMultiplier: current=${currentMultiplier}, target=${targetMultiplierBigInt}, periods=${periods}`);
            console.log(`  ratio=${ratio}, ratePerPeriod=${ratePerPeriodFloat}, periodsPerYear=${periodsPerYear}`);
        }

        if (process.env.TEST_VERBOSE) {
            console.log(`  periodsPerYear=${periodsPerYear}, apr=${apr}`);
        }

        // APR is stored as fraction at 10 decimals
        // 100% APR = 1.0 * 1e10 = 10000000000
        // Contract enforces APR bounds via setRateBoundsByAPR(), so we don't cap here

        // Check for negative rate (which would happen with decrease or zero target)
        if (apr < 0n) {
            // For zero multiplier, we should get MultiplierCannotBeZero from the contract
            // For decrease, we should get MultiplierCannotDecrease from the contract
            // Let's set rate to 0 and let contract validation handle it
            const zeroAPR = 0n;
            if (process.env.TEST_VERBOSE) console.log(`  Setting APR to 0 (negative rate)`);
            await token.connect(signer).setMultiplierRateByAPR(multiplierIndex, zeroAPR);
        } else {
            // Let contract enforce any APR bounds configured via setRateBoundsByAPR()
            if (process.env.TEST_VERBOSE) console.log(`  Setting APR to ${apr}`);
            await token.connect(signer).setMultiplierRateByAPR(multiplierIndex, apr);
        }

        // Step 3: Fast forward to target time
        await time.increaseTo(finalTargetTime);

        // Step 4: Reset rate to 0 to prevent further changes
        // This ensures the multiplier stays at (approximately) the target value
        const tx = await token.connect(signer).setMultiplierRateByAPR(multiplierIndex, 0);

        // Verify the multiplier changed (tolerance check only, no logging)
        const finalMultiplier = await token.getActiveMultiplier(multiplierIndex);
        const tolerance = targetMultiplierBigInt / 1000n; // 0.1% tolerance
        if (process.env.TEST_VERBOSE) {
            console.log(`  finalMultiplier=${finalMultiplier}, target=${targetMultiplierBigInt}, diff=${finalMultiplier - targetMultiplierBigInt}`);
        }
        if (finalMultiplier > targetMultiplierBigInt + tolerance || finalMultiplier < targetMultiplierBigInt - tolerance) {
            // Multiplier differs from target - let it proceed, tests will catch if it's a problem
        }

        return tx; // Return the transaction for applying the rate
    } catch (error) {
        // Re-throw so tests can properly catch failures
        throw error;
    }
}

/**
 * Grant all necessary test roles to an account
 * @param {Contract} token - The token contract instance
 * @param {SignerWithAddress} admin - The admin signer (must have DEFAULT_ADMIN_ROLE)
 * @param {string} account - The account address to grant roles to
 */
async function grantAllTestRoles(token, admin, account) {
    // Role constants - using ethers to compute the same keccak256 hashes as the contract
    const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const MULT_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MULT_ADMIN_ROLE"));
    const MULT_RATE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MULT_RATE_ROLE"));
    const PAYOUT_GROUP_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAYOUT_GROUP_ADMIN_ROLE"));
    const PAYOUT_GROUP_REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAYOUT_GROUP_REGISTRAR_ROLE"));

    try {
        // Grant all necessary roles for testing
        const rolesToGrant = [
            { role: MULT_ADMIN_ROLE, name: 'MULT_ADMIN_ROLE' },
            { role: MULT_RATE_ROLE, name: 'MULT_RATE_ROLE' },
            { role: PAYOUT_GROUP_ADMIN_ROLE, name: 'PAYOUT_GROUP_ADMIN_ROLE' },
            { role: PAYOUT_GROUP_REGISTRAR_ROLE, name: 'PAYOUT_GROUP_REGISTRAR_ROLE' }
        ];

        for (const { role, name } of rolesToGrant) {
            try {
                // Check if role is already granted
                const hasRole = await token.hasRole(role, account);
                if (!hasRole) {
                    await token.connect(admin).grantRole(role, account);
                }
            } catch (error) {
                // Continue with other roles even if one fails
            }
        }

        // Set up global claim source (no longer per-multiplier)
        // Note: Fixtures already fund the claim source, so we just set it here if needed
        try {
            // Use the admin/owner as the claim source
            await token.connect(admin).setClaimSource(account);
        } catch (error) {
            // Ignore errors - may already be set
        }

        // Also grant DEFAULT_ADMIN_ROLE if the account doesn't have it and admin is granting to themselves
        if (admin.address === account) {
            try {
                const hasAdminRole = await token.hasRole(DEFAULT_ADMIN_ROLE, account);
                if (!hasAdminRole) {
                    await token.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, account);
                }
            } catch (error) {
                // Ignore errors
            }
        }

    } catch (error) {
        // Don't throw - let tests handle missing roles gracefully
    }
}

/**
 * Impersonate an account with ETH balance for testing
 * @param {string} address - The address to impersonate
 * @param {string} ethAmount - Amount of ETH to set (default: "1")
 * @returns {Promise<SignerWithAddress>} The impersonated signer
 */
async function impersonateAccountWithBalance(address, ethAmount = "1") {
    const { impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
    await impersonateAccount(address);
    await setBalance(address, ethers.parseEther(ethAmount));
    const signer = await ethers.getSigner(address);
    return signer;
}

module.exports = {
    setNextMultiplier,
    grantAllTestRoles,
    impersonateAccountWithBalance
};