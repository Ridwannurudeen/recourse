// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPolicyEvaluatorV1} from "../v2/interfaces/IPolicyEvaluatorV1.sol";
import {ProofJobsV1} from "../v2/ProofJobsV1.sol";
import {FacilityStatus} from "../v2/types/RecourseTypesV2.sol";
import {PortfolioMandateV1} from "./PortfolioMandateV1.sol";

interface IPortfolioPoolFactoryV1 {
    function createFacility(
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external returns (address facility);

    function isFacility(address facility) external view returns (bool);
}

interface IPortfolioPoolFacilityV1 {
    function asset() external view returns (IERC20);
    function kernel() external view returns (address);
    function lender() external view returns (address);
    function status() external view returns (FacilityStatus);
    function maturityBlock() external view returns (uint64);
    function facilityLimit() external view returns (uint256);
    function bondRequired() external view returns (uint256);
    function bondPosted() external view returns (uint256);
    function lenderFunded() external view returns (uint256);
    function outstandingDebt() external view returns (uint256);
    function lenderClaimable() external view returns (uint256);
    function fundAsLender(uint256 amount) external;
    function lenderWithdraw() external;
    function markDefaulted() external;
    function cancel() external;
    function settleDefaultLoss() external;
    function setDrawPaused(bool paused) external;
}

interface IPortfolioPoolKernelV1 {
    function registerPolicy(address facility, uint256 policyId, IPolicyEvaluatorV1 evaluator) external;
    function proofJobs() external view returns (address);
    function policyOf(address facility, uint256 policyId)
        external
        view
        returns (address evaluator, bytes32 configHash, bytes memory manifestBytes);
}

interface IPortfolioPoolRemedyCoordinatorV1 {
    function authorizePolicy(address facility, uint256 policyId, address policy) external;
    function publishIntent(bytes32 intentId, bytes calldata actionData) external returns (bytes32 messageId);
    function authorizedPolicy(address facility, uint256 policyId) external view returns (address policy);
    function latestPolicyIntent(address facility, uint256 policyId) external view returns (bytes32 intentId);
}

interface IPortfolioPoolRemedyPolicyV1 {
    function coordinator() external view returns (address);
    function latestIntent(address facility, uint256 policyId) external view returns (bytes32 intentId);
    function replaceRemedyIntent(address facility, uint256 policyId) external returns (bytes32 intentId);
}

contract PortfolioPoolV1 is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAXIMUM_INVESTORS = 64;
    uint256 public constant MAXIMUM_SERVICE_BUDGET_BPS = 500;

    enum PoolStatus {
        Configuring,
        Funding,
        Active,
        Finalized,
        Cancelled
    }

    struct Allocation {
        bytes32 deploymentId;
        uint256 principal;
        uint256 recovered;
        uint256 realizedLoss;
        bool registered;
        bool settled;
    }

    error AccountingInvariant();
    error AllocationAlreadySettled();
    error AllocationNotSettled();
    error CandidateAlreadyRegistered();
    error CandidateNotRegistered();
    error FundingExpired();
    error IneligibleFacility(PortfolioMandateV1.EligibilityCode code);
    error InvalidAmount();
    error InvalidConfiguration();
    error InvalidFacility();
    error InvalidPolicyCall();
    error InvestorLimitExceeded();
    error InvestorNotRegistered();
    error MandateAlreadySet();
    error NotManager();
    error RecoveryPending();
    error ServiceBudgetExceeded();
    error ServiceVenueNotSet();
    error SharesLocked();
    error TransferAmountMismatch();
    error WrongStatus(PoolStatus expected, PoolStatus actual);
    error ZeroAddress();

    event AllocationFunded(address indexed facility, bytes32 indexed deploymentId, uint256 amount);
    event AllocationRecovered(address indexed facility, uint256 amount, uint256 totalRecovered);
    event AllocationSettled(address indexed facility, uint256 recovered, uint256 realizedLoss);
    event AssetsClaimed(address indexed account, uint256 amount);
    event AssetsDistributed(uint256 amount);
    event CandidateRegistered(address indexed facility, bytes32 indexed deploymentId);
    event FacilityCreated(address indexed facility);
    event FundingCancelled();
    event FundingOpened();
    event InvestorRegistered(address indexed investor);
    event MandateSet(address indexed mandate);
    event PolicyConfigured(address indexed facility, uint256 indexed policyId, address indexed evaluator);
    event PoolActivated(uint256 assets);
    event PoolFinalized(uint256 recovered, uint256 realizedLoss);
    event ProofJobCreated(uint256 indexed jobId, address indexed facility, uint256 escrow);
    event ProofJobFundsRecovered(uint256 amount);
    event ProofJobsVenueSet(address indexed proofJobs);
    event RemedyPolicyAuthorized(address indexed facility, uint256 indexed policyId, address indexed coordinator);
    event RemedyIntentPublished(
        address indexed facility, uint256 indexed policyId, bytes32 indexed intentId, bytes32 messageId
    );
    event RemedyIntentReplaced(address indexed facility, uint256 indexed policyId, bytes32 indexed intentId);

