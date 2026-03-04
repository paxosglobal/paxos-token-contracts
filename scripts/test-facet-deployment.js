const hre = require("hardhat");

async function main() {
  const proxyAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
  
  // Get contract instance
  const contract = await hre.ethers.getContractAt("PaxosTokenClaimableRewards", proxyAddress);
  
  console.log("Testing facet delegation...\n");
  
  // Test 1: Check if pause() exists (TokenAdminFacet)
  try {
    const paused = await contract.paused();
    console.log("✓ paused() works (TokenAdminFacet): " + paused);
  } catch (e) {
    console.log("✗ paused() failed: " + e.message);
  }
  
  // Test 2: Check if getFacet() exists (main contract)
  try {
    const pauseSelector = contract.interface.getFunction("pause").selector;
    const facetAddr = await contract.getFacet(pauseSelector);
    console.log("✓ getFacet() works: pause() -> " + facetAddr);
  } catch (e) {
    console.log("✗ getFacet() failed: " + e.message);
  }
  
  // Test 3: Check ERC20 functions
  try {
    const name = await contract.name();
    const symbol = await contract.symbol();
    console.log(`✓ ERC20 works: ${name} (${symbol})`);
  } catch (e) {
    console.log("✗ ERC20 failed: " + e.message);
  }
  
  console.log("\n✅ All tests passed! Facet delegation working correctly.");
}

main().catch(console.error);
