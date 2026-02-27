# On-Chain Rewards: Efficient Claimable Rewards

## Goals

### Business Goals

**Rewards 2.0** modernizes distribution partner reward distribution with three core improvements:

- **Transparent**: Daily on-chain reward calculation replaces 30-day delayed reconciliation, providing real-time visibility into reward accumulation and distribution.

- **Approachable**: Simplified reward model focuses on custody rewards with on-chain calculation, while "last distributor" rewards handle off-network activity. This reduces complexity for the 96% of rewards handled on-chain.

- **Buildable**: On-chain reward infrastructure enables partners to build efficient flows for distributing rewards to users or integrating with DeFi protocols.

### Technical Implementation Goals

**The Claimable Rewards Model** achieves these business goals through:

- **Efficient**: O(1) gas costs independent of scale - gas fees don't increase with number of accounts. Partners choose when to claim: frequently for immediacy, or accumulate to save gas fees.

- **Fully Reserved**: All reward accumulation and payout flows require funded claim source - no unbacked liabilities.

- **Compliant**: Partners earn and claim rewards for marketing and incentive programs. End-users do not passively earn interest, maintaining regulatory compliance.

## Flows

### Payout Groups

A partner create a Payout Group on-chain. Payout Groups are groups of addresses on a single blockchain that accumulate rewards together.

Partners are distribution partners that Paxos can distribute rewards to. For regulatory compliance, these are not end-users, but rather entities that run marketing or incentive programs.

Payout Groups can have:
- A **Claimer Address** that is the authority to trigger reward claims. Required.
- A **Destination Address** for where reward claims go. Defaults to claimer address.
- A **Manager Address** that can change these settings and claim to custom destinations. Optional.

Payout groups have integer ids (uint32) for efficient storage reference.

#### Interface

```solidity
// PAYOUT_GROUP_REGISTRAR_ROLE
createPayoutGroup(multId, claimer) => id
deletePayoutGroup(payoutGroupId) // requires claiming to the configured destination
adminSetPayoutGroupMultiplier(payoutGroupId, multiplierId) // forces claim first

// PAYOUT_GROUP_ADMIN_ROLE
adminSetPayoutGroupClaimer(payoutGroupId, address)
adminSetPayoutGroupManager(payoutGroupId, address)
adminSetPayoutGroupDestination(payoutGroupId, address)

// Manager (self-service by payout group manager)
setPayoutGroupClaimer(payoutGroupId, address)
setPayoutGroupManager(payoutGroupId, address)
setPayoutGroupDestination(payoutGroupId, address)
```

### Registering Addresses

Addresses that hold USDG are registered transparently on-chain to a given Payout Group.

There are **three registration methods** to support different use cases:

1. **Registrar Registration** (Primary Method): Paxos (the issuer) registers addresses using admin functionality, based on first-come-first-serve. Paxos automatically registers addresses after they first have balance.

2. **Signature-Based Registration**: Account holders provide EIP-712 signatures to register themselves. Requires `setPartnerSignedRegistrationsEnabled(true)`.

3. **Propose-Accept Registration** (New - for Smart Contracts): Two-step flow for smart contract addresses that cannot provide EIP-712 signatures (e.g., liquidity pools, lending pools in DeFi custody scenarios). The claimer/manager/registrar proposes registration, then the smart contract accepts by executing a transaction.

#### Interface

```solidity
// PAYOUT_GROUP_REGISTRAR_ROLE
registrarRegisterRewardAddress(payoutGroupId, address)
registrarUnregisterRewardAddress(payoutGroupId, address) // REGISTRAR role only, includes claiming
registrarRegisterRewardAddressBatch(payoutGroupId, address[])
registrarUnregisterRewardAddressBatch(payoutGroupId, address[]) // includes claiming

// Signature-Based Registration (requires partner-signed registrations enabled)
registerRewardAddress(payoutGroupId, account, nonce, deadline, v, r, s) // account signs EIP-712 message
unregisterRewardAddress(payoutGroupId, account) // callable by claimer OR manager, forces claim

// Propose-Accept Registration (for smart contracts that can't sign)
proposeRegisterRewardAddress(payoutGroupId, account) // callable by claimer, manager, OR registrar
acceptRegisterRewardAddress(payoutGroupId) // callable by the proposed account only
cancelRegistrationProposal(account) // callable by proposer only
getPendingRegistration(account) => (payoutGroupId, proposer) // view pending proposal

// PAYOUT_GROUP_ADMIN_ROLE
setPartnerSignedRegistrationsEnabled(bool) // enable/disable signature-based registration
```

#### Registration Constraints

All registration methods enforce the following constraints:

1. **Frozen Accounts Cannot Be Registered**: Addresses that are frozen (via the Asset Protection role) cannot be registered to payout groups. This ensures compliance with freeze semantics where frozen addresses are excluded from all token operations and participation.
   - Registration attempts for frozen accounts will revert with `AddressFrozen` error
   - This applies to all registration paths: registrar, signature-based, and propose-accept flows
   - Accounts can be registered after being unfrozen

2. **Claim Source Protection**: The claim source address cannot be registered to any payout group to prevent circular reward distribution

3. **Single Payout Group**: An address can only be registered to one active payout group at a time (must unregister before registering to a different group)

**EIP-712 Signature Format** for `registerRewardAddress`:
```solidity
struct RegisterRewardAddress {
    address account;
    uint32 payoutGroupId;
    bytes32 nonce;
    uint256 deadline;
}
```

**Propose-Accept Flow** for smart contracts:
1. **Propose**: Authorized party (claimer/manager/registrar) calls `proposeRegisterRewardAddress(payoutGroupId, smartContractAddress)`
   - Creates a pending registration proposal
   - Only one pending proposal per address (new proposals overwrite old ones)
2. **Accept**: Smart contract calls `acceptRegisterRewardAddress(payoutGroupId)` to prove ownership
   - Must match the proposed payout group ID
   - Completes registration just like signature-based registration
3. **Cancel**: Proposer can cancel via `cancelRegistrationProposal(account)` before acceptance

**Use Case**: This flow enables DeFi custody scenarios where a liquidity pool or lending pool (smart contract) holds USDG and should earn rewards, but cannot provide an ECDSA signature because it has no private key.

### Claiming Rewards

**Scope**: All claims are for the entire available rewards amount for the entire payout group, or for one or more specific addresses.
- `claimForAddresses` can claim for a single address or multiple addresses (batch).
- `claimAll` does not update per-account state, achieving gas cost that is independent of the number of addresses [O(1)].

**Authority**: There are three authorities that can claim:
- **Claims by the payout group claimer** go to the configured destination address. This facilitates a separation of concerns between choosing a safe destination, and the day-to-day operation of claiming.
- **Claims by the payout group manager** go to an address specified as part of the claim. This facilitates claiming patterns that use different destinations for claims from different wallets.
- **Claims by Paxos super roles** provide operational control across all payout groups.

#### Interface

```solidity
// Payout Group Claimer (to configured destination) OR CLAIM_OPERATOR_ROLE role
claimAll(payoutGroupId, upToCheckpoint)
claimForAddresses(payoutGroupId, accounts[], upToCheckpoint)

// Payout Group Manager (specifies destination) OR CLAIM_ADMIN_ROLE role
claimAllTo(payoutGroupId, destination, upToCheckpoint)
claimForAddressesTo(payoutGroupId, accounts[], destination, upToCheckpoint)

// Role Constants
CLAIM_OPERATOR_ROLE() // Can call claimer functions for any payout group
CLAIM_ADMIN_ROLE() // Can call manager functions for any payout group
```

**Parameters:**
- `payoutGroupId`: The payout group to claim from
- `accounts[]`: Array of account addresses to claim for (can be a single address)
- `destination`: Address to send claimed rewards to (manager functions only)
- `upToCheckpoint`: Boolean flag:
  - `false`: Claim rewards up to current time ("now")
  - `true`: Claim rewards up to last checkpoint time

**Access Control Details:**
- `claimAll/claimForAddresses`: Callable by payout group's claimer OR anyone with `CLAIM_OPERATOR_ROLE` role
- `claimAllTo/claimForAddressesTo`: Callable by payout group's manager OR anyone with `CLAIM_ADMIN_ROLE` role