    IERC20 public immutable asset;
    address public immutable manager;
    uint256 public immutable maximumPoolAssets;
    uint256 public immutable maximumServiceBudget;
    uint64 public immutable maximumServiceJobDuration;
    uint16 public immutable maximumFacilityCount;
    uint64 public immutable fundingDeadline;
    uint64 public immutable recoveryDelayBlocks;
    uint8 private immutable assetDecimals;

    PortfolioMandateV1 public mandate;
    ProofJobsV1 public proofJobsVenue;
    PoolStatus public status;
    uint256 public totalDeposited;
    uint256 public totalAllocatedPrincipal;
    uint256 public totalRecovered;
    uint256 public totalRealizedLoss;
    uint256 public totalServiceEscrowed;
    uint256 public totalServiceRecovered;
    uint256 public allocatedFacilityCount;
    uint256 public settledFacilityCount;
    uint256 public totalDistributed;
    uint256 public totalClaimed;

    address[] private createdFacilities;
    address[] private candidateFacilities;
    address[] private investors;
    mapping(address facility => bool created) public isCreatedFacility;
    mapping(address facility => Allocation allocation) private allocations;
    mapping(address account => bool investor) public isInvestor;
    mapping(address account => uint256 amount) private claimableAssets;
    mapping(address account => uint256 amount) public claimedAssets;
    mapping(uint256 jobId => bool created) public isPoolProofJob;
    mapping(address facility => mapping(uint256 policyId => address evaluator)) public remedyPolicyEvaluator;
    mapping(address facility => mapping(uint256 policyId => address coordinator)) public remedyCoordinator;

    constructor(
        IERC20 asset_,
        address manager_,
        uint256 maximumPoolAssets_,
        uint256 maximumServiceBudget_,
        uint64 maximumServiceJobDuration_,
        uint16 maximumFacilityCount_,
        uint64 fundingDeadline_,
        uint64 recoveryDelayBlocks_
    ) ERC20("Recourse Portfolio Share", "rPORT") {
        if (address(asset_) == address(0) || manager_ == address(0)) revert ZeroAddress();
        if (
            maximumPoolAssets_ == 0
                || maximumServiceBudget_ > Math.mulDiv(maximumPoolAssets_, MAXIMUM_SERVICE_BUDGET_BPS, 10_000)
                || (maximumServiceBudget_ != 0 && maximumServiceJobDuration_ == 0) || maximumFacilityCount_ == 0
                || fundingDeadline_ <= block.timestamp || recoveryDelayBlocks_ == 0
        ) revert InvalidConfiguration();
        asset = asset_;
        manager = manager_;
        maximumPoolAssets = maximumPoolAssets_;
        maximumServiceBudget = maximumServiceBudget_;
        maximumServiceJobDuration = maximumServiceJobDuration_;
        maximumFacilityCount = maximumFacilityCount_;
        fundingDeadline = fundingDeadline_;
        recoveryDelayBlocks = recoveryDelayBlocks_;
        assetDecimals = IERC20Metadata(address(asset_)).decimals();
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert NotManager();
        _;
    }

    function decimals() public view override returns (uint8) {
        return assetDecimals;
    }

    function setMandate(PortfolioMandateV1 mandate_) external onlyManager {
        _requireStatus(PoolStatus.Configuring);
        if (address(mandate) != address(0)) revert MandateAlreadySet();
        if (address(mandate_) == address(0)) revert ZeroAddress();
        if (address(mandate_.asset()) != address(asset)) revert InvalidConfiguration();
        mandate = mandate_;
        emit MandateSet(address(mandate_));
    }

