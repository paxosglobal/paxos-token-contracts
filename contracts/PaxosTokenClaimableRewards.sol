// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EIP2612 and EIP3009 storage in BaseStorageV3 for shared facet access
// DOMAIN_SEPARATOR_DEPRECATED from BaseStorageV3, PaxosBaseAbstract provides modifiers
import { PaxosBaseAbstract } from "./lib/PaxosBaseAbstract.sol";
import { EIP712 } from "./lib/EIP712.sol";
import { ClaimableRewardsBase } from "./ClaimableRewardsBase.sol";
import { StorageLib } from "./lib/StorageLib.sol";
import { Roles } from "./lib/Roles.sol";

/**
 * @title PaxosTokenClaimableRewards
 * @dev this contract is a Pausable ERC20 token with Burn and Mint
 * controlled by a `SupplyControl` contract.
 * NOTE: The storage defined here will actually be held in the Proxy
 * contract and all calls to this contract should be made through
 * the proxy, including admin actions done as owner or supplyController.
 * Any call to transfer against this contract should fail
 * with insufficient funds since no tokens will be issued there.
 * @custom:security-contact smart-contract-security@paxos.com
 *
 * ARCHITECTURE:
 * ============
 * This contract inherits from ClaimableRewardsBase, which provides:
 * - All storage contracts (BaseStorageV3, ClaimableRewardsStorageV3)
 * - All event contracts (ClaimableRewardsEvents, TokenAdminEvents)
 * - AccessControl functionality
 * - All claimable rewards business logic (transfer, balance updates, claims)
 */
