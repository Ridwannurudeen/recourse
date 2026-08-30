// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CappedPilotFactoryV1} from "../../contracts/v3/CappedPilotFactoryV1.sol";
import {RecourseFacilityV3} from "../../contracts/v3/RecourseFacilityV3.sol";

contract CappedPilotFactoryV1Test is Test {
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant GUARDIAN = address(0xC3);
    IERC20 private constant ASSET = IERC20(address(0xD4));
    address private constant KERNEL = address(0xE5);

    CappedPilotFactoryV1 private factory;

    function setUp() public {
        factory =
            new CappedPilotFactoryV1(ASSET, KERNEL, LENDER, BORROWER, GUARDIAN, 1_000, 2_000, 2_000, 300, 1_000, 20, 2);
    }

    function test_lenderCreatesOnlyWithinEveryBound() public {
        vm.prank(LENDER);
        address created = factory.createFacility(1_000, 200, 300, uint64(block.number + 1_000), 20);

        assertTrue(factory.isFacility(created));
        assertEq(factory.facilityCount(), 1);
        assertEq(factory.facilityAt(0), created);
        assertEq(factory.totalFacilityLimit(), 1_000);
        assertEq(address(RecourseFacilityV3(created).asset()), address(ASSET));
        assertEq(RecourseFacilityV3(created).lender(), LENDER);
        assertEq(RecourseFacilityV3(created).borrower(), BORROWER);
    }

    function test_unauthorizedCallerCannotConsumePilotCapacity() public {
        vm.expectRevert(CappedPilotFactoryV1.NotLender.selector);
        factory.createFacility(1_000, 200, 300, uint64(block.number + 1_000), 20);
        assertEq(factory.facilityCount(), 0);
        assertEq(factory.totalFacilityLimit(), 0);
    }

    function test_guardianPauseAndAllEconomicBoundsAreEnforced() public {
        vm.prank(GUARDIAN);
        factory.setCreationPaused(true);
        vm.expectRevert(CappedPilotFactoryV1.CreationPaused.selector);
        vm.prank(LENDER);
        factory.createFacility(1_000, 200, 300, uint64(block.number + 1_000), 20);

        vm.prank(GUARDIAN);
        factory.setCreationPaused(false);
        _expectCreateRevert(CappedPilotFactoryV1.FacilityLimitExceeded.selector, 1_001, 201, 300, 1_000, 20);
        _expectCreateRevert(CappedPilotFactoryV1.InvalidBond.selector, 1_000, 199, 300, 1_000, 20);
        _expectCreateRevert(CappedPilotFactoryV1.InvalidDrawFee.selector, 1_000, 200, 301, 1_000, 20);
        _expectCreateRevert(CappedPilotFactoryV1.InvalidMaturity.selector, 1_000, 200, 300, 0, 20);
        _expectCreateRevert(CappedPilotFactoryV1.InvalidMaturity.selector, 1_000, 200, 300, 1_001, 20);
        _expectCreateRevert(CappedPilotFactoryV1.InvalidMaturity.selector, 1_000, 200, 300, 1_000, 21);
    }

    function test_aggregateAndCountCapsCannotBeExceeded() public {
        vm.startPrank(LENDER);
        factory.createFacility(1_000, 200, 100, uint64(block.number + 100), 1);
        factory.createFacility(1_000, 200, 100, uint64(block.number + 100), 1);
        vm.expectRevert(CappedPilotFactoryV1.FacilityCountExceeded.selector);
        factory.createFacility(1, 1, 0, uint64(block.number + 1), 0);
        vm.stopPrank();
    }

    function test_invalidImmutableGuardrailsAreRejected() public {
        vm.expectRevert(CappedPilotFactoryV1.InvalidParameters.selector);
        new CappedPilotFactoryV1(ASSET, KERNEL, LENDER, BORROWER, GUARDIAN, 1_000, 999, 2_000, 300, 1_000, 20, 2);
    }

    function _expectCreateRevert(
        bytes4 selector,
        uint256 limit,
        uint256 bond,
        uint16 fee,
        uint64 maturityDelta,
        uint32 delay
    ) private {
        vm.expectRevert(selector);
        vm.prank(LENDER);
        factory.createFacility(limit, bond, fee, uint64(block.number) + maturityDelta, delay);
    }
}
