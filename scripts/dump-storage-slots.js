const hre = require('hardhat');

async function main() {
  // Compile with storage layout
  for (let compiler of hre.config.solidity.compilers) {
    compiler.settings.outputSelection['*']['*'].push('storageLayout');
  }
  await hre.run("compile");

  const fqn = "contracts/PaxosTokenClaimableRewards.sol:PaxosTokenClaimableRewards";
  const info = await hre.artifacts.getBuildInfo(fqn);
  const storage = info.output.contracts["contracts/PaxosTokenClaimableRewards.sol"]["PaxosTokenClaimableRewards"].storageLayout.storage;
  const types = info.output.contracts["contracts/PaxosTokenClaimableRewards.sol"]["PaxosTokenClaimableRewards"].storageLayout.types;

  console.log("Storage Layout for PaxosTokenClaimableRewards:");
  console.log("===========================================\n");

  // Show all non-gap storage from slot 0 to 160, and V3 storage (250+)
  const relevant = storage.filter(s =>
    (!s.label.startsWith('__gap_') && parseInt(s.slot) < 160) ||
    parseInt(s.slot) >= 250
  );

  for (const item of relevant) {
    const type = types[item.type];
    console.log(`Slot ${item.slot}: ${item.label} (${type.label})`);
  }

  // Show slot range summary
  const gaps = storage.filter(s => s.label.startsWith('__gap_'));
  console.log("\n\nStorage Gaps:");
  console.log("=============");
  for (const gap of gaps) {
    const type = types[gap.type];
    const arraySize = type.label.match(/\[(\d+)\]/)?.[1] || 1;
    const endSlot = parseInt(gap.slot) + parseInt(arraySize) - 1;
    console.log(`${gap.label}: slots ${gap.slot}-${endSlot}`);
  }

  // Check facet storage
  const facetFqn = "contracts/facets/PayoutGroupFacet.sol:PayoutGroupFacet";
  const facetInfo = await hre.artifacts.getBuildInfo(facetFqn);
  const facetStorage = facetInfo.output.contracts["contracts/facets/PayoutGroupFacet.sol"]["PayoutGroupFacet"].storageLayout.storage;

  console.log("\n\nPayoutGroupFacet Storage:");
  console.log("=========================");

  // Show all storage variables
  for (const item of facetStorage) {
    console.log(`Slot ${item.slot}: ${item.label}`);
  }
}

main().catch(console.error);
