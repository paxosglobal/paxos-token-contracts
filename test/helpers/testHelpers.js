
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
    impersonateAccountWithBalance
};