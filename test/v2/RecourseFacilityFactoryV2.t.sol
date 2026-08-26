// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {RecourseFacilityFactoryV2} from "../../contracts/v2/RecourseFacilityFactoryV2.sol";

contract RecourseFacilityFactoryV2Test is Test {
    RecourseFacilityFactoryV2 internal factory;
    address internal guardian = address(0xA11CE);
    address internal token = address(0x1000);
    address internal kernel = address(0x2000);
    address internal lender = address(0x3000);
    address internal borrower = address(0x4000);

    function setUp() public {
        factory = new RecourseFacilityFactoryV2(guardian);
    }

    function test_permissionlessCreationEmitsAndIndexesFacility() public {
        vm.expectEmit(false, true, true, false);
        emit RecourseFacilityFactoryV2.FacilityCreated(address(0), lender, borrower, IERC20(token), kernel);
        address created = factory.createFacility(
            IERC20(token), kernel, lender, borrower, 1_000e6, 200e6, 200, uint64(block.number + 100), 10
        );

        assertEq(factory.facilityCount(), 1);
        assertEq(factory.facilityAt(0), created);
        assertTrue(factory.isFacility(created));
        assertEq(address(RecourseFacilityV2(created).asset()), token);
        assertEq(RecourseFacilityV2(created).kernel(), kernel);
    }

    function test_onlyGuardianCanPauseCreation() public {
        vm.expectRevert();
        factory.setCreationPaused(true);

        vm.prank(guardian);
        factory.setCreationPaused(true);
        assertTrue(factory.creationPaused());
    }

    function test_guardianPauseBlocksOnlyNewCreation() public {
        address existing = _create();
        vm.prank(guardian);
        factory.setCreationPaused(true);

        vm.expectRevert();
        _create();
        assertTrue(factory.isFacility(existing));
        assertEq(factory.facilityCount(), 1);
    }

    function test_zeroGuardianRejected() public {
        vm.expectRevert();
        new RecourseFacilityFactoryV2(address(0));
    }

    function _create() internal returns (address) {
        return factory.createFacility(
            IERC20(token), kernel, lender, borrower, 1_000e6, 200e6, 200, uint64(block.number + 100), 10
        );
    }
}
