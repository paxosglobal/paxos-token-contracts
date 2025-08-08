// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { BaseStorage } from "./BaseStorage.sol";
import { SupplyControl } from "./SupplyControl.sol";
import { EIP2612 } from "./lib/EIP2612.sol";
import { EIP3009 } from "./lib/EIP3009.sol";
import { EIP712 } from "./lib/EIP712.sol";
import { AccessControlDefaultAdminRulesUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlDefaultAdminRulesUpgradeable.sol";

/**
 * @title PaxosTokenV2
 * @dev this contract is a Pausable ERC20 token with Burn and Mint
 * controlled by a `SupplyControl` contract.
 * NOTE: The storage defined here will actually be held in the Proxy
 * contract and all calls to this contract should be made through
 * the proxy, including admin actions done as owner or supplyController.
 * Any call to transfer against this contract should fail
 * with insufficient funds since no tokens will be issued there.
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract PaxosTokenV2 is BaseStorage, EIP2612, EIP3009, AccessControlDefaultAdminRulesUpgradeable {
    /**
     * EVENTS
     */

    // ERC20 BASIC EVENTS
    event Transfer(address indexed from, address indexed to, uint256 value);

    // ERC20 EVENTS
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // PAUSABLE EVENTS
    event Pause();
    event Unpause();

    // ASSET PROTECTION EVENTS
    event FrozenAddressWiped(address indexed addr);
    event FreezeAddress(address indexed addr);
    event UnfreezeAddress(address indexed addr);

    // SUPPLY CONTROL EVENTS
    event SupplyIncreased(address indexed to, uint256 value);
    event SupplyDecreased(address indexed from, uint256 value);
    event SupplyControlSet(address supplyControlAddress);

    // Event when sanction address changes.
    event SanctionedAddressListUpdate(address newSanctionedAddress);

    /**
     * ERRORS
     */
    error OnlySupplyController();
    error InsufficientFunds();
    error AddressNotFrozen();
    error ZeroValue();
    error AlreadyPaused();
    error AlreadyUnPaused();
    error InsufficientAllowance();
    error SupplyControllerUnchanged();
    error OnlySupplyControllerOrOwner();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * External Functions
     */

    /**
     * @notice Reclaim all tokens at the contract address
     * @dev Transfers the tokens this contract holds, to the owner of smart contract.
     * Note: This is not affected by freeze constraints.
     */
    function reclaimToken() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 _balance = balances[address(this)];
        address owner = owner();
        balances[address(this)] = 0;
        balances[owner] += _balance;
        emit Transfer(address(this), owner, _balance);
    }

    /**
     * @dev Update the supply control contract which controls minting and burning for this token.
     * @param supplyControlAddress Supply control contract address
     */
    function setSupplyControl(
        address supplyControlAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) isNonZeroAddress(supplyControlAddress) {
        supplyControl = SupplyControl(supplyControlAddress);
        emit SupplyControlSet(supplyControlAddress);
    }

    /**
     * @notice Return the freeze status of an address.
     * @dev Check if whether the address is currently frozen.
     * @param addr The address to check if frozen.
     * @return A bool representing whether the given address is frozen.
     */
    function isFrozen(address addr) external view returns (bool) {
        return _isAddrFrozen(addr);
    }

    /**
     * Public Functions
     */

    /**
     * @notice Initialize the contract.
     * @dev Wrapper around {_initialize}. This is useful to get the version before
     * it is updated by {reinitializer}.
     * @param initialDelay Initial delay for changing the owner
     * @param initialOwner Address of the initial owner
     * @param pauser Address of the pauser
     * @param assetProtector Address of the asset protector
     */
    function initialize(uint48 initialDelay, address initialOwner, address pauser, address assetProtector) public {
        uint64 pastVersion = _getInitializedVersion();
        _initialize(pastVersion, initialDelay, initialOwner, pauser, assetProtector);
    }

    /**
     * @notice Initialize the domain separator for the contract.
     * @dev This is public to allow for updates to the domain separator if the name is updated.
     */
    function initializeDomainSeparator() public {
        _initializeDomainSeparator();
    }

    /**
     * @notice Returns the total supply of the token.
     * @return An uint256 representing the total supply of the token.
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
     * @notice Gets the balance of the specified address
     * @param addr The address to query the the balance of
     * @return An uint256 representing the amount owned by the passed address
     */
    function balanceOf(address addr) public view returns (uint256) {
        return balances[addr];
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
     * @notice Pause the contract
     * @dev called by the owner to pause, triggers stopped state
     */
    function pause() public onlyRole(PAUSE_ROLE) {
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Pause();
    }

    /**
     * @notice Unpause the contract
     * @dev called by the owner to unpause, returns to normal state
     */
    function unpause() public onlyRole(PAUSE_ROLE) {
        if (!paused) revert AlreadyUnPaused();
        paused = false;
        emit Unpause();
    }

    // ASSET PROTECTION FUNCTIONALITY
    /**
     * @notice Wipe the token balance of a frozen address
     * @dev Wipes the balance of a frozen address, and burns the tokens
     * @param addr The new frozen address to wipe
     */
    function wipeFrozenAddress(address addr) public onlyRole(ASSET_PROTECTION_ROLE) {
        if (!_isAddrFrozen(addr)) revert AddressNotFrozen();
        uint256 balance = balances[addr];
        balances[addr] = 0;
        totalSupply_ -= balance;
        emit FrozenAddressWiped(addr);
        emit SupplyDecreased(addr, balance);
        emit Transfer(addr, address(0), balance);
    }

    /**
     * @dev Freezes an address balance from being transferred.
     * @param addr The address to freeze.
     */
    function freeze(address addr) public onlyRole(ASSET_PROTECTION_ROLE) {
        _freeze(addr);
    }

    /**
     * @dev Freezes all addresses balance from being transferred.
     * @param addresses The addresses to freeze.
     */
    function freezeBatch(address[] calldata addresses) public onlyRole(ASSET_PROTECTION_ROLE) {
        for (uint256 i = 0; i < addresses.length; ) {
            _freeze(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @dev Unfreezes an address balance allowing transfer.
     * @param addr The new address to unfreeze.
     */
    function unfreeze(address addr) public onlyRole(ASSET_PROTECTION_ROLE) {
        _unfreeze(addr);
    }

    /**
     * @dev Unfreezes all addresses balance from being transferred.
     * @param addresses The addresses to unfreeze.
     */
    function unfreezeBatch(address[] calldata addresses) public onlyRole(ASSET_PROTECTION_ROLE) {
        for (uint256 i = 0; i < addresses.length; ) {
            _unfreeze(addresses[i]);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Increases the total supply by minting the specified number of tokens to the supply controller account.
     * Function is marked virtual to aid in testing, but is never overridden on the actual token.
     * @param value The number of tokens to add
     * @param mintToAddress Address to mint tokens to.
     * @return success A boolean that indicates if the operation was successful
     */
    function increaseSupplyToAddress(uint256 value, address mintToAddress) public virtual returns (bool success) {
        require(!_isAddrFrozen(mintToAddress), "mintToAddress frozen");
        supplyControl.canMintToAddress(mintToAddress, value, msg.sender);

        totalSupply_ += value;
        balances[mintToAddress] += value;
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
     * @notice Decreases the total supply by burning the specified number of tokens.  Can only be called by a
     * supply controller. Function is marked virtual to aid in testing, but is never overridden on the actual token.
     * @param value The number of tokens to remove
     * @param burnFromAddress Address to burn tokens from.
     * @return success A boolean that indicates if the operation was successful
     */
    function decreaseSupplyFromAddress(uint256 value, address burnFromAddress) public virtual returns (bool success) {
        require(!_isAddrFrozen(burnFromAddress), "burnFromAddress frozen");
        supplyControl.canBurnFromAddress(burnFromAddress, msg.sender);
        if (value > balances[burnFromAddress]) revert InsufficientFunds();

        balances[burnFromAddress] -= value;
        totalSupply_ -= value;
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
     */
    function _isPaused() internal view override returns (bool) {
        return paused;
    }

    /**
     * @dev See {PaxosBaseAbstract-_isAddrFrozen}
     */
    function _isAddrFrozen(address addr) internal view override returns (bool) {
        return frozen[addr];
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
     */
    function _approve(address owner, address spender, uint256 value) internal override {
        allowed[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /**
     * @dev See {PaxosBaseAbstract-_transfer}
     */
    function _transfer(address from, address to, uint256 value) internal override isNonZeroAddress(to) {
        if (_isAddrFrozen(to) || _isAddrFrozen(from)) revert AddressFrozen();
        if (value > balances[from]) revert InsufficientFunds();

        balances[from] -= value;
        balances[to] += value;
        emit Transfer(from, to, value);
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
     */
    function _initialize(
        uint64 pastVersion,
        uint48 initialDelay,
        address initialOwner,
        address pauser,
        address assetProtector
    ) private reinitializer(2) {
        _initializeV1(pastVersion);
        _initializeV2(initialDelay, initialOwner, pauser, assetProtector);
    }

    /**
     * @dev Called on deployment to initialize V1 state. If contract already initialized,
     * it returns immediately.
     * @param pastVersion Previous contract version
     */
    function _initializeV1(uint64 pastVersion) private {
        if (pastVersion < 1 && !initializedV1) {
            //Need this second condition since V1 could have used old upgrade pattern
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
        _grantRole(PAUSE_ROLE, pauser);
        _grantRole(ASSET_PROTECTION_ROLE, assetProtector);
        _initializeDomainSeparator();
    }

    /**
     * @dev Private function to initialize the domain separator for the contract.
     */
    function _initializeDomainSeparator() private {
        DOMAIN_SEPARATOR = EIP712._makeDomainSeparator(name(), "1");
    }

    /**
     * @dev Private function to Freezes an address balance from being transferred.
     * @param addr The addresses to freeze.
     */
    function _freeze(address addr) private {
        frozen[addr] = true;
        emit FreezeAddress(addr);
    }

    /**
     * @dev Private function to Unfreezes an address balance from being transferred.
     * @param addr The addresses to unfreeze.
     */
    function _unfreeze(address addr) private {
        delete frozen[addr];
        emit UnfreezeAddress(addr);
    }
}
