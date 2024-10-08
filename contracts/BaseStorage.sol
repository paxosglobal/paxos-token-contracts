// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { SupplyControl } from "./SupplyControl.sol";

/**
 * @title BaseStorage
 * @notice The BaseStorage contract is a storage abstraction contract for the PaxosToken.
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract BaseStorage {
    // Check if contract is initialized until version 1.
    bool internal initializedV1;

    // ERC20 Basic data to capture balances and total supply.
    mapping(address => uint256) internal balances;
    uint256 internal totalSupply_;

    // Storage to keep track of allowances.
    mapping(address => mapping(address => uint256)) internal allowed;

    // Owner of contract: Deprecated.
    address public ownerDeprecated;

    // Represents if the contact is paused or not.
    bool public paused;

    // Asset protection data: Deprecated.
    address public assetProtectionRoleDeprecated;

    // Mapping to keep track of frozen addresses.
    mapping(address => bool) internal frozen;

    // Supply controller of the contract.
    address public supplyControllerDeprecated;

    // Proposed owner of the contract: Deprecated.
    address public proposedOwnerDeprecated;

    // Delegated transfer data: Deprecated.
    address public betaDelegateWhitelisterDeprecated;
    mapping(address => bool) internal betaDelegateWhitelistDeprecated;
    mapping(address => uint256) internal nextSeqsDeprecated;
    // Hash of the EIP712 Domain Separator data: Deprecated.
    // solhint-disable-next-line var-name-mixedcase
    bytes32 public EIP712_DOMAIN_HASH_DEPRECATED;

    // Address of the supply control contract
    SupplyControl public supplyControl;

    // Storage gap: https://docs.openzeppelin.com/upgrades-plugins/1.x/writing-upgradeable#storage-gaps
    uint256[24] __gap_BaseStorage;
}
