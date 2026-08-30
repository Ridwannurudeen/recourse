// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RecourseFacilityV3} from "../../contracts/v3/RecourseFacilityV3.sol";

contract FacilityV3InvariantToken is ERC20 {
    constructor() ERC20("Facility V3 Invariant USD", "FV3") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract FacilityV3InvariantKernel {
    bytes32 public constant COMMITMENT = keccak256("facility-v3-invariant");

    function policySetCommitment(address) external pure returns (bytes32) {
        return COMMITMENT;
    }
}

contract FacilityV3DefaultHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public constant LENDER = address(0xA11CE);
    address public constant BORROWER = address(0xB0B);
    FacilityV3InvariantToken public immutable token;
    RecourseFacilityV3 public immutable facility;

    constructor() {
        token = new FacilityV3InvariantToken();
        FacilityV3InvariantKernel kernel = new FacilityV3InvariantKernel();
        facility = new RecourseFacilityV3(token, address(kernel), LENDER, BORROWER, 1_000, 300, 0, 10, 0);
        token.mint(LENDER, 1_000);
        token.mint(BORROWER, 1_200);
        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(LENDER);
        facility.fundAsLender(1_000);
        vm.prank(BORROWER);
        facility.postBond(300);
        bytes32 commitment = kernel.COMMITMENT();
        vm.prank(BORROWER);
        facility.activate(commitment);
        vm.prank(BORROWER);
        facility.requestDraw(800);
        vm.prank(BORROWER);
        facility.executeDraw();
        vm.roll(11);
        facility.markDefaulted();
    }

    function settleDefaultLoss() external {
        if (facility.bondPosted() != 0) facility.settleDefaultLoss();
    }

    function repay(uint256 seed) external {
        uint256 debt = facility.outstandingDebt();
        uint256 balance = token.balanceOf(BORROWER);
        uint256 maximum = debt < balance ? debt : balance;
        if (maximum == 0) return;
        vm.prank(BORROWER);
        facility.repay(1 + seed % maximum);
    }

    function lenderWithdraw() external {
        if (facility.lenderClaimable() == 0) return;
        vm.prank(LENDER);
        facility.lenderWithdraw();
    }

    function borrowerWithdraw() external {
        if (facility.borrowerClaimable() == 0) return;
        vm.prank(BORROWER);
        facility.claimBorrowerRefund();
    }
}

contract RecourseFacilityV3InvariantTest is Test {
    FacilityV3DefaultHandler private handler;
    FacilityV3InvariantToken private token;
    RecourseFacilityV3 private facility;

    function setUp() public {
        handler = new FacilityV3DefaultHandler();
        token = handler.token();
        facility = handler.facility();
        targetContract(address(handler));
    }

    function invariant_assetsAreConservedAndEveryRecordedClaimIsSolvent() public view {
        uint256 facilityBalance = token.balanceOf(address(facility));
        assertEq(facilityBalance + token.balanceOf(handler.LENDER()) + token.balanceOf(handler.BORROWER()), 2_200);
        assertGe(facilityBalance, facility.bondPosted() + facility.lenderClaimable() + facility.borrowerClaimable());
    }

    function invariant_defaultCannotExposeNewCredit() public view {
        assertEq(facility.availableCredit(), 0);
    }
}
