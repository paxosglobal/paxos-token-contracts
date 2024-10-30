// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { AccessControlDefaultAdminRulesUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlDefaultAdminRulesUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { DoubleEndedQueue } from "@openzeppelin/contracts/utils/structs/DoubleEndedQueue.sol";
import { PaxosBaseAbstract } from "./lib/PaxosBaseAbstract.sol";
import { RateLimit } from "./lib/RateLimit.sol";

/**
 * @title SupplyControl
 * @dev control the token supply. The `SUPPLY_CONTROLLER_MANAGER_ROLE` role is responsible for managing
 * addresses with the `SUPPLY_CONTROLLER_ROLE`, referred to as supplyControllers. Only supplyControllers can
 * mint and burn tokens. SupplyControllers can optionally have rate limits to limit how many tokens can be
 * minted over a given time frame.
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract SupplyControl is AccessControlDefaultAdminRulesUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;
    // Access control roles
    // keccak256("SUPPLY_CONTROLLER_MANAGER_ROLE")
    // Can add, update, and remove `SupplyController`s
    bytes32 public constant SUPPLY_CONTROLLER_MANAGER_ROLE =
        0x5d3e9f1ecbcdad7b0da30e7d29c9eddaef83a4502dafe3d2dd85cfdb12e4af10;
    // keccak256("SUPPLY_CONTROLLER_ROLE")
    // Can mint/burn tokens
    bytes32 public constant SUPPLY_CONTROLLER_ROLE = 0x9c00d6f280439b1dfa4da90321e0a3f3c2e87280f4d07fea9fa43ff2cf02df2b;
    // keccak256("TOKEN_CONTRACT_ROLE")
    // Tracks the token contract to protect functions which impact rate limits
    bytes32 public constant TOKEN_CONTRACT_ROLE = 0xd32fd1ee5f4f111da6f27444787e5200ec57a8849509c00ef2998467052b32a3;

    // SUPPLY CONTROL DATA
    mapping(address => SupplyController) internal supplyControllerMap;

    //Used to get all supply controllers
    EnumerableSet.AddressSet internal supplyControllerSet;

    uint256[35] private __gap_SC; // solhint-disable-line var-name-mixedcase

    /**
     * @dev Struct defines a supply controller. Different supply controllers can have different rules.
     * @param rateLimit Contract which handles rate limit logic
     * @param mintAddressWhitelist Addresses the {SupplyController} can mint to
     * @param allowAnyMintAndBurnAddress If true, allows the supply controller to mint to and burn from any address
     */
    struct SupplyController {
        RateLimit.Storage rateLimitStorage;
        EnumerableSet.AddressSet mintAddressWhitelist;
        bool allowAnyMintAndBurnAddress;
    }

    /**
     * @dev Struct defines the configuration needed when creating a new supply controller.
     * @param newSupplyController Address of the new supply controller
     * @param limitConfig Limit configuration
     * @param mintAddressWhitelist Addresses the supply controller can mint to
     * @param allowAnyMintAndBurnAddress If true, allows the supply controller to mint to and burn from any address
     */
    struct SupplyControllerInitialization {
        address newSupplyController;
        RateLimit.LimitConfig limitConfig;
        address[] mintAddressWhitelist;
        bool allowAnyMintAndBurnAddress;
    }

    /**
     * @dev Emitted when {addSupplyController} is called.
     * @param newSupplyController Address of the new supply controller
     * @param limitCapacity Max amount for the rate limit. Checked in `_checkCurrentPeriodAmount`
     * @param refillPerSecond Amount to add to limit each second up to the `limitCapacity`
     * @param mintAddressWhitelist Addresses the supply controller can mint to
     * @param allowAnyMintAndBurnAddress If true, allows the supply controller to mint to and burn from any address
     */
    event SupplyControllerAdded(
        address indexed newSupplyController,
        uint256 limitCapacity,
        uint256 refillPerSecond,
        address[] mintAddressWhitelist,
        bool allowAnyMintAndBurnAddress
    );

    /**
     * @dev Emitted when {removeSupplyController} is called.
     * @param oldSupplyController The old supply controller address
     */
    event SupplyControllerRemoved(address indexed oldSupplyController);

    /**
     * @dev Emitted when limit configuration is updated for `supplyController`.
     * Occurs when {updateLimitConfig} is called.
     * @param supplyController Supply controller address
     * @param newLimitConfig New limit configuration
     * @param oldLimitConfig Old limit configuration
     */
    event LimitConfigUpdated(
        address indexed supplyController,
        RateLimit.LimitConfig newLimitConfig,
        RateLimit.LimitConfig oldLimitConfig
    );

    /**
     * @dev Emitted when `allowAnyMintAndBurnAddress` is updated for `supplyController`.
     * Occurs when {updateAllowAnyMintAndBurnAddress} is called.
     * @param supplyController Supply controller address
     * @param newAllowAnyMintAndBurnAddress New allow config
     * @param oldAllowAnyMintAndBurnAddress Old allow config
     */
    event AllowAnyMintAndBurnAddressUpdated(
        address indexed supplyController,
        bool newAllowAnyMintAndBurnAddress,
        bool oldAllowAnyMintAndBurnAddress
    );

    /**
     * @dev Emitted when `mintAddress` is added to `mintAddressWhitelist` in `supplyController`.
     * Occurs when {addMintAddressToWhitelist} is called
     * @param supplyController Supply controller address
     * @param mintAddress New address which can be minted to
     */
    event MintAddressAddedToWhitelist(address indexed supplyController, address indexed mintAddress);

    /**
     * @dev Emitted when `mintAddress` is removed from `mintAddressWhitelist` in `supplyController`.
     * Occurs when {removeMintAddressFromWhitelist} is called
     * @param supplyController Supply controller address
     * @param mintAddress Address which can no longer be minted to
     */
    event MintAddressRemovedFromWhitelist(address indexed supplyController, address indexed mintAddress);

    error AccountMissingSupplyControllerRole(address account);
    error AccountAlreadyHasSupplyControllerRole(address account);
    error CannotMintToAddress(address supplyController, address mintToAddress);
    error CannotBurnFromAddress(address supplyController, address burnFromAddress);
    error CannotAddDuplicateAddress(address addressToAdd);
    error CannotRemoveNonExistantAddress(address addressToRemove);
    error ZeroAddress();

    /**
     * @dev Modifier which checks that the specified `supplyController` address has the SUPPLY_CONTROLLER_ROLE
     * @param supplyController Supply controller address
     */
    modifier onlySupplyController(address supplyController) {
        if (!hasRole(SUPPLY_CONTROLLER_ROLE, supplyController)) {
            revert AccountMissingSupplyControllerRole(supplyController);
        }
        _;
    }

    /**
     * @dev Modifier which checks that the specified `supplyController` address does not have the SUPPLY_CONTROLLER_ROLE
     * @param supplyController Supply controller address
     */
    modifier notSupplyController(address supplyController) {
        if (hasRole(SUPPLY_CONTROLLER_ROLE, supplyController)) {
            revert AccountAlreadyHasSupplyControllerRole(supplyController);
        }
        _;
    }

    /**
     * @dev Modifier to check for zero address.
     */
    modifier isNonZeroAddress(address addr) {
        if (addr == address(0)) {
            revert ZeroAddress();
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializer for SupplyControl.
     * Proper order of setting up the contracts:
     *  1. Deploy/reinitialize PaxosToken
     *  2. Deploy SupplyControl with `SupplyControllerInitialization` config
     *  3. Set SupplyControl address in PaxosToken via `setSupplyControl`
     * @param initialOwner Initial owner address
     * @param supplyControllerManager SupplyControllerManager address
     * @param tokenAddress Token contract address
     * @param scInitializationConfig Configuration to initialize a list of supply controllers
     */
    function initialize(
        address initialOwner,
        address supplyControllerManager,
        address tokenAddress,
        SupplyControllerInitialization[] calldata scInitializationConfig
    ) external initializer isNonZeroAddress(supplyControllerManager) isNonZeroAddress(tokenAddress) {
        __AccessControlDefaultAdminRules_init(3 hours, initialOwner);
        __UUPSUpgradeable_init();
        _grantRole(SUPPLY_CONTROLLER_MANAGER_ROLE, supplyControllerManager);
        _grantRole(TOKEN_CONTRACT_ROLE, tokenAddress);
        for (uint256 i = 0; i < scInitializationConfig.length; ) {
            _addSupplyController(scInitializationConfig[i]);
            unchecked {
                i++;
            }
        }
    }

    /**
     * @dev Adds a new supply controller which can be used to control the supply of a token.
     * Can be called externally by the `SUPPLY_CONTROLLER_MANAGER_ROLE`.
     * @param newSupplyController Address of the new supply controller
     * @param limitCapacity Max amount for the rate limit.
     * @param refillPerSecond Amount to add to limit each second up to the `limitCapacity`
     * @param mintAddressWhitelist Addresses the supply controller can mint to
     * @param allowAnyMintAndBurnAddress If true, allows the supply controller to mint to and burn from any address
     */
    function addSupplyController(
        address newSupplyController,
        uint256 limitCapacity,
        uint256 refillPerSecond,
        address[] memory mintAddressWhitelist,
        bool allowAnyMintAndBurnAddress
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) {
        RateLimit.LimitConfig memory limitConfig = RateLimit.LimitConfig(limitCapacity, refillPerSecond);
        SupplyControllerInitialization memory scInitializationConfig = SupplyControllerInitialization(
            newSupplyController,
            limitConfig,
            mintAddressWhitelist,
            allowAnyMintAndBurnAddress
        );
        _addSupplyController(scInitializationConfig);
    }

    /**
     * @dev Removes `oldSupplyController`
     * @param oldSupplyController The old supply controller address
     */
    function removeSupplyController(
        address oldSupplyController
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) onlySupplyController(oldSupplyController) {
        _revokeRole(SUPPLY_CONTROLLER_ROLE, oldSupplyController);
        SupplyController storage supplyController = supplyControllerMap[oldSupplyController];
        _removeAddressSet(supplyController.mintAddressWhitelist);
        EnumerableSet.remove(supplyControllerSet, oldSupplyController);
        delete supplyControllerMap[oldSupplyController];
        emit SupplyControllerRemoved(oldSupplyController);
    }

    /**
     * Update limit configuration
     * @param supplyController_ Supply controller address.
     * @param limitCapacity Max amount for the rate limit
     * @param refillPerSecond Amount to add to limit each second up to the `limitCapacity`
     */
    function updateLimitConfig(
        address supplyController_,
        uint256 limitCapacity,
        uint256 refillPerSecond
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) onlySupplyController(supplyController_) {
        RateLimit.LimitConfig memory limitConfig = RateLimit.LimitConfig(limitCapacity, refillPerSecond);
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        RateLimit.LimitConfig memory oldLimitConfig = supplyController.rateLimitStorage.limitConfig;
        supplyController.rateLimitStorage.limitConfig = limitConfig;
        emit LimitConfigUpdated(supplyController_, limitConfig, oldLimitConfig);
    }

    function updateAllowAnyMintAndBurnAddress(
        address supplyController_,
        bool allowAnyMintAndBurnAddress
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) onlySupplyController(supplyController_) {
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        bool oldAllowValue = supplyController.allowAnyMintAndBurnAddress;
        supplyController.allowAnyMintAndBurnAddress = allowAnyMintAndBurnAddress;
        emit AllowAnyMintAndBurnAddressUpdated(supplyController_, allowAnyMintAndBurnAddress, oldAllowValue);
    }

    /**
     * @dev Adds `mintAddress` to `mintAddressWhitelist` in `supplyController`.
     * @param supplyController_ Supply controller address
     * @param mintAddress Address which can be minted to
     */
    function addMintAddressToWhitelist(
        address supplyController_,
        address mintAddress
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) onlySupplyController(supplyController_) {
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        if (EnumerableSet.contains(supplyController.mintAddressWhitelist, mintAddress)) {
            revert CannotAddDuplicateAddress(mintAddress);
        }
        EnumerableSet.add(supplyController.mintAddressWhitelist, mintAddress);
        emit MintAddressAddedToWhitelist(supplyController_, mintAddress);
    }

    /**
     * @dev Removes `mintAddress` from `mintAddressWhitelist` in `supplyController`.
     * @param supplyController_ Supply controller address
     * @param mintAddress Address which can no longer be minted to
     */
    function removeMintAddressFromWhitelist(
        address supplyController_,
        address mintAddress
    ) external onlyRole(SUPPLY_CONTROLLER_MANAGER_ROLE) onlySupplyController(supplyController_) {
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        if (!EnumerableSet.contains(supplyController.mintAddressWhitelist, mintAddress)) {
            revert CannotRemoveNonExistantAddress(mintAddress);
        }

        EnumerableSet.remove(supplyController.mintAddressWhitelist, mintAddress);
        emit MintAddressRemovedFromWhitelist(supplyController_, mintAddress);
    }

    /**
     * @dev Gets supply controller configuration
     * @param supplyController_ Supply controller address
     */
    function getSupplyControllerConfig(
        address supplyController_
    )
        external
        view
        onlySupplyController(supplyController_)
        returns (
            RateLimit.LimitConfig memory limitConfig,
            address[] memory mintAddressWhitelist,
            bool allowAnyMintAndBurnAddress
        )
    {
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        RateLimit.LimitConfig memory limitConfig_ = supplyController.rateLimitStorage.limitConfig;
        address[] memory mintAddressWhitelist_ = EnumerableSet.values(
            supplyControllerMap[supplyController_].mintAddressWhitelist
        );
        return (limitConfig_, mintAddressWhitelist_, supplyController.allowAnyMintAndBurnAddress);
    }

    /**
     * @dev Gets all supply controller addresses
     */
    function getAllSupplyControllerAddresses() external view returns (address[] memory) {
        return EnumerableSet.values(supplyControllerSet);
    }

    /**
     * @dev Get remaining amount which can be minted at `timestamp`
     * @param supplyController_ Supply controller address
     * @param timestamp Time to check remaining amount for
     */
    function getRemainingMintAmount(
        address supplyController_,
        uint256 timestamp
    ) external view onlySupplyController(supplyController_) returns (uint256) {
        SupplyController storage supplyController = supplyControllerMap[supplyController_];
        RateLimit.Storage storage limitStorage = supplyController.rateLimitStorage;
        return RateLimit.getRemainingAmount(timestamp, limitStorage);
    }

    /**
     * @dev Function which checks that `mintToAddress` is in the whitelisted map for msg.sender
     * and the amount does not exceed the rate limit
     * @param mintToAddress Mint to address
     * @param amount Amount to check
     * @param sender Supply controller address
     */
    function canMintToAddress(
        address mintToAddress,
        uint256 amount,
        address sender
    ) external onlySupplyController(sender) onlyRole(TOKEN_CONTRACT_ROLE) {
        SupplyController storage supplyController = supplyControllerMap[sender];
        if (
            !supplyController.allowAnyMintAndBurnAddress &&
            !EnumerableSet.contains(supplyController.mintAddressWhitelist, mintToAddress)
        ) {
            revert CannotMintToAddress(sender, mintToAddress);
        }
        RateLimit.Storage storage limitStorage = supplyController.rateLimitStorage;
        RateLimit.checkNewEvent(block.timestamp, amount, limitStorage);
    }

    /**
     * @dev Function which checks that `burnFromAddress` is the 'sender' or that the 'sender' is allowed to burn
     * from any address.
     * Also checks that the `sender` is a supply controller since only a supply controller can burn tokens.
     * @param burnFromAddress Burn from address
     * @param sender Supply controller address
     */
    function canBurnFromAddress(address burnFromAddress, address sender) external view onlySupplyController(sender) {
        SupplyController storage supplyController = supplyControllerMap[sender];
        if (!supplyController.allowAnyMintAndBurnAddress && sender != burnFromAddress) {
            revert CannotBurnFromAddress(sender, burnFromAddress);
        }
    }

    /**
     * @dev Adds a new supply controller which can be used to control the supply of a token.
     * Can only be called internally.
     * @param scInitializationConfig Configuration to setup a new supply controller
     */
    function _addSupplyController(
        SupplyControllerInitialization memory scInitializationConfig
    )
        internal
        notSupplyController(scInitializationConfig.newSupplyController)
        isNonZeroAddress(scInitializationConfig.newSupplyController)
    {
        SupplyController storage supplyController = supplyControllerMap[scInitializationConfig.newSupplyController];
        supplyController.rateLimitStorage.limitConfig = scInitializationConfig.limitConfig;
        supplyController.allowAnyMintAndBurnAddress = scInitializationConfig.allowAnyMintAndBurnAddress;
        _addressArrayToSet(scInitializationConfig.mintAddressWhitelist, supplyController.mintAddressWhitelist);
        _grantRole(SUPPLY_CONTROLLER_ROLE, scInitializationConfig.newSupplyController);
        EnumerableSet.add(supplyControllerSet, scInitializationConfig.newSupplyController);
        emit SupplyControllerAdded(
            scInitializationConfig.newSupplyController,
            scInitializationConfig.limitConfig.limitCapacity,
            scInitializationConfig.limitConfig.refillPerSecond,
            scInitializationConfig.mintAddressWhitelist,
            scInitializationConfig.allowAnyMintAndBurnAddress
        );
    }

    /**
     * @dev required by the OZ UUPS module to authorize an upgrade
     * of the contract. Restricted to DEFAULT_ADMIN_ROLE.
     */
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {} // solhint-disable-line no-empty-blocks

    /**
     * @dev Helper function for setting `mintAddressWhitelist`
     * @param addressArray Array containing mint addresses
     * @param addressSet Set which addresses should be added to
     */
    function _addressArrayToSet(address[] memory addressArray, EnumerableSet.AddressSet storage addressSet) private {
        for (uint256 i = 0; i < addressArray.length; ) {
            EnumerableSet.add(addressSet, addressArray[i]);
            unchecked {
                i++;
            }
        }
    }

    /**
     * @dev Helper function for removing all addresses from `mintAddressWhitelist`
     * Removes elements in reverse order to reduce array reordering and improve gas efficiency
     * @param addressSet Set of addresses
     */
    function _removeAddressSet(EnumerableSet.AddressSet storage addressSet) private {
        uint256 length = EnumerableSet.length(addressSet);
        for (uint256 i = length; i > 0; ) {
            unchecked {
                i--;
            }
            EnumerableSet.remove(addressSet, EnumerableSet.at(addressSet, i));
        }
    }
}
