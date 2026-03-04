// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Roles } from "./Roles.sol";

/**
 * @title PaxosBaseAbstract contract
 * @dev An abstract contract for Paxos tokens with additional internal functions.
 * @custom:security-contact smart-contract-security@paxos.com
 */
abstract contract PaxosBaseAbstract {
    // All base errors.
    error ZeroAddress();
    error ContractPaused();
    error AlreadyPaused();
    error AlreadyUnPaused();
    error AddressFrozen();
    error InvalidPermission();
    error AccessControlUnauthorizedAccount(address account, bytes32 role);
    error InvalidSignature();
    error ArgumentLengthMismatch();

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     */
    modifier whenNotPaused() virtual {
        if (_isPaused()) revert ContractPaused();
        _;
    }

    /**
     * @dev Modifier to check for zero address.
     */
    modifier isNonZeroAddress(address addr) virtual {
        if (addr == address(0)) revert ZeroAddress();
        _;
    }

    /*
     * @dev Returns the name of the token.
     */
    function name() public view virtual returns (string memory) {
        return "PaxosToken USD";
    }

    /*
     * @dev Returns the symbol of the token.
     */
    function symbol() public view virtual returns (string memory) {
        return "PaxosToken";
    }

    /*
     * @dev Returns the decimal count of the token.
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @dev Set allowance for a given spender, of a given owner.
     * @param owner address The address which owns the funds.
     * @param spender address The address which will spend the funds.
     * @param value uint256 The amount of tokens to increase the allowance by.
     */
    function _approve(address owner, address spender, uint256 value) internal virtual;

    /**
     * @dev Transfer `value` amount `from` => `to`.
     * @param from address The address which you want to send tokens from
     * @param to address The address which you want to send tokens to
     * @param value uint256 the amount of tokens to be transferred
     */
    function _transfer(address from, address to, uint256 value) internal virtual;

    /**
     * @dev Check if contract is paused.
     * @return bool True if the contract is paused, false otherwise.
     */
    function _isPaused() internal view virtual returns (bool);

    /**
     * @dev Internal function to check whether the address is currently frozen by checking
     * the sanctioned list first.
     * @param addr The address to check if frozen.
     * @return A bool representing whether the given address is frozen.
     */
    function _isAddrFrozen(address addr) internal view virtual returns (bool);
}
