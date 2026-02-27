const { ethers } = require("hardhat");
const { PrintDeployerDetails, PrintContractDetails } = require('./utils');

const { MIN_DELAY, PROPOSERS, EXECUTORS } = process.env;

function validateAddresses(addresses, label) {
  for (const addr of addresses) {
    if (!ethers.isAddress(addr)) {
      throw new Error(`Invalid ${label} address: ${addr}`);
    }
  }
}

async function main() {
  await PrintDeployerDetails();

  const minDelayNum = Number(MIN_DELAY || "86400");
  if (!Number.isInteger(minDelayNum) || minDelayNum < 0) {
    throw new Error(`MIN_DELAY must be a non-negative integer, got: ${MIN_DELAY}`);
  }
  const minDelay = BigInt(minDelayNum);

  const proposers = PROPOSERS ? PROPOSERS.split(",").map(s => s.trim()).filter(s => s.length > 0) : [];
  const executors = EXECUTORS ? EXECUTORS.split(",").map(s => s.trim()).filter(s => s.length > 0) : [];

  validateAddresses(proposers, "proposer");
  validateAddresses(executors, "executor");

  if (proposers.length === 0) {
    throw new Error("PROPOSERS must be specified. At least one proposer address is required.");
  }

  console.log("\nDeployment Configuration:");
  console.log("  MIN_DELAY: %s seconds", minDelay.toString());
  console.log("  PROPOSERS: %s", proposers.length > 0 ? proposers : "(none)");
  console.log("  EXECUTORS: %s", executors.length > 0 ? executors : "(none)");
  console.log("  ADMIN: self-administered (no external admin)");

  console.log("\nDeploying TimelockController...");
  const TimelockController = await ethers.getContractFactory("TimelockController");
  const timelock = await TimelockController.deploy(
    minDelay,
    proposers,
    executors,
    ethers.ZeroAddress // No external admin - contract administers itself
  );
  await timelock.waitForDeployment();
  await PrintContractDetails(timelock, "TimelockController");

  const address = await timelock.getAddress();
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const hasAdminRole = await timelock.hasRole(DEFAULT_ADMIN_ROLE, address);
  console.log("Self-admin verified: %s", hasAdminRole);

  const actualMinDelay = await timelock.getMinDelay();
  console.log("Min delay: %s seconds", actualMinDelay.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
