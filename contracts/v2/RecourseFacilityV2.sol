// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPolicyFacilityV1} from "./interfaces/IPolicyFacilityV1.sol";
import {IPolicySetCommitmentV1} from "./interfaces/IPolicySetCommitmentV1.sol";
import {FacilityStatus, PolicyEffect, PolicyOutcome} from "./types/RecourseTypesV2.sol";

contract RecourseFacilityV2 is IPolicyFacilityV1, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    error DrawNotReady(uint256 readyAtBlock);
    error DrawPaused();
    error EvidenceExpired(uint64 validUntil);
    error EvidenceRequired();
    error ExceedsFacility(uint256 requested, uint256 available);
    error InvalidBasisPoints();
    error MaturityPassed(uint256 maturityBlock);
    error NotBorrower();
    error NotKernel();
    error NotLender();
    error NotParty();
    error EmptyPolicySet();
    error PolicySetMismatch(bytes32 expected, bytes32 actual);
    error TransferAmountMismatch();
    error WrongState(FacilityStatus expected, FacilityStatus actual);
    error ZeroAddress();
    error ZeroAmount();

    event Activated(bytes32 indexed policySetCommitment);
    event BondPosted(uint256 amount);
    event BorrowerClaimed(uint256 amount);
    event DrawExecuted(uint256 amount, uint256 fee);
    event DrawPauseSet(address indexed party, bool paused);
    event DrawRequested(uint256 amount, uint256 readyAtBlock);
    event LenderClaimed(uint256 amount);
    event LenderFunded(uint256 amount);
    event PolicyEffectApplied(
        uint256 indexed policyId, PolicyOutcome indexed outcome, uint16 creditLimitBps, uint16 futureDrawFeeBps
    );
    event Repaid(uint256 amount, uint256 outstandingDebt);

    IERC20 public immutable override asset;
    address public immutable kernel;
    address public immutable override lender;
    address public immutable override borrower;
    uint256 public immutable facilityLimit;
    uint256 public immutable bondRequired;
    uint16 public immutable initialDrawFeeBps;
    uint64 public immutable maturityBlock;
    uint32 public immutable drawDelayBlocks;

    FacilityStatus public override status;
    PolicyOutcome public policyOutcome;
    uint16 public creditLimitBps;
    uint16 public futureDrawFeeBps;
    uint64 public evidenceValidUntil;
    bool public freshEvidenceRequired;
    bool public lenderDrawPaused;
    bool public borrowerDrawPaused;
    uint256 public lenderFunded;
    uint256 public bondPosted;
    uint256 public drawnPrincipal;
    uint256 public outstandingDebt;
    uint256 public pendingDrawAmount;
    uint256 public drawReadyAtBlock;
    uint256 public lenderClaimable;
    uint256 public borrowerClaimable;

    struct StoredPolicyEffect {
        PolicyEffect effect;
        uint64 evidenceExpiry;
        bool exists;
    }

    mapping(uint256 policyId => StoredPolicyEffect stored) private policyEffects;
    uint256[] private policyIds;

    constructor(
        IERC20 asset_,
        address kernel_,
        address lender_,
        address borrower_,
        uint256 facilityLimit_,
        uint256 bondRequired_,
        uint16 drawFeeBps_,
        uint64 maturityBlock_,
        uint32 drawDelayBlocks_
    ) {
        if (address(asset_) == address(0) || kernel_ == address(0) || lender_ == address(0) || borrower_ == address(0))
        {
            revert ZeroAddress();
        }
        if (lender_ == borrower_) revert NotParty();
        if (facilityLimit_ == 0 || bondRequired_ == 0) revert ZeroAmount();
        if (drawFeeBps_ > BPS_DENOMINATOR) revert InvalidBasisPoints();
        if (uint256(maturityBlock_) < block.number) revert MaturityPassed(maturityBlock_);

        asset = asset_;
        kernel = kernel_;
        lender = lender_;
        borrower = borrower_;
        facilityLimit = facilityLimit_;
        bondRequired = bondRequired_;
        initialDrawFeeBps = drawFeeBps_;
        futureDrawFeeBps = drawFeeBps_;
        maturityBlock = maturityBlock_;
        drawDelayBlocks = drawDelayBlocks_;
        creditLimitBps = 10_000;
        status = FacilityStatus.Created;
        policyOutcome = PolicyOutcome.Eligible;
    }

    function fundAsLender(uint256 amount) external nonReentrant {
        _requireStatus(FacilityStatus.Created);
        if (msg.sender != lender) revert NotLender();
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = facilityLimit - lenderFunded;
        if (amount > remaining) revert ExceedsFacility(amount, remaining);

        lenderFunded += amount;
        _pull(lender, amount);
        emit LenderFunded(amount);
    }

    function postBond(uint256 amount) external nonReentrant {
        _requireStatus(FacilityStatus.Created);
        if (msg.sender != borrower) revert NotBorrower();
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = bondRequired - bondPosted;
        if (amount > remaining) revert ExceedsFacility(amount, remaining);

        bondPosted += amount;
        _pull(borrower, amount);
        emit BondPosted(amount);
    }

    function activate(bytes32 expectedPolicySet) external {
        _requireStatus(FacilityStatus.Created);
        if (msg.sender != borrower) revert NotBorrower();
        if (lenderFunded != facilityLimit) revert ExceedsFacility(facilityLimit, lenderFunded);
        if (bondPosted != bondRequired) revert ExceedsFacility(bondRequired, bondPosted);

        bytes32 actual = IPolicySetCommitmentV1(kernel).policySetCommitment(address(this));
        if (actual == bytes32(0)) revert EmptyPolicySet();
        if (actual != expectedPolicySet) revert PolicySetMismatch(expectedPolicySet, actual);
        status = FacilityStatus.Active;
        emit Activated(actual);
    }

    function requestDraw(uint256 amount) external {
        _requireStatus(FacilityStatus.Active);
        if (msg.sender != borrower) revert NotBorrower();
        _requireDrawAllowed();
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableCredit();
        if (amount > available) revert ExceedsFacility(amount, available);

        pendingDrawAmount = amount;
        drawReadyAtBlock = block.number + drawDelayBlocks;
        emit DrawRequested(amount, drawReadyAtBlock);
    }

    function executeDraw() external nonReentrant {
        _requireStatus(FacilityStatus.Active);
        if (msg.sender != borrower) revert NotBorrower();
        _requireDrawAllowed();

        uint256 amount = pendingDrawAmount;
        if (amount == 0) revert ZeroAmount();
        if (block.number < drawReadyAtBlock) revert DrawNotReady(drawReadyAtBlock);
        uint256 available = availableCredit();
        if (amount > available) revert ExceedsFacility(amount, available);
        uint256 fee = Math.mulDiv(amount, futureDrawFeeBps, BPS_DENOMINATOR);

        pendingDrawAmount = 0;
        drawReadyAtBlock = 0;
        drawnPrincipal += amount;
        outstandingDebt += amount + fee;
        asset.safeTransfer(borrower, amount);
        emit DrawExecuted(amount, fee);
    }

    function repay(uint256 amount) external nonReentrant {
        if (msg.sender != borrower) revert NotBorrower();
        if (
            status != FacilityStatus.Active && status != FacilityStatus.Defaulted && status != FacilityStatus.Terminated
        ) {
            revert WrongState(FacilityStatus.Active, status);
        }
        if (amount == 0) revert ZeroAmount();
        uint256 payment = amount > outstandingDebt ? outstandingDebt : amount;
        if (payment == 0) revert ZeroAmount();

        outstandingDebt -= payment;
        lenderClaimable += payment;
        _pull(borrower, payment);
        if (outstandingDebt == 0) {
            if (status == FacilityStatus.Active) {
                status = FacilityStatus.Repaid;
                _releaseUndrawn();
            }
            _releaseBond();
        }
        emit Repaid(payment, outstandingDebt);
    }

    function markDefaulted() external {
        _requireStatus(FacilityStatus.Active);
        if (block.number <= maturityBlock) revert DrawNotReady(uint256(maturityBlock) + 1);
        _clearPendingDraw();
        if (outstandingDebt == 0) {
            status = FacilityStatus.Repaid;
            _releaseUndrawn();
            _releaseBond();
        } else {
            status = FacilityStatus.Defaulted;
            _releaseUndrawn();
        }
    }

    function cancel() external {
        _requireStatus(FacilityStatus.Created);
        if (msg.sender != lender && msg.sender != borrower) revert NotParty();
        status = FacilityStatus.Cancelled;
        lenderClaimable += lenderFunded;
        borrowerClaimable += bondPosted;
        lenderFunded = 0;
        bondPosted = 0;
    }

    function lenderWithdraw() external nonReentrant {
        if (msg.sender != lender) revert NotLender();
        uint256 amount = lenderClaimable;
        if (amount == 0) revert ZeroAmount();
        lenderClaimable = 0;
        asset.safeTransfer(lender, amount);
        emit LenderClaimed(amount);
    }

    function claimBorrowerRefund() external nonReentrant {
        if (msg.sender != borrower) revert NotBorrower();
        uint256 amount = borrowerClaimable;
        if (amount == 0) revert ZeroAmount();
        borrowerClaimable = 0;
        asset.safeTransfer(borrower, amount);
        emit BorrowerClaimed(amount);
    }

    function setDrawPaused(bool paused) external {
        if (msg.sender == lender) lenderDrawPaused = paused;
        else if (msg.sender == borrower) borrowerDrawPaused = paused;
        else revert NotParty();
        if (paused) _clearPendingDraw();
        emit DrawPauseSet(msg.sender, paused);
    }

    function applyPolicyEffect(uint256 policyId, PolicyEffect calldata effect, uint64 evidenceExpiry)
        external
        override
        nonReentrant
    {
        if (msg.sender != kernel) revert NotKernel();
        _requireStatus(FacilityStatus.Active);
        if (effect.creditLimitBps > BPS_DENOMINATOR || effect.futureDrawFeeBps > BPS_DENOMINATOR) {
            revert InvalidBasisPoints();
        }

        StoredPolicyEffect storage stored = policyEffects[policyId];
        if (!stored.exists) {
            stored.exists = true;
            policyIds.push(policyId);
        }
        stored.effect = effect;
        stored.evidenceExpiry = evidenceExpiry;
        _recomputePolicyState();
        if (effect.freezePendingDraw) _clearPendingDraw();
        if (effect.terminate) {
            status = FacilityStatus.Terminated;
            _clearPendingDraw();
            _releaseUndrawn();
            if (outstandingDebt == 0) _releaseBond();
        }
        emit PolicyEffectApplied(policyId, effect.outcome, creditLimitBps, futureDrawFeeBps);
    }

    function policyEffectOf(uint256 policyId)
        external
        view
        returns (PolicyEffect memory effect, uint64 evidenceExpiry, bool exists)
    {
        StoredPolicyEffect storage stored = policyEffects[policyId];
        return (stored.effect, stored.evidenceExpiry, stored.exists);
    }

    function policyCount() external view returns (uint256) {
        return policyIds.length;
    }

    function policyIdAt(uint256 index) external view returns (uint256) {
        return policyIds[index];
    }

    function incidentPaused() public view override returns (bool) {
        return lenderDrawPaused || borrowerDrawPaused;
    }

    function availableCredit() public view returns (uint256) {
        if (status != FacilityStatus.Active || incidentPaused() || freshEvidenceRequired) return 0;
        if (evidenceValidUntil != 0 && block.timestamp >= evidenceValidUntil) return 0;
        uint256 effectiveLimit = Math.mulDiv(facilityLimit, creditLimitBps, BPS_DENOMINATOR);
        return drawnPrincipal >= effectiveLimit ? 0 : effectiveLimit - drawnPrincipal;
    }

    function _requireDrawAllowed() private view {
        if (block.number > maturityBlock) revert MaturityPassed(maturityBlock);
        if (incidentPaused()) revert DrawPaused();
        if (freshEvidenceRequired) revert EvidenceRequired();
        if (evidenceValidUntil != 0 && block.timestamp >= evidenceValidUntil) {
            revert EvidenceExpired(evidenceValidUntil);
        }
    }

    function _recomputePolicyState() private {
        uint8 aggregateSeverity;
        uint16 aggregateCreditLimitBps = 10_000;
        uint16 aggregateDrawFeeBps = initialDrawFeeBps;
        uint64 aggregateEvidenceExpiry;
        bool aggregateFreshEvidenceRequired;
        uint256 length = policyIds.length;

        for (uint256 i; i < length; ++i) {
            StoredPolicyEffect storage stored = policyEffects[policyIds[i]];
            PolicyEffect storage effect = stored.effect;
            uint8 severity = _severity(effect.outcome);
            if (severity > aggregateSeverity) aggregateSeverity = severity;
            if (effect.creditLimitBps < aggregateCreditLimitBps) {
                aggregateCreditLimitBps = effect.creditLimitBps;
            }
            if (effect.futureDrawFeeBps > aggregateDrawFeeBps) aggregateDrawFeeBps = effect.futureDrawFeeBps;
            if (effect.requireFreshEvidence) aggregateFreshEvidenceRequired = true;
            uint64 expiry = stored.evidenceExpiry;
            if (expiry != 0 && (aggregateEvidenceExpiry == 0 || expiry < aggregateEvidenceExpiry)) {
                aggregateEvidenceExpiry = expiry;
            }
        }

        policyOutcome = _outcomeForSeverity(aggregateSeverity);
        creditLimitBps = aggregateCreditLimitBps;
        futureDrawFeeBps = aggregateDrawFeeBps;
        freshEvidenceRequired = aggregateFreshEvidenceRequired;
        evidenceValidUntil = aggregateEvidenceExpiry;
    }

    function _severity(PolicyOutcome outcome) private pure returns (uint8) {
        if (outcome == PolicyOutcome.Watch) return 1;
        if (outcome == PolicyOutcome.Restricted) return 2;
        if (outcome == PolicyOutcome.MarginCalled) return 3;
        if (outcome == PolicyOutcome.Breached) return 4;
        return 0;
    }

    function _outcomeForSeverity(uint8 severity) private pure returns (PolicyOutcome) {
        if (severity == 1) return PolicyOutcome.Watch;
        if (severity == 2) return PolicyOutcome.Restricted;
        if (severity == 3) return PolicyOutcome.MarginCalled;
        if (severity == 4) return PolicyOutcome.Breached;
        return PolicyOutcome.Eligible;
    }

    function _releaseUndrawn() private {
        uint256 undrawn = facilityLimit - drawnPrincipal;
        if (lenderFunded == 0) return;
        lenderFunded = 0;
        lenderClaimable += undrawn;
    }

    function _releaseBond() private {
        uint256 amount = bondPosted;
        if (amount == 0) return;
        bondPosted = 0;
        borrowerClaimable += amount;
    }

    function _clearPendingDraw() private {
        pendingDrawAmount = 0;
        drawReadyAtBlock = 0;
    }

    function _pull(address from, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _requireStatus(FacilityStatus expected) private view {
        if (status != expected) revert WrongState(expected, status);
    }
}