## Reward Accumulation

Partners earn rewards at **Daily Earn Events** at a fixed UTC time every 24h.

To facilitate this Paxos operates multipliers with scheduled updates. Each Payout Group has a multiplierId associating it with the yield of that multiplier - which are separate for different entities in different jurisdictions and with different management fees.

A multiplier has a daily rate and a source address for the earned rewards. All multipliers use the same schedule.

### Multiplier Management Flows

Finance will be able to set a new rate on a daily basis. At earn time the multiplier increases by:

```
multiplier = multiplier * rate
```

Additionally, finance can schedule a multiplier rate change where they specify a specific period time that first uses that new rate. They can only enqueue one rate change, and calling schedule again will replace the previously-scheduled change. This allows the one scheduled change to fit nicely in one storage slot.

By using a rate instead of a next multiplier, less information is needed on a daily basis. Multiplier growth is computed automatically during transfers and claims based on the rate and time elapsed.
- Transfer cost increases slightly if many periods have elapsed since the last balance-changing operation.
- If we use EXP, `rate**days` costs 50 gas for the number of bytes in the exponent (days), so if we catch up every 255 days there is no cost increase.
- However, we use a for loop with `mult=mult*rate` in each iteration for efficient calculation.

#### Interface

```solidity
// MULT_ADMIN_ROLE
createMultiplier(rate) => id // creates multiplier with specified APR (claim source set globally)
setClaimSource(address) // sets global claim source for ALL multipliers + marks address as reward source
setRateBounds(minRate, maxRate) // limits MULT_RATE_ROLE globally
setRewardsPeriod(period) // set compounding period (e.g., 86400 for 1 day)
setReferenceTime(timestamp) // realign period boundaries to specific time (e.g., midnight UTC)
deleteMultiplier(multiplierId) // remove multiplier from active list (requires zero balance)

// MULT_RATE_ROLE
scheduleNextMultRate(multiplierId, rate, atTime) // schedule future rate change (atTime = timestamp, not period)
setMultiplierRate(multiplierId, rate) // update APR immediately (checkpoints multiplier first)

// Role Constants
MULT_ADMIN_ROLE() // Can manage multipliers and reward configuration
MULT_RATE_ROLE() // Can set multiplier rates
```

**Note**: There is a single global claim source shared by all multipliers. It must be set via `setClaimSource()` or during contract initialization.

**Claim Source:**
The claim source address holds tokens for reward distribution. It is tracked as a normal account in the system for balance purposes. The claim source CANNOT be registered to a payout group - all reward accumulation for the claim source is tracked off-chain to avoid circular accounting.

## View Functions

Strategy on what deserves a view function and what doesn't:
- We want this to be buildable.
- We don't want to tie ourselves down too much.
- We can't easily change the data model later anyway.

Generally they return uint256 for numbers, even if the storage size is significantly less.

### View Functions

**Account Views:**
- `balanceOf(address)` - ERC20 balance (excludes unclaimed rewards)
- `availableRewardsOf(address)` - Available rewards for account
- `payoutGroupIdOf(address)` - Which payout group the account belongs to

**Payout Group Views:**
- `getPayoutGroupIdByClaimer(address) => id` - Reverse lookup from claimer to group
- `getPayoutGroupAvailableRewards(id)` - Total claimable rewards for all accounts in group
- `getPayoutGroupMultId(id)` - Which multiplier the group uses
- `getPayoutGroupClaimer(id)` - Authorized claimer address
- `getPayoutGroupManager(id)` - Authorized manager address
- `getPayoutGroupDestination(id)` - Default claim destination
- `getPayoutGroupBalance(id)` - Balance for this payout group
- `getPendingRegistration(address) => (payoutGroupId, proposer)` - View pending registration proposal

**Payout Group Convenience Wrappers** (eliminate two-step lookups):
- `getPayoutGroupCurrentRate(id)` - Current rate for payout group's multiplier
- `getPayoutGroupActiveMultiplier(id)` - Active multiplier for payout group
- `getPayoutGroupNextRate(id)` - Scheduled future rate for payout group's multiplier
- `getPayoutGroupNextRateTime(id)` - Timestamp when next rate takes effect

**Multiplier Views:**
- `getActiveMultiplier(multiplierId)` - Current multiplier value with compounding (12 decimals)
- `getCurrentRate(multiplierId)` - Current rate for multiplier (12 decimals)
- `getNextRate(multiplierId)` - Scheduled future rate for multiplier (12 decimals, 0 if none)
- `getNextRateTime(multiplierId)` returns uint256 - Timestamp when scheduled rate takes effect (0 if none, stored as uint40 internally)
- `getMinRate()` - Minimum allowed APR for rate changes (12 decimals)
- `getMaxRate()` - Maximum allowed APR for rate changes (12 decimals)

**Global Views:**
- `getRewardPeriod()` returns uint32 - Reward compounding period in seconds (e.g., 86400 for daily)
- `getClaimSource()` - Address holding tokens for reward distribution
- `getReferenceTime()` returns uint40 - Reference timestamp for period calculation
- `getReferencePeriodNum()` returns uint24 - Period number at reference time
- `getCurrentPeriodNum()` returns uint24 - Current period number

## Reward Funding

Interest from reserve investments is swept into a Paxos Platform account that withdraws (mints) USDG to the reward source address configured on-chain. The current plan is for all multipliers to share a single source representing PTE funds.

The reward source address will be "off-platform" with respect to the "platform" ledgering system. We will alert on when that balance goes below a threshold.

Available rewards are computed in a way that doesn't require an on-chain transaction to change its value.

The rewards earned on available rewards will go to the customer, who is the rightful owner of the USDG claim for those funds (compound yield).

The total supply tracks the sum of balances and available rewards. Claiming transfers rewards from the claim source to destination addresses.

### Compound Yield vs Simple Yield

Automatic compound yield is much better for the user to help with gas fee management, and treat the available rewards as the customer's funds.

If we did want to do simple yield for all partners, instead of compound yield, then we just would pay the yield on Available Rewards (the global total) to the issuer (paid to the rewards source address ideally), and when computing wallet or payout group yield we'd use the balance instead of balance+availableRewards as the base for applying multiplier increases. So, this design is quite robust to that change.

If we wanted to support compound yield for some partners and simple yield for others, you could imagine an option [This is an even worse idea; no one wants to give up auto compounding] we would have to track an additional global of compoundAvailableRewards vs SimpleAvailableRewards to figure out the yield to corporate/issuer correctly. This would have minor transfer cost implications, but would be also a small change to the current design.

## Diamond Cuts

The USDG contract is already pretty "full" in terms of compiled bytes used relative to the maximum (~24kb). So, the EVM implementation for claimable rewards will need a way to put its logic in one more new smart contracts.

Delegatecall allows "proxy" patterns where the storage lives in a calling contract while the logic executed on that storage is drawn from a target contract. USDG already uses a proxy for upgradeability, which delegatecall's to single implementation contract.

A Diamond Cut Proxy is a solution to scaling a smart contract's logic beyond what can fit in a single implementation contract. It is simply a proxy that includes logic in its fallback function about what contract to delegatecall to, depending on which method is being called. The "Diamond Cut" naming calls the different logic contracts "facets" (like the faces of a diamond that was cut).

### Facet Layout

USDG with On-chain rewards uses a 6-facet diamond architecture with a shared base contract. Contract sizes measured using `npx hardhat size-contracts` with optimizer enabled (200 runs):

**Main Contract: PaxosTokenClaimableRewards** (17.282 KB)
- Core ERC20 (transfer, balanceOf, approve, increaseApproval, decreaseApproval)
- Reward accumulation during transfers
- Diamond proxy infrastructure (method→facet registry via `setFacet` and `batchSetFacet`)
- Supply control integration (mint/burn/wipe remain in main contract)

**PayoutGroupFacet** (20.434 KB)
- Payout group management (10 functions):
  - Create, delete, and configure payout groups
  - Admin and manager role-based configuration
- Account registration (9 functions):
  - Registrar registration (batch support)
  - Signature-based registration (EIP-712)
  - Propose-accept registration (for smart contracts)
