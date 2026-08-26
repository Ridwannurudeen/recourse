// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {FacilityStatus, PolicyEffect, PolicyOutcome} from "../../contracts/v2/types/RecourseTypesV2.sol";

contract TestStablecoin is ERC20 {
    constructor() ERC20("Test USD", "tUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract MockPolicyKernelV2 {
    mapping(address facility => bytes32 commitment) public policySetCommitment;

    function setCommitment(address facility, bytes32 commitment) external {
        policySetCommitment[facility] = commitment;
    }

    function applyEffect(RecourseFacilityV2 facility, PolicyEffect calldata effect, uint64 evidenceExpiry) external {
        facility.applyPolicyEffect(effect, evidenceExpiry);
    }
}

contract RecourseFacilityV2Test is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant LIMIT = 1_000 * UNIT;
    uint256 internal constant BOND = 200 * UNIT;

    TestStablecoin internal token;
    MockPolicyKernelV2 internal kernel;
    RecourseFacilityV2 internal facility;
    address internal lender = address(0xA1);
    address internal borrower = address(0xB2);
    address internal outsider = address(0xC3);
    bytes32 internal commitment = keccak256("policy-set");

    function setUp() public {
        token = new TestStablecoin();
        kernel = new MockPolicyKernelV2();
        facility = new RecourseFacilityV2(
            token, address(kernel), lender, borrower, LIMIT, BOND, 200, uint64(block.number + 100_000), 10
        );
        kernel.setCommitment(address(facility), commitment);
        token.mint(lender, LIMIT);
        token.mint(borrower, BOND + LIMIT);
        vm.prank(lender);
        token.approve(address(facility), type(uint256).max);
        vm.prank(borrower);
        token.approve(address(facility), type(uint256).max);
    }

    function test_erc20FundingBondActivationAndDraw() public {
        _activate();
        _draw(400 * UNIT);

        assertEq(token.balanceOf(borrower), BOND + LIMIT - BOND + 400 * UNIT);
        assertEq(facility.outstandingDebt(), 408 * UNIT);
        assertEq(facility.availableCredit(), 600 * UNIT);
    }

    function test_activationBindsExactKernelPolicySet() public {
        _fundAndBond();
        vm.prank(borrower);
        vm.expectRevert();
        facility.activate(bytes32(uint256(1)));

        vm.prank(borrower);
        facility.activate(commitment);
    }

    function test_activationRejectsEmptyPolicySet() public {
        RecourseFacilityV2 emptyPolicyFacility = new RecourseFacilityV2(
            token, address(kernel), lender, borrower, LIMIT, BOND, 200, uint64(block.number + 100_000), 10
        );
        vm.startPrank(lender);
        token.approve(address(emptyPolicyFacility), LIMIT);
        emptyPolicyFacility.fundAsLender(LIMIT);
        vm.stopPrank();
        vm.startPrank(borrower);
        token.approve(address(emptyPolicyFacility), BOND);
        emptyPolicyFacility.postBond(BOND);
        vm.expectRevert();
        emptyPolicyFacility.activate(bytes32(0));
        vm.stopPrank();
    }

    function test_onlyKernelCanApplyPolicyEffect() public {
        _activate();
        vm.expectRevert();
        facility.applyPolicyEffect(_effect(PolicyOutcome.Restricted, 5_000, 300, true, true, false), 0);
    }

    function test_policyCanFreezePendingDrawAndReduceCredit() public {
        _activate();
        vm.prank(borrower);
        facility.requestDraw(400 * UNIT);

        kernel.applyEffect(facility, _effect(PolicyOutcome.Restricted, 5_000, 300, true, false, false), 0);

        assertEq(facility.pendingDrawAmount(), 0);
        assertEq(facility.availableCredit(), 500 * UNIT);
        assertEq(facility.futureDrawFeeBps(), 300);
    }

    function test_creditReductionIsRecheckedAtDrawExecution() public {
        _activate();
        vm.prank(borrower);
        facility.requestDraw(600 * UNIT);
        kernel.applyEffect(facility, _effect(PolicyOutcome.Restricted, 5_000, 200, false, false, false), 0);
        vm.roll(block.number + 10);

        vm.prank(borrower);
        vm.expectRevert();
        facility.executeDraw();
        assertEq(facility.pendingDrawAmount(), 600 * UNIT);
    }

    function test_freshEvidenceGateAndExpiryBlockDraws() public {
        _activate();
        kernel.applyEffect(facility, _effect(PolicyOutcome.Watch, 10_000, 200, false, true, false), 0);
        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(UNIT);

        kernel.applyEffect(
            facility, _effect(PolicyOutcome.Cured, 10_000, 200, false, false, false), uint64(block.timestamp + 100)
        );
        vm.prank(borrower);
        facility.requestDraw(UNIT);

        vm.warp(block.timestamp + 100);
        vm.roll(block.number + 10);
        vm.prank(borrower);
        vm.expectRevert();
        facility.executeDraw();
    }

    function test_futureFeeAppliesOnlyToFutureDrawExecution() public {
        _activate();
        _draw(100 * UNIT);
        assertEq(facility.outstandingDebt(), 102 * UNIT);

        kernel.applyEffect(facility, _effect(PolicyOutcome.Watch, 10_000, 500, false, false, false), 0);
        _draw(100 * UNIT);
        assertEq(facility.outstandingDebt(), 207 * UNIT);
    }

    function test_terminationReleasesUndrawnFundsAndNeverBlocksRepayment() public {
        _activate();
        _draw(400 * UNIT);
        kernel.applyEffect(facility, _effect(PolicyOutcome.Breached, 0, 0, true, true, true), 0);

        assertEq(uint256(facility.status()), uint256(FacilityStatus.Terminated));
        assertEq(facility.lenderClaimable(), 600 * UNIT);
        uint256 debt = facility.outstandingDebt();
        vm.prank(borrower);
        facility.repay(debt);
        assertEq(facility.borrowerClaimable(), BOND);
        assertEq(facility.lenderClaimable(), 1_008 * UNIT);
    }

    function test_lenderAndBorrowerPauseIndependentlyAndOnlyOwnPauseCanBeCleared() public {
        _activate();
        vm.prank(lender);
        facility.setDrawPaused(true);
        vm.prank(borrower);
        facility.setDrawPaused(false);
        assertTrue(facility.incidentPaused());

        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(UNIT);
        vm.prank(lender);
        facility.setDrawPaused(false);
        assertFalse(facility.incidentPaused());
    }

    function test_pauseDoesNotBlockRepaymentOrRepeatableClaims() public {
        _activate();
        _draw(400 * UNIT);
        vm.prank(lender);
        facility.setDrawPaused(true);

        vm.prank(borrower);
        facility.repay(200 * UNIT);
        vm.prank(lender);
        facility.lenderWithdraw();
        assertEq(token.balanceOf(lender), 200 * UNIT);

        vm.prank(borrower);
        facility.repay(208 * UNIT);
        vm.prank(lender);
        facility.lenderWithdraw();
        assertEq(token.balanceOf(lender), 1_008 * UNIT);
        vm.prank(borrower);
        facility.claimBorrowerRefund();
        assertEq(token.balanceOf(borrower), 1_192 * UNIT);
    }

    function test_claimsUseChecksEffectsInteractions() public {
        _activate();
        _draw(100 * UNIT);
        vm.prank(borrower);
        facility.repay(102 * UNIT);

        vm.prank(lender);
        facility.lenderWithdraw();
        assertEq(facility.lenderClaimable(), 0);
        vm.prank(lender);
        vm.expectRevert();
        facility.lenderWithdraw();
    }

    function test_cancelReturnsPartialFundingAndBondThroughPullClaims() public {
        vm.prank(lender);
        facility.fundAsLender(300 * UNIT);
        vm.prank(borrower);
        facility.postBond(50 * UNIT);
        vm.prank(borrower);
        facility.cancel();

        assertEq(uint256(facility.status()), uint256(FacilityStatus.Cancelled));
        assertEq(facility.lenderClaimable(), 300 * UNIT);
        assertEq(facility.borrowerClaimable(), 50 * UNIT);
        vm.prank(lender);
        facility.lenderWithdraw();
        vm.prank(borrower);
        facility.claimBorrowerRefund();
    }

    function test_defaultReleasesUndrawnFundsButHoldsBondUntilDebtIsRepaid() public {
        _activate();
        _draw(400 * UNIT);
        vm.roll(uint256(facility.maturityBlock()) + 1);
        facility.markDefaulted();

        assertEq(uint256(facility.status()), uint256(FacilityStatus.Defaulted));
        assertEq(facility.lenderClaimable(), 600 * UNIT);
        assertEq(facility.borrowerClaimable(), 0);
        uint256 debt = facility.outstandingDebt();
        vm.prank(borrower);
        facility.repay(debt + UNIT);
        assertEq(facility.borrowerClaimable(), BOND);
        assertEq(facility.lenderClaimable(), 1_008 * UNIT);
    }

    function test_nonPartyCannotPauseDraws() public {
        _activate();
        vm.prank(outsider);
        vm.expectRevert();
        facility.setDrawPaused(true);
    }

    function test_invalidPolicyBasisPointsRevertWithoutChangingState() public {
        _activate();
        vm.expectRevert();
        kernel.applyEffect(facility, _effect(PolicyOutcome.Restricted, 10_001, 200, false, false, false), 0);
        assertEq(facility.creditLimitBps(), 10_000);

        vm.expectRevert();
        kernel.applyEffect(facility, _effect(PolicyOutcome.Watch, 10_000, 10_001, false, false, false), 0);
        assertEq(facility.futureDrawFeeBps(), 200);
    }

    function _fundAndBond() internal {
        vm.prank(lender);
        facility.fundAsLender(LIMIT);
        vm.prank(borrower);
        facility.postBond(BOND);
    }

    function _activate() internal {
        _fundAndBond();
        vm.prank(borrower);
        facility.activate(commitment);
    }

    function _draw(uint256 amount) internal {
        vm.prank(borrower);
        facility.requestDraw(amount);
        vm.roll(block.number + 10);
        vm.prank(borrower);
        facility.executeDraw();
    }

    function _effect(PolicyOutcome outcome, uint16 limitBps, uint16 feeBps, bool freeze, bool fresh, bool terminate)
        internal
        pure
        returns (PolicyEffect memory)
    {
        return PolicyEffect({
            outcome: outcome,
            creditLimitBps: limitBps,
            futureDrawFeeBps: feeBps,
            freezePendingDraw: freeze,
            requireFreshEvidence: fresh,
            terminate: terminate
        });
    }
}
