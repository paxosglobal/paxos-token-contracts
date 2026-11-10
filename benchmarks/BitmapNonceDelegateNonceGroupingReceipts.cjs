// Run against a disposable Anvil node on port 18547 with a compiled repository root.
// Delegation setup is excluded.
const fs = require("node:fs");
const path = require("node:path");
const ethers = require("ethers");

const [root] = process.argv.slice(2);
if (!root)
  throw new Error(
    "Usage: node benchmarks/BitmapNonceDelegateNonceGroupingReceipts.cjs ROOT",
  );
const provider = new ethers.JsonRpcProvider(
  "http://127.0.0.1:18547",
  undefined,
  { cacheTimeout: -1 },
);
const coder = ethers.AbiCoder.defaultAbiCoder();
// Set this from the reserve calculation for the batch and execution fork.
const benchmarkReserve = BigInt(process.env.BENCHMARK_GAS_RESERVE || "42000");
const key = new ethers.SigningKey(ethers.toBeHex(0x0117b115, 32));
const authority = ethers.computeAddress(key.publicKey);
const implementation = ethers.getAddress(ethers.toBeHex(0x500000, 20));
const tokenAddress = ethers.getAddress(ethers.toBeHex(0x400000, 20));
const signedMode =
  "0x0100000000005041580100000000000000000000000000000000000000000000";
const packedIntentType = "tuple(uint256 targetAndGasLimit,uint256 value,bytes data,uint256 nonce)[]";
const batchType =
  "tuple(uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)";
const readArtifact = (root, name) =>
  JSON.parse(
    fs.readFileSync(path.join(root, "out", `${name}.sol`, `${name}.json`)),
  );
const artifact = readArtifact(root, "BitmapNonceDelegate");
const metadata =
  typeof artifact.metadata === "string"
    ? JSON.parse(artifact.metadata)
    : artifact.metadata;
const settings = metadata.settings;
if (
  !metadata.compiler.version.startsWith("0.8.28+") ||
  !settings.optimizer.enabled ||
  settings.optimizer.runs !== 200 ||
  settings.viaIR ||
  settings.evmVersion !== "cancun"
) {
  throw new Error(
    "Use solc 0.8.28, optimizer 200, no IR, Cancun; do not benchmark coverage artifacts",
  );
}
const tokenArtifact = readArtifact(root, "MockERC20");
const tokenInterface = new ethers.Interface(tokenArtifact.abi);
const calldataCost = (data) =>
  ethers.getBytes(data).reduce((sum, byte) => sum + (byte === 0 ? 4 : 16), 0);
const setStorage = (account, slot, value) =>
  provider.send("anvil_setStorageAt", [
    account,
    slot,
    ethers.toBeHex(value, 32),
  ]);
const balanceSlot = (account) =>
  ethers.keccak256(coder.encode(["address", "uint256"], [account, 4]));

async function main() {
  const signer = await provider.getSigner(0);
  await provider.send("anvil_setCode", [
    authority,
    `0xef0100${implementation.slice(2)}`,
  ]);
  await provider.send("anvil_setBalance", [
    authority,
    ethers.toBeHex(10n ** 24n),
  ]);
  await provider.send("anvil_setCode", [
    tokenAddress,
    tokenArtifact.deployedBytecode.object,
  ]);
  await setStorage(tokenAddress, balanceSlot(authority), 10n ** 30n);
  const wordZeroSlot = ethers.keccak256(
    coder.encode(
      ["uint256", "uint256"],
      [0, "0xc2fc9e42e177dd235e6ad0b26b77e6d7fcb28ef74343e397cf478f9d3c408000"],
    ),
  );
  await setStorage(authority, wordZeroSlot, 1);
  for (let i = 0; i < 101; ++i) {
    const recipient = ethers.getAddress(ethers.toBeHex(0x100001 + i, 20));
    await provider.send("anvil_setBalance", [recipient, "0x1"]);
    await setStorage(tokenAddress, balanceSlot(recipient), 1);
  }
  const rows = [];
  await provider.send("anvil_setCode", [
    implementation,
    artifact.deployedBytecode.object,
  ]);
  const delegate = new ethers.Contract(authority, artifact.abi, signer);
  const sizes = (process.env.BENCHMARK_SIZES || "1,2,5,10,25,50,100").split(",").map(Number);
  const cap = 500000;
  for (const scenario of ["erc20", "native", "nativeEmpty"])
    for (const stride of [1, 256])
      for (const n of sizes) {
        const snapshot = await provider.send("evm_snapshot", []);
        const intents = Array.from({ length: n }, (_, i) => {
          const recipient = ethers.getAddress(
            ethers.toBeHex((scenario === "nativeEmpty" ? 0x200001 : 0x100001) + i, 20),
          );
          const [to, value, data] =
            scenario === "erc20"
              ? [tokenAddress, 0, tokenInterface.encodeFunctionData("transfer", [recipient, 1])]
              : [recipient, 1, "0x"];
          return [BigInt(to) | (BigInt(cap) << 160n), value, data, 1 + i * stride];
        });
        const batch = [0, 9999999999, true, benchmarkReserve];
        const digest = await delegate.hashBatch(batch, intents);
        const signature = key.sign(digest).serialized;
        const opData = coder.encode([batchType, "bytes"], [batch, signature]);
        const payload = coder.encode([packedIntentType, "bytes"], [intents, opData]);
        const data = delegate.interface.encodeFunctionData("execute", [signedMode, payload]);
        const tx = await signer.sendTransaction({
          to: authority,
          data,
          gasLimit: 15000000,
        });
        const receipt = await provider.getTransactionReceipt(tx.hash);
        if (!receipt || receipt.status !== 1)
          throw new Error("Execution failed");
        if (n && !(await delegate.isNonceUsed(1 + (n - 1) * stride)))
          throw new Error("Missing consumed ID");
        rows.push({
          scenario,
          stride,
          cap,
          n,
          gasUsed: Number(receipt.gasUsed),
          gasReserve: benchmarkReserve.toString(),
          calldata: calldataCost(data),
        });
        await provider.send("evm_revert", [snapshot]);
      }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