- Payout group views (16 functions, including getPendingRegistration)

**TokenExtensionsFacet** (16.500 KB)
- EIP-2612 (Permit): `permit()`, `nonces()`
- EIP-3009 (Transfer with Authorization): `transferWithAuthorization()`, `receiveWithAuthorization()`, `cancelAuthorization()`
- EIP-712 signature verification
- Uses `_transfer()` from ClaimableRewardsBase (no callbacks)

**MultiplierMgmtFacet** (13.894 KB)
- Multiplier management (7 functions):
  - `createMultiplier()`, `setMultiplierRate()`
  - `scheduleNextMultRate()`, `getActiveMultiplier()`
- Multiplier-specific views (12 functions)
- Balance and reward queries, rate management views

**ClaimableRewardsFacet** (12.781 KB)
- 4 claim functions for reward distribution:
  - Claimer functions: `claimAll()`, `claimForAddresses()`
  - Manager functions: `claimAllTo()`, `claimForAddressesTo()`
- O(1) claim operations with LastMultiplier model

**TokenAdminFacet** (11.606 KB)
- Pause/unpause functionality
- Supply control configuration (`setSupplyControl()`)
- Asset protection (freeze/unfreeze)

**ClaimableRewardsBase** (5.034 KB)
- Shared business logic base contract
- Helper functions for multiplier existence, projected earnings, authorization checks
- Inherited by all facets for common functionality

**Total Deployed Footprint:** 97.531 KB across 7 contracts
**Largest Individual Contract:** 20.434 KB (PayoutGroupFacet, well under 24KB limit)
**Balanced Facet Sizes:** All facets in 5-22 KB range for maintainability

All facets share the same storage layout through `ClaimableRewardsStorageV3` inheritance, enabling independent upgrades while maintaining shared state consistency.

## Storage Model and Gas Optimization

The EVM uses 32 byte (32B) slot sizes, and our current balances are stored in a whole slot (256bit integers). The highest gas cost within a contract is for initializing, writing, and reading storage respectively (and then event logging). Transfers typically cost about 50k gas today. We want to fit new storage variables into the existing balances word by repurposing 19+ bytes of upper register storage (to save 15-30K gas cost on transfer vs two slots, which is 25-50%, or four slots if we implemented this naively).

**Reminder**: the number of decimal digits for a given set of n bytes is `log_base_10(256^n)`. The max value is `256^n / 10^d` where d is the number of decimal places.

### Solution: Shares-Based Reward Model

**Token Account Data (TokenAccountData):**
- Balance: 8B at 6 decimals, max 18 Trillion USDG
- Shares: 8B at 6 decimals, max 18 Trillion (shares * multiplier / MULT_BASE = balance + rewards)
- PayoutGroupId: 3B at 0 decimals, max 16 million payout groups
- PeriodNum: 3B at 0 decimals, max 16 million periods (tracks last update time)
- 10B available for future use

**Flag Storage (separate mapping for gas optimization):**
- frozen: bool mapping for frozen addresses (asset protection)

**Benefits:**
- Supports unlimited multiplier updates and continuous compounding
- O(1) claimAll operations via period-based detection
- Automatic compound yield through shares model

### Reward Equation

The shares-based model tracks rewards implicitly through shares that grow in value as the multiplier increases:

**Core Formula:**
```
totalValue = shares * multiplier / MULT_BASE
rewards = totalValue - balance
```

Where:
- `shares`: Account's share amount (6 decimals)
- `multiplier`: Current multiplier value (12 decimals)
- `MULT_BASE`: 1e12 (constant for 12 decimal precision)
- `balance`: Account's ERC20 balance (6 decimals)

**On balance change** (transfer, mint, burn):
```
// Calculate current total value from shares
totalValue = shares * multiplier / MULT_BASE
unclaimedRewards = max(0, totalValue - oldBalance)

// Preserve unclaimed rewards with new balance
newShares = (newBalance + unclaimedRewards) * MULT_BASE / multiplier
```

**On claim**:
```
// Transfer rewards to destination
rewards = (shares * multiplier / MULT_BASE) - balance

// Reset shares to balance at current multiplier
newShares = balance * MULT_BASE / multiplier
```

### Payout Level Claims

A "claimAll" operation achieves O(1) gas complexity by using period-based detection instead of updating individual accounts:

1. **ClaimAll records**: Sets `PayoutGroup.lastClaimAllPeriodNum` to the current period and `PayoutGroup.lastClaimAllBaseMultiplier` to current multiplier
2. **Individual checkpointing**: When an account has a balance-changing event (transfer, claim, etc.), it detects if a claimAll occurred:
   ```
   if (wallet.periodNum <= payoutGroup.lastClaimAllPeriodNum) {
       // ClaimAll happened since last update - recalculate shares from lastClaimAllBaseMultiplier
       shares = balance * MULT_BASE / lastClaimAllBaseMultiplier
   }
   ```
3. **Lazy synchronization**: Accounts are only updated when they interact with the system, achieving O(1) claimAll cost

This model ensures rewards are never double-claimed while maintaining constant gas cost for claimAll operations regardless of group size.

## Storage Layout

### Token Account Data

```solidity
// Data touched in transfers between token accounts (32-byte slot)
struct TokenAccountData {
    uint64 balance;                           // 8 bytes (up to ~18 trillion at 6 decimals)
    uint64 shares;                            // 8 bytes (up to 18 trillion at 6 decimals)
                                              // shares * multiplier represents total value
    uint16 payoutGroupId;                     // 2 bytes (max 65k payout groups, 0 = no payout group)
    uint32 periodNum;                         // 4 bytes - period when wallet was last updated
    // Total: 22 bytes (10 bytes unused in 32-byte slot)
}
mapping(address => TokenAccountData) internal balanceData;

// Frozen status for asset protection
mapping(address => bool) internal frozen;
```

### Payout Group Data

```solidity
// Payout group data with shares tracking (32-byte slot)
struct PayoutGroupData {
    uint64 balance;                           // 8 bytes (up to ~18 trillion at 6 decimals)
    uint64 shares;                            // 8 bytes (up to 18 trillion at 6 decimals)
                                              // (shares * multiplier represents total value)
    uint16 multiplierId;                      // 2 bytes (max 65k multipliers)
    uint48 lastClaimAllMultiplier;            // 6 bytes (12 decimals, max 281x growth)
    uint16 cachedCheckpointNum;               // 2 bytes - which checkpoint period this cache is for
                                              // Cache Invariant: if cachedCheckpointNum == current checkpoint,
                                              // then cachedCheckpointAvailableRewards is fresh
    uint48 cachedCheckpointAvailableRewards;  // 6 bytes - aggregate checkpoint rewards for all accounts
                                              // (2 decimals, max 2.8T)
    // Total: 32 bytes (perfect slot fit)
}
mapping(uint256 => PayoutGroupData) internal payoutData;

// Payout group identity mappings
mapping(uint256 => address) internal payoutIdToClaimer;     // Forward lookup (ID → claimer)
mapping(uint256 => address) internal payoutIdToManager;     // Manager address per group
mapping(uint256 => address) internal payoutIdToDestination; // Destination address per group

uint16 internal nextPayoutId;  // Next ID to assign (starts at 1, 0 = no payout group)

// Pending Registration Proposal - for smart contract address registration
struct PendingRegistration {
    uint32 payoutGroupId;        // 4 bytes - payout group ID
    address proposer;            // 20 bytes - who proposed this registration
    // Total: 24 bytes (8 bytes unused)
}
mapping(address => PendingRegistration) internal _pendingRegistrations;
```

### Multiplier Data