contract PaxosTokenClaimableRewards is PaxosBaseAbstract, ClaimableRewardsBase {
    // PaxosBaseAbstract provides modifiers (isNonZeroAddress, etc.)
    // ClaimableRewardsBase provides all business logic and storage

    /**
     * EVENTS
     * NOTE: ERC20 events (Transfer, Approval) are inherited from ClaimableRewardsBase
     */

    // NOTE: Admin events (Pause, Unpause, Freeze, Supply Control, etc.) are inherited from TokenAdminEvents contract
    // NOTE: V3 Claimable Rewards events are inherited from ClaimableRewardsEvents contract

    /**
     * ERRORS
     * NOTE: InsufficientFunds is inherited from ClaimableRewardsBase
     * NOTE: AddressFrozen, AlreadyPaused, AlreadyUnPaused are inherited from PaxosBaseAbstract (via ClaimableRewardsBase)
     */
    error OnlySupplyController();
    error AddressNotFrozen();
    error ZeroValue();
    error InsufficientAllowance();
    error SupplyControllerUnchanged();
    error OnlySupplyControllerOrOwner();
    error BadDestination();
    error FacetNotFound();

    /**
     * @dev Struct to bundle a facet address with its selectors for initialization.
     * Similar to Diamond standard's FacetCut but simplified for this use case.
     */
    struct FacetCut {
        address facet;
        bytes4[] selectors;
    }

    /**
     * @dev Struct to bundle V3 role addresses for initialization.
     * Used to avoid stack too deep errors with many parameters.
     */
    struct V3RoleAddresses {
        address multAdmin;           // MULT_ADMIN_ROLE
        address multRateAdmin;       // MULT_RATE_ROLE
        address payoutGroupAdmin;    // PAYOUT_GROUP_ADMIN_ROLE
        address payoutGroupRegistrar; // PAYOUT_GROUP_REGISTRAR_ROLE
        address claimOperator;       // CLAIM_OPERATOR_ROLE
        address claimAdmin;          // CLAIM_ADMIN_ROLE
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * External Functions
     */

    /**
     * Public Functions
     */

    /**
     * @notice Initialize the contract.
     * @dev Wrapper around {_initialize}. This is useful to get the version before
     * it is updated by {reinitializer}. Registers facets atomically during initialization
     * so contract is fully functional immediately.
     * @param initialDelay Initial delay for changing the owner
     * @param initialOwner Address of the initial owner (receives DEFAULT_ADMIN_ROLE)
     * @param pauser Address of the pauser (receives PAUSE_ROLE)
     * @param assetProtector Address of the asset protector (receives ASSET_PROTECTION_ROLE)
     * @param facetCuts Array of FacetCut structs mapping facet addresses to their selectors
     * @param claimSource Address to use as claim source (where rewards come from)
     * @param minRate Minimum APR bound (10 decimals, e.g., 0 for no minimum)
     * @param maxRate Maximum APR bound (10 decimals, e.g., type(uint40).max for unlimited)
     * @param v3Roles Struct containing addresses for V3 roles (multAdmin, multRateAdmin, etc.)
     */
    function initialize(
        uint48 initialDelay,
        address initialOwner,
        address pauser,
        address assetProtector,
        FacetCut[] calldata facetCuts,
        address claimSource,
        uint256 minRate,
        uint256 maxRate,
        V3RoleAddresses calldata v3Roles
    ) public {
        uint64 pastVersion = _getInitializedVersion();
        _initialize(
            pastVersion, initialDelay, initialOwner, pauser, assetProtector,
            facetCuts, claimSource, minRate, maxRate, v3Roles
        );
    }

    /**
     * @notice Returns the total supply of the token (sum of all balances).
     * @dev Standard ERC20 behavior: totalSupply = sum of all account balances.
     *      Does NOT include unclaimed rewards (those are transferred from claim source during claims).
     * @return An uint256 representing the total supply.
     */
    function totalSupply() public view returns (uint256) {
        return totalSupply_;
    }

    /**
     * @notice Execute a transfer
     * @dev Transfer token to the specified address from msg.sender
     * @param to The address to transfer to
     * @param value The amount to be transferred
     * @return True if successful
     */
    function transfer(address to, uint256 value) public whenNotPaused returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /**
     * @notice Gets the ERC20 balance of the specified address (base balance only, excludes unclaimed rewards)
     * @dev This follows ERC20 standard - unclaimed rewards are NEVER included in balanceOf
     * @param addr The address to query the the balance of
     * @return An uint256 representing the ERC20 balance owned by the passed address
     */
    function balanceOf(address addr) public view returns (uint256) {
        return _getBalance(addr);
    }

    /**
     * @notice Transfer tokens from one address to another
     * @param from address The address which you want to send tokens from
     * @param to address The address which you want to transfer to
     * @param value uint256 the amount of tokens to be transferred
     * @return True if successful
     */
    function transferFrom(address from, address to, uint256 value) public whenNotPaused returns (bool) {
        if (_isAddrFrozen(msg.sender)) revert AddressFrozen();
        _transferFromAllowance(from, to, value);
        return true;
    }

    /**
     * @notice Transfer tokens from one set of addresses to another in a single transaction
     * @param from addres[] The addresses which you want to send tokens from
     * @param to address[] The addresses which you want to transfer to
     * @param value uint256[] The amounts of tokens to be transferred
     * @return True if successful
     */
    function transferFromBatch(
        address[] calldata from,
        address[] calldata to,
        uint256[] calldata value
    ) public whenNotPaused returns (bool) {
        // Validate length of each parameter with "_from" argument to make sure lengths of all input arguments are the same.
        if (to.length != from.length || value.length != from.length) revert ArgumentLengthMismatch();
        if (_isAddrFrozen(msg.sender)) revert AddressFrozen();
        for (uint16 i = 0; i < from.length; i++) {
            _transferFromAllowance(from[i], to[i], value[i]);
        }
        return true;
    }

    /**
     * @notice Set allowance of spender to spend tokens on behalf of msg.sender
     * @dev Approve the passed address to spend the specified amount of tokens on behalf of msg.sender.
     * Beware that changing an allowance with this method brings the risk that someone may use both the old
     * and the new allowance by unfortunate transaction ordering. One possible solution to mitigate this
     * race condition is to first reduce the spender's allowance to 0 and set the desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     * @param spender The address which will spend the funds
     * @param value The amount of tokens to be spent
     * @return True if successful
     */
    function approve(address spender, uint256 value) public whenNotPaused isNonZeroAddress(spender) returns (bool) {
        if (_isAddrFrozen(spender) || _isAddrFrozen(msg.sender)) revert AddressFrozen();
        _approve(msg.sender, spender, value);
        return true;
    }

    /**
     * @notice Increase the allowance of spender to spend tokens on behalf of msg.sender
     * @dev Increase the amount of tokens that an owner allowed to a spender.
     * To increment allowed value is better to use this function to avoid 2 calls (and wait until the first transaction
     * is mined) instead of approve.
     * @param spender The address which will spend the funds
     * @param addedValue The amount of tokens to increase the allowance by
     * @return True if successful
     */
    function increaseApproval(address spender, uint256 addedValue) public whenNotPaused returns (bool) {
        if (_isAddrFrozen(spender) || _isAddrFrozen(msg.sender)) revert AddressFrozen();
        if (addedValue == 0) revert ZeroValue();
        allowed[msg.sender][spender] += addedValue;
        emit Approval(msg.sender, spender, allowed[msg.sender][spender]);
        return true;
    }

    /**
     * @notice Decrease the allowance of spender to spend tokens on behalf of msg.sender
     * @dev Decrease the amount of tokens that an owner allowed to a spender.
     * To decrement allowed value is better to use this function to avoid 2 calls (and wait until the first transaction
     * is mined) instead of approve.
     * @param spender The address which will spend the funds
     * @param subtractedValue The amount of tokens to decrease the allowance by
     * @return True if successful
     */
    function decreaseApproval(address spender, uint256 subtractedValue) public whenNotPaused returns (bool) {
        if (_isAddrFrozen(spender) || _isAddrFrozen(msg.sender)) revert AddressFrozen();
        if (subtractedValue == 0) revert ZeroValue();
        if (subtractedValue > allowed[msg.sender][spender]) {
            allowed[msg.sender][spender] = 0;
        } else {
            allowed[msg.sender][spender] -= subtractedValue;
        }
        emit Approval(msg.sender, spender, allowed[msg.sender][spender]);
        return true;
    }

    /**
     * @dev Get the amount of token allowance that an owner allowed to a spender
     * @param owner address The address which owns the funds
     * @param spender address The address which will spend the funds
     * @return A uint256 specifying the amount of tokens still available for the spender
     */
    function allowance(address owner, address spender) public view returns (uint256) {
        return allowed[owner][spender];
    }

    /**
     * @notice Increases the total supply by minting tokens to a specified address
     * @dev V2-compatible mint function. Function is marked virtual to aid in testing, but is never overridden on the actual token.
     * @param value The number of tokens to add
     * @param mintToAddress Address to mint tokens to
     * @return success A boolean that indicates if the operation was successful
     */
    function increaseSupplyToAddress(uint256 value, address mintToAddress) public virtual returns (bool success) {
        if (_isAddrFrozen(mintToAddress)) revert AddressFrozen();
        supplyControl.canMintToAddress(mintToAddress, value, msg.sender);

        totalSupply_ += value;

        // Update aggregated balance if this address has a payout address
        TokenAccountData memory wallet = _getBalanceData(mintToAddress);
        uint256 newBalance = uint256(wallet.balance) + value;

        // Update wallet with payout group (handles invalid payout cleanup internally)
        uint40 currentTime = uint40(block.timestamp);
        _updateWalletWithPayoutGroup(mintToAddress, wallet, newBalance, currentTime);

        emit SupplyIncreased(mintToAddress, value);
        emit Transfer(address(0), mintToAddress, value);
        return true;
    }

    /**
     * @dev Wrapper around 'increaseSupplyToAddress' to extend the API
     * @param value The number of tokens to add.
     * @return success A boolean that indicates if the operation was successful
     */
    function increaseSupply(uint256 value) public returns (bool success) {
        return increaseSupplyToAddress(value, msg.sender);
    }

    /**
     * @dev Wrapper around `increaseSupplyToAddress` to extend the API
     * @param account Address to mint tokens to
     * @param amount The number of tokens to add
     */
    function mint(address account, uint256 amount) public {
        increaseSupplyToAddress(amount, account);
    }

    /**
     * @notice Decreases the total supply by burning tokens from a specified address
     * @dev V2-compatible burn function. Function is marked virtual to aid in testing, but is never overridden on the actual token.
     * @param value The number of tokens to remove
     * @param burnFromAddress Address to burn tokens from
     * @return success A boolean that indicates if the operation was successful
     */
    function decreaseSupplyFromAddress(uint256 value, address burnFromAddress) public virtual returns (bool success) {
        if (_isAddrFrozen(burnFromAddress)) revert AddressFrozen();
        supplyControl.canBurnFromAddress(burnFromAddress, msg.sender);
        uint256 currentBalance = _getBalance(burnFromAddress);
        if (value > currentBalance) revert InsufficientFunds();

        totalSupply_ -= value;

        // Update aggregated balance if this address has a payout address
        TokenAccountData memory wallet = _getBalanceData(burnFromAddress);
        uint256 newBalance = currentBalance - value;

        // Update wallet with payout group (handles invalid payout cleanup internally)
        uint40 currentTime = uint40(block.timestamp);
        _updateWalletWithPayoutGroup(burnFromAddress, wallet, newBalance, currentTime);

        emit SupplyDecreased(burnFromAddress, value);
        emit Transfer(burnFromAddress, address(0), value);
        return true;
    }

    /**
     * @dev Wrapper around 'decreaseSupplyFromAddress' to extend the API
     * @param value The number of tokens to remove.
     * @return success A boolean that indicates if the operation was successful
     */
    function decreaseSupply(uint256 value) public returns (bool success) {
        return decreaseSupplyFromAddress(value, msg.sender);
    }

    /**
     * @dev Wrapper around `decreaseSupply` to extend the API
     * @param amount The number of tokens to remove
     */
    function burn(uint256 amount) public {
        decreaseSupply(amount);
    }

    /**
     * Internal Functions
     */

    /**
     * @dev See {PaxosBaseAbstract-_isPaused}
     * @dev Override required to resolve multiple inheritance (PaxosBaseAbstract + ClaimableRewardsBase)
     */
    function _isPaused() internal view override(PaxosBaseAbstract, ClaimableRewardsBase) returns (bool) {
        return super._isPaused();
    }

    /**
     * @dev See {PaxosBaseAbstract-_isAddrFrozen}
     * @dev Override required to resolve multiple inheritance (PaxosBaseAbstract + ClaimableRewardsBase)
     */
    function _isAddrFrozen(address addr) internal view override(PaxosBaseAbstract, ClaimableRewardsBase) returns (bool) {
        return super._isAddrFrozen(addr);
    }

    /**
     * @dev Internal function to transfer balances from => to.
     * Internal to the contract - see transferFrom and transferFromBatch.
     * @param from address The address which you want to send tokens from
     * @param to address The address which you want to transfer to
     * @param value uint256 the amount of tokens to be transferred
     */
    function _transferFromAllowance(address from, address to, uint256 value) internal {
        if (value > allowed[from][msg.sender]) revert InsufficientAllowance();
        _transfer(from, to, value);
        allowed[from][msg.sender] -= value;
    }

    /**
     * @dev See {PaxosBaseAbstract-_approve}
     * @dev Override required to resolve multiple inheritance (PaxosBaseAbstract + ClaimableRewardsBase)
     */
    function _approve(address owner, address spender, uint256 value) internal override(PaxosBaseAbstract, ClaimableRewardsBase) {
        super._approve(owner, spender, value);
    }

    /**
     * @dev See {PaxosBaseAbstract-_transfer}
     * @dev Override required to resolve multiple inheritance (PaxosBaseAbstract + ClaimableRewardsBase)
     * Delegates to ClaimableRewardsBase implementation
     */
    function _transfer(address from, address to, uint256 value) internal override(PaxosBaseAbstract, ClaimableRewardsBase) {
        super._transfer(from, to, value);
    }

    /**
     * Private Functions
     */

    /**
     * @dev Called on deployment, can only be called once. If the contract is ever upgraded,
     * the version in reinitializer will be incremented and additional initialization logic
     * can be added for the new version.
     * @param pastVersion Previous contract version
     * @param initialDelay Initial delay for changing the owner
     * @param initialOwner Address of the initial owner
     * @param pauser Address of the pauser
     * @param assetProtector Address of the asset protector
     * @param facetCuts Array of FacetCut structs mapping facet addresses to their selectors
     * @param claimSource Address to use as claim source
     * @param minRate Minimum APR bound (10 decimals)
     * @param maxRate Maximum APR bound (10 decimals)
     * @param v3Roles Struct containing addresses for V3 roles
     * @custom:oz-upgrades-validate-as-initializer
     */
    function _initialize(
        uint64 pastVersion,
        uint48 initialDelay,
        address initialOwner,
        address pauser,
        address assetProtector,
        FacetCut[] calldata facetCuts,
        address claimSource,
        uint256 minRate,
        uint256 maxRate,
        V3RoleAddresses calldata v3Roles
    ) private reinitializer(3) {
        _initializeV1(pastVersion);
        _initializeV2(initialDelay, initialOwner, pauser, assetProtector);
        _initializeV3WithConfig(claimSource, minRate, maxRate, v3Roles);
        _registerFacets(facetCuts);
    }

    /**
     * @dev Called on deployment to initialize V1 state. If contract already initialized,
     * it returns immediately.
     * @param pastVersion Previous contract version
     */
    function _initializeV1(uint64 pastVersion) private {
        if (pastVersion < 1 && !initializedV1) {
            totalSupply_ = 0;
            initializedV1 = true;
        }
    }

    /**
     * @dev Called on deployment to initialize V2 state
     * @param initialDelay Initial delay for changing the owner
     * @param initialOwner Address of the initial owner
     * @param pauser Address of the pauser
     * @param assetProtector Address of the assetProtector
     */
    function _initializeV2(
        uint48 initialDelay,
        address initialOwner,
        address pauser,
        address assetProtector
    ) private isNonZeroAddress(pauser) isNonZeroAddress(assetProtector) {
        __AccessControlDefaultAdminRules_init(initialDelay, initialOwner);
        _grantRole(Roles.PAUSE_ROLE, pauser);
        _grantRole(Roles.ASSET_PROTECTION_ROLE, assetProtector);
    }

    /**
     * @dev Initialize V3 state with claimable rewards functionality AND register facets atomically.
     * This ensures that facet functions work immediately after upgrade with no gap.
     *
     * V2→V3 UPGRADE COMPATIBILITY:
     * This public function allows V2 contracts to be upgraded to V3 atomically.
     *
     * @param facetCuts Array of FacetCut structs mapping facet addresses to their selectors
     * @param claimSource Address to use as claim source (where rewards come from)
     * @param minRate Minimum APR bound (10 decimals, e.g., 0 for no minimum)
     * @param maxRate Maximum APR bound (10 decimals, e.g., type(uint40).max for unlimited)
     * @param v3Roles Struct containing addresses for V3 roles (multAdmin, multRateAdmin, etc.)
     */
    function initializeV3(
        FacetCut[] calldata facetCuts,
        address claimSource,
        uint256 minRate,
        uint256 maxRate,
        V3RoleAddresses calldata v3Roles
    ) external reinitializer(3) {
        _initializeV3WithConfig(claimSource, minRate, maxRate, v3Roles);
        _registerFacets(facetCuts);
    }

    /**
     * @dev Private function to initialize V3 state with claimable rewards functionality.
     * This includes role grants, multiplier setup, and global configuration with provided values.
     * @param claimSource Address to use as claim source
     * @param minRate Minimum APR bound (10 decimals)
     * @param maxRate Maximum APR bound (10 decimals)
     * @param v3Roles Struct containing addresses for V3 roles
     */
    function _initializeV3WithConfig(
        address claimSource,
        uint256 minRate,
        uint256 maxRate,
        V3RoleAddresses calldata v3Roles
    ) private {
        // Use shared validation functions (same as setClaimSource and setRateBoundsByAPR)
        _validateClaimSource(claimSource);
        _validateRateBounds(minRate, maxRate);

        // Grant multiplier management roles
        _grantRole(Roles.MULT_ADMIN_ROLE, v3Roles.multAdmin);
        _grantRole(Roles.MULT_RATE_ROLE, v3Roles.multRateAdmin);

        // Grant payout group management roles
        _grantRole(Roles.PAYOUT_GROUP_ADMIN_ROLE, v3Roles.payoutGroupAdmin);
        _grantRole(Roles.PAYOUT_GROUP_REGISTRAR_ROLE, v3Roles.payoutGroupRegistrar);

        // Grant claim roles
        _grantRole(Roles.CLAIM_OPERATOR_ROLE, v3Roles.claimOperator);
        _grantRole(Roles.CLAIM_ADMIN_ROLE, v3Roles.claimAdmin);

        // Initialize multiplier linked list tracking (no pre-created multipliers)
        // Multipliers must be created via createMultiplier() after setting rate bounds
        nextMultiplierId = 1;       // First multiplier will be ID 1
        firstActiveId = 0;          // Empty list
        activeMultiplierCount = 0;  // No multipliers

        // Initialize period settings (hot path)
        globalTransferSettings.maturityPeriod = StorageLib.toUint32RewardPeriod(86400); // 1 day default
        globalTransferSettings.partnerSignedRegistrationsEnabled = false; // Disabled by default
        globalTransferSettings.referenceTime = 0; // Unix epoch (UTC midnight aligned)

        // Initialize admin config settings with PROVIDED values
        adminConfig.claimSource = claimSource;
        adminConfig.minRate = StorageLib.toUint40APR(minRate);
        adminConfig.maxRate = StorageLib.toUint40APR(maxRate);

        // Initialize nextPayoutId (must be in initializer for upgrade safety)
        nextPayoutId = 1; // Start at 1 since 0 means "no payout group"
    }

    /**
     * @dev Register all facet selectors atomically.
     * Selectors are passed as calldata arrays to avoid hardcoding them in bytecode,
     * significantly reducing contract size. Emits FacetUpdate for each selector.
     *
     * @param facetCuts Array of FacetCut structs mapping facet addresses to their selectors
     */
    function _registerFacets(FacetCut[] calldata facetCuts) private {
        for (uint256 i = 0; i < facetCuts.length; ) {
            address facet = facetCuts[i].facet;
            bytes4[] calldata selectors = facetCuts[i].selectors;
            for (uint256 j = 0; j < selectors.length; ) {
                facets[selectors[j]] = facet;
                emit FacetUpdate(selectors[j], facet);
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
    }

    // =============================================================
    // DIAMOND FACET SUPPORT
    // =============================================================

    /**
     * @dev Mapping from function selector to facet address
     */
    mapping(bytes4 => address) public facets;

    /**
     * @dev Event emitted when facet is added/updated/removed
     */
    event FacetUpdate(bytes4 indexed selector, address indexed facet);

    /**
     * @notice Add or update a facet function
     * @dev Only admin can manage facets
     * @param selector The function selector
     * @param facetAddress The facet contract address (zero to remove)
     */
    function setFacet(bytes4 selector, address facetAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        facets[selector] = facetAddress;
        emit FacetUpdate(selector, facetAddress);
    }

    /**
     * @notice Batch set facet functions from one or more facets
     * @dev Uses _registerFacets to apply all cuts. More efficient for setting up multiple facets in one tx.
     * @param facetCuts Array of FacetCut structs (facet address + selectors per facet)
     */
    function batchSetFacet(FacetCut[] calldata facetCuts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _registerFacets(facetCuts);
    }

    /**
     * @notice Get the facet address for a function selector
     * @param selector The function selector
     * @return The facet contract address
     */
    function getFacet(bytes4 selector) external view returns (address) {
        return facets[selector];
    }

    /**
     * @dev Fallback function to delegate calls to facets
     * This handles any function not defined in the main contract
     */
    fallback() external payable {
        address facet = facets[msg.sig];
        if (facet == address(0)) revert FacetNotFound();

        // Use delegatecall to execute facet function in this contract's context
        assembly {
            // Copy calldata
            calldatacopy(0, 0, calldatasize())
            
            // Execute delegatecall
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            
            // Copy return data
            returndatacopy(0, 0, returndatasize())
            
            // Handle return
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    /**
     * @dev Receive function for direct ETH transfers (should not happen in normal operation)
     */
    receive() external payable {
        revert("Direct ETH transfers not supported");
    }

}
