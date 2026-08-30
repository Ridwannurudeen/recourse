// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {FacilityStatus, PolicyEffect, PolicyOutcome} from "../../contracts/v2/types/RecourseTypesV2.sol";

contract InvariantTokenV2 is ERC20 {
    constructor() ERC20("Invariant USD", "iUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract InvariantKernelV2 {
    mapping(address facility => bytes32 commitment) public policySetCommitment;

    function setCommitment(address facility, bytes32 commitment) external {
        policySetCommitment[facility] = commitment;
    }

    function applyEffect(
        RecourseFacilityV2 facility,
        uint256 policyId,
        PolicyEffect calldata effect,
        uint64 evidenceExpiry
    ) external {
        facility.applyPolicyEffect(policyId, effect, evidenceExpiry);
    }
}

contract RecourseFacilityV2Handler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    InvariantTokenV2 public immutable token;
    InvariantKernelV2 public immutable kernel;
    RecourseFacilityV2 public immutable facility;

    address public constant LENDER = address(0xA11CE);
    address public constant BORROWER = address(0xB0B);
    uint256 public constant LIMIT = 1_000_000_000;
    uint256 public constant BOND = 200_000_000;
    uint256 public constant BORROWER_RESERVE = 1_000_000_000;

    constructor() {
        token = new InvariantTokenV2();
        kernel = new InvariantKernelV2();
        facility =
            new RecourseFacilityV2(token, address(kernel), LENDER, BORROWER, LIMIT, BOND, 200, type(uint64).max, 1);

        bytes32 commitment = keccak256("invariant-policy-set");
        kernel.setCommitment(address(facility), commitment);
        token.mint(LENDER, LIMIT);
        token.mint(BORROWER, BOND + BORROWER_RESERVE);

        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(LENDER);
        facility.fundAsLender(LIMIT);
        vm.prank(BORROWER);
        facility.postBond(BOND);
    }

    function activate() external {
        if (facility.status() != FacilityStatus.Created) return;
        bytes32 commitment = kernel.policySetCommitment(address(facility));
        vm.prank(BORROWER);
        facility.activate(commitment);
    }

    function cancel(bool byLender) external {
        if (facility.status() != FacilityStatus.Created) return;
        vm.prank(byLender ? LENDER : BORROWER);
        facility.cancel();
    }

    function markDefaulted() external {
        if (facility.status() != FacilityStatus.Active || facility.outstandingDebt() == 0) return;
        vm.roll(uint256(type(uint64).max) + 1);
        facility.markDefaulted();
    }

    function draw(uint256 seed) external {
        if (facility.status() != FacilityStatus.Active) return;
        uint256 available = facility.availableCredit();
        if (available == 0) return;

        uint256 amount = 1 + seed % available;
        vm.prank(BORROWER);
        facility.requestDraw(amount);
        vm.roll(block.number + 1);
        vm.prank(BORROWER);
        facility.executeDraw();
    }

    function repay(uint256 seed) external {
        FacilityStatus current = facility.status();
        if (
            current != FacilityStatus.Active && current != FacilityStatus.Defaulted
                && current != FacilityStatus.Terminated
        ) return;

        uint256 debt = facility.outstandingDebt();
        uint256 balance = token.balanceOf(BORROWER);
        uint256 maximum = debt < balance ? debt : balance;
        if (maximum == 0) return;

        uint256 amount = 1 + seed % maximum;
        vm.prank(BORROWER);
        facility.repay(amount);
    }

    function applyPolicy(uint256 seed) external {
        if (facility.status() != FacilityStatus.Active) return;

        PolicyEffect memory effect = PolicyEffect({
            outcome: PolicyOutcome(seed % 6),
            creditLimitBps: uint16(seed % 10_001),
            futureDrawFeeBps: uint16((seed >> 16) % 10_001),
            freezePendingDraw: seed & 1 != 0,
            requireFreshEvidence: seed & 2 != 0,
            terminate: seed & 31 == 31
        });
        kernel.applyEffect(facility, 1 + seed % 4, effect, 0);
    }

    function setLenderPause(bool paused) external {
        vm.prank(LENDER);
        facility.setDrawPaused(paused);
    }

    function setBorrowerPause(bool paused) external {
        vm.prank(BORROWER);
        facility.setDrawPaused(paused);
    }

    function lenderWithdraw() external {
        if (facility.lenderClaimable() == 0) return;
        vm.prank(LENDER);
        facility.lenderWithdraw();
    }

    function claimBorrowerRefund() external {
        if (facility.borrowerClaimable() == 0) return;
        vm.prank(BORROWER);
        facility.claimBorrowerRefund();
    }
}

contract RecourseFacilityV2InvariantTest is Test {
    RecourseFacilityV2Handler private handler;
    RecourseFacilityV2 private facility;
    InvariantTokenV2 private token;
    uint256 private totalAssets;

    function setUp() public {
        handler = new RecourseFacilityV2Handler();
        facility = handler.facility();
        token = handler.token();
        totalAssets = handler.LIMIT() + handler.BOND() + handler.BORROWER_RESERVE();
        targetContract(address(handler));
    }

    function invariant_assetsAreConservedAndClaimsAreSolvent() public view {
        uint256 facilityBalance = token.balanceOf(address(facility));
        uint256 trackedAssets =
            facilityBalance + token.balanceOf(handler.LENDER()) + token.balanceOf(handler.BORROWER());

        assertEq(trackedAssets, totalAssets);
        assertGe(facilityBalance, facility.lenderClaimable() + facility.borrowerClaimable());
        assertLe(facility.lenderFunded(), facility.facilityLimit());
        assertLe(facility.drawnPrincipal(), facility.facilityLimit());
    }

    function invariant_nonActiveFacilitiesExposeNoAvailableCredit() public view {
        if (facility.status() != FacilityStatus.Active) assertEq(facility.availableCredit(), 0);
    }
}
