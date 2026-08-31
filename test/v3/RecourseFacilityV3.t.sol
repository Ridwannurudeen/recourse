// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FacilityStatus, PolicyEffect, PolicyOutcome} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {CappedPilotFactoryV1} from "../../contracts/v3/CappedPilotFactoryV1.sol";

interface IPilotFacilityV3 {
    function activate(bytes32 expectedPolicySet) external;
    function applyPolicyEffect(uint256 policyId, PolicyEffect calldata effect, uint64 evidenceExpiry) external;
    function bondPosted() external view returns (uint256);
    function borrowerClaimable() external view returns (uint256);
    function claimBorrowerRefund() external;
    function executeDraw() external;
    function fundAsLender(uint256 amount) external;
    function lenderClaimable() external view returns (uint256);
    function lenderWithdraw() external;
    function markDefaulted() external;
    function outstandingDebt() external view returns (uint256);
    function postBond(uint256 amount) external;
    function repay(uint256 amount) external;
    function requestDraw(uint256 amount) external;
    function settleDefaultLoss() external;
    function status() external view returns (FacilityStatus);
}

contract PilotFacilityToken is ERC20 {
    constructor() ERC20("Pilot USD", "pUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract PilotPolicyCommitment {
    bytes32 internal constant COMMITMENT = keccak256("pilot-policy-set");

    function policySetCommitment(address) external pure returns (bytes32) {
        return COMMITMENT;
    }
}

contract RecourseFacilityV3Test is Test {
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant GUARDIAN = address(0xC3);
    bytes32 private constant POLICY_SET = keccak256("pilot-policy-set");

    PilotFacilityToken private token;
    PilotPolicyCommitment private kernel;
    IPilotFacilityV3 private facility;

    function setUp() public {
        token = new PilotFacilityToken();
        kernel = new PilotPolicyCommitment();
        CappedPilotFactoryV1 factory = new CappedPilotFactoryV1(
            token, address(kernel), LENDER, BORROWER, GUARDIAN, 1_000, 1_000, 2_000, 0, 20, 0, 1
        );
        vm.prank(LENDER);
        facility = IPilotFacilityV3(factory.createFacility(1_000, 300, 0, uint64(block.number + 10), 0));

        token.mint(LENDER, 1_000);
        token.mint(BORROWER, 300);
        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(LENDER);
        facility.fundAsLender(1_000);
        vm.prank(BORROWER);
        facility.postBond(300);
        vm.prank(BORROWER);
        facility.activate(POLICY_SET);
        vm.prank(BORROWER);
        facility.requestDraw(800);
        vm.prank(BORROWER);
        facility.executeDraw();
    }

    function test_defaultSettlementAppliesBondToDebtAndPreservesEveryToken() public {
        vm.roll(block.number + 11);
        facility.markDefaulted();
        vm.prank(LENDER);
        facility.settleDefaultLoss();

        assertEq(facility.outstandingDebt(), 500);
        assertEq(facility.bondPosted(), 0);
        assertEq(facility.lenderClaimable(), 500);
        assertEq(facility.borrowerClaimable(), 0);
        assertEq(token.balanceOf(address(facility)), 500);
        vm.expectRevert(bytes4(keccak256("ZeroAmount()")));
        vm.prank(LENDER);
        facility.settleDefaultLoss();

        vm.prank(BORROWER);
        facility.repay(500);
        assertEq(facility.outstandingDebt(), 0);
        assertEq(facility.lenderClaimable(), 1_000);
        assertEq(token.balanceOf(address(facility)), 1_000);

        vm.prank(LENDER);
        facility.lenderWithdraw();
        assertEq(token.balanceOf(LENDER), 1_000);
        assertEq(token.balanceOf(address(facility)), 0);
    }

    function test_defaultSettlementReturnsOnlyBondExcessToBorrower() public {
        vm.prank(BORROWER);
        facility.repay(700);
        vm.roll(block.number + 11);
        facility.markDefaulted();
        vm.prank(LENDER);
        facility.settleDefaultLoss();

        assertEq(facility.outstandingDebt(), 0);
        assertEq(facility.lenderClaimable(), 1_000);
        assertEq(facility.borrowerClaimable(), 200);
        assertEq(facility.bondPosted(), 0);
        assertEq(token.balanceOf(address(facility)), 1_200);

        vm.prank(LENDER);
        facility.lenderWithdraw();
        vm.prank(BORROWER);
        facility.claimBorrowerRefund();
        assertEq(token.balanceOf(address(facility)), 0);
    }

    function test_terminatedDebtCanSettleBondAfterMaturity() public {
        PolicyEffect memory termination = PolicyEffect({
            outcome: PolicyOutcome.Breached,
            creditLimitBps: 0,
            futureDrawFeeBps: 0,
            freezePendingDraw: true,
            requireFreshEvidence: false,
            terminate: true
        });
        vm.prank(address(kernel));
        facility.applyPolicyEffect(1, termination, uint64(block.timestamp + 1 days));
        assertEq(uint256(facility.status()), uint256(FacilityStatus.Terminated));

        vm.roll(block.number + 11);
        vm.prank(LENDER);
        facility.settleDefaultLoss();

        assertEq(facility.outstandingDebt(), 500);
        assertEq(facility.bondPosted(), 0);
        assertEq(facility.lenderClaimable(), 500);
    }
}
