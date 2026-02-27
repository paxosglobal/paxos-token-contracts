# PAXOS TOKEN

Paxos-issued USD-collateralized ERC20 stablecoin public smart contract repository.

https://github.com/paxosglobal/paxos-token-contract

### Roles

| Role                           |
| ------------------------------ |
| DEFAULT_ADMIN_ROLE             |
| PAUSE_ROLE                     |
| ASSET_PROTECTION_ROLE          |
| SUPPLY_CONTROLLER_MANAGER_ROLE |
| SUPPLY_CONTROLLER_ROLE         |

To guard against centralized control, the addresses above utilize multisignature contracts ([source](https://github.com/paxosglobal/simple-multisig)). Any change requires the presence of a quorum of signers in the same physical location, ensuring that no individual signer can unilaterally influence a change.

### ABI and Addresses

The contract abi is in `PaxosToken.abi`, which is the implementation contract abi.

Interaction with token is done at the address of the proxy. Deployed token addresses can be found in
the [Paxos docs](https://docs.paxos.com/stablecoin).

## Contract Specification

Paxos Token is an ERC20 token that is Centrally Minted and Burned by Paxos,
representing the trusted party backing the token with USD.

### ERC20 Token

The public interface of PaxosToken is the ERC20 interface
specified by [EIP-20](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-20.md).

- `name()`
- `symbol()`
- `decimals()`
- `totalSupply()`
- `balanceOf(address who)`
- `transfer(address to, uint256 value)`
- `approve(address spender, uint256 value)`
- `increaseApproval(address spender, uint256 addedValue)`
- `decreaseApproval(address spender, uint256 subtractedValue)`
- `allowance(address owner, address spender)`
- `transferFrom(address from, address to, uint256 value)`

And the usual events.

- `event Transfer(address indexed from, address indexed to, uint256 value)`
- `event Approval(address indexed owner, address indexed spender, uint256 value)`

Typical interaction with the contract will use `transfer` to move the token as payment.
Additionally, a pattern involving `approve` and `transferFrom` can be used to allow another
address to move tokens from your address to a third party without the need for the middleperson
to custody the tokens, such as in the 0x protocol.

#### Warning about ERC20 approve front-running

[There is a well known gotcha](https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729) involving the ERC20
`approve` method. The problem occurs when the owner decides to change the allowance of a spender that already has an
allowance. If the spender sends a `transferFrom` transaction at a similar time that the owner sends the new `approve`
transaction and the `transferFrom` by the spender goes through first, then the spender gets to use the original
allowance, and also get approved for the intended new allowance.

To mitigate this risk, we recommend that smart contract users utilize the alternative functions `increaseApproval` and
`decreaseApproval` instead of using `approve` directly.

### Controlling the token supply

PaxosToken uses a separately deployed `SupplyControl` contract to control the token supply. `SupplyControl` has a `SUPPLY_CONTROLLER_MANAGER_ROLE` which is responsible for managing addresses with the `SUPPLY_CONTROLLER_ROLE`, referred
to as supplyControllers. Only supplyControllers can mint and burn tokens. SupplyControllers can optionally have rate 
limits to limit how many tokens can be minted over a given time frame.

`SupplyControl` also includes functions to get all of the supply controller addresses
and get configuration for a specific supply controller.

### Pausing the contract

In the event of a critical security threat, Paxos has the ability to pause transfers
and approvals of the token. The ability to pause is controlled by a single `owner` role,
following OpenZeppelin's
[Ownable](https://github.com/OpenZeppelin/openzeppelin-solidity/blob/5daaf60d11ee2075260d0f3adfb22b1c536db983/contracts/ownership/Ownable.sol).
The simple model for pausing transfers following OpenZeppelin's
[Pausable](https://github.com/OpenZeppelin/openzeppelin-solidity/blob/5daaf60d11ee2075260d0f3adfb22b1c536db983/contracts/lifecycle/Pausable.sol).

While paused, the supply controller retains the ability to mint and burn tokens.

### Asset Protection Role

The `ASSET_PROTECTION_ROLE` can freeze and unfreeze the token balance of any address on chain.
It can also wipe the balance of an address after it is frozen
to allow the appropriate authorities to seize the backing assets.

Freezing is something that Paxos will not do on its own accord,
and as such we expect to happen extremely rarely. Checking if an address is frozen is possible
via `isFrozen(address who)`.

### USDG Rewards System

USDG implements an auto-compounding yield system where registered token holders automatically earn rewards. For complete technical documentation, see [docs/REWARDS_README.md](docs/REWARDS_README.md).

### Contract Architecture

USDG uses a diamond-style facet pattern to organize functionality across multiple contracts while maintaining a single proxy address. This architecture enables gas optimizations, modularity, and upgradability.

#### Main Contract: PaxosTokenClaimableRewards
The main contract contains:
- Core ERC20 functions (transfer, approve, balanceOf, etc.)
- Minting and burning functionality
- Internal balance and rewards processing
- Fallback mechanism for delegating to facets

#### Facets
Additional functionality is organized into specialized facet contracts:

**TokenAdminFacet** - Administrative operations:
- `reclaimToken()` - Recover accidentally sent tokens
- `setSupplyControl()` - Configure supply controller
- `pause()` / `unpause()` - Emergency pause functionality
- `freeze()` / `unfreeze()` / `wipeFrozenAddress()` - Asset protection
- `isFrozen()` - Check if address is frozen
- `paused()` - Check if contract is paused

**ClaimableRewardsFacet** - Rewards operations:
- Claim functions for payout groups
- Reward calculation and distribution
- Payout group management functions

#### Storage Organization

**BaseStorageV3** - Core token storage:
- ERC20 balances and allowances
- Account flags (frozen, reward source)
- Global transfer settings
- EIP-2612 (permit) and EIP-3009 storage
- Provides storage getter/setter helpers

**ClaimableRewardsStorageV3** - Rewards-specific storage:
- Payout group data and mappings
- Multiplier configurations and balances
- Admin config settings
- Registration authorization state

#### Helper Libraries

**ClaimableRewardsBase.sol** - Complex business logic:
- Reward calculation algorithms
- Balance update processing
- Cross-multiplier transfer logic

**SharesLib** - Shares-based reward calculations:
- Period number calculations
- ClaimAll detection
- Share delta calculations

**MultiplierGrowthLib** - Multiplier math:
- Current multiplier calculation with rate growth
- Period-aligned compounding

This separation allows the main contract to focus on core ERC20 functionality while delegating specialized operations to facets, reducing contract size and improving gas efficiency.

### Delegate Transfer 

To facilitate gas-less transactions, we have implemented [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) and [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612).

#### Comparison: EIP-3009 vs EIP-2612

Both standards enable gasless token operations via signed messages, but they have different use cases and capabilities:

| Feature | EIP-3009 | EIP-2612 |
|---------|----------|----------|
| **Primary Use Case** | Direct token transfers | Gasless approvals (allowances) |
| **Nonce Type** | Random `bytes32` (chosen by user) | Sequential `uint256` (auto-incremented) |
| **Cancellation** | ✅ `cancelAuthorization()` with signature | ✅ `cancelPermits(count)` increments nonce |
| **Timing Control** | `validAfter` and `validBefore` windows | Single `deadline` parameter |
| **Flexibility** | Individual authorization cancellation | Bulk permit cancellation (up to 50) |
| **State Check** | `authorizationState(address, bytes32)` | `nonces(address)` |

**When to use each:**
- **EIP-3009**: Direct transfers with fine-grained control and individual cancellation capability
- **EIP-2612**: Standard gasless approvals compatible with existing `transferFrom` workflows

#### EIP-3009
The public functions, `transferWithAuthorization` and `transferWithAuthorizationBatch` (for multiple transfers request), allows a spender(delegate) to transfer tokens on behalf of the sender, with condition that a signature, conforming to [EIP-712](https://eips.ethereum.org/EIPS/eip-712), is provided by the respective sender.

 ```
function transferWithAuthorization(
    address from,
    address to,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;

function transferWithAuthorizationBatch(
    address[] memory from,
    address[] memory to,
    uint256[] memory value,
    uint256[] memory validAfter,
    uint256[] memory validBefore,
    bytes32[] memory nonce,
    uint8[] memory v,
    bytes32[] memory r,
    bytes32[] memory s
) external;

function cancelAuthorization(
    address authorizer,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;
 ```

#### EIP-2612
The sender can establish an allowance for the spender using the permit function, which employs an EIP-712 signature for authorization. Subsequently, the spender can employ the `transferFrom` and `transferFromBatch` functions to initiate transfers on behalf of the sender.

```
function permit(
    address owner,
    address spender,
    uint value,
    uint deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
) external;

function cancelPermits(uint256 count) external;

function transferFrom(
    address _from,
    address _to,
    uint256 _value
) public returns (bool);

function transferFromBatch(
    address[] calldata _from,
    address[] calldata _to,
    uint256[] calldata _value
) public returns (bool);
```

**Permit Cancellation**: Users can call `cancelPermits(count)` to increment their nonce by `count` (1-50), effectively canceling any pending permits signed with the old nonces. This addresses the need to revoke gasless approvals before they are executed or expire.

### Upgradeability Proxy

To facilitate upgradeability on the immutable blockchain we follow a standard
two-contract delegation pattern: a proxy contract represents the token,
while all calls not involving upgrading the contract are delegated to an
implementation contract.

The delegation uses `delegatecall`, which runs the code of the implementation contract
_in the context of the proxy storage_. This way the implementation pointer can
be changed to a different implementation contract while still keeping the same
data and contract address, which are really for the proxy contract.

USDP and PYUSD use `AdminUpgradeabilityProxy` from OpenZeppelin.

USDG and SupplyControl use `UUPSUpgradeable` from OpenZeppelin. 

`UUPSUpgradeable` is a newer proxy pattern which
has some advantages over `AdminUpgradeabilityProxy`. One issue with `AdminUpgradeabilityProxy` is the proxy admin
cannot call any of the implementation functions which means the proxy admin must be a separate address
from the DEFAULT_ADMIN_ROLE. This is not an issue with `UUPSUpgradeable`. Another advantage is updating
the proxy admin in `UUPSUpgradeable` is a two step process due to using OpenZeppelin's AccessControlDefaultAdmin. 
However, in `AdminUpgradeabilityProxy` it's one step which is more dangerous.

## Upgrade Process

The implementation contract is only used for the logic of the non-admin methods.
A new implementation contract can be set by calling `upgradeTo()` or `upgradeToAndCall()` on the proxy,
where the latter is used for upgrades requiring a new initialization or data migration so that
it can all be done in one transaction. You must first deploy a copy of the new implementation
contract, which is automatically paused by its constructor to help avoid accidental calls directly
to the proxy contract.

## Contract Tests
Install dependencies:

`npm install`

Compile the contracts:

`npm run compile`

Run unit tests:

`npm run test`

Check test coverage:

`npm run coverage`