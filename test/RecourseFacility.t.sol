// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {RecourseFacility} from "../contracts/RecourseFacility.sol";
import {
    DrawNotReady,
    FacilityState,
    MaturityPassed,
    TransferFailed,
    ZeroAmount
} from "../contracts/types/RecourseTypes.sol";

contract RevertingReceiver {
    receive() external payable {
        revert();
    }
}

contract EmptyCommitmentRegistry {
    function covenantSetCommitment(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }
}

contract RecourseFacilityTest is Test {
    RecourseFacility facility;
    address lender = address(0xA1);
    address borrower = address(0xB2);
    address hunter = address(0xC3);
    address adjudicator = address(0xD4);
    uint256 id;

    function setUp() public {
        facility = new RecourseFacility();
        adjudicator = address(new EmptyCommitmentRegistry());
        facility.setAdjudicator(adjudicator);
        vm.deal(lender, 2000 ether);
        vm.deal(borrower, 2000 ether);
        id = facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100000), 10);
    }

    function _activate() internal {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(id);
        vm.prank(borrower);
        facility.activate(id, bytes32(0));
    }

    function _draw(uint256 amount) internal {
        vm.prank(borrower);
        facility.requestDraw(id, amount);
        vm.roll(block.number + 10);
        vm.prank(borrower);
        facility.executeDraw(id);
    }

    function test_activationRequiresBothSides() public {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        vm.expectRevert();
        facility.activate(id, bytes32(0));
    }

    function test_drawRequiresDelayToElapse() public {
        _activate();
        vm.prank(borrower);
        facility.requestDraw(id, 400 ether);
        vm.prank(borrower);
        vm.expectRevert();
        facility.executeDraw(id);
        vm.roll(block.number + 10);
        vm.prank(borrower);
        facility.executeDraw(id);
        assertEq(facility.availableCredit(id), 600 ether);
    }

    function test_drawBeyondLimitReverts() public {
        _activate();
        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(id, 1001 ether);
    }

    function test_breachFreezesUndrawnCapacityAndPaysHunter() public {
        _activate();
        _draw(400 ether);
        uint256 hunterBefore = hunter.balance;
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Breached));
        assertEq(hunter.balance - hunterBefore, 40 ether);
        assertEq(facility.availableCredit(id), 0);
    }

    function test_slashIsAppliedAgainstDebtNotAsWindfall() public {
        _activate();
        _draw(400 ether);
        uint256 debtBefore = facility.outstandingDebt(id);
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        assertEq(facility.outstandingDebt(id), debtBefore - 160 ether);
    }

    function test_drawBlockedAfterBreach() public {
        _activate();
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(id, 100 ether);
    }

    function test_doubleBreachReverts() public {
        _activate();
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        vm.prank(adjudicator);
        vm.expectRevert();
        facility.reportBreach(id, hunter);
    }

    function test_onlyAdjudicatorCanReportBreach() public {
        _activate();
        vm.prank(borrower);
        vm.expectRevert();
        facility.reportBreach(id, hunter);
    }

    function test_repayInFullClosesFacility() public {
        _activate();
        _draw(400 ether);
        uint256 debt = facility.outstandingDebt(id);
        vm.prank(borrower);
        facility.repay{value: debt}(id);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Repaid));
        assertEq(facility.outstandingDebt(id), 0);
    }

    function test_overpaymentIsRefunded() public {
        _activate();
        _draw(400 ether);
        uint256 debt = facility.outstandingDebt(id);
        uint256 balanceBefore = borrower.balance;
        vm.prank(borrower);
        facility.repay{value: debt + 5 ether}(id);
        assertEq(borrower.balance, balanceBefore - debt);
    }

    function test_breachWithZeroDebtDoesNotOverpayLender() public {
        _activate();
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        assertEq(facility.outstandingDebt(id), 0);
        assertEq(facility.lenderClaimable(id), 1000 ether);
        assertEq(facility.borrowerClaimable(id), 160 ether);
        assertEq(hunter.balance, 40 ether);
        assertEq(address(facility).balance, 1160 ether);
    }

    function test_maturityWithDebtAllowsDefault() public {
        _activate();
        _draw(400 ether);
        vm.roll(block.number + 100001);
        facility.markDefaulted(id);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Defaulted));
    }

    function test_maturityWithZeroDebtClosesAsRepaid() public {
        _activate();
        vm.roll(uint256(facility.facilityOf(id).maturityBlock) + 1);

        facility.markDefaulted(id);

        assertEq(uint256(facility.state(id)), uint256(FacilityState.Repaid));
        assertEq(facility.lenderClaimable(id), 1000 ether);
        assertEq(facility.borrowerClaimable(id), 200 ether);
    }

    function test_openFacilityRejectsExpiredMaturity() public {
        vm.roll(10);
        vm.expectRevert(abi.encodeWithSelector(MaturityPassed.selector, uint256(9)));
        facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, 9, 10);
    }

    function test_requestDrawAfterMaturityReverts() public {
        _activate();
        uint256 maturityBlock = facility.facilityOf(id).maturityBlock;
        vm.roll(maturityBlock + 1);

        vm.expectRevert(abi.encodeWithSelector(MaturityPassed.selector, maturityBlock));
        vm.prank(borrower);
        facility.requestDraw(id, 400 ether);
    }

    function test_executeDrawAfterMaturityReverts() public {
        _activate();
        vm.prank(borrower);
        facility.requestDraw(id, 400 ether);
        uint256 maturityBlock = facility.facilityOf(id).maturityBlock;
        vm.roll(maturityBlock + 1);

        vm.expectRevert(abi.encodeWithSelector(MaturityPassed.selector, maturityBlock));
        vm.prank(borrower);
        facility.executeDraw(id);
    }

    function test_requestDrawAtMaturitySucceeds() public {
        _activate();
        uint256 maturityBlock = facility.facilityOf(id).maturityBlock;
        vm.roll(maturityBlock);

        vm.prank(borrower);
        facility.requestDraw(id, 400 ether);

        assertEq(facility.facilityOf(id).pendingDrawAmount, 400 ether);
    }

    function test_executeDrawAtMaturitySucceeds() public {
        _activate();
        uint256 maturityBlock = facility.facilityOf(id).maturityBlock;
        vm.roll(maturityBlock - 10);
        vm.prank(borrower);
        facility.requestDraw(id, 400 ether);
        vm.roll(maturityBlock);

        vm.prank(borrower);
        facility.executeDraw(id);

        assertEq(facility.outstandingDebt(id), 408 ether);
    }

    function test_drawFeeIsAddedToDebtAtDrawTime() public {
        _activate();
        _draw(400 ether);
        assertEq(facility.outstandingDebt(id), 408 ether);
    }

    function test_lenderCanWithdrawPrincipalAndDrawFeeAfterRepaid() public {
        _activate();
        _draw(400 ether);
        vm.prank(borrower);
        facility.repay{value: 408 ether}(id);

        uint256 lenderBefore = lender.balance;
        assertEq(facility.lenderClaimable(id), 1008 ether);
        vm.prank(lender);
        facility.lenderWithdraw(id);

        assertEq(lender.balance - lenderBefore, 1008 ether);
        assertEq(facility.lenderClaimable(id), 0);
    }

    function test_borrowerReceivesWholeBondAfterRepaid() public {
        _activate();
        _draw(400 ether);
        vm.prank(borrower);
        facility.repay{value: 408 ether}(id);

        uint256 borrowerBefore = borrower.balance;
        assertEq(facility.borrowerClaimable(id), 200 ether);
        vm.prank(borrower);
        facility.claimBorrowerRefund(id);

        assertEq(borrower.balance - borrowerBefore, 200 ether);
        assertEq(facility.borrowerClaimable(id), 0);
    }

    function test_cancelBeforeActivationRefundsBothDeposits() public {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(id);
        uint256 lenderBefore = lender.balance;
        uint256 borrowerBefore = borrower.balance;

        vm.prank(lender);
        facility.cancel(id);

        assertEq(uint256(facility.state(id)), uint256(FacilityState.Cancelled));
        assertEq(lender.balance, lenderBefore);
        assertEq(borrower.balance, borrowerBefore);
        assertEq(facility.lenderClaimable(id), 1000 ether);
        assertEq(facility.borrowerClaimable(id), 200 ether);
        assertEq(address(facility).balance, 1200 ether);

        vm.prank(lender);
        facility.lenderWithdraw(id);
        assertEq(lender.balance - lenderBefore, 1000 ether);
        assertEq(address(facility).balance, 200 ether);

        vm.prank(borrower);
        facility.claimBorrowerRefund(id);
        assertEq(borrower.balance - borrowerBefore, 200 ether);
        assertEq(address(facility).balance, 0);
    }

    function test_borrowerCanCancelBeforeActivation() public {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(id);

        vm.prank(borrower);
        facility.cancel(id);

        assertEq(uint256(facility.state(id)), uint256(FacilityState.Cancelled));
        assertEq(facility.lenderClaimable(id), 1000 ether);
        assertEq(facility.borrowerClaimable(id), 200 ether);
        assertEq(address(facility).balance, 1200 ether);
    }

    function test_rejectingLenderCannotBlockBorrowerCancellationRecovery() public {
        RevertingReceiver receiver = new RevertingReceiver();
        uint256 otherId = facility.openFacility(
            address(receiver), borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10
        );
        vm.deal(address(receiver), 1000 ether);
        vm.prank(address(receiver));
        facility.fundAsLender{value: 1000 ether}(otherId);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(otherId);

        vm.prank(borrower);
        facility.cancel(otherId);

        uint256 borrowerBefore = borrower.balance;
        vm.prank(borrower);
        facility.claimBorrowerRefund(otherId);
        assertEq(borrower.balance - borrowerBefore, 200 ether);

        vm.expectRevert(TransferFailed.selector);
        vm.prank(address(receiver));
        facility.lenderWithdraw(otherId);
        assertEq(facility.lenderClaimable(otherId), 1000 ether);
    }

    function test_workedExampleEndToEnd() public {
        _activate();
        assertEq(address(facility).balance, 1200 ether);

        _draw(400 ether);
        assertEq(facility.outstandingDebt(id), 408 ether);
        assertEq(address(facility).balance, 800 ether);

        uint256 hunterBefore = hunter.balance;
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);
        assertEq(hunter.balance - hunterBefore, 40 ether);
        assertEq(facility.outstandingDebt(id), 248 ether);
        assertEq(facility.lenderClaimable(id), 760 ether);
        assertEq(facility.borrowerClaimable(id), 0);
        assertEq(address(facility).balance, 760 ether);

        vm.prank(borrower);
        facility.repay{value: 248 ether}(id);
        assertEq(facility.outstandingDebt(id), 0);
        assertEq(facility.lenderClaimable(id), 1008 ether);
        assertEq(address(facility).balance, 1008 ether);

        uint256 lenderBefore = lender.balance;
        vm.prank(lender);
        facility.lenderWithdraw(id);
        assertEq(lender.balance - lenderBefore, 1008 ether);
        assertEq(address(facility).balance, 0);
    }

    function test_lenderCanWithdrawAgainAfterLateBreachRepayment() public {
        _activate();
        _draw(400 ether);
        vm.prank(adjudicator);
        facility.reportBreach(id, hunter);

        vm.prank(lender);
        facility.lenderWithdraw(id);
        assertEq(facility.lenderClaimable(id), 0);
        assertEq(address(facility).balance, 0);

        vm.prank(borrower);
        facility.repay{value: 248 ether}(id);
        assertEq(facility.lenderClaimable(id), 248 ether);
        vm.prank(lender);
        facility.lenderWithdraw(id);

        assertEq(facility.lenderClaimable(id), 0);
        assertEq(facility.borrowerClaimable(id), 0);
        assertEq(address(facility).balance, 0);
    }

    function test_defaultReturnsWholeBondToBorrower() public {
        _activate();
        _draw(400 ether);
        vm.roll(block.number + 100001);
        facility.markDefaulted(id);

        assertEq(facility.borrowerClaimable(id), 200 ether);
        uint256 borrowerBefore = borrower.balance;
        vm.prank(borrower);
        facility.claimBorrowerRefund(id);
        assertEq(borrower.balance - borrowerBefore, 200 ether);
    }

    function test_repayAfterMaturityStaysDefaultedWhenDebtClears() public {
        _activate();
        _draw(400 ether);
        vm.roll(block.number + 100001);

        vm.prank(borrower);
        facility.repay{value: 408 ether}(id);

        assertEq(uint256(facility.state(id)), uint256(FacilityState.Defaulted));
        assertEq(facility.outstandingDebt(id), 0);
        assertEq(facility.lenderClaimable(id), 1008 ether);
        assertEq(facility.borrowerClaimable(id), 200 ether);
    }

    function test_bondCanBeClaimedAtMostOnce() public {
        _activate();
        _draw(400 ether);
        vm.prank(borrower);
        facility.repay{value: 408 ether}(id);
        vm.prank(borrower);
        facility.claimBorrowerRefund(id);

        vm.prank(borrower);
        vm.expectRevert(ZeroAmount.selector);
        facility.claimBorrowerRefund(id);
    }

    function test_failedHunterTransferRollsBackBreach() public {
        _activate();
        _draw(400 ether);
        uint256 debtBefore = facility.outstandingDebt(id);
        RevertingReceiver receiver = new RevertingReceiver();

        vm.prank(adjudicator);
        vm.expectRevert(TransferFailed.selector);
        facility.reportBreach(id, address(receiver));

        assertEq(uint256(facility.state(id)), uint256(FacilityState.Active));
        assertEq(facility.outstandingDebt(id), debtBefore);
        assertEq(facility.lenderClaimable(id), 0);
    }

    function test_largeDrawFeeUsesFullPrecision() public {
        uint256 amount = type(uint256).max / 200 + 1;
        uint256 otherId = facility.openFacility(lender, borrower, amount, 1, 200, uint64(block.number + 100_000), 0);
        vm.deal(lender, amount);
        vm.deal(borrower, 1);
        vm.prank(lender);
        facility.fundAsLender{value: amount}(otherId);
        vm.prank(borrower);
        facility.postBond{value: 1}(otherId);
        vm.prank(borrower);
        facility.activate(otherId, bytes32(0));
        vm.prank(borrower);
        facility.requestDraw(otherId, amount);

        vm.prank(borrower);
        facility.executeDraw(otherId);

        assertEq(facility.outstandingDebt(otherId), amount + amount / 50);
        assertEq(borrower.balance, amount);
    }

    function test_largeBondSlashUsesFullPrecision() public {
        uint256 bond = type(uint256).max / 8_000 + 1;
        uint256 otherId = facility.openFacility(lender, borrower, 1, bond, 0, uint64(block.number + 100_000), 0);
        vm.deal(lender, 1);
        vm.deal(borrower, bond);
        vm.prank(lender);
        facility.fundAsLender{value: 1}(otherId);
        vm.prank(borrower);
        facility.postBond{value: bond}(otherId);
        vm.prank(borrower);
        facility.activate(otherId, bytes32(0));

        uint256 lenderShare = (bond / 5) * 4 + ((bond % 5) * 4) / 5;
        uint256 hunterBefore = hunter.balance;
        vm.prank(adjudicator);
        facility.reportBreach(otherId, hunter);

        assertEq(hunter.balance - hunterBefore, bond - lenderShare);
        assertEq(facility.borrowerClaimable(otherId), lenderShare);
        assertEq(facility.lenderClaimable(otherId), 1);
        assertEq(uint256(facility.state(otherId)), uint256(FacilityState.Breached));
    }

    function test_maxMaturityReportsUint256ReadyBlockWithoutOverflow() public {
        uint256 otherId = facility.openFacility(lender, borrower, 1, 1, 0, type(uint64).max, 0);
        vm.prank(lender);
        facility.fundAsLender{value: 1}(otherId);
        vm.prank(borrower);
        facility.postBond{value: 1}(otherId);
        vm.prank(borrower);
        facility.activate(otherId, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(DrawNotReady.selector, uint256(type(uint64).max) + 1));
        facility.markDefaulted(otherId);
    }
}

