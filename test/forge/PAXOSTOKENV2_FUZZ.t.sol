// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "lib/forge-std/src/Test.sol";
import "../../contracts/PaxosTokenV2.sol";
import "../../contracts/SupplyControl.sol";
import "../../contracts/lib/PaxosBaseAbstract.sol";
import "../../contracts/lib/Roles.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StdInvariant} from "lib/forge-std/src/StdInvariant.sol";

contract PaxosTokenV2Test is StdInvariant, Test {
    PaxosTokenV2 public paxosTokenV2;
    SupplyControl public supplyControl;
    address[] public mintAndBurnAddresses;

    function setUp() public {
        address paxosTokenImpl = address(new PaxosTokenV2());
        address proxy = address(
            new ERC1967Proxy(
                paxosTokenImpl,
                abi.encodeWithSelector(
                    bytes4(keccak256("initialize(uint48,address,address,address)")),
                    0,
                    address(this),
                    address(this),
                    address(this)
                )
            )
        );

        paxosTokenV2 = PaxosTokenV2(proxy);

        // Deploy SupplyControl proxy and initialize it
        address supplyControlImpl = address(new SupplyControl());

        mintAndBurnAddresses = new address[](1);
        mintAndBurnAddresses[0] = address(this);

        SupplyControl.SupplyControllerInitialization[] memory supplyControllers = new SupplyControl.SupplyControllerInitialization[](1);
        supplyControllers[0] = SupplyControl.SupplyControllerInitialization({
            newSupplyController: address(this),
            limitConfig: RateLimit.LimitConfig({
                limitCapacity: 10000,
                refillPerSecond: 5000
            }),
            mintAddressWhitelist: mintAndBurnAddresses,
            allowAnyMintAndBurnAddress: false
        });

        address supplyControlProxy = address(
            new ERC1967Proxy(
                supplyControlImpl,
                abi.encodeWithSelector(
                    SupplyControl.initialize.selector,
                    address(this), // initialOwner
                    address(this), // supplyControllerManager
                    address(0x2e234DAe75C793f67A35089C9d99245E1C58470b), // tokenAddress
                    supplyControllers // supplyControllers
                )
            )
        );
        supplyControl = SupplyControl(supplyControlProxy);

        paxosTokenV2.setSupplyControl(address(supplyControl));

        paxosTokenV2.grantRole(Roles.PAUSE_ROLE, address(this));
        paxosTokenV2.grantRole(Roles.ASSET_PROTECTION_ROLE, address(this));
    }

    function testPausedAccountCantTransfer(address randomAddress) public {
        uint256 transferAmount = uint256(keccak256(abi.encodePacked(randomAddress))) % 1000 * 1e18;

        // Only proceed with valid addresses to avoid testing unnecessary scenarios
        vm.assume(randomAddress != address(0));

        //Ensure the random address has funds. This might require a specific contract method.
        vm.prank(address(this));
        paxosTokenV2.increaseSupply(100);

        paxosTokenV2.transfer(randomAddress, 50);

        paxosTokenV2.pause();

        // Attempt to transfer a random amount from the paused address and expect a revert
        vm.startPrank(randomAddress);
        vm.expectRevert(PaxosBaseAbstract.ContractPaused.selector);
        paxosTokenV2.transfer(randomAddress, transferAmount);
        vm.stopPrank();
    }

    function testFrozenAccountCantTransfer(address randomAddress) public {
        // Only proceed with valid addresses to avoid testing unnecessary scenarios
        vm.assume(randomAddress != address(0));

        vm.prank(address(this));
        paxosTokenV2.freeze(randomAddress);

        // Try to transfer a random amount from the froze address and expect a revert
        uint256 randomAmount = uint256(keccak256(abi.encodePacked(randomAddress))) % 1000;
        vm.prank(randomAddress);
        vm.expectRevert(PaxosBaseAbstract.AddressFrozen.selector);
        paxosTokenV2.transfer(randomAddress, randomAmount * 1e18);
    }

    function testNonSupplyControllerCantChangeSupply(address randomAddress) public {
        // Only proceed with valid addresses to avoid testing unnecessary scenarios
        vm.assume(randomAddress != address(0));
        vm.assume(!supplyControl.hasRole(keccak256("SUPPLY_CONTROLLER_ROLE"), randomAddress));

        // Try to increase the supply from the random address and expect a revert
        uint256 randomAmount = uint256(keccak256(abi.encodePacked(randomAddress))) % 1000;
        vm.prank(randomAddress);
        vm.expectRevert(abi.encodeWithSelector(SupplyControl.AccountMissingSupplyControllerRole.selector, randomAddress));
        paxosTokenV2.increaseSupply(randomAmount * 1e18);

        // Try to decrease the supply from the random address and expect a revert
        vm.prank(randomAddress);
        vm.expectRevert(abi.encodeWithSelector(SupplyControl.AccountMissingSupplyControllerRole.selector, randomAddress));
        paxosTokenV2.decreaseSupply(randomAmount * 1e18);
    }

    function testUnpauseRestoresFunctionality(address randomAddress) public {
        vm.assume(randomAddress != address(0));

        uint256 transferAmount = 100;

        // Mint some tokens and transfer to the random address
        vm.prank(address(this));
        paxosTokenV2.increaseSupply(1000);
        paxosTokenV2.transfer(randomAddress, 100);

        vm.prank(address(this));
        paxosTokenV2.pause();

        // Attempt to transfer and expect a revert
        vm.startPrank(randomAddress);
        vm.expectRevert(PaxosBaseAbstract.ContractPaused.selector);
        paxosTokenV2.transfer(randomAddress, transferAmount);
        vm.stopPrank();

        vm.prank(address(this));
        paxosTokenV2.unpause();

        // Now the transfer should succeed
        vm.prank(randomAddress);
        paxosTokenV2.transfer(randomAddress, transferAmount);
    }

    function testNonAuthorizedAddressCannotPause(address randomAddress) public {
        vm.assume(randomAddress != address(0));

        // Ensure the random address does not have the PAUSE_ROLE
        bool hasPauseRole = paxosTokenV2.hasRole(Roles.PAUSE_ROLE, randomAddress);
        vm.assume(!hasPauseRole);

        // Attempt to pause the contract from a non-authorized address
        vm.prank(randomAddress);
        vm.expectRevert();
        paxosTokenV2.pause();
    }

    function testCannotIncreaseSupplyBeyondRateLimit(uint256 supply) public {
        vm.assume(supply != 0);

        // Increase the supply to the max limit
        vm.prank(address(this));
        paxosTokenV2.increaseSupply(1000);
        paxosTokenV2.increaseSupply(1000);
        paxosTokenV2.increaseSupply(1000);
        paxosTokenV2.increaseSupply(1000);
        paxosTokenV2.increaseSupply(1000);

        // Attempt to exceed the rate limit
        vm.prank(address(this));
        vm.expectRevert(RateLimit.RateLimitExceeded.selector);
        paxosTokenV2.increaseSupply(supply);
    }

    function invariant_totalSupplyIsCorrect() view public {
        // Ensure the total supply is the sum of all balances
        uint256 totalSupply = paxosTokenV2.totalSupply();
        uint256 sumBalances = 0;
        for (uint256 i = 0; i < mintAndBurnAddresses.length; i++) {
            sumBalances += paxosTokenV2.balanceOf(mintAndBurnAddresses[i]);
        }
        assertEq(totalSupply, sumBalances);
    }

    function invariant_supplyControlIsSet() view public {
        // Ensure the supply control address is set
        assertEq(address(paxosTokenV2.supplyControl()), address(supplyControl));
    }
    
}