```solidity
// Multiplier configuration data (31-byte slot)
struct MultiplierData {
    uint40 beforeRate;                   // 5 bytes - APR rate (fraction w/o 1, 10 decimals)
    uint40 afterRate;                    // 5 bytes - scheduled next rate (10 decimals)
    uint40 switchTime;                   // 5 bytes - timestamp when rate switches
                                         // (type(uint40).max = no scheduled rate)
    uint48 switchTimeMultiplier;         // 6 bytes - multiplier at switchTime (12 decimals)
    uint48 cachedCheckpointMultiplier;   // 6 bytes - multiplier at most recent checkpoint (12 decimals)
    uint16 cachedCheckpointNum;          // 2 bytes - checkpoint number when cached
    uint16 nextActiveId;                 // 2 bytes - next active multiplier ID (0 = end of list)
    // Total: 31 bytes - fits in 32-byte slot with 1 byte remaining
}
mapping(uint256 => MultiplierData) internal multipliers;  // Mapping indexed by multiplierId

// Linked list tracking for deletion support
uint16 internal nextMultiplierId;       // Next ID to assign (starts at 1, 0 = invalid)
uint16 internal firstActiveId;          // Head of linked list (0 = empty list)
uint16 internal activeMultiplierCount;  // Count of active multipliers
```

### Multiplier Payout Group Count

```solidity
// Payout group count per multiplier for O(1) deletion safety
mapping(uint256 => uint256) internal multiplierPayoutGroupCount;
```

### Global Reward Settings

```solidity
// Global transfer settings (HOT PATH - loaded on every transfer)
// Packed in single slot for gas optimization
struct GlobalTransferSettings {
    uint40 referenceTime;        // 5 bytes - timestamp for period calculation
    uint32 maturityPeriod;       // 4 bytes - period duration in seconds (e.g., 86400 for daily)
    uint32 checkpointPeriod;     // 4 bytes - checkpoint period in seconds
    bool partnerSignedRegistrationsEnabled;  // 1 byte - signature-based registration feature flag
    bytes6 __gap_remaining;      // 6 bytes - reserved for future use
    bool paused;                 // 1 byte - pause flag
    // Total: 20 bytes in slot 4, 12 bytes remaining
}
GlobalTransferSettings public globalTransferSettings;

// Admin config settings (COLD PATH - admin operations only)
struct AdminConfigSettings {
    address claimSource;     // 20 bytes - single global claim source (funds all claims)
    uint40 minRate;          // 5 bytes, 10 decimals - Global minimum allowed APR
    uint40 maxRate;          // 5 bytes, 10 decimals - Global maximum allowed APR
    // Total: 30 bytes used, 2 bytes remaining in 32-byte slot
}
AdminConfigSettings internal adminConfig;
```

## Implementation Logic