contract RecourseFacilityHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    RecourseFacility public immutable facility;
    address public constant LENDER = address(0xA11CE);
    address public constant BORROWER = address(0xB0B);
    address public constant HUNTER = address(0xCA7);
    uint64 public constant MATURITY_BLOCK = 100_001;
    uint256 public immutable facilityId;
    bool private initialized;

    constructor() {
        facility = new RecourseFacility();
        facility.setAdjudicator(address(this));
        facilityId = facility.openFacility(LENDER, BORROWER, 1000 ether, 200 ether, 200, MATURITY_BLOCK, 10);
    }

    function initialize() external {
        if (initialized) return;
        initialized = true;
        vm.prank(LENDER);
        facility.fundAsLender{value: 1000 ether}(facilityId);
        vm.prank(BORROWER);
        facility.postBond{value: 200 ether}(facilityId);
        vm.prank(BORROWER);
        facility.activate(facilityId, bytes32(0));
    }

    function draw(uint256 seed) external {
        if (facility.state(facilityId) != FacilityState.Active) return;
        uint256 available = facility.availableCredit(facilityId);
        if (available == 0) return;
        uint256 amount = 1 + (seed % available);
        vm.prank(BORROWER);
        facility.requestDraw(facilityId, amount);
        vm.roll(block.number + 10);
        vm.prank(BORROWER);
        facility.executeDraw(facilityId);
    }

    function repay(uint256 seed) external {
        FacilityState current = facility.state(facilityId);
        if (current != FacilityState.Active && current != FacilityState.Breached && current != FacilityState.Defaulted)
        {
            return;
        }
        uint256 debt = facility.outstandingDebt(facilityId);
        if (debt == 0) return;
        uint256 amount = 1 + (seed % debt);
        vm.prank(BORROWER);
        facility.repay{value: amount}(facilityId);
    }

    function breach() external {
        if (facility.state(facilityId) == FacilityState.Active) facility.reportBreach(facilityId, HUNTER);
    }

    function defaultFacility() external {
        if (facility.state(facilityId) != FacilityState.Active || facility.outstandingDebt(facilityId) == 0) return;
        vm.roll(MATURITY_BLOCK + 1);
        facility.markDefaulted(facilityId);
    }

    function covenantSetCommitment(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    function lenderWithdraw() external {
        if (facility.lenderClaimable(facilityId) == 0) return;
        FacilityState current = facility.state(facilityId);
        if (
            current != FacilityState.Repaid && current != FacilityState.Breached && current != FacilityState.Defaulted
                && current != FacilityState.Cancelled
        ) return;
        vm.prank(LENDER);
        facility.lenderWithdraw(facilityId);
    }

    function claimBorrowerRefund() external {
        if (facility.borrowerClaimable(facilityId) == 0) return;
        vm.prank(BORROWER);
        facility.claimBorrowerRefund(facilityId);
    }
}

contract RecourseFacilityInvariantTest is Test {
    RecourseFacilityHandler handler;
    RecourseFacility facility;
    uint256 constant TOTAL_ASSETS = 4000 ether;

    function setUp() public {
        handler = new RecourseFacilityHandler();
        facility = handler.facility();
        vm.deal(handler.LENDER(), 2000 ether);
        vm.deal(handler.BORROWER(), 2000 ether);
        handler.initialize();
        targetContract(address(handler));
    }

    function invariant_assetsAreConservedAndClaimsAreSolvent() public view {
        uint256 trackedAssets = address(facility).balance + handler.LENDER().balance + handler.BORROWER().balance
            + handler.HUNTER().balance;
        assertEq(trackedAssets, TOTAL_ASSETS);
        assertGe(
            address(facility).balance,
            facility.lenderClaimable(handler.facilityId()) + facility.borrowerClaimable(handler.facilityId())
        );
    }
}
