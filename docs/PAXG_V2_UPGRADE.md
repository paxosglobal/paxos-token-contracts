# PAXG V2 Upgrade

## Overview

PAXG (Paxos Gold) is upgraded from its original Solidity 0.4.24 implementation to the PaxosTokenV2 architecture shared with PYUSD, USDP, and USDG. The new `PAXG` contract inherits `PaxosTokenV2` directly, with two PAXG-specific additions:

1. **Storage migration** — one-time assembly to move `paused` and zero mislabeled deprecated slots
2. **Frozen mapping override** — `_isAddrFrozen`, `_freeze`, `_unfreeze` read/write from slot 7 instead of BaseStorage's slot 6

## Why Storage Migration Is Needed

The deployed PAXG (0.4.24) has a different storage layout from BaseStorage in slots 4-8:

```
Slot  BaseStorage (PYUSD/USDP)               Deployed PAXG
────  ──────────────────────────────────────  ─────────────────────────────────────
0-3   identical                               identical
4     ownerDeprecated + paused [PACKED]        owner [ALONE]
5     assetProtectionRoleDeprecated            proposedOwner + paused [PACKED]
6     mapping frozen                           assetProtectionRole
7     supplyControllerDeprecated               mapping frozen
8     proposedOwnerDeprecated                  supplyController
9-12  identical                                identical
13    supplyControl                            feeRate
14    gap                                      feeController
15    gap                                      feeRecipient
```

The only active field V2 reads from a different slot is `paused` (slot 5 → slot 4). The `frozen` mapping can't be moved easily (mapping data lives at `keccak256(key, slot)` — 285 frozen addresses on mainnet would need individual re-writes). All other differing slots contain deprecated values that V2 never reads.

## What the Migration Does

Six `sstore` operations:

1. **Slot 4**: Pack `paused` (read from slot 5 byte 20) into slot 4 byte 20 alongside the owner address (already at slot 4 bytes 0-19 in both layouts). This is the only active field that V2 reads from a different slot.
2. **Slot 5**: Zero. Public getter `assetProtectionRoleDeprecated()` would return the old `proposedOwner`.
3. **Slot 6**: Zero. No public getter (mapping base), but holds stale `assetProtectionRole` address.
4. **Slot 8**: Zero. Public getter `proposedOwnerDeprecated()` would return the old `supplyController`.
5. **Slot 14**: Zero. In BaseStorage's gap, holds stale `feeController` address.
6. **Slot 15**: Zero. In BaseStorage's gap, holds stale `feeRecipient` address.

Unlike the PYUSD upgrade (where deprecated slots held correctly-labeled stale values), PAXG's slot shuffling means deprecated slots would hold values from different V1 fields. All such mislabeled slots are zeroed.

**Slots left as-is:**
- **Slot 4 low bytes**: Owner address (same position in both layouts).
- **Slot 7**: Still the active frozen mapping base — PAXG reads/writes frozen data at `keccak256(addr, 7)` via overrides. Already 0x0 (Solidity never writes to mapping base slots).
- **Slots 9-12**: Deprecated values at matching positions in both layouts.
- **Slot 13**: Old `feeRate` — gets overwritten by `setSupplyControl()` after upgrade.

## Upgrade Execution Order

The upgrade is a single `upgradeToAndCall` transaction:

```
proxy.upgradeToAndCall(newImpl, initializeData)
│
├── 1. Proxy updates implementation pointer
│      (EIP-1967 hashed slot — does not touch token storage)
│
└── 2. Proxy delegatecalls PaxosTokenV2.initialize(...)
       │
       ├── 2a. Captures wasInitializedV1 = true, pastVersion = 0
       │        (slot 0 is true from V1 init; OZ version is 0 because V1
       │         didn't use OZ Initializable)
       │
       ├── 2b. PaxosTokenV2._initialize() [reinitializer(2)]
       │        ├── _initializeV1(): skipped (initializedV1 at slot 0 is already true)
       │        └── _initializeV2(): sets up AccessControl roles
       │            (writes to OZ ERC-7201 namespaced storage at hashed slots,
       │             NOT sequential slots 4-8 — old PAXG values still intact)
       │
       └── 2c. _onUpgradeInitialize() — called because wasInitializedV1 && pastVersion == 0
                └── PAXG._migratePAXGStorage()
                     ├── Reads paused from slot 5 byte 20
                     ├── Packs into slot 4 alongside owner
                     └── Zeroes mislabeled deprecated slots (5, 6, 8, 14, 15)
```

