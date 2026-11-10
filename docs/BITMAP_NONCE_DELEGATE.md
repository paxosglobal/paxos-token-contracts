# Bitmap Nonce Delegate: batches of replay-protected intents

`BitmapNonceDelegate` separates an EOA's authority from submission: the authority signs,
and any relayer can submit and pay gas. The implementation has no reimbursement,
paymaster, or authority/relayer economic agreement. One signature authorizes one ordered
**batch of intents** from one delegated EOA. An **intent** is one call with one stable
bitmap nonce. There is no additional bundle of independently signed batches.

## Trust model

Signed execution preserves authorization safety without trusting either the relayer
or an intent's target. It does not guarantee submission, timing, or application-level
success.

### Untrusted targets

For every signed intent, the target cannot consume more than its
signed CALL allowance, apart from the EVM's call stipend (G_callstipend). Return-data
copying is bounded, and every batch ID is reserved before the first external call,
so callbacks cannot consume later intents' IDs.

When the signed `gasReserve` covers the active chain's CALL charges and executor
handling, a target that exhausts its allowance cannot consume the gas needed to
process its result. A completed tolerant batch records the failure and continues;
a strict batch reverts as authorized. Each intent specifies the gas limit used
when the wallet calls its target.

Targets can still revert, lack a prerequisite balance, or return application-level
failure data. The authority chooses through `revertOnFailure` whether an EVM call
failure reverts the batch or counts as a consumed attempt. Return values such as an
ERC-20 `false` are not interpreted; see [Token return behavior](#token-return-behavior).

### Untrusted relayers

The signature binds the exact intents, ordering, validity window, failure policy,
per-intent gas limits, and gas reserve. A relayer chooses whether and when to submit,
the transaction gas limit, gas price, and transaction ordering, but cannot alter the
signed execution.

Before issuing each signed CALL, the executor checks that enough gas remains for
the signed CALL allowance, EIP-150 headroom, and signed reserve. If that check
fails, `InsufficientGas` reverts the entire batch. If the enclosing transaction
instead runs out of gas, ordinary EVM rollback has the same atomic effect. In
either case, earlier call effects, logs, and every nonce reservation roll back.
A completed batch therefore cannot retain a nonce for an intent the executor
never reached.

For nonce semantics, an intent is attempted when the executor issues its CALL after
the funding check passes. The call need not succeed or enter target code. In tolerant
mode, the authority accepts that attempted calls consume their IDs even when they
fail. In strict mode, any call failure rolls back every ID.

An untrusted relayer can still withhold a batch or choose any execution time inside
its signed validity window. Gas-isolation guarantees require per-intent gas
limits and a reserve selected for the active chain's gas schedule. A network upgrade
that reprices CALL or executor handling can make a pending reserve inadequate.
Use validity windows that expire before an incompatible upgrade, or confirm
cancellation of at least one ID from each affected batch before issuing a
replacement authorization. Cancellation permanently consumes that ID, so the
corresponding replacement intent must use a new ID. Other unused IDs can remain
assigned to the same work. Re-signing with the same IDs does not revoke an older
signature.

## Replay IDs and execution

Assign each work item an unused `uint256 nonce` in the authority's namespace.
Keep that ID when re-signing the work item into another batch. The bitmap
records IDs, not content hashes: never assign one ID to unrelated work, and
never give the same work a new ID merely because the outcome of a submission is
unknown. IDs can be consumed out of order; gaps block nothing. Nearby IDs share
a storage word (256 IDs per word), reducing gas.

The signature binds every intent's `to`, `gasLimit`, `value`, `data`, and `nonce`, its position,
and the batch's validity window, failure policy, and gas reserve. It cannot authorize a subset,
a reordered list, or a different grouping. Regrouping requires the authority to
sign a new batch, reusing the original work IDs. A one-intent batch is the standalone
submission path; it uses exactly the same signing and replay rules.

Every ID in the batch is reserved before the first external call. Adjacent intents
whose IDs share a bitmap word are combined into one update. During reservation,
that cached word contains both existing consumed bits and this run's new bits, so
an already-used or duplicated ID is rejected before any target runs. When the next
intent uses a different word, the accumulated word is written and the next word is
loaded. Revisiting a word reloads its committed bits; neither IDs nor calls are sorted.
A standalone intent uses the existing single-nonce routine. An empty signed batch is rejected.

No cached bitmap value crosses an external call. Callbacks can consume or cancel
unrelated IDs in the same word without any later cached write erasing them. All IDs
belonging to the outer batch are already reserved, including its later intents:
reentrant attempts to execute or cancel those IDs fail with `NonceUsed`.
Self-targeting intents and invalid replay IDs are rejected before any target runs.


| Policy                    | Failed inner call                                 | Nonces after a completed submission                                                         |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `revertOnFailure = true`  | Revert the whole batch                            | All writes roll back; every intent remains executable unless already used before submission |
| `revertOnFailure = false` | Emit `CallFailed(batchDigest, nonce, returnData)` and continue | Every attempted intent's ID is consumed, including failed attempts                          |


In either policy, an already-used, cancelled, or duplicated ID causes `NonceUsed`
before any call. All reservation writes roll back, including earlier word runs.
Failure tolerance applies to call failures, not invalid replay IDs. To submit the
remaining work after partial completion, build and sign a new batch containing only
unused IDs. Retrying a failed tolerant-mode operation is a new authorization/work
item with a new ID; resubmitting its old ID is rejected. An outer transaction revert
(including out-of-gas) rolls back all this contract's bitmap updates.

`cancelAuthorization(nonce, signature)` burns an individual ID. It does not cancel
only one particular batch: every batch containing that ID becomes unexecutable.

`BatchExecuted(digest)` identifies the submitted signed envelope. Each
`CallFailed(batchDigest, nonce, returnData)` identifies both the signed batch and
the failed intent's replay ID. The digest and nonce are indexed for log filtering;
the emitting address identifies the delegated account. The intent's position can
be recovered from the signed batch, so the event does not include an array index.
Use `isNonceUsed(id)` to check bitmap state. `BatchExecuted` means the submission
completed, not that every call succeeded. There is one batch event rather than
one event per intent. An enclosing revert erases these logs along with call effects and nonce
updates; strict failures therefore leave no retained `CallFailed` event.

Nested signed execution with unrelated IDs is supported. Those batches emit from
the same delegated account and their logs can interleave. Match each failure to
its batch by digest, rather than by proximity to a `BatchExecuted` event. Confirm
the underlying business outcome before authorizing a retry with a fresh ID; call
success remains EVM success rather than application-level return-value validation.

## Work-queue retry patterns

For a strict batch with IDs `[100, 101, 102]`, a failure at any position unwinds all
call effects, logs, and bitmap writes. A failure of intent 102 does not strand 100
or 101. Resubmit the same signed batch after fixing the execution condition, while
it remains valid and its IDs remain unused. Alternatively, obtain a new signature
for a different batch of unused intents, preserving their IDs. Splitting or
reordering the original batch requires a new signature.

For a completed tolerant batch with IDs `[200, 201, 202]`, suppose 200 and 202
succeed and 201 fails. All three IDs are consumed. Record the two successes and
create a newly authorized attempt for the failed work with a fresh ID, for example
203. Sign and submit only that retry; do not copy the successful transfers into a
new batch with fresh IDs. A batch containing any old consumed ID reverts with
`NonceUsed`, including any new work submitted alongside it. If every inner call
fails but the tolerant batch completes, all attempted IDs are still consumed.

When a submission's outcome is unknown, check its receipt and the bitmap, and
resolve any ambiguity in the business outcome before allocating fresh IDs. A set
bit proves consumption or cancellation, not that the underlying business
operation succeeded. The bitmap cannot protect against the authority assigning
fresh IDs to work that already succeeded. Avoid racing a new ID against an
earlier submission whose result is still unknown.

Failure tolerance is conditional on the enclosing execution completing. Outer
out-of-gas or a caller reverting after delegate execution rolls back earlier
calls, bitmap writes, and logs. Every signed gas limit is the CALL gas argument.
Call success here means EVM call success; the delegate does not validate
application return values.

The self-authorized ERC-7821 path has no bitmap IDs and always executes atomically.
It relies on the authority's native transaction authorization. A mined transaction
consumes its sender's native nonce even if it reverts, while the delegate's bitmap
updates roll back on an enclosing revert. For a relayed batch, that native nonce
belongs to the relayer, not to the authority's work queue. Resubmission uses a new
native transaction nonce while retaining any unused intent IDs.

## Token return behavior

The delegate treats a call as successful if it does not revert. It does not
interpret return values: `true`, `false`, empty data, and other replies all count
as successful calls. This applies to both signed batches and self-mode execution.

A token that returns `false` without reverting does not trigger `CallFailed` or
`revertOnFailure`. Later calls still run, and the signed intent's ID is consumed
when the batch completes, even if no tokens moved. A token that reverts follows
the batch's failure policy.

Only use token operations whose outcome the caller can verify. When adding a
token, check its return behavior and verify the transfer using its documented
receipt events or balance changes before confirming it. A successful transaction
or a consumed intent ID alone does not prove that a token transfer succeeded.

## Why one signature per batch

Replay identity and signature scope serve different purposes. The per-intent
bitmap ID prevents a work item from being executed twice after it is re-signed
into another group. The batch signature authorizes the exact ordered list, the
shared validity window, and the chosen failure policy. One signature does not
require one replay key, and one replay key per intent does not require a signature
per intent.

Batches use one signature to amortize signature bytes, decoding, and verification
across the work queue. A batch carries one 65-byte signature and performs one signer
recovery; independent intent signatures would carry and verify one per item. The
benchmarks in this document do not measure a per-intent-signature alternative.

The primary authority/relayer relationship is operational cooperation: the
authority approves work, and the relayer submits it and pays gas. The signed fields
and rollback behavior also preserve authorization safety with a less-trusted
relayer, subject to the liveness and timing limits in [Trust model](#trust-model).
Hot signers can sign new batch arrangements as work is ready. That permits
inexpensive batch authority without reimbursement, paymasters, or a negotiated
gas-price deal. The relayer cannot independently select, reorder, or regroup
already signed intents: a new batch signature is required.

Cold or warm signers can use a one-intent batch through the same signed endpoint.
A multi-intent strict batch is available when the authority wants ordered, coupled
execution. Tolerant mode authorizes independent attempts within one signed list;
it does not make those intents independently signed or independently deliverable.
There is no additional grouping layer.

## Wire format and signing

```solidity
struct PackedIntent {
    uint256 targetAndGasLimit;
    uint256 value;
    bytes data;
    uint256 nonce;
}
struct BatchMetadata {
    uint256 validAfter;
    uint256 validBefore;
    bool revertOnFailure;
    uint64 gasReserve;
}
// executionData for MODE_SIGNED_BATCH:
abi.encode(intents, abi.encode(batch, signature))
```

Validity is exclusive: `validAfter < block.timestamp < validBefore`. The signature
is 65-byte `r || s || v`. Native value comes from the delegated EOA's balance;
`execute` is nonpayable. Each batch has one authority, one validity window, one
failure policy, one gas reserve, and one signature.

The wire naming follows
[ERC-4337's `PackedUserOperation`](https://eips.ethereum.org/EIPS/eip-4337#entrypoint-interface):
a packed on-chain representation can differ from the signing representation. Our
`PackedIntent` layout is custom; it is not an ERC-4337 UserOperation. The
EIP-712 type is `Intent`, with separate `to` and `gasLimit` fields.

| Bits in `targetAndGasLimit` | Field |
| --- | --- |
| 0–159 | Recipient address `to` |
| 160–223 | `uint64 gasLimit` |
| 224–255 | Reserved; must be zero |

`targetAndGasLimit = uint256(uint160(to)) | (uint256(gasLimit) << 160)`. Every limit
is the explicit CALL gas argument; native sends also receive the EVM's call stipend
(G_callstipend). A limit of 0 forwards only the stipend on ETH sends, which suits
value transfers to accounts that will not have code at execution. Before each call,
the guard requires `gasLimit + floor(gasLimit / 63) + gasReserve` gas. `gasReserve`
covers account access, instructions between the gas check and CALL, value transfer,
and cleanup. Insufficient gas reverts the whole batch and rolls back every
reservation, even when `revertOnFailure = false`. The standard self path uses
three-field Call[] and has no per-call caps.

The EIP-712 domain is
`{ name: "BitmapNonceDelegate", version: "1", chainId, verifyingContract: delegatedEOA }`.
The signing schema includes the intents array; the Solidity `BatchMetadata`
struct is only the policy metadata passed alongside that array. Off-chain
encoders must use this schema, not infer the envelope from Solidity metadata:

```javascript
const types = {
  Intent: [
    { name: "to", type: "address" },
    { name: "gasLimit", type: "uint64" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint256" },
  ],
  Batch: [
    { name: "intents", type: "Intent[]" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "revertOnFailure", type: "bool" },
    { name: "gasReserve", type: "uint64" },
  ],
};
// ethers v6: sign unpacked Intent fields; encode PackedIntent on-chain.
const intents = [{ to: recipient, gasLimit: 500_000n, value: 0n, data: "0x", nonce: 1n }];
const gasReserve = reserveForThisBatch; // Calculate using the Gas reserve section.
const message = { intents, validAfter, validBefore, revertOnFailure, gasReserve };
const signature = await authority.signTypedData(domain, types, message);
const packedIntents = intents.map(({ to, gasLimit, value, data, nonce }) => ({
  targetAndGasLimit: BigInt(to) | (gasLimit << 160n),
  value,
  data,
  nonce,
}));
const coder = ethers.AbiCoder.defaultAbiCoder();
const opData = coder.encode(
  ["tuple(uint256 validAfter,uint256 validBefore,bool revertOnFailure,uint64 gasReserve)", "bytes"],
  [[validAfter, validBefore, revertOnFailure, gasReserve], signature],
);
const executionData = coder.encode(
  ["tuple(uint256 targetAndGasLimit,uint256 value,bytes data,uint256 nonce)[]", "bytes"],
  [packedIntents, opData],
);
```

`hashBatch(metadata, intents)` returns the complete digest, not just the struct hash.
The unit suite includes an independently computed golden digest for the packed-cap signing schema.

The self-authorized path uses `MODE_BATCH` and `abi.encode(Call[])`, requires
`msg.sender == address(this)`, executes atomically, and has no bitmap IDs. Its
calls are authorized by the native transaction. The signed path uses custom mode
selector `0x50415801`, full value
`0x0100000000005041580100000000000000000000000000000000000000000000`. The
standard [ERC-7821](https://eips.ethereum.org/EIPS/eip-7821) signed mode
describes three-field `Call[]`; advertising it for four-field `PackedIntent[]`
would mislead clients. This is a custom signed extension alongside the standard
self-execution mode, not a new standard ERC-7821 payload.

Signed intents cannot call the wallet itself. For example, an intent could call
`execute(MODE_BATCH, ...)` on the wallet and enter self mode, bypassing signed-mode
checks. The batch rejects all calls to the wallet itself, regardless of calldata,
value, gas cap, or failure policy. Direct self-mode execution still works.

## Account compatibility

The delegated account accepts ERC-721 and ERC-1155 safe transfers and
reports them through ERC-165. Its receiver hooks return the standard selector and
do nothing else. ERC-1271 accepts a signature by the account's own key.
Malformed signatures revert.
Unrecognized calls succeed without executing any action, like an EOA; attached ETH
is accepted, but a wrong function selector can silently succeed.

## Delegation changes and pending authorizations

The signing domain identifies the chain, delegated EOA, name, and version. It does
not include the implementation address, the EOA's native transaction nonce, or
delegation history. Changing or clearing delegation does not revoke outstanding
batch or cancellation signatures.

An implementation with the same domain and signing schema can accept earlier
authorizations. Returning to an earlier domain makes unused, unexpired batch
signatures usable again. Cancellation signatures have no expiry. Incrementing the
domain version separates authorizations on the new implementation; it does not
invalidate them if the account later returns to the earlier domain.

Consumed and cancelled IDs stay blocked only while subsequent delegates preserve
the bitmap in the account's storage. Use trusted, storage-compatible delegates.
Clearing or overwriting the bitmap can make previously consumed authorizations
replayable when the account returns to a compatible domain and signing schema.

To retire pending batches, cancel their replay IDs and confirm the cancellations
before changing delegation. Every batch containing a cancelled ID becomes
unexecutable while that bit remains set. Use bounded validity windows for batch
signatures, and do not treat a delegation change or native nonce increment as
cancellation. The contract has no global authorization epoch or operation that
invalidates all outstanding authorizations at once.

## Bounded return data

Failed-call replies of up to 256 bytes are copied unchanged; successful replies
are discarded. Larger replies are replaced with the four-byte
`ReturnDataTooLarge()` selector without copying the original data. The EVM
success flag is unchanged: strict signed failures revert with
`CallReverted(nonce, result)`, self execution reverts with
`ExecuteError(index, result)`, and
tolerant failures include it in `CallFailed` and continue to the next intent. An
oversized successful reply remains successful. A target can also return the
`ReturnDataTooLarge()` selector itself, so confirm the business outcome, not
error data, before deciding retries.

## Gas reserve

`gasReserve` is extra gas the wallet must have beyond each signed call's gas limit
before making the call. The signer sets it once for the batch. It pays for CALL
charges, instructions between the check and CALL, and cleanup such as logging
failures. It is not extra gas forwarded to the target or a guaranteed balance
after the call. The contract has no default or minimum reserve. Gas figures in
this document are measured on the bytecode and settings in
[Measured gas](#measured-gas).

### Calculating the reserve

Choose the largest requirement across the batch's possible execution paths:

```text
gasReserve >= max(guard-to-CALL instructions + CALL charges + cleanup)
```

The funding check separately adds `gasLimit + floor(gasLimit / 63)` for the target
allowance and EIP-150 headroom. Assume the target uses its full allowance rather
than relying on unused gas returning.

1. **Guard to CALL.** Trace the optimized deployed bytecode from the guard's
   `GAS` result to the CALL opcode. Remeasure after compiler, optimizer, bytecode,
   or execution-fork changes.
2. **CALL charges.** Budget for the most expensive state the target could be in with
   code: account access (COLD_ACCOUNT_ACCESS_COST), G_callvalue for ETH, and access
   to its delegate's code if it is, or could become, a delegated EOA. Do not include
   G_newaccount: an account without code executes nothing, so the gas it receives
   cannot change its outcome, and an unfunded surcharge only reverts the batch. For
   an ETH send to an address you don't control, budget for a cold delegated account.
   Treat precompiles as targets with code, including G_newaccount if one may be
   empty. Account access and creation rules are defined by
   [EIP-2929](https://eips.ethereum.org/EIPS/eip-2929),
   [EIP-161](https://eips.ethereum.org/EIPS/eip-161), and
   [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702).
3. **Cleanup.** Trace the parent wallet after the target returns. Include reply
   copying, `CallFailed`, loop work, and enough gas to finish or reject the next
   underfunded call with `InsufficientGas`. Test both failure policies, the
   maximum copied failure (256 bytes), the oversized-reply sentinel, and failures
   at different positions. A trace that only reaches the next check misses the
   instructions needed to reject it.

Use the actual batch inputs when measuring memory. For `a` words already paid
for and a peak of `b` words during cleanup, expansion costs:

```text
C(a) = G_memory·a + floor(a² / 512)
memory expansion = C(b) - C(a)
cleanup = fixed instructions/copy/log costs + memory expansion
```

Hash encodings and failure replies allocate fresh memory for each intent. Later
failures can therefore cost more to handle, even with equal-sized replies.
Intent count alone does not bound memory: input sizes matter too.
For batches beyond the measured cases, derive a memory bound or trace those
larger cases rather than extrapolating from 100 intents.
A conservative cap-based bound can instead solve `C(a) <= transaction cap -
intrinsic gas`, ignoring other costs, then bound the additional cleanup words
from the bytecode. Apply the memory formula at that ceiling and check every exit
path. This can overestimate states that cannot occur together; it is not an
exact reachable maximum.

For a local trace of the failure-buffer regression, without instrumenting the
contract, run:

```sh
forge test --offline --match-test test_failureBuffersPreserveLaterInputsAndLogs \
  --debug --dump /tmp/bitmap-cleanup-trace.json
```

For a submitted batch, use the node's `debug_traceTransaction` instead. Count
only the wallet's parent-frame cleanup steps; target execution is paid from its
cap. Use the trace's memory sizes to separate fixed cost from expansion.

### Measured example

With the bytecode and settings listed below, guard-to-CALL instructions cost
48 gas. In a batch of 100 intents carrying four-byte inputs and reverting with
256-byte replies, cleanup has a fixed cost of 4,853 gas before the next funding
check. The first failure adds 145 memory gas, giving 4,998. Reaching and rejecting
the next call needs another 40 gas: cleanup through `InsufficientGas` is **5,038**.
Later failures add 82–113 memory gas each; finishing after the last
failure costs 4,817. These are fixture measurements, not universal bounds.

Using that cleanup measurement gives conservative component sums:

```text
Cold ERC-20 target:                        48 + COLD_ACCOUNT_ACCESS_COST + 5,038
Cold ETH recipient that may be delegated:  48 + 2 × COLD_ACCOUNT_ACCESS_COST + G_callvalue + 5,038
```

These sums can combine costs that do not occur together. They are allowances,
not claims about an exactly reachable minimum. The benchmark fixtures use a
rounded **42,000** for their small inputs; it is not a production default.
Different inputs, return data, batch sizes, or chain rules require recalculation.

### Funding the batch and changes to gas rules

The relayer must also fund intrinsic/calldata gas, authorization, nonce reservation,
every target's gas allowance, account creation for empty recipients, and the rest of
the batch. The reserve only protects a call's surrounding work; it does not pay for
later calls. Split the batch if its worst-case total exceeds the chain's transaction
limit. `revertOnFailure = false` permits individual failures, but an underfunded
later call or outer out-of-gas still rolls back the batch and its nonce updates.

Gas estimation from a successful transfer alone is insufficient: test targets
that exhaust their caps and return the largest failure reply. With an undersized
signed reserve, anyone can copy a pending signed batch and front-run it with less
gas, causing a call to fail while consuming its nonce.

Recalculate and test the reserve when the chain's gas rules or the deployed
bytecode change. Expire or cancel pending authorizations before a change makes
their reserve insufficient, then sign replacements with recalculated settings.

## Measured gas

Measured November 3, 2026 with Forge/Anvil 1.8.6
(`6bad0a66de7c83f7b33695044138f0f5fa4c5990`), solc 0.8.28, optimizer 200, Cancun
bytecode, Osaka test EVM and no via-IR. Runtime bytecode is 6,063 bytes.

The fixtures use a 500,000 target cap and a 42,000 example reserve. These
successful-transfer fixtures have short replies; they do not measure
oversized-reply savings or establish a reserve for arbitrary batches.

### Warm-context execution

Execution gas measures the `execute` call, including the caller's ABI-copy work.
It excludes calldata charges and the 21,000 intrinsic fee. The harness uses the
same warm-up and resets to the same snapshot for every row. The
implementation/token are warm, the first nonce word and sender balance are
dirty, and recipients are cooled. Consecutive IDs share bitmap words. ERC-20
recipients already hold one token unit; native recipients hold one wei or are
empty as labeled. Each row includes nonce reservation and execution of every
intent.

#### ERC-20

| Calls | Execution |
| --- | ---: |
| 1 | 20,591 |
| 2 | 31,218 |
| 5 | 62,570 |
| 10 | 114,906 |
| 25 | 272,543 |
| 50 | 537,368 |
| 100 | 1,074,887 |

#### ETH to an existing address

| Calls | Execution |
| --- | ---: |
| 1 | 21,644 |
| 2 | 33,322 |
| 5 | 67,815 |
| 10 | 125,344 |
| 25 | 298,268 |
| 50 | 587,584 |
| 100 | 1,170,375 |

#### ETH to an empty address

| Calls | Execution |
| --- | ---: |
| 1 | 46,644 |
| 2 | 83,322 |
| 5 | 192,815 |
| 10 | 375,344 |
| 25 | 923,268 |
| 50 | 1,837,584 |
| 100 | 3,670,375 |

#### ID allocation matters

Adjacent intents in the same bitmap word share a storage write. Separate-word IDs
(stride 256) require more writes; allocate compact IDs even when executing out of
order. These are ERC-20 execution measurements:

| Calls | Consecutive IDs | Separate-word IDs |
| --- | ---: | ---: |
| 1 | 20,591 | 20,591 |
| 10 | 114,906 | 315,174 |
| 100 | 1,074,887 | 3,277,835 |

### Mined transaction receipts

The receipt fixture runs on a disposable Anvil node with Prague execution and
Cancun-compiled bytecode. The EOA is already delegated; installing delegation is
excluded. Bitmap bit 0 is seeded and IDs 1..N are unused. ERC-20 sends
one token unit to a funded recipient; native sends one wei to funded or empty
recipients. Every transaction starts from the same snapshot with fresh access
accounting.

Receipt gas includes intrinsic gas and actual calldata charges. The warm-context
execution fixture above has different storage and access conditions; compare
each table only with its own baseline. The driver measures 42 rows: three
transfer scenarios, two ID strides, and seven batch sizes.
Tables show consecutive IDs.

#### ERC-20

| Calls | Receipt |
| --- | ---: |
| 1 | 57,245 |
| 2 | 69,165 |
| 5 | 104,326 |
| 10 | 162,994 |
| 25 | 339,095 |
| 50 | 633,162 |
| 100 | 1,223,411 |

#### ETH to an existing address

| Calls | Receipt |
| --- | ---: |
| 1 | 50,575 |
| 2 | 63,075 |
| 5 | 100,121 |
| 10 | 161,838 |
| 25 | 347,081 |
| 50 | 656,206 |
| 100 | 1,275,892 |

#### ETH to an empty address

| Calls | Receipt |
| --- | ---: |
| 1 | 75,575 |
| 2 | 113,087 |
| 5 | 225,121 |
| 10 | 411,826 |
| 25 | 972,081 |
| 50 | 1,906,206 |
| 100 | 3,775,880 |

### Reservation algorithm

For each nonce, `wordPos = nonce >> 8` and `mask = 1 << (nonce & 255)`.
The cached word includes preexisting consumed bits and pending bits from the
current adjacent run. Reject if `word & mask != 0`; otherwise combine with
`word |= mask`. Write on a word change and after the final run. All writes
finish before any target runs. This uses constant extra memory and linear work
without sorting or restricting nonce order.

`[1, 9, 3, 256, 257, 2, 10]` makes three writes: word 0, word 1, then word 0
again. The storage-trace test verifies that count. Reloading a revisited word
preserves its committed bits and detects duplicates across runs. The standalone
path reuses the existing single-nonce routine, preserving its gas cost.

## Validation and reproduction

The four delegate suites pass 96 tests with pinned Forge 1.8.6. Fuzz tests run
10,000 cases. Tests cover batch-reserve and cap tampering, reserved packed bits,
funding and 100-intent reserve boundaries, nonce rollback, batch hashing, and
failure buffers preserving later call inputs and earlier logs. This document does
not report coverage.

These results use Foundry `v1.8.6`. Use that same
version for local tests, coverage and benchmarks; solc 0.8.28 settings are pinned
separately in `foundry.toml`. From the repository root with dependencies and the
pinned forge-std installed:

```sh
foundryup --install v1.8.6
forge --version # must report 1.8.6
forge test --match-path 'test/forge/BitmapNonceDelegate*.t.sol' -vv
forge test --match-contract BitmapNonceDelegateReplayGasTest -vv
FOUNDRY_PROFILE=bitmap_coverage forge coverage \
  --match-path 'test/forge/BitmapNonceDelegate*.t.sol' \
  --report summary --report lcov --report-file /tmp/bitmap-nonce-coverage.lcov
```

To reproduce execution tables, run the replay-gas command above and read the
`ROW` lines by scenario, stride, cap, and batch size. `foundry.toml` sets
`isolate = false`, which the warm-context fixture requires. Do not
benchmark coverage-instrumented bytecode: the coverage profile disables
optimization and compiler restrictions, targets delegate sources to avoid
unsupported archived pragmas, and runs in an EIP-7702-capable EVM. Rebuild with
the default profile before measuring gas.

To reproduce receipts, compile with the settings above and run a disposable
`anvil --port 18547 --hardfork prague` node. From the repository root:

```sh
BENCHMARK_GAS_RESERVE=42000 node benchmarks/BitmapNonceDelegateNonceGroupingReceipts.cjs \
  /absolute/path/to/repository \
  > /tmp/bitmap-gas-receipts.json
```

It requires ethers v6 (this snapshot used 6.17.0) and compiled delegate and
MockERC20 artifacts. It checks compiler settings and rejects unoptimized coverage
artifacts. It installs delegation and fixture balances through local Anvil RPC; use
a disposable node.