Strategically, due to large slot size and high slot read+write costs, gas efficient smart contract code on the EVM treats reading and writing slots similar to reading and writing to a database over the network:
- Read whole slot structs and pass them around as structs (typically don't denormalize the fields)
- Only read slots if you need them
- Only write if you need them, and only once

Notably double reading the same struct is not a huge cost (100 vs 2100) but double writes are significant (extra 2900 vs 5000 to write once).

Checked arithmetic is more expensive, but not enough to use unchecked in most cases due to complexity of proving that a given arithmetic is safe.

All mappings from integer use uint256 (full slot) [as in `mapping(uint256 => xxx)`] as the key so that they are compatible with larger keys in the future, since there is no extra cost to hash the larger key (cost of keccak256 is by count of full slots) and casting is free. More importantly, the hash of a smaller integer with the same value is different because the hash encodes the slot right after the key in a fully-packed manner:

```solidity
map_hash = keccak256(abi.encodePacked(key, slot)) // <key_bytes><slot_bytes>
```

### Storage Types

- **Balance/Amount/Shares (USDG)**: uint64, 6 decimals, 8 bytes, max 18 Trillion
- **Multiplier**: uint48, 12 decimals, 6 bytes, max 281x growth
- **Rate**: uint40, 10 decimals, 5 bytes, max 1,099,511x growth per period
- **Timestamp (DateTime)**: uint40, 5 bytes, max year 36,000 AD
- **Duration/RewardPeriod**: uint32, 4 bytes in seconds, max 136 years
- **Multiplier ID**: uint16, 2 bytes, supports 65k ids
- **Payout Group ID**: uint16, 2 bytes, supports 65k ids
- **Checkpoint Number**: uint16, 2 bytes, max 65k checkpoints
- **Cached Checkpoint Rewards**: uint48, 5 or 2 decimals depending on context, 6 bytes
- **Flags**: uint8, 1 byte (bit-packed for 8 flag bits)
- **Address**: address, 20 bytes

### Interface Types

Use the same decimals, but use uint256 for balances/amounts, and for multipliers and rates. For ids, timestamps, durations use uint64 with the same decimals as storage types.

## Gas Performance Reference Data

The following gas measurements are from the current implementation and serve as reference for optimization tracking.

### Transfer Function Performance

Measured with `benchmarks/GasBenchmarkTest.js` on actual implementation:

- **No payout groups**: 50,587 gas (baseline unregistered transfer)
- **Zero value transfer**: 37,858 gas (early return optimization)
- **Same payout group**: 59,076 gas (optimized via aggregation skip)
- **Different payout groups (same multiplier)**: 72,161 gas (optimized same-multiplier path)
- **Different payout groups (different multiplier)**: 74,161 gas (full cross-jurisdiction functionality)

**Note**: Compound interest calculation (using binary exponentiation) adds ~500-800 gas vs linear approximation, but provides mathematically correct results. The implementation uses `unchecked` math with explicit 2^128 overflow checks, saving ~550-1,040 gas per compound interest calculation while maintaining safety.

### SLOAD/SSTORE Optimization Achievement (100% SSTORE Efficiency!)

With manual memory-pattern optimization (viaIR disabled), we've achieved **100% SSTORE efficiency** - every storage write goes to a unique slot with zero wasted gas:

- **No payout**: 7 unique SLOAD, **2 unique SSTORE** (100% efficient)
- **Same payout**: 10 unique SLOAD, **2 unique SSTORE** (100% efficient - skips aggregation updates)
- **Different payout, same multiplier**: 11 unique SLOAD, **4 unique SSTORE** (100% efficient - skips multiplier aggregations)
- **Different multiplier**: 14 unique SLOAD, **6 unique SSTORE** (100% efficient - full cross-jurisdiction)

**Key Optimization**: Both `_updatePayoutGroupBals()` and `_updateMultiplierBals()` use single-write memory pattern - load struct to memory, modify all fields, write once. This eliminates repeat SSTOREs that previously wasted ~10-20K gas per aggregation update.

### Storage Operation Breakdown

Detailed EVM-level storage operation counts by transfer scenario:

| Scenario | Total Gas | Unique SLOAD | Total SLOAD | Unique SSTORE | Total SSTORE | SSTORE Efficiency |
|----------|-----------|--------------|-------------|---------------|---------------|--------------|-------------------|
| **No Payout Groups** | 50,587 | 7 | 9 | 2 | 2 | **100%** |
| **Same Payout Group** | 59,076 | 9 | 13 | 2 | 2 | **100%** |
| **Diff Payout, Same Mult** | 72,161 | 10 | 18 | 4 | 4 | **100%** |
| **Diff Payout, Diff Mult** | 74,161 | 12 | 26 | 6 | 6 | **100%** |

**Analysis:**
- **SSTORE Efficiency = (Unique SSTORE / Total SSTORE) × 100%**
- **100% efficiency means zero wasted gas** - every storage write goes to a different slot
- Repeat SLOADs are acceptable (100 gas warm vs 2100 cold) and expected for struct field access
- Repeat SSTOREs were eliminated through memory-pattern optimization (would waste 5000 gas each)

**Gas Savings from Optimization:**
- Same payout scenario: Saved ~33K gas via aggregation skip optimization
- Same multiplier scenario: Saved ~17K gas by skipping multiplier aggregate updates
- Full optimization uses memory-pattern for hierarchical updates

### Key Operations

Measured gas costs from actual implementation:

- **Full claim (O(1))**: 78,876 gas - O(1) optimized regardless of group size (warm storage)
- **Create payout group**: 102,377 gas (one-time setup per group)
- **Register account**: 64,900 gas (one-time registration cost)
- **Individual account claim**: 82,606 gas (single account claim operation)
- **Batch claim per wallet (asymptotic)**: 26,852 gas (marginal cost per account in batch)

### Individual Operations

| Scenario | Gas Cost | Unique SSTORE | Notes |
|----------|----------|---------------|--------|
| **Transfer (no payout groups)** | **50,587** | **2** | Baseline unregistered transfer (100% efficient) |
| **Transfer (same payout group)** | **59,076** | **2** | Skips aggregation updates (100% efficient) |
| **Transfer (different groups, same multiplier)** | **72,161** | **4** | Skips multiplier aggregation (100% efficient) |
| **Transfer (different groups, different multipliers)** | **74,161** | **6** | Full cross-multiplier functionality (100% efficient) |
| **Full claim (O(1))** | **78,893** | **N/A** | O(1) regardless of group size (warm storage) |
| **Create payout group** | **102,377** | **N/A** | One-time setup per group |
| **Register account** | **64,900** | **N/A** | One-time registration cost |

### Admin Registration Gas Analysis

**Unified `adminRegisterRewardAccounts` Performance (automatically optimizes per account):**

| Scenario | Total Gas | Per Account (excl. 39K overhead) | Optimization |
|----------|-----------|-----------------------------------|--------------|
| **Single zero-balance account** | **118K** | **79K** | Single call with overhead |
| **Single account with balance** | **47K** | **8K** | Rebalancing included |
| **Batch 5 zero-balance accounts** | **174K** | **27K** | **77% reduction vs single** |
| **Batch 5 accounts with balance** | **138K** | **20K** | **58% reduction vs single** |
| **Mixed batch (3 zero + 2 balance)** | **170K** | **26K** | **Automatic per-account optimization** |
| **Large batch 10 zero-balance** | **304K** | **26K** | **Scales efficiently** |

**Key Benefits of Unified Function:**
- Single API: No need to choose between functions - automatic optimization
- Per-account optimization: Zero-balance accounts skip expensive rebalancing
- Mixed batches supported: Handles any combination efficiently
- Maintains gas efficiency: Best performance for each account type

**Detailed Gas Breakdown (per account, excluding 39K proxy overhead):**

#### Zero-Balance Accounts (Fresh/New):
- `balancesData[account]` SLOAD: **2,100 gas** (cold storage read)
- `balancesData[account]` SSTORE: **20,000 gas** (zero→non-zero, new slot)
- `emit AccountRegistered`: **1,750 gas**
- Loop iteration & validation: **~1,000 gas**
- Direct ID comparison optimization: **~200 gas saved**
- **OPTIMIZATION**: Skips `_rebalancePayoutAddressAccounting` entirely
- **Pure Cost: ~27K gas per account**

#### Accounts With Existing Balance:
- `balancesData[account]` SLOAD: **2,100 gas** (cold)
- `balancesData[account]` SSTORE: **5,000 gas** (non-zero→non-zero, existing slot)
- `emit AccountRegistered`: **1,750 gas**
- `getActiveMultiplier(payoutMultiplierId)`: **100 gas** (warm, cached, correct multiplier)
- `SharesLib.calcShares()`: **~500 gas**
- Payout rebalancing operations:
  - `payoutBalances` SLOAD/SSTORE: **5,100 gas**
  - `totalsByMultiplier` SLOAD/SSTORE: **5,100 gas**
- Loop iteration & validation: **~1,000 gas**
- Local variable optimizations: **~200 gas saved**
- **Pure Cost: ~20K gas per account**

**Key Insight:** Accounts with existing balance can be cheaper than zero-balance accounts because SSTORE to existing non-zero slots (5K gas) costs less than SSTORE to new zero slots (20K gas).

**Diamond Proxy Overhead:** The 39K gas fixed cost comes from diamond proxy function dispatch, which is amortized across batch operations, making batching highly effective for gas optimization.

### Bulk Registration Gas Costs

**Current `registrarRegisterRewardAddressBatch` Performance:**

Measured with `benchmarks/BulkRegistrationGasBenchmark.js` using actual EVM execution:

| Batch Size | Total Gas | Avg/Address | Marginal Cost | Efficiency Gain |
|------------|-----------|-------------|---------------|-----------------|
| **1 address** | 90,030 | 90,030 | 90,030 | baseline |
| **5 addresses** | 140,864 | 28,173 | 16,341 | 82% |
| **10 addresses** | 225,821 | 22,582 | 16,702 | 81% |
| **20 addresses** | 395,841 | 19,792 | 16,860 | 81% |
| **50 addresses** | 906,986 | 18,140 | 16,969 | 81% |
| **100 addresses** | 1,762,339 | 17,623 | **17,039** | 81% |

**Key Insights:**
- **First address overhead**: ~90K gas (includes cold SSTORE for new account)
- **Marginal cost (2nd+ addresses)**: ~**17K gas per address**
- **Batch efficiency**: 81% gas savings per address at scale vs single registration
- **Idempotent registrations**: ~7.6K gas per address (already registered, early-return optimization)

**Storage Operations Per Address:**
- **5 SLOADs**:
  - 1 cold: `balanceData[account]` (new account data)
  - 4 warm: `payoutData[payoutGroupId]`, `multipliers[multiplierId]`, `periodSettings`, `multiplierBals[multiplierId]`
- **3 SSTOREs** (optimized for single-write):
  - 1 cold: `balanceData[account]` (~20K gas for new account)
  - 2 warm: `payoutData[payoutGroupId]`, `multiplierBals[multiplierId]` (~5.8K gas total)

**Optimization Impact:**
Recent memory-pattern optimization for hierarchical balance updates (`_updatePayoutGroupBals` and `_updateMultiplierBals`) eliminated duplicate SSTOREs to aggregation structs, reducing marginal cost from ~22.8K → ~17K gas per address (**~25% reduction**).

**Idempotent Batch Registration:**
When registering addresses already in the target payout group, the idempotent early-return path costs only **~7.6K gas per address** (73% cheaper than new registration):
- Single SLOAD check: `balanceData[account].payoutGroupId`
- Early return if already registered to same group
- No storage writes needed

**Recommendation**: Use batch registration for multiple addresses to maximize gas efficiency. Batching 50+ addresses achieves near-optimal ~17K gas per address cost.

**Key Innovations**:

- **Zero Callbacks Architecture**: All shared logic compiled into facets via inheritance - no `address(this).call()` or interface casts
  - `ClaimableRewardsBase` provides `_transfer()` and all helper functions directly to facets
  - TokenExtensionsFacet's EIP-3009 implementation calls `_transfer()` directly (eliminated callback)
  - Removes staticcall security risks and saves ~2600 gas per eliminated callback
- **Direct AccessControl inheritance**: Facets inherit AccessControl directly instead of using external calls, eliminating ~2600 gas per role check
- **GlobalTransferSettings optimization**: Consolidated `paused` flag with period settings at slot 4, saving 2100 gas per transfer by reducing 2 SLOADs to 1 SLOAD (hot path optimization)
- **100% SSTORE efficiency**: Memory-pattern optimization eliminates all repeat storage writes, achieving perfect efficiency
- **Same-payout-group optimization**: Skips aggregation updates entirely, saving ~33K gas vs cross-group transfers
- **Same-multiplier optimization**: Skips multiplier aggregate updates, saving ~17K gas vs cross-multiplier transfers
- **Single-write struct updates**: Load to memory, modify all fields, write once - saves gas per aggregation
- **Storage efficiency**: Packed 32-byte slots minimize SLOAD/SSTORE operations
- **O(1) claims**: ClaimAll operation costs 78,876 gas regardless of group size (warm storage)
- **Unchecked math optimization**: Binary exponentiation uses `unchecked` blocks with explicit 2^128 overflow checks, saving ~550-1,040 gas per compound interest calculation
- **EVM-level profiling**: debug_traceTransaction ensures accuracy of gas optimization claims

Cross-multiplier transfers cost 74,161 gas while enabling full multi-jurisdiction support with different rates per jurisdiction.

### Payout Group-Centric O(1) Gas Optimization

LastMultiplier model with payout group-level `lastClaimAllMultiplier` achieves O(1) gas complexity for full group claims:

| Scenario | Gas Cost | **O(1) Scaling** |
|----------|----------|-------------------|
| **ClaimAll** | **78,876 gas** | O(1) constant - updates payout group state and distributes rewards (warm storage) |

**Key Innovation**: The `claimAll()` function updates only the payout group's `lastClaimAllMultiplier` without touching individual account storage. Individual accounts "lazy checkpoint" on their next balance-changing event, using period-based detection to prevent double-claiming. This architecture achieves:
- **O(1) claim accounting**: 78,876 gas regardless of registered addresses (3 or 10,000)
- **Storage efficiency**: ClaimAll only updates payout group struct - no per-account iteration
- **True O(1) scaling**: Gas cost is independent of the number of addresses in the payout group

## Summary

The Claimable Rewards system provides:
- **Efficient**: O(1) gas complexity for claims
- **Transparent**: On-chain reward tracking and calculations
- **Compliant**: Partner-controlled reward claiming
- **Buildable**: Flexible claiming modes for partner integration
- **Scalable**: Multi-jurisdiction support with separate multipliers
- **Gas Optimized**: Packed storage and minimal SLOAD/SSTORE operations

---

## Architecture Diagram

### System Overview

The Paxos Token Rebase Claims system uses a **Diamond Proxy Pattern** to split functionality across multiple facets while maintaining a single contract address and shared storage.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT INTERACTIONS                          │
│  (External callers: Users, Partners, Paxos Operators, Admins)      │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    PaxosTokenClaimableRewards                           │
│                   (Diamond Proxy + Main Contract)                    │
│                                                                      │
│  Core ERC20 Functions:                                              │
│  • transfer(), balanceOf(), approve()                               │
│  • transferFrom(), increaseApproval(), decreaseApproval()          │
│  • totalSupply()                                                    │
│                                                                      │
│  Supply Control:                                                    │
│  • mint(), burn(), increaseSupply(), decreaseSupply()              │
│                                                                      │
│  Diamond Proxy Infrastructure:                                      │
│  • fallback() → delegates to facets                                │
│  • setFacet(), batchSetFacet(), getFacet()                         │
│  • facets mapping: bytes4 selector → address                       │
│                                                                      │
│  Internal Transfer Logic:                                           │
│  • _transfer() with gas optimizations                              │
│  • _updateWalletWithPayoutGroup() for transfer/mint/burn                    │
│  • _updatePayoutGroupBals(), _updateMultiplierBals()               │
└──────────┬───────────────────────────────────────────────┬─────────┘
           │                                                │
           │ delegates via fallback()                       │ shares storage
           ↓                                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│                         FACET LAYER                                   │
│              (Business Logic via Delegatecall)                        │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────────┐
│  PayoutGroupFacet   │  │ MultiplierMgmtFacet │  │ClaimableRewards  │
│    (20.434 KB)      │  │    (13.894 KB)      │  │   Facet          │
│                     │  │                     │  │  (12.781 KB)     │
│ Payout Group CRUD:  │  │ Multiplier Mgmt:    │  │                  │
│ • createPayoutGroup │  │ • createMultiplier  │  │ Claimer Claims:  │
│ • deletePayoutGroup │  │ • deleteMultiplier  │  │ • claimAll()     │
│ • adminSetPayout    │  │ • setMultiplierRate │  │ • claimFor       │
│   GroupMultiplier   │  │ • scheduleNextMult  │  │   Addresses()    │
│   (REGISTRAR_ROLE)  │  │   Rate              │  │                  │
│ • adminSetPayout    │  │ • setRewardsPeriod  │  │ Manager Claims:  │
│   GroupClaimer      │  │ • setReferenceTime  │  │ • claimAllTo()   │
│ • adminSetPayout    │  │ • setClaimSource    │  │ • claimFor       │
│   GroupManager      │  │ • setRateBounds     │  │   AddressesTo()  │
│ • adminSetPayout    │  │ • setRateBounds     │  │                  │
│   GroupDestination  │  │                     │  │                  │
│                     │  │                     │  │ Authorization:   │
│ Manager Functions:  │  │ Multiplier Views:   │  │ • _isAuthorized  │
│ • setPayoutGroup    │  │ • getActiveMulti    │  │   AsClaimer()    │
│   Claimer           │  │   plier()           │  │ • _isAuthorized  │
│ • setPayoutGroup    │  │ • getMinRate()      │  │   AsManager()    │
│   Manager           │  │ • getMaxRate()      │  │                  │
│ • setPayoutGroup    │  │ • getNextRate()     │  │ Batch Processing:│
│   Destination       │  │ • getNextRateTime() │  │ • _processBatch  │
│                     │  │                     │  │   Claims()       │
│ Registration:       │  │ Admin Config:       │  │                  │
│ • registrarRegister │  │ • Rate bounds       │  └──────────────────┘
│   RewardAddress     │  │ • Period management │
│ • registrarUnreg    │  │                     │
│   isterRewardAddr   │  └─────────────────────┘
│ • registrarRegister │
│   RewardAddress     │
│   Batch             │
│ • registerReward    │
│   Address (sig)     │
│ • unregisterReward  │
│   Address           │
│                     │
│ Payout Group Views: │
│ • availableRewards  │
│   Of()              │
│ • payoutGroupIdOf() │
│ • getPayoutGroup    │
│   AvailableRewards()│
│ • getPayoutGroup    │
│   MultId()          │
│ • getPayoutGroup    │
│   Balance()         │
└─────────────────────┘

┌─────────────────────┐  ┌─────────────────────┐
│ TokenExtensionsFacet│  │  TokenAdminFacet    │
│    (16.500 KB)      │  │    (11.606 KB)      │
│                     │  │                     │
│ EIP-2612 (Permit):  │  │ Pause/Unpause:      │
│ • permit()          │  │ • pause()           │
│ • nonces()          │  │ • unpause()         │
│                     │  │                     │
│ EIP-3009 (Transfer  │  │ Supply Control:     │
│  with Auth):        │  │ • setSupplyControl()│
│ • transferWith      │  │                     │
│   Authorization()   │  │ Asset Protection:   │
│ • transferWith      │  │ • freeze()          │
│   Authorization     │  │ • freezeBatch()     │
│   Batch()           │  │ • unfreeze()        │
│ • receiveWith       │  │ • unfreezeBatch()   │
│   Authorization()   │  │ • wipeFrozen        │
│ • cancelAuth        │  │   Address()         │
│   orization()       │  │                     │
│ • authorizationState│  │ View Functions:     │
│ EIP-712 Signatures: │  │ • isFrozen()        │
│ • _recover()        │  │ • paused()          │
│ • DOMAIN_SEPARATOR  │  │ • reclaimToken()    │
│                     │  │                     │
│ Uses _transfer()    │  │                     │
│ from ClaimableRewardsBase│ │                     │
│ (no callbacks!)     │  │                     │
└─────────────────────┘  └─────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        SHARED BASE LOGIC                              │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      ClaimableRewardsBase                                │
│                      (5.034 KB)                                      │
│                                                                      │
│  INHERITANCE: Extends PaxosBaseAbstract (first parent) to provide  │
│  shared business logic to all facets via direct inheritance.       │
│                                                                      │
│  PAXOSBASEABSTRACT IMPLEMENTATION:                                  │
│  Implements abstract functions (marked virtual for main override): │
│  • _isPaused() - Returns pause state from globalTransferSettings   │
│  • _isAddrFrozen() - Checks freeze status via _isFrozen()          │
│  • _approve() - Sets allowance and emits Approval event            │
│  • _transfer() - Full transfer logic with payout/multiplier updates│
│                                                                      │
│  CLEAN SEPARATION: Business logic only - uses StorageLib for all   │
│  type conversions. No storage variables or pure functions.         │
│                                                                      │
│  Shared Business Logic Functions:                                   │
│  • _claimIndividualRewards() - Claim for single account            │
│  • _executeClaimAll() - O(1) payout group claim                    │
│  • _claimRewards() - Transfer from claim source                    │
│  • _updateBalanceWithShares() - Unified balance update             │
│  • _updatePayoutGroupBals() - Hierarchical payout update           │
│  • _updateMultiplierBals() - Hierarchical multiplier update        │
│  • _getCurrentPeriodNum() - Period calculation                     │
│  • _getCurrentPeriodStartTime() - Period timing                    │
│  • _getActiveMultiplier() - Current multiplier with rate           │
│  • _updateWalletWithPayoutGroup() - Wallet processing helper      │
│  • _processRewardSourceWalletChange() - Claim source special case  │
│  • _multiplierExists() - Validation helper                         │
│  • _isAuthorizedAsClaimer() - Authorization check                  │
│  • _isAuthorizedAsManager() - Authorization check                  │
│  • _validateNotFrozen() - Freeze status validation                 │
│  • _isClaimerOrManager() - Combined authorization check            │
│                                                                      │
│  Transfer Functions (for facet use):                                │
│  • _transferWithDifferentPayouts() - Cross-group transfer logic    │
│  • _updateWalletWithPayoutGroup() - Wallet+payout update helper    │
│  • _updateWalletAndPayoutOnly() - Same-mult optimization helper    │
│  • _updateWalletSharesForTransfer() - Same-group helper            │
│                                                                      │
│  Uses StorageLib for all type conversions (toUint64Balance, etc.)  │
│  Uses SharesLib for shares calculations                            │
│  Uses MultiplierGrowthLib for compound interest calculations       │
│                                                                      │
│  NOTE: No external callbacks - all logic compiled into facets      │
│  Inherited by all facets for shared functionality                  │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        STORAGE LAYER                                  │
│                    (Shared via Delegatecall)                          │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  ClaimableRewardsStorageV3                               │
│                  (Pure Storage + Minimal View Accessors)            │
│                                                                      │
│  CLEAN SEPARATION: Storage contracts contain pure storage variables│
│  and minimal view accessors only. Pure type conversion functions   │
│  have been extracted to StorageLib for better separation of        │
│  concerns.                                                          │
│                                                                      │
│  V3 Data Structures:                                                │
│  • PayoutGroupData (balance, shares, multiplierId, periodNum,      │
│    lastClaimAllPeriodNum, lastClaimAllBaseMultiplier)              │
│  • MultiplierData (checkpointMultiplier, checkpointTime, rate,     │
│    nextRate, nextRatePeriodNum, nextActiveId)                      │
│  • MultiplierBalances (balance, shares, periodNum)                 │
│  • AdminConfigSettings (claimSource, minRate, maxRate)             │
│                                                                      │
│  V3 Storage Variables (Slot 252+):                                 │
│  • payoutData: mapping(uint256 => PayoutGroupData)                 │
│  • payoutClaimerToId: mapping(address => uint32)                   │
│  • payoutIdToClaimer: mapping(uint256 => address)                  │
│  • payoutIdToManager: mapping(uint256 => address)                  │
│  • payoutIdToDestination: mapping(uint256 => address)              │
│  • nextPayoutId: uint32                                            │
│  • multipliers: mapping(uint256 => MultiplierData)                 │
│  • multiplierBals: mapping(uint256 => MultiplierBalances)          │
│  • nextMultiplierId: uint24                                        │
│  • firstActiveId: uint24 (linked list head)                        │
│  • activeMultiplierCount: uint24                                   │
│  • adminConfig: AdminConfigSettings                                │
│  • _registrationAuthState: mapping(address => mapping(bytes32 => bool))│
│                                                                      │
│  Minimal View Accessors (needed by both main contract and facets): │
│  • _isPayoutGroupActive() - Check if payout group is active        │
│  • _getPayoutDestination() - Get destination with claimer fallback │
│                                                                      │
│  NOTE: All pure type conversion functions moved to StorageLib      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      BaseStorageV3                                   │
│      (V2→V3 Upgrade Compatible Storage + Minimal Accessors)        │
│                                                                      │
│  CLEAN SEPARATION: Storage contracts contain pure storage variables│
│  and minimal storage accessor functions only. Pure type conversion │
│  functions have been extracted to StorageLib.                      │
│                                                                      │
│  Packed Token Account Data (32-byte slot):                          │
│  • TokenAccountData struct:                                         │
│    - balance: uint64 (8 bytes, up to 18 trillion at 6 decimals)   │
│    - shares: uint64 (8 bytes, up to 18 trillion at 6 decimals)    │
│    - payoutGroupId: uint24 (3 bytes, 0 = no payout group)         │
│    - periodNum: uint24 (3 bytes, max 16M periods)                 │
│  • balanceData: mapping(address => TokenAccountData)               │
│  • frozen: mapping(address => bool) (asset protection)             │
│                                                                      │
│  Global Transfer Settings (slot 4, HOT PATH):                       │
│  • GlobalTransferSettings struct:                                   │
│    - paused: bool (1 byte)                                          │
│    - partnerSignedRegistrationsEnabled: bool (1 byte)               │
│    - rewardPeriod: uint32 (4 bytes, compounding period)            │
│    - referenceTime: uint40 (5 bytes, epoch anchor)                 │
│    - referencePeriodNum: uint24 (3 bytes, period offset)           │
│  • globalTransferSettings: GlobalTransferSettings                   │
│                                                                      │
│  EIP-712 & Signature Support:                                       │
│  • DOMAIN_SEPARATOR: bytes32                                        │
│  • _nonces: mapping(address => uint256) (EIP-2612)                 │
│  • _authorizationStates: mapping(address =>                         │
│                           mapping(bytes32 => bool)) (EIP-3009)     │
│                                                                      │
│  Storage Accessor Functions (used by PaxosTokenRebaseClaims):      │
│  • _getBalanceData(), _setBalanceData()                            │
│  • _getBalance(), _setBalance()                                    │
│  • _getShares(), _setShares()                                      │
│  • _getPeriodNum(), _setPeriodNum()                                │
│  • _getPayoutGroupId()                                             │
│  • _isFrozen(), _setFrozen()                                       │
│                                                                      │
│  NOTE: All pure type conversion functions moved to StorageLib      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    PaxosBaseAbstract                                 │
│         (Abstract Base with Shared Modifiers and Errors)            │
│                                                                      │
│  Purpose: Provides shared modifiers, errors, and abstract function  │
│           signatures inherited by both main contract and base.      │
│                                                                      │
│  Shared Errors (inherited by all):                                  │
│  • ZeroAddress() - Validates non-zero addresses                     │
│  • AddressFrozen() - Validates unfrozen addresses                   │
│  • ContractPaused() - Validates contract not paused                 │
│  • ArgumentLengthMismatch() - Validates array length equality       │
│  • InvalidSignature() - Validates EIP-712 signature recovery        │
│                                                                      │
│  Shared Modifiers (marked virtual for facet inheritance):           │
│  • whenNotPaused() - Checks _isPaused() before execution            │
│  • isNonZeroAddress(addr) - Checks addr != address(0)               │
│                                                                      │
│  Abstract Functions (implemented by ClaimableRewardsBase):          │
│  • _isPaused() - Returns contract pause state                       │
│  • _isAddrFrozen(address) - Returns address freeze status           │
│  • _approve(owner, spender, value) - Sets allowance                 │
│  • _transfer(from, to, value) - Internal transfer logic             │
│                                                                      │
│  Storage Alignment Achievement:                                     │
│  • ClaimableRewardsBase inherits directly from PaxosBaseAbstract    │
│  • Main contract also inherits from PaxosBaseAbstract               │
│  • Multiple inheritance resolution via explicit override specifiers │
│  • Shared storage through identical inheritance order               │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        LIBRARY LAYER                                  │
│                   (Pure Functions - No Storage)                       │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐
│    StorageLib       │  │    SharesLib         │  │MultiplierGrowth │
│                     │  │                      │  │      Lib        │
│ Type Conversions:   │  │ Shares Calculations: │  │                 │
│ • hasPayoutGroup()  │  │ • initializeShares() │  │ Multiplier      │
│ • toUint64Balance() │  │ • calcRewards()      │  │ Growth:         │
│ • toUint64Shares()  │  │ • calcSharesDelta()  │  │ • getCurrent   │
│ • toUint24PeriodNum│  │ • resetSharesAfter   │  │   Multiplier()  │
│ • toUint24Payout   │  │   Claim()            │  │ • Continuous    │
│   GroupId()         │  │ • updateSharesOn     │  │   compounding   │
│ • toUint56         │  │   BalanceChange()    │  │ • Rate-based    │
│   Multiplier()      │  │ • handleClaimAll     │  │   growth        │
│ • toUint40         │  │   Detection()        │  │ • Period-       │
│   Timestamp()       │  │                      │  │   aligned       │
│ • toUint32Reward   │  │ Period Management:   │  │   calculations  │
│   Period()          │  │ • getCurrentPeriod   │  │                 │
│ • toUint48Rate()    │  │   Num()              │  │                 │
│ • toUint8()         │  │                      │  │                 │
│                     │  │ Constants:           │  │                 │
│ All with overflow   │  │ • MULT_BASE = 1e12   │  │                 │
│ protection & errors │  │   (12 decimals)      │  │                 │
└─────────────────────┘  └──────────────────────┘  └─────────────────┘

┌─────────────────────┐
│   EIP712 / ECR      │
│                     │
│ Signature Util:     │
│ • _makeDomain       │
│   Separator()       │
│ • _recover()        │
│                     │
│ EIP-2612:           │
│ • permit()          │
│                     │
│ EIP-3009:           │
│ • transferWith      │
│   Authorization     │
│                     │
└─────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                     EXTERNAL DEPENDENCIES                             │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              OpenZeppelin Contracts (Upgradeable)                    │
│                                                                      │
│  • AccessControlDefaultAdminRulesUpgradeable                        │
│    - Role-based access control                                      │
│    - DEFAULT_ADMIN_ROLE, PAUSE_ROLE, ASSET_PROTECTION_ROLE         │
│    - MULT_ADMIN_ROLE, MULT_RATE_ROLE                               │
│    - PAYOUT_GROUP_ADMIN_ROLE, PAYOUT_GROUP_REGISTRAR_ROLE          │
│    - CLAIM_OPERATOR_ROLE, CLAIM_ADMIN_ROLE                         │
│                                                                      │
│  • Initializable                                                    │
│    - Proxy initialization support                                   │
│    - Version management                                             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                       SupplyControl                                  │
│                  (External Authorization)                            │
│                                                                      │
│  Interface for mint/burn authorization:                             │
│  • canMintToAddress(address, uint256, address)                      │
│  • canBurnFromAddress(address, address)                             │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Patterns

#### 1. Diamond Proxy Pattern
- **Main Contract** (`PaxosTokenClaimableRewards`) contains core ERC20 logic and diamond infrastructure
- **Facets** contain specialized functionality accessed via `delegatecall`
- **Single Storage Layout** shared across all facets via delegatecall context
- **Fallback Function** routes unknown function calls to registered facets
- **No Callbacks**: All shared logic is compiled into facets via inheritance (no `address(this).call()` or interface casts)
  - Facets inherit `ClaimableRewardsBase` for shared business logic
  - Facets inherit `AccessControlDefaultAdminRulesUpgradeable` directly for role checks
  - Eliminates ~2600 gas per callback and removes staticcall security risks

#### 2. Storage Alignment Strategy
```
Main Contract Storage Layout:
├── BaseStorageV3 (slots 0-50)
│   └── Core token data, balances, EIP-712 support
├── AccessControl (slots 51-251)
│   └── Role-based access control storage
└── ClaimableRewardsStorageV3 (slots 252+)
    └── V3-specific storage (payout groups, multipliers)

Facet Storage Layout:
├── BaseStorageV3 (slots 0-50)
│   └── Same as main contract
├── AccessControlDefaultAdminRulesUpgradeable (slots 51-251)
│   └── Same AccessControl inheritance as main contract
│   └── Provides hasRole() directly (no external calls)
└── ClaimableRewardsStorageV3 (slots 252+)
    └── Identical V3 storage (delegatecall shares storage)
```

#### 3. Inheritance Hierarchy

```
Main Contract (PaxosTokenClaimableRewards):
  ├── BaseStorageV3 (packed storage + helpers)
  ├── PaxosBaseAbstract (modifiers)
  ├── AccessControlDefaultAdminRulesUpgradeable (roles)
  ├── ClaimableRewardsStorageV3 (V3 storage)
  ├── ClaimableRewardsEvents (event definitions)
  └── TokenAdminEvents (admin event definitions)

Facets:
  ├── ClaimableRewardsBase (shared business logic)
  │   ├── PaxosBaseAbstract (abstract base with modifiers, errors)
  │   ├── BaseStorageV3 (storage + helpers)
  │   ├── AccessControlDefaultAdminRulesUpgradeable (roles)
  │   ├── ClaimableRewardsStorageV3 (V3 storage)
  │   ├── ClaimableRewardsEvents (events)
  │   └── TokenAdminEvents (events)
  └── Facet-specific logic
```

#### 4. Gas Optimization Features

**Transfer Optimizations:**
- **No payout groups**: 50,587 gas (2 SLOAD, 2 SSTORE)
- **Same payout group**: 59,076 gas (skips aggregation updates)
- **Same multiplier**: 72,161 gas (skips multiplier aggregation)
- **Different multipliers**: 74,161 gas (full cross-jurisdiction)

**Storage Efficiency:**
- **Packed structs**: Minimize SLOAD operations
- **Single-write pattern**: Load to memory, modify, write once
- **100% SSTORE efficiency**: Zero redundant storage writes
- **Hot path optimization**: `globalTransferSettings` at slot 4 saves 2100 gas

**O(1) Claims:**
- **claimAll()**: 78,876 gas regardless of group size (warm storage)
- **LastClaimAll model**: No per-account iteration needed
- **Lazy checkpoint**: Accounts update on next balance change

#### 5. Roles and Access Control

| Role | Description | Functions |
|------|-------------|-----------|
| `DEFAULT_ADMIN_ROLE` | System admin | setSupplyControl, setFacet, reclaimToken |
| `PAUSE_ROLE` | Emergency pause | pause, unpause |
| `ASSET_PROTECTION_ROLE` | Freeze addresses | freeze, unfreeze, wipeFrozenAddress |
| `MULT_ADMIN_ROLE` | Multiplier admin | createMultiplier, setClaimSource, setRateBounds |
| `MULT_RATE_ROLE` | Rate updates | setMultiplierRate, scheduleNextMultRate |
| `PAYOUT_GROUP_ADMIN_ROLE` | Payout admin (cold wallet) | adminSetPayoutGroupClaimer, adminSetPayoutGroupManager, adminSetPayoutGroupDestination |
| `PAYOUT_GROUP_REGISTRAR_ROLE` | Registration (hot wallet) | createPayoutGroup, deletePayoutGroup, adminSetPayoutGroupMultiplier, registrarRegisterRewardAddress |
| `CLAIM_OPERATOR_ROLE` | Claim operator | Can call claimAll/claimForAddresses for any group |
| `CLAIM_ADMIN_ROLE` | Claim admin | Can call claimAllTo/claimForAddressesTo for any group |

#### 6. Data Flow Examples

**Transfer Between Registered Accounts (Same Payout Group):**
```
User calls transfer()
  ↓
PaxosTokenClaimableRewards._transfer()
  ↓
Load fromWallet and toWallet (2 SLOAD)
  ↓
Check: same payoutGroupId? YES
  ↓
Load payoutGroup data (1 SLOAD)
Calculate current multiplier
  ↓
Update FROM and TO wallet shares (2 SSTORE)
Skip aggregation updates (optimization)
  ↓
Emit Transfer event
```

**Claim All Rewards:**
```
Claimer calls claimAll(payoutGroupId)
  ↓
ClaimableRewardsFacet.claimAll()
  ↓ (delegatecall)
ClaimableRewardsBase._executeClaimAll()
  ↓
Load payoutGroup data (1 SLOAD)
Calculate rewards from shares
  ↓
Update lastClaimAllPeriodNum and lastClaimAllBaseMultiplier
Reset shares (1 SSTORE to payoutGroup)
  ↓
_claimRewards() transfers from claim source
Update claim source and destination balances
  ↓
Emit ClaimAllExecuted and Transfer events
```

**Register Address to Payout Group:**
```
Registrar calls registrarRegisterRewardAddress()
  ↓
PayoutGroupFacet.registrarRegisterRewardAddress()
  ↓ (delegatecall)
_internalRegisterRewardAddress()
  ↓
Load account balance data
Check not already registered
  ↓
Calculate initial shares based on balance
Update account with payoutGroupId and shares
  ↓
Update payout group aggregates (balance, shares)
Update multiplier aggregates (balance, shares)
  ↓
Emit AccountRegistered event
```

---

*For technical implementation details, see the contract source code and comprehensive test suite.*
