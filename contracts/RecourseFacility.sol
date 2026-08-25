// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRecourseFacility} from "./interfaces/IRecourseFacility.sol";
import {
    CovenantSetMismatch,
    DrawNotReady,
    ExceedsFacility,
    FacilityState,
    MaturityPassed,
    NotAdjudicator,
    NotBorrower,
    NotLender,
    TransferFailed,
    WrongState,
    ZeroAmount
} from "./types/RecourseTypes.sol";

interface ICovenantSetRegistry {
    function covenantSetCommitment(uint256 facilityId) external view returns (bytes32);
}

contract RecourseFacility is IRecourseFacility {
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant LENDER_SLASH_BPS = 8_000;

    address public immutable owner;
    address public override adjudicator;
    uint256 private nextFacilityId = 1;

    mapping(uint256 facilityId => Facility) private facilities;
    mapping(uint256 facilityId => uint256 amount) public override lenderClaimable;
    mapping(uint256 facilityId => uint256 amount) public override borrowerClaimable;

    constructor() {
        owner = msg.sender;
    }

    function setAdjudicator(address newAdjudicator) external override {
        if (msg.sender != owner || adjudicator != address(0)) revert NotAdjudicator();
        if (newAdjudicator == address(0)) revert ZeroAmount();
        adjudicator = newAdjudicator;
    }

    function openFacility(
        address lender,
        address borrower,
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external override returns (uint256 facilityId) {
        if (lender == address(0) || borrower == address(0) || facilityLimit == 0 || bondRequired == 0) {
            revert ZeroAmount();
        }
        if (drawFeeBps > BPS_DENOMINATOR) revert ExceedsFacility(drawFeeBps, BPS_DENOMINATOR);
        if (uint256(maturityBlock) < block.number) revert MaturityPassed(maturityBlock);

        facilityId = nextFacilityId++;
        facilities[facilityId] = Facility({
            lender: lender,
            borrower: borrower,
            facilityLimit: facilityLimit,
            bondRequired: bondRequired,
            drawFeeBps: drawFeeBps,
            maturityBlock: maturityBlock,
            drawDelayBlocks: drawDelayBlocks,
            state: FacilityState.Created,
            lenderFunded: 0,
            bondPosted: 0,
            drawnPrincipal: 0,
            outstandingDebt: 0,
            pendingDrawAmount: 0,
            drawReadyAtBlock: 0
        });

        emit FacilityOpened(facilityId, lender, borrower);
    }

    function fundAsLender(uint256 facilityId) external payable override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Created);
        if (msg.sender != facility.lender) revert NotLender();
        if (msg.value == 0) revert ZeroAmount();

        uint256 remaining = facility.facilityLimit - facility.lenderFunded;
        if (msg.value > remaining) revert ExceedsFacility(msg.value, remaining);
        facility.lenderFunded += msg.value;
    }

    function postBond(uint256 facilityId) external payable override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Created);
        if (msg.sender != facility.borrower) revert NotBorrower();
        if (msg.value == 0) revert ZeroAmount();

        uint256 remaining = facility.bondRequired - facility.bondPosted;
        if (msg.value > remaining) revert ExceedsFacility(msg.value, remaining);
        facility.bondPosted += msg.value;
    }

    function activate(uint256 facilityId, bytes32 expectedCovenantSet) external override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Created);
        if (msg.sender != facility.borrower) revert NotBorrower();
        if (facility.lenderFunded != facility.facilityLimit) {
            revert ExceedsFacility(facility.facilityLimit, facility.lenderFunded);
        }
        if (facility.bondPosted != facility.bondRequired) {
            revert ExceedsFacility(facility.bondRequired, facility.bondPosted);
        }
        bytes32 actualCovenantSet = ICovenantSetRegistry(adjudicator).covenantSetCommitment(facilityId);
        if (expectedCovenantSet != actualCovenantSet) {
            revert CovenantSetMismatch(expectedCovenantSet, actualCovenantSet);
        }

        facility.state = FacilityState.Active;
        emit FacilityActivated(facilityId);
    }

    function requestDraw(uint256 facilityId, uint256 amount) external override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Active);
        if (msg.sender != facility.borrower) revert NotBorrower();
        if (block.number > facility.maturityBlock) revert MaturityPassed(facility.maturityBlock);
        if (amount == 0) revert ZeroAmount();

        uint256 available = facility.facilityLimit - facility.drawnPrincipal;
        if (amount > available) revert ExceedsFacility(amount, available);
        facility.pendingDrawAmount = amount;
        facility.drawReadyAtBlock = block.number + facility.drawDelayBlocks;

        emit DrawRequested(facilityId, amount, facility.drawReadyAtBlock);
    }

    function executeDraw(uint256 facilityId) external override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Active);
        if (msg.sender != facility.borrower) revert NotBorrower();
        if (block.number > facility.maturityBlock) revert MaturityPassed(facility.maturityBlock);

        uint256 amount = facility.pendingDrawAmount;
        if (amount == 0) revert ZeroAmount();
        if (block.number < facility.drawReadyAtBlock) revert DrawNotReady(facility.drawReadyAtBlock);

        uint256 available = facility.facilityLimit - facility.drawnPrincipal;
        if (amount > available) revert ExceedsFacility(amount, available);
        uint256 fee = Math.mulDiv(amount, facility.drawFeeBps, BPS_DENOMINATOR);

        facility.pendingDrawAmount = 0;
        facility.drawReadyAtBlock = 0;
        facility.drawnPrincipal += amount;
        facility.outstandingDebt += amount + fee;

        emit DrawExecuted(facilityId, amount, fee);
        _transfer(facility.borrower, amount);
    }

    function repay(uint256 facilityId) external payable override {
        Facility storage facility = facilities[facilityId];
        if (msg.sender != facility.borrower) revert NotBorrower();
        if (
            facility.state != FacilityState.Active && facility.state != FacilityState.Breached
                && facility.state != FacilityState.Defaulted
        ) {
            revert WrongState(FacilityState.Active, facility.state);
        }
        if (msg.value == 0) revert ZeroAmount();

        if (facility.state == FacilityState.Active && block.number > facility.maturityBlock) {
            _enterDefaulted(facilityId, facility);
        }

        uint256 payment = msg.value > facility.outstandingDebt ? facility.outstandingDebt : msg.value;
        uint256 refund = msg.value - payment;
        facility.outstandingDebt -= payment;
        lenderClaimable[facilityId] += payment;

        if (facility.state == FacilityState.Active && facility.outstandingDebt == 0) {
            _enterRepaid(facilityId, facility);
        }

        emit Repaid(facilityId, payment, facility.outstandingDebt);
        if (refund != 0) _transfer(facility.borrower, refund);
    }

    function reportBreach(uint256 facilityId, address hunter) external override {
        if (msg.sender != adjudicator) revert NotAdjudicator();
        if (hunter == address(0)) revert ZeroAmount();
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Active);

        uint256 lenderShare = Math.mulDiv(facility.bondPosted, LENDER_SLASH_BPS, BPS_DENOMINATOR);
        uint256 hunterReward = facility.bondPosted - lenderShare;
        uint256 debtReduction = lenderShare > facility.outstandingDebt ? facility.outstandingDebt : lenderShare;
        uint256 borrowerRemainder = lenderShare - debtReduction;

        facility.state = FacilityState.Breached;
        facility.pendingDrawAmount = 0;
        facility.drawReadyAtBlock = 0;
        facility.outstandingDebt -= debtReduction;
        facility.bondPosted = 0;
        lenderClaimable[facilityId] += facility.facilityLimit - facility.drawnPrincipal + debtReduction;
        borrowerClaimable[facilityId] += borrowerRemainder;

        emit Breached(facilityId, hunter, debtReduction, hunterReward);
        _transfer(hunter, hunterReward);
    }

    function markDefaulted(uint256 facilityId) external override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Active);
        if (block.number <= facility.maturityBlock) {
            revert DrawNotReady(uint256(facility.maturityBlock) + 1);
        }
        if (facility.outstandingDebt == 0) {
            _enterRepaid(facilityId, facility);
        } else {
            _enterDefaulted(facilityId, facility);
        }
    }

    function cancel(uint256 facilityId) external override {
        Facility storage facility = facilities[facilityId];
        _requireState(facility, FacilityState.Created);
        if (msg.sender != facility.lender && msg.sender != facility.borrower) revert NotBorrower();

        uint256 lenderRefund = facility.lenderFunded;
        uint256 borrowerRefund = facility.bondPosted;
        facility.state = FacilityState.Cancelled;
        facility.lenderFunded = 0;
        facility.bondPosted = 0;
        lenderClaimable[facilityId] += lenderRefund;
        borrowerClaimable[facilityId] += borrowerRefund;
    }

    function lenderWithdraw(uint256 facilityId) external override {
        Facility storage facility = facilities[facilityId];
        if (msg.sender != facility.lender) revert NotLender();
        _requireTerminal(facility.state);

        uint256 amount = lenderClaimable[facilityId];
        if (amount == 0) revert ZeroAmount();
        lenderClaimable[facilityId] = 0;
        _transfer(facility.lender, amount);
    }

    function claimBorrowerRefund(uint256 facilityId) external override {
        Facility storage facility = facilities[facilityId];
        if (msg.sender != facility.borrower) revert NotBorrower();
        _requireTerminal(facility.state);

        uint256 amount = borrowerClaimable[facilityId];
        if (amount == 0) revert ZeroAmount();
        borrowerClaimable[facilityId] = 0;
        _transfer(facility.borrower, amount);
    }

    function state(uint256 facilityId) external view override returns (FacilityState) {
        return facilities[facilityId].state;
    }

    function outstandingDebt(uint256 facilityId) external view override returns (uint256) {
        return facilities[facilityId].outstandingDebt;
    }

    function availableCredit(uint256 facilityId) external view override returns (uint256) {
        Facility storage facility = facilities[facilityId];
        if (facility.state != FacilityState.Active) return 0;
        return facility.facilityLimit - facility.drawnPrincipal;
    }

    function facilityOf(uint256 facilityId) external view override returns (Facility memory) {
        return facilities[facilityId];
    }

    function _enterRepaid(uint256 facilityId, Facility storage facility) private {
        facility.state = FacilityState.Repaid;
        facility.pendingDrawAmount = 0;
        facility.drawReadyAtBlock = 0;
        facility.bondPosted = 0;
        lenderClaimable[facilityId] += facility.facilityLimit - facility.drawnPrincipal;
        borrowerClaimable[facilityId] += facility.bondRequired;
    }

    function _enterDefaulted(uint256 facilityId, Facility storage facility) private {
        facility.state = FacilityState.Defaulted;
        facility.pendingDrawAmount = 0;
        facility.drawReadyAtBlock = 0;
        facility.bondPosted = 0;
        lenderClaimable[facilityId] += facility.facilityLimit - facility.drawnPrincipal;
        borrowerClaimable[facilityId] += facility.bondRequired;
        emit Defaulted(facilityId);
    }

    function _requireState(Facility storage facility, FacilityState expected) private view {
        if (facility.state != expected) revert WrongState(expected, facility.state);
    }

    function _requireTerminal(FacilityState current) private pure {
        if (
            current != FacilityState.Repaid && current != FacilityState.Breached && current != FacilityState.Defaulted
                && current != FacilityState.Cancelled
        ) {
            revert WrongState(FacilityState.Repaid, current);
        }
    }

    function _transfer(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