**Why this ordering is safe:** Step 2b writes only to ERC-7201 namespaced storage (hashed slot locations like `0xf0c57e16...`), never to sequential slots 4-8. So when step 2c reads from slots 4 and 5, it still sees the original PAXG values.

**Proxy storage is separate:** The proxy's own storage (implementation address, admin) lives at EIP-1967 hashed slots, completely independent of the token's sequential storage.

## After `upgradeToAndCall`

```
3. Deploy SupplyControl contract
4. Call token.setSupplyControl(supplyControlAddress)
      (writes to slot 13 — the old feeRate value gets overwritten)
```

## Fresh Deploy (New Chains)

On chains where PAXG hasn't been deployed before, `initializedV1` is false so the `wasInitializedV1 && pastVersion == 0` guard fails and `_onUpgradeInitialize()` is not called. The frozen mapping override stays active on all chains — on fresh deploys slot 7 starts empty, so reads/writes to slot 7 are self-consistent. This keeps the contract identical across EVM chains.

## Frozen Mapping Override

The `frozen` mapping data lives at `keccak256(address, 7)` in the deployed proxy's storage. BaseStorage declares `frozen` at slot 6, which would look for data at `keccak256(address, 6)` — a completely different set of storage locations.

PAXG overrides three virtual functions to use slot 7:
- `_isAddrFrozen(address)` — reads via `sload(keccak256(addr, 7))`
- `_freeze(address)` — writes via `sstore(keccak256(addr, 7), 1)`
- `_unfreeze(address)` — writes via `sstore(keccak256(addr, 7), 0)`

All code paths in PaxosTokenV2 that check or modify frozen state go through these three functions. There is no direct `frozen[addr]` access outside of them.

## Changes to PaxosTokenV2

Three functions changed from `private` to `internal virtual` to allow PAXG's overrides:
- `_freeze(address)`
- `_unfreeze(address)`
- `_isAddrFrozen(address)` (added `virtual`)

Additionally, `initialize()` now includes an `_onUpgradeInitialize()` hook — a virtual no-op called only when upgrading from a V1 contract (`initializedV1` was already true). PAXG overrides this hook to run `_migratePAXGStorage()`. The `initialize` function itself is non-virtual, so the `reinitializer(2)` guard cannot be bypassed.

These changes do not affect behavior for existing tokens (PYUSD, USDP, USDG) — they only enable overriding.

## Re-initialization Safety

`PaxosTokenV2.initialize()` uses OpenZeppelin's `reinitializer(2)`. On the deployed PAXG proxy:
- The original `bool initialized` at slot 0 is `true`, but OZ's `Initializable` uses a separate ERC-7201 namespaced storage slot (`0xf0c57e16...`), so it sees version 0
- `reinitializer(2)` sets the version to 2 and allows initialization
- Any subsequent call to `initialize` reverts because the version is already >= 2
- This also prevents `_migratePAXGStorage()` from running twice

## Test Coverage

PAXG-specific tests:
- `test/paxg/UpgradeToV2Test.js` — upgrade from V1 with state preservation (paused/unpaused), frozen through migration, fresh deploy, reinitializer guard
- `test/paxg/StorageLayoutTest.js` — verifies paused migrated to slot 4, mislabeled slots (5, 6, 8, 14, 15) zeroed, slot 7 untouched
- `test/StablecoinTest.js` (PAXG block) — name/symbol/decimals, frozen override slot verification

All other ERC20/pause/freeze/supply behavior is covered by the existing PaxosTokenV2 test suite, since PAXG inherits the same logic.
