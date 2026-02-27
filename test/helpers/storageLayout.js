const hre = require('hardhat');
const { parseFullyQualifiedName } = require('hardhat/utils/contract-names');

function isEqual(entryOld, entryNew) {
  return entryOld.type == "EMPTY" || entryOld.type == entryNew.type;
};

async function getStorageLayout(fullyQualifiedName) {
  // fullyQualifiedName example: contracts/PaxosTokenV2.sol:PaxosTokenV2
  const info = await hre.artifacts.getBuildInfo(fullyQualifiedName);
  const { sourceName, contractName } = parseFullyQualifiedName(fullyQualifiedName);
  const storage = info.output.contracts[sourceName][contractName].storageLayout.storage
  const types = info.output.contracts[sourceName][contractName].storageLayout.types;

  return storage.reduce(function (storageLayout, { label, offset, slot, type }) {
    const slotSize = 32;

    const currentVarSize = parseInt(types[type].numberOfBytes);
    slot = parseInt(slot);
    offset = parseInt(offset);

    const bytesStart = slot * slotSize + offset;
    const bytesEnd = bytesStart + currentVarSize - 1;

    // append gaps left in the previous storage slot.
    const prevBytesEnd = storageLayout.length > 0 ? storageLayout[storageLayout.length-1].bytesEnd : -1;
    if (bytesStart > prevBytesEnd + 1) {
      storageLayout.push({ label: 'EMPTY', type: 'EMPTY', bytesStart: prevBytesEnd + 1, bytesEnd: bytesStart - 1});
    } 
    storageLayout.push({ label, type: types[type].label, slot: slot, offset, currentVarSize, bytesStart, bytesEnd});

    return storageLayout;
  }, []);
}

function compareStorageLayouts(storageOld, storageNew) {
  let bytesIndex = 0;
  const storageOldLength = storageOld.length;
  const storageNewLength = storageNew.length;
  let indexOld = 0;
  let indexNew = 0;
  let comparisonTable = [];

  // Values exist in both the iteratoras
  while (indexOld < storageOldLength && indexNew < storageNewLength) {
    const [ entryOld, entryNew ] = [ storageOld[indexOld], storageNew[indexNew] ];
    const [ bytesEndOld, bytesEndNew ]  = [ entryOld.bytesEnd, entryNew.bytesEnd ];

    const currBytesEndMin = Math.min(bytesEndOld, bytesEndNew);
    comparisonTable.push({
      bytesStart: bytesIndex,
      bytesEnd: currBytesEndMin,
      entryOld: `${entryOld.label}: ${entryOld.type}`,
      entryNew: `${entryNew.label}: ${entryNew.type}`,
      changed: isEqual(entryOld, entryNew) ? "same": "modified",
    });

    if (bytesEndOld >= bytesEndNew) {
      indexNew++;
    }

    if (bytesEndNew >= bytesEndOld) {
      indexOld++;
    }

    bytesIndex = currBytesEndMin + 1;
  }

  // We can delete variables, compared to old storage
  while (indexOld < storageOldLength) {
    entry = storageOld[indexOld];
    comparisonTable.push({
      bytesStart: bytesIndex,
      bytesEnd: entry.bytesEnd,
      entryOld: `${entry.label}: ${entry.type}`,
      changed: "delete",
    });
    
    indexOld++;
    bytesIndex = entry.bytesEnd + 1;
  }
  
  // We can append variables, compared to old storage
  while (indexNew < storageNewLength) {
    entry = storageNew[indexNew];
    comparisonTable.push({
      bytesStart: bytesIndex,
      bytesEnd: entry.bytesEnd,
      entryNew: `${entry.label}: ${entry.type}`,
      changed: "append",
    });
    
    indexNew++;
    bytesIndex = entry.bytesEnd + 1;
  }

  return comparisonTable;
};

async function compile() {
  for (let compiler of hre.config.solidity.compilers) {
    compiler.settings.outputSelection['*']['*'].push('storageLayout');
  }
  await hre.run("compile");
}


async function getComparison(oldFullQualifiedName, newFullQualifiedName) {
  await compile();
  const storageOld = await getStorageLayout(oldFullQualifiedName);
  const storageNew = await getStorageLayout(newFullQualifiedName);
  return compareStorageLayouts(storageOld, storageNew);
}

async function isStorageLayoutModified(oldFullQualifiedName, newFullQualifiedName) {
  compareData = await getComparison(oldFullQualifiedName, newFullQualifiedName);
  // console.table(compareData)
  return compareData.filter((entry) => "modified" == entry.changed && !entry.entryOld.startsWith("__gap_")).length > 0
}

/**
 * Check if V2 storage layout is preserved in V3 upgrade
 * This only checks V2 storage slots (bytes 0-8063, i.e., slots 0-251)
 * V3-specific storage (after slot 252) is allowed to change
 * @param {string} v2FullQualifiedName - e.g., "contracts/PaxosTokenV2.sol:PaxosTokenV2"
 * @param {string} v3FullQualifiedName - e.g., "contracts/PaxosTokenClaimableRewards.sol:PaxosTokenClaimableRewards"
 * @returns {boolean} true if V2 storage is preserved, false if modified
 */
async function isV2StoragePreserved(v2FullQualifiedName, v3FullQualifiedName) {
  const compareData = await getComparison(v2FullQualifiedName, v3FullQualifiedName);

  // V2 storage ends at slot 251 (byte 8063)
  // Slot 252 starts at byte 8064 (252 * 32 = 8064)
  const V2_STORAGE_END_BYTE = 8063;

  // Check for modifications only in V2 storage range (ignore __gap_)
  const v2Modifications = compareData.filter((entry) =>
    entry.changed === "modified" &&
    !entry.entryOld.startsWith("__gap_") &&
    entry.bytesStart <= V2_STORAGE_END_BYTE
  );

  return v2Modifications.length === 0;
}

module.exports = {
  getComparison,
  isStorageLayoutModified,
  isV2StoragePreserved,
};

/* Sample Usage
async function exec() {
  const oldFullQualifiedName = "contracts/archive/PaxosTokenV1.sol:PaxosTokenV1";
  const newFullQualifiedName = "contracts/PaxosTokenV2.sol:PaxosTokenV2";
  console.table(await getComparison(oldFullQualifiedName, newFullQualifiedName))
}
exec();
*/