    function createFacility(
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external onlyManager returns (address facility) {
        _requireStatus(PoolStatus.Configuring);
        PortfolioMandateV1 currentMandate = _mandate();
        if (createdFacilities.length >= maximumFacilityCount) revert InvalidConfiguration();
        IPortfolioPoolFactoryV1 factory = IPortfolioPoolFactoryV1(address(currentMandate.factory()));
        facility = factory.createFacility(facilityLimit, bondRequired, drawFeeBps, maturityBlock, drawDelayBlocks);
        if (
            facility == address(0) || isCreatedFacility[facility] || !factory.isFacility(facility)
                || IPortfolioPoolFacilityV1(facility).lender() != address(this)
        ) revert InvalidFacility();
        isCreatedFacility[facility] = true;
        createdFacilities.push(facility);
        emit FacilityCreated(facility);
    }

    function configureAndRegisterPolicy(
        address facility,
        uint256 policyId,
        IPolicyEvaluatorV1 evaluator,
        bytes calldata configurationCall
    ) external onlyManager nonReentrant {
        _requireStatus(PoolStatus.Configuring);
        if (!isCreatedFacility[facility]) revert InvalidFacility();
        if (address(evaluator) == address(0) || address(evaluator) == address(asset) || configurationCall.length < 4) {
            revert InvalidPolicyCall();
        }
        address kernel = IPortfolioPoolFacilityV1(facility).kernel();
        if (kernel != _mandate().kernel()) revert InvalidFacility();
        (bool success, bytes memory returnData) = address(evaluator).call(configurationCall);
        if (!success) _revertWith(returnData);
        IPortfolioPoolKernelV1(kernel).registerPolicy(facility, policyId, evaluator);
        emit PolicyConfigured(facility, policyId, address(evaluator));
    }

    function authorizeRemedyPolicy(address facility, uint256 policyId, IPortfolioPoolRemedyCoordinatorV1 coordinator)
        external
        onlyManager
        nonReentrant
    {
        _requireStatus(PoolStatus.Configuring);
        if (!isCreatedFacility[facility] || address(coordinator) == address(0)) revert InvalidFacility();
        if (remedyCoordinator[facility][policyId] != address(0)) revert InvalidPolicyCall();
        IPortfolioPoolKernelV1 kernel = IPortfolioPoolKernelV1(IPortfolioPoolFacilityV1(facility).kernel());
        (address evaluator,,) = kernel.policyOf(facility, policyId);
        if (evaluator == address(0)) revert InvalidFacility();
        if (IPortfolioPoolRemedyPolicyV1(evaluator).coordinator() != address(coordinator)) {
            revert InvalidPolicyCall();
        }
        coordinator.authorizePolicy(facility, policyId, evaluator);
        if (coordinator.authorizedPolicy(facility, policyId) != evaluator) revert InvalidPolicyCall();
        remedyPolicyEvaluator[facility][policyId] = evaluator;
        remedyCoordinator[facility][policyId] = address(coordinator);
        emit RemedyPolicyAuthorized(facility, policyId, address(coordinator));
    }

    function publishRemedyIntent(address facility, uint256 policyId, bytes calldata actionData)
        external
        onlyManager
        nonReentrant
        returns (bytes32 messageId)
    {
        _requireRemedyServicingStatus();
        Allocation storage allocation = allocations[facility];
        if (!allocation.registered || allocation.principal == 0) revert InvalidFacility();
        address evaluator = remedyPolicyEvaluator[facility][policyId];
        IPortfolioPoolRemedyCoordinatorV1 coordinator =
            IPortfolioPoolRemedyCoordinatorV1(remedyCoordinator[facility][policyId]);
        if (evaluator == address(0) || address(coordinator) == address(0)) revert InvalidPolicyCall();
        IPortfolioPoolKernelV1 kernel = IPortfolioPoolKernelV1(IPortfolioPoolFacilityV1(facility).kernel());
        (address registeredEvaluator,,) = kernel.policyOf(facility, policyId);
        if (
            registeredEvaluator != evaluator || coordinator.authorizedPolicy(facility, policyId) != evaluator
                || IPortfolioPoolRemedyPolicyV1(evaluator).coordinator() != address(coordinator)
        ) revert InvalidPolicyCall();
        bytes32 intentId = IPortfolioPoolRemedyPolicyV1(evaluator).latestIntent(facility, policyId);
        if (intentId == bytes32(0) || coordinator.latestPolicyIntent(facility, policyId) != intentId) {
            revert InvalidPolicyCall();
        }
        messageId = coordinator.publishIntent(intentId, actionData);
        emit RemedyIntentPublished(facility, policyId, intentId, messageId);
    }

    function replaceRemedyIntent(address facility, uint256 policyId)
        external
        onlyManager
        nonReentrant
        returns (bytes32 intentId)
    {
        _requireRemedyServicingStatus();
        Allocation storage allocation = allocations[facility];
        if (!allocation.registered || allocation.principal == 0) revert InvalidFacility();
        address evaluator = remedyPolicyEvaluator[facility][policyId];
        IPortfolioPoolRemedyCoordinatorV1 coordinator =
            IPortfolioPoolRemedyCoordinatorV1(remedyCoordinator[facility][policyId]);
        if (evaluator == address(0) || address(coordinator) == address(0)) revert InvalidPolicyCall();
        IPortfolioPoolKernelV1 kernel = IPortfolioPoolKernelV1(IPortfolioPoolFacilityV1(facility).kernel());
        (address registeredEvaluator,,) = kernel.policyOf(facility, policyId);
        if (
            registeredEvaluator != evaluator || coordinator.authorizedPolicy(facility, policyId) != evaluator
                || IPortfolioPoolRemedyPolicyV1(evaluator).coordinator() != address(coordinator)
        ) revert InvalidPolicyCall();
        intentId = IPortfolioPoolRemedyPolicyV1(evaluator).replaceRemedyIntent(facility, policyId);
        if (intentId == bytes32(0) || coordinator.latestPolicyIntent(facility, policyId) != intentId) {
            revert InvalidPolicyCall();
        }
        emit RemedyIntentReplaced(facility, policyId, intentId);
    }

    function registerCandidate(address facility, bytes32 deploymentId) external onlyManager {
        _requireStatus(PoolStatus.Configuring);
        if (!isCreatedFacility[facility]) revert InvalidFacility();
        if (deploymentId == bytes32(0)) revert InvalidConfiguration();
        Allocation storage allocation = allocations[facility];
        if (allocation.registered) revert CandidateAlreadyRegistered();
        PortfolioMandateV1.EligibilityCode code = _mandate().evaluate(facility, deploymentId);
        if (code != PortfolioMandateV1.EligibilityCode.Eligible) revert IneligibleFacility(code);
        allocation.deploymentId = deploymentId;
        allocation.registered = true;
        candidateFacilities.push(facility);
        emit CandidateRegistered(facility, deploymentId);
    }

    function registerInvestor(address investor) external onlyManager {
        _requireStatus(PoolStatus.Configuring);
        if (investor == address(0)) revert ZeroAddress();
        if (isInvestor[investor]) revert InvalidConfiguration();
        if (investors.length >= MAXIMUM_INVESTORS) revert InvestorLimitExceeded();
        isInvestor[investor] = true;
        investors.push(investor);
        emit InvestorRegistered(investor);
    }

    function setProofJobsVenue(ProofJobsV1 proofJobs_) external onlyManager {
        _requireStatus(PoolStatus.Configuring);
        if (address(proofJobsVenue) != address(0)) revert InvalidConfiguration();
        if (address(proofJobs_) == address(0)) revert ZeroAddress();
        address kernel = _mandate().kernel();
        if (address(proofJobs_.kernel()) != kernel || IPortfolioPoolKernelV1(kernel).proofJobs() != address(proofJobs_))
        {
            revert InvalidConfiguration();
        }
        proofJobsVenue = proofJobs_;
        emit ProofJobsVenueSet(address(proofJobs_));
    }

    function openFunding() external onlyManager {
        _requireStatus(PoolStatus.Configuring);
        _mandate();
        if (block.timestamp >= fundingDeadline) revert FundingExpired();
        if (candidateFacilities.length == 0) revert CandidateNotRegistered();
        if (investors.length == 0) revert InvestorNotRegistered();
        status = PoolStatus.Funding;
        emit FundingOpened();
    }

    function deposit(uint256 amount) external nonReentrant {
        _requireStatus(PoolStatus.Funding);
        if (block.timestamp >= fundingDeadline) revert FundingExpired();
        if (amount == 0 || totalSupply() + amount > maximumPoolAssets) revert InvalidAmount();
        _pull(msg.sender, amount);
        totalDeposited += amount;
        _mint(msg.sender, amount);
    }

    function withdrawFunding(uint256 amount) external nonReentrant {
        if (status != PoolStatus.Funding && status != PoolStatus.Cancelled) {
            revert WrongStatus(PoolStatus.Funding, status);
        }
        if (amount == 0) revert InvalidAmount();
        _burn(msg.sender, amount);
        totalDeposited -= amount;
        asset.safeTransfer(msg.sender, amount);
    }

    function cancelFunding() external {
        if (status != PoolStatus.Configuring && status != PoolStatus.Funding) {
            revert WrongStatus(PoolStatus.Funding, status);
        }
        if (msg.sender != manager && block.timestamp < fundingDeadline) revert NotManager();
        status = PoolStatus.Cancelled;
        emit FundingCancelled();
    }

    function activate() external onlyManager {
        _requireStatus(PoolStatus.Funding);
        if (block.timestamp >= fundingDeadline) revert FundingExpired();
        if (totalSupply() == 0) revert InvalidAmount();
        status = PoolStatus.Active;
        emit PoolActivated(totalDeposited);
    }

    function allocate(address facility, uint256 amount) external onlyManager nonReentrant {
        _requireStatus(PoolStatus.Active);
        if (block.timestamp >= fundingDeadline) revert FundingExpired();
        Allocation storage allocation = allocations[facility];
        if (!allocation.registered) revert CandidateNotRegistered();
        if (allocation.settled) revert AllocationAlreadySettled();
        IPortfolioPoolFacilityV1 candidate = IPortfolioPoolFacilityV1(facility);
        if (candidate.lender() != address(this)) revert InvalidFacility();
        if (
            amount != candidate.facilityLimit() || candidate.lenderFunded() != 0
                || amount > asset.balanceOf(address(this))
        ) {
            revert InvalidAmount();
        }
        if (candidate.bondPosted() != candidate.bondRequired()) revert InvalidFacility();
        PortfolioMandateV1.EligibilityCode code = mandate.evaluate(facility, allocation.deploymentId);
        if (code != PortfolioMandateV1.EligibilityCode.Eligible) revert IneligibleFacility(code);

        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.forceApprove(facility, amount);
        candidate.fundAsLender(amount);
        asset.forceApprove(facility, 0);
        if (beforeBalance - asset.balanceOf(address(this)) != amount) revert TransferAmountMismatch();

        if (allocation.principal == 0) ++allocatedFacilityCount;
        allocation.principal += amount;
        totalAllocatedPrincipal += amount;
        emit AllocationFunded(facility, allocation.deploymentId, amount);
    }

    function setFacilityDrawPaused(address facility, bool paused) external onlyManager {
        _requireStatus(PoolStatus.Active);
        if (!allocations[facility].registered) revert CandidateNotRegistered();
        IPortfolioPoolFacilityV1(facility).setDrawPaused(paused);
    }

    function createProofJob(ProofJobsV1.JobParams calldata params)
        external
        onlyManager
        nonReentrant
        returns (uint256 jobId)
    {
        _requireStatus(PoolStatus.Active);
        ProofJobsV1 venue = proofJobsVenue;
        if (address(venue) == address(0)) revert ServiceVenueNotSet();
        if (maximumServiceJobDuration == 0 || uint256(params.expiry) > block.timestamp + maximumServiceJobDuration) {
            revert InvalidConfiguration();
        }
        Allocation storage allocation = allocations[params.facility];
        if (!allocation.registered || allocation.principal == 0 || address(params.token) != address(asset)) {
            revert InvalidFacility();
        }
        address kernel = IPortfolioPoolFacilityV1(params.facility).kernel();
        if (address(venue.kernel()) != kernel || IPortfolioPoolKernelV1(kernel).proofJobs() != address(venue)) {
            revert InvalidConfiguration();
        }
        (address evaluator, bytes32 configHash,) =
            IPortfolioPoolKernelV1(kernel).policyOf(params.facility, params.policyId);
        if (evaluator == address(0) || params.requirementsDigest != configHash) revert InvalidConfiguration();

        uint256 escrow = params.proofReimbursement * params.maxSuccessfulProofs + params.outcomeReward;
        if (totalServiceEscrowed + escrow > maximumServiceBudget || escrow > asset.balanceOf(address(this))) {
            revert ServiceBudgetExceeded();
        }
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.forceApprove(address(venue), escrow);
        jobId = venue.createJob(params);
        asset.forceApprove(address(venue), 0);
        if (beforeBalance - asset.balanceOf(address(this)) != escrow) revert TransferAmountMismatch();
        totalServiceEscrowed += escrow;
        isPoolProofJob[jobId] = true;
        emit ProofJobCreated(jobId, params.facility, escrow);
    }

    function recoverProofJobFunds() external nonReentrant returns (uint256 recovered) {
        if (status != PoolStatus.Active && status != PoolStatus.Finalized) {
            revert WrongStatus(PoolStatus.Active, status);
        }
        ProofJobsV1 venue = proofJobsVenue;
        if (address(venue) == address(0)) revert ServiceVenueNotSet();
        recovered = venue.claimable(address(asset), address(this));
        if (recovered == 0) revert InvalidAmount();
        uint256 beforeBalance = asset.balanceOf(address(this));
        venue.claim(asset);
        if (asset.balanceOf(address(this)) - beforeBalance != recovered) revert TransferAmountMismatch();
        totalServiceRecovered += recovered;
        if (status == PoolStatus.Finalized) _distributeAvailable();
        emit ProofJobFundsRecovered(recovered);
    }

    function harvest(address facility) external nonReentrant returns (uint256 recovered) {
        if (status != PoolStatus.Active && status != PoolStatus.Finalized) {
            revert WrongStatus(PoolStatus.Active, status);
        }
        Allocation storage allocation = allocations[facility];
        if (allocation.principal == 0) revert CandidateNotRegistered();
        recovered = _harvest(facility, allocation);
        if (recovered == 0) revert InvalidAmount();
        if (status == PoolStatus.Finalized) _distributeAvailable();
    }

    function settleAllocation(address facility) external nonReentrant {
        _requireStatus(PoolStatus.Active);
        Allocation storage allocation = allocations[facility];
        if (allocation.principal == 0) revert CandidateNotRegistered();
        if (allocation.settled) revert AllocationAlreadySettled();

        IPortfolioPoolFacilityV1 candidate = IPortfolioPoolFacilityV1(facility);
        FacilityStatus facilityStatus = candidate.status();
        if (facilityStatus == FacilityStatus.Created) {
            if (block.number <= candidate.maturityBlock()) revert RecoveryPending();
            candidate.cancel();
            facilityStatus = FacilityStatus.Cancelled;
        } else if (facilityStatus == FacilityStatus.Active) {
            if (block.number <= candidate.maturityBlock()) revert RecoveryPending();
            candidate.markDefaulted();
            facilityStatus = candidate.status();
        }

        if (facilityStatus == FacilityStatus.Defaulted || facilityStatus == FacilityStatus.Terminated) {
            if (candidate.outstandingDebt() != 0) {
                uint256 settlementBlock = uint256(candidate.maturityBlock()) + recoveryDelayBlocks;
                if (block.number <= settlementBlock) revert RecoveryPending();
                if (candidate.bondPosted() != 0) candidate.settleDefaultLoss();
            }
        } else if (facilityStatus != FacilityStatus.Repaid && facilityStatus != FacilityStatus.Cancelled) {
            revert AllocationNotSettled();
        }

        _harvest(facility, allocation);
        uint256 realizedLoss =
            allocation.principal > allocation.recovered ? allocation.principal - allocation.recovered : 0;
        allocation.realizedLoss = realizedLoss;
        allocation.settled = true;
        totalRealizedLoss += realizedLoss;
        ++settledFacilityCount;
        emit AllocationSettled(facility, allocation.recovered, realizedLoss);
    }

    function finalize() external nonReentrant {
        _requireStatus(PoolStatus.Active);
        if (allocatedFacilityCount == 0) {
            if (msg.sender != manager && block.timestamp < fundingDeadline) revert NotManager();
        } else if (settledFacilityCount != allocatedFacilityCount) {
            revert AllocationNotSettled();
        }
        status = PoolStatus.Finalized;
        _distributeAvailable();
        emit PoolFinalized(totalRecovered, totalRealizedLoss);
    }

    function distributeAvailable() external nonReentrant returns (uint256 amount) {
        _requireStatus(PoolStatus.Finalized);
        amount = _distributeAvailable();
        if (amount == 0) revert InvalidAmount();
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _requireStatus(PoolStatus.Finalized);
        amount = claimable(msg.sender);
        if (amount == 0) revert InvalidAmount();
        claimableAssets[msg.sender] = 0;
        claimedAssets[msg.sender] += amount;
        totalClaimed += amount;
        asset.safeTransfer(msg.sender, amount);
        emit AssetsClaimed(msg.sender, amount);
    }

    function claimable(address account) public view returns (uint256) {
        return claimableAssets[account];
    }

    function allocationOf(address facility) external view returns (Allocation memory) {
        return allocations[facility];
    }

    function createdFacilityCount() external view returns (uint256) {
        return createdFacilities.length;
    }

    function createdFacilityAt(uint256 index) external view returns (address) {
        return createdFacilities[index];
    }

    function candidateCount() external view returns (uint256) {
        return candidateFacilities.length;
    }

    function candidateAt(uint256 index) external view returns (address) {
        return candidateFacilities[index];
    }

    function investorCount() external view returns (uint256) {
        return investors.length;
    }

    function investorAt(uint256 index) external view returns (address) {
        return investors[index];
    }

    function _harvest(address facility, Allocation storage allocation) private returns (uint256 recovered) {
        IPortfolioPoolFacilityV1 candidate = IPortfolioPoolFacilityV1(facility);
        uint256 claimAmount = candidate.lenderClaimable();
        if (claimAmount == 0) return 0;
        uint256 beforeBalance = asset.balanceOf(address(this));
        candidate.lenderWithdraw();
        recovered = asset.balanceOf(address(this)) - beforeBalance;
        if (recovered != claimAmount) revert TransferAmountMismatch();
        allocation.recovered += recovered;
        totalRecovered += recovered;

        if (allocation.settled && allocation.realizedLoss != 0) {
            uint256 lossReduction = recovered < allocation.realizedLoss ? recovered : allocation.realizedLoss;
            allocation.realizedLoss -= lossReduction;
            totalRealizedLoss -= lossReduction;
        }
        emit AllocationRecovered(facility, recovered, allocation.recovered);
    }

    function _distributeAvailable() private returns (uint256 amount) {
        uint256 reserved = totalDistributed - totalClaimed;
        uint256 balance = asset.balanceOf(address(this));
        if (balance < reserved) revert AccountingInvariant();
        amount = balance - reserved;
        if (amount == 0) return 0;

        uint256 supply = totalSupply();
        uint256 investorLength = investors.length;
        uint256[] memory remainders = new uint256[](investorLength);
        uint256 assigned;
        for (uint256 i; i < investorLength; ++i) {
            address investor = investors[i];
            uint256 shares = balanceOf(investor);
            if (shares == 0) continue;
            uint256 investorAmount = Math.mulDiv(amount, shares, supply);
            remainders[i] = mulmod(amount, shares, supply);
            claimableAssets[investor] += investorAmount;
            assigned += investorAmount;
        }
        uint256 remaining = amount - assigned;
        for (uint256 i; i < remaining; ++i) {
            uint256 selected = type(uint256).max;
            uint256 largestRemainder;
            for (uint256 j; j < investorLength; ++j) {
                if (remainders[j] > largestRemainder) {
                    largestRemainder = remainders[j];
                    selected = j;
                }
            }
            if (selected == type(uint256).max) revert AccountingInvariant();
            ++claimableAssets[investors[selected]];
            remainders[selected] = 0;
        }
        totalDistributed += amount;
        emit AssetsDistributed(amount);
    }

    function _pull(address from, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _mandate() private view returns (PortfolioMandateV1 currentMandate) {
        currentMandate = mandate;
        if (address(currentMandate) == address(0)) revert InvalidConfiguration();
    }

    function _requireStatus(PoolStatus expected) private view {
        if (status != expected) revert WrongStatus(expected, status);
    }

    function _requireRemedyServicingStatus() private view {
        if (status != PoolStatus.Active && status != PoolStatus.Finalized) {
            revert WrongStatus(PoolStatus.Active, status);
        }
    }

    function _revertWith(bytes memory returnData) private pure {
        if (returnData.length == 0) revert InvalidPolicyCall();
        assembly ("memory-safe") {
            revert(add(returnData, 32), mload(returnData))
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && status != PoolStatus.Funding) revert SharesLocked();
        if (value != 0 && to != address(0) && !isInvestor[to]) revert InvestorNotRegistered();
        super._update(from, to, value);
    }
}
