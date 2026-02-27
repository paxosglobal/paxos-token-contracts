// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PaxosTokenV2 } from "../PaxosTokenV2.sol";

/**
 * @title USDGv2 Smart contract (Pre-RebaseClaims Archive)
 * @dev This contract is a PaxosTokenV2 ERC20 token representing USDG before V3 upgrade.
 *      Archived version of USDG before upgrade to PaxosTokenRebaseClaims (V3).
 *      Uses PaxosTokenV2 which inherits from BaseStorage with simple storage format.
 *
 * STORAGE FORMAT (V2 - Simple Storage):
 * =====================================
 * - mapping(address => uint256) balances (slot 1)
 * - mapping(address => bool) frozen (slot 7)
 *
 * This allows proper testing of V2→V3 upgrade migration to packed storage:
 * - mapping(address => BalanceData) balanceData (slot 1, packed struct)
 * - mapping(address => uint8) tokenAccountFlags (slot 7, bit-packed flags)
 *
 * The upgrade test validates that data is preserved through slot-level reinterpretation.
 *
 * @custom:security-contact smart-contract-security@paxos.com
 */
contract USDGv2 is PaxosTokenV2, UUPSUpgradeable {
    /**
     * @dev Returns the name of the token.
     */
    function name() public view virtual override returns (string memory) {
        return "Global Dollar";
    }

    /**
     * @dev Returns the symbol of the token.
     */
    function symbol() public view virtual override returns (string memory) {
        return "USDG";
    }

    /**
     * @dev Returns the decimal count of the token.
     */
    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    /**
     * @dev required by the OZ UUPS module to authorize an upgrade 
     * of the contract. Restricted to DEFAULT_ADMIN_ROLE.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {} // solhint-disable-line no-empty-blocks
}